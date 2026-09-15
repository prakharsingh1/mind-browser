// =============================================================================
// Local Mind Browser — Tor process
// =============================================================================
// Owns the lifecycle of a `tor` child process and reports its bootstrap
// progress, so Onion Mode can show something honest while the circuit builds
// (it takes 5-30 seconds, and a browser that just sits there looks broken).
//
// Port 9150, not 9050: 9050 is where a system Tor daemon or Tor Browser
// usually sits, and binding over it would either fail or silently hijack
// someone else's Tor. 9150 is Tor Browser's own port, so we offset again to
// 9152 to stay out of everyone's way.

const { app } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const SOCKS_PORT = 9152;

let proc = null;
let state = 'stopped';        // stopped | starting | ready | failed
let progress = 0;
let lastError = '';
const listeners = new Set();

function emit() {
  const snapshot = { state, progress, error: lastError, socksPort: SOCKS_PORT };
  for (const fn of listeners) { try { fn(snapshot); } catch { /* listener's problem */ } }
}

const onStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const status = () => ({ state, progress, error: lastError, socksPort: SOCKS_PORT });

/**
 * Where the tor binary lives.
 *
 * Packaged builds carry it in extraResources; in development it sits in the
 * repo. If neither exists we fall back to whatever `tor` is on PATH, so a
 * contributor who already runs Tor is not blocked on the download step.
 */
function findTorBinary() {
  const key = `${process.platform}-${process.arch}`;
  const exe = process.platform === 'win32' ? 'tor.exe' : 'tor';
  const candidates = [
    path.join(process.resourcesPath || '', 'tor', key, 'tor', exe),
    path.join(__dirname, '..', 'resources', 'tor', key, 'tor', exe)
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }

  // Nothing bundled. Fall back to a tor already installed on this machine, so
  // a developer who has one is not blocked on the download step. Common
  // package-manager locations, then PATH.
  const known = [
    '/opt/homebrew/bin/tor', '/usr/local/bin/tor', '/usr/bin/tor', '/usr/sbin/tor'
  ];
  for (const c of known) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const c = path.join(dir, exe);
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return null;
}

/** Is something already listening on our SOCKS port? */
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(700, () => { sock.destroy(); resolve(false); });
  });
}

// ── Bridges ──────────────────────────────────────────────────────────────────
// Plain Tor is blocked outright in Iran, China, Russia and elsewhere: the relay
// list is public, so a censor simply drops connections to all of it. Bridges
// are unlisted entry points, and pluggable transports disguise the traffic so
// it does not look like Tor at all.
//
// Without this, Onion Mode fails for precisely the people who need it most, and
// fails in the most confusing way — a connection that just times out.
//
// The Tor Expert Bundle already ships the transports (lyrebird) and a set of
// default bridges in pt_config.json, so nothing extra has to be downloaded.

let bridgeMode = 'direct';        // direct | obfs4 | snowflake | meek | custom
let customBridges = [];          // raw "obfs4 1.2.3.4:443 FINGERPRINT cert=…" lines

const getBridgeMode = () => bridgeMode;
const setBridgeMode = (m) => {
  if (['direct', 'obfs4', 'snowflake', 'meek', 'custom'].includes(m)) bridgeMode = m;
  return bridgeMode;
};

/**
 * Bridges the user obtained themselves, from bridges.torproject.org or by
 * emailing bridges@torproject.org.
 *
 * This matters more than it looks: the built-in bridges are public, shared by
 * everyone, and are the first thing a censor blocks. A personally-issued bridge
 * is often the only one that works in the places bridges are needed.
 */
const getCustomBridges = () => customBridges.join('\n');
const setCustomBridges = (text) => {
  customBridges = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return customBridges.length;
};

/** Which transport a set of custom bridge lines needs. */
function transportOf(lines) {
  for (const l of lines) {
    const first = l.split(/\s+/)[0].toLowerCase();
    if (['obfs4', 'obfs3', 'obfs2', 'scramblesuit', 'meek_lite', 'webtunnel'].includes(first)) return 'lyrebird';
    if (first === 'snowflake') return 'snowflake';
    if (first === 'conjure') return 'conjure';
  }
  return null;               // plain "1.2.3.4:443 FINGERPRINT" — no transport
}

/** The transports directory that sits beside the tor binary. */
function ptDir(binPath) {
  return path.join(path.dirname(binPath), 'pluggable_transports');
}

function readPtConfig(binPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ptDir(binPath), 'pt_config.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Which bridge modes this install can actually offer. */
function availableBridgeModes(binPath = findTorBinary()) {
  if (!binPath) return ['direct'];
  const cfg = readPtConfig(binPath);
  const modes = ['direct'];
  for (const m of ['obfs4', 'snowflake', 'meek']) {
    if (cfg?.bridges?.[m]?.length) modes.push(m);
  }
  return modes;
}

/**
 * Build a torrc rather than passing options as argv.
 *
 * Bridge lines contain spaces, '=' and base64 — quoting all of that through
 * argv is fragile, and a single mangled line fails as an unexplained
 * connection timeout rather than a parse error.
 */
function writeTorrc(binPath) {
  const lines = [
    `SocksPort ${SOCKS_PORT}`,
    `DataDirectory ${dataDir()}`,
    // No control port: nothing needs to reconfigure a running tor, and an open
    // one is a remote-control channel into the circuit.
    'ControlPort 0',
    'AvoidDiskWrites 1',
    'ClientOnly 1'
  ];

  if (bridgeMode !== 'direct') {
    const cfg = readPtConfig(binPath);
    const useCustom = bridgeMode === 'custom' && customBridges.length;
    const bridges = useCustom ? customBridges : (cfg?.bridges?.[bridgeMode] || []);

    // The plugin key differs from the mode name: snowflake has its own entry,
    // while obfs4 and meek_lite are both served by lyrebird.
    const pluginKey = useCustom
      ? transportOf(customBridges)
      : (bridgeMode === 'snowflake' ? 'snowflake' : 'lyrebird');
    const plugin = pluginKey ? cfg?.pluggableTransports?.[pluginKey] : null;

    if (bridges.length) {
      // ${pt_path} is a placeholder in the shipped config, with a trailing slash.
      if (plugin) lines.push(plugin.replace('${pt_path}', ptDir(binPath) + path.sep));
      lines.push('UseBridges 1');
      for (const b of bridges) lines.push(`Bridge ${b}`);
    }
  }

  const file = path.join(app.getPath('userData'), 'torrc');
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return file;
}

function dataDir() {
  const dir = path.join(app.getPath('userData'), 'tor-data');
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* tor will complain */ }
  return dir;
}

/**
 * Start tor and resolve once it reports a usable circuit.
 * Resolving early would hand the session a proxy that refuses every request.
 */
function start() {
  if (state === 'ready') return Promise.resolve(status());
  if (state === 'starting' && proc) return waitForReady();

  const bin = findTorBinary();
  if (!bin) {
    state = 'failed';
    lastError = 'No Tor binary found. Run "npm run fetch-tor" to download the official one.';
    emit();
    return Promise.reject(new Error(lastError));
  }

  state = 'starting';
  progress = 0;
  lastError = '';
  emit();

  return portInUse(SOCKS_PORT).then((busy) => {
    if (busy) {
      // Something is already there. Reusing it would mean trusting a proxy we
      // did not start, which is exactly the thing not to do silently.
      state = 'failed';
      lastError = `Port ${SOCKS_PORT} is already in use. Close whatever is using it and try again.`;
      emit();
      throw new Error(lastError);
    }

    let torrc;
    try {
      torrc = writeTorrc(bin);
    } catch (err) {
      state = 'failed';
      lastError = `Could not write the Tor configuration (${err.message}).`;
      emit();
      throw new Error(lastError);
    }

    proc = spawn(bin, ['-f', torrc], { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (buf) => {
      const text = buf.toString();
      // "Bootstrapped 45% (requesting_descriptors): ..."
      const m = /Bootstrapped (\d+)%/.exec(text);
      if (m) {
        progress = Number(m[1]);
        if (progress >= 100 && state !== 'ready') { state = 'ready'; }
        emit();
      }
      if (/\[err\]/.test(text)) {
        lastError = text.split('\n').find((l) => l.includes('[err]'))?.trim() || 'tor reported an error';
        emit();
      }
    });

    proc.stderr.on('data', (buf) => { lastError = buf.toString().trim().slice(0, 300); });

    proc.on('exit', (code) => {
      proc = null;
      if (state !== 'stopped') {
        state = 'failed';
        if (!lastError) lastError = `tor exited unexpectedly (code ${code}).`;
      }
      emit();
    });

    proc.on('error', (err) => {
      proc = null;
      state = 'failed';
      lastError = err.message;
      emit();
    });

    return waitForReady();
  });
}

/** Resolve on a built circuit, reject on failure or after 90s. */
function waitForReady(timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    if (state === 'ready') return resolve(status());
    const done = (fn, arg) => { clearTimeout(timer); off(); fn(arg); };
    const off = onStatus((s) => {
      if (s.state === 'ready') done(resolve, s);
      else if (s.state === 'failed') done(reject, new Error(s.error || 'tor failed to start'));
    });
    // Generous, because the first run is genuinely slow: a fresh data directory
    // means downloading the consensus and tens of MB of relay descriptors.
    // Later starts take seconds.
    const timer = setTimeout(() => {
      done(reject, new Error('Tor could not connect. Your network may be blocking it — try a bridge in Settings, Privacy.'));
    }, timeoutMs);
  });
}

function stop() {
  state = 'stopped';
  progress = 0;
  if (proc) {
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    proc = null;
  }
  emit();
}

// Never leave a tor process behind when the browser closes.
// Guarded so the module can also be required outside Electron (tests, scripts),
// where `app` does not exist.
if (app?.on) {
  app.on('before-quit', stop);
  app.on('will-quit', stop);
}

module.exports = {
  start, stop, status, onStatus, findTorBinary, SOCKS_PORT,
  getBridgeMode, setBridgeMode, availableBridgeModes,
  getCustomBridges, setCustomBridges
};
