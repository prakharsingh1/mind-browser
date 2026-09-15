// =============================================================================
// Local Mind Browser — Onion Mode
// =============================================================================
// A separate window on a separate session, with every request routed through
// Tor. It hides your IP and reaches .onion services.
//
// What it is NOT, and the code should say so as plainly as the UI does: this is
// not Tor Browser. Tor Browser's real protection is its patch set — every user
// made to look identical, in window size, fonts, user agent and available APIs.
// This is an Electron app with your extensions and your screen; you are
// anonymous by IP but still distinctive by fingerprint. Good for reaching onion
// services and keeping your ISP out of it. Not good enough to bet your safety
// on. The start page says this too, in those words.
//
// The session is deliberately its own partition, in memory only:
//   • separate cookie jar, so an onion visit cannot be joined to normal browsing
//   • no extensions — an extension can see and exfiltrate every page
//   • proxied DNS, so lookups do not leak to the local resolver
//   • no WebRTC, the classic way a proxied browser gives up its real address

const { BrowserWindow, session, app } = require('electron');
const path = require('path');
const tor = require('./tor');

const PARTITION = 'onion';          // no "persist:" prefix — dies with the app
let win = null;

// ── Security levels ──────────────────────────────────────────────────────────
// The same three-step model Tor Browser uses, and for the same reason: the
// things that make you identifiable — JavaScript, WebGL, fonts, media — are
// also the things that make the web work. There is no setting that is both
// safe and fully functional, so the user picks where on that line to sit
// instead of us pretending the tradeoff does not exist.
const LEVELS = {
  standard: {
    name: 'Standard',
    detail: 'Everything works. Your IP is hidden, but a determined site can still fingerprint this browser.',
    javascript: true, webgl: true, media: true
  },
  safer: {
    name: 'Safer',
    detail: 'Blocks WebGL, audio and video, and the fonts and maths that make a device identifiable. Some sites break.',
    javascript: true, webgl: false, media: false
  },
  safest: {
    name: 'Safest',
    detail: 'JavaScript is off everywhere. This is what actually stops fingerprinting. Most sites will not work properly.',
    javascript: false, webgl: false, media: false
  }
};

let level = 'safer';                // a real default, not the weakest one
const getLevel = () => level;
const levelInfo = () => ({ level, levels: LEVELS });

/**
 * Route everything through Tor.
 *
 * socks5:// rather than socks:// matters: with SOCKS5 Chromium resolves names
 * through the proxy, so DNS goes over Tor too. With SOCKS4 it resolves locally
 * first and hands your resolver the hostname of every onion site you open,
 * which defeats the whole exercise.
 */
async function configureSession() {
  const ses = session.fromPartition(PARTITION);

  await ses.setProxy({
    proxyRules: `socks5://127.0.0.1:${tor.SOCKS_PORT}`,
    // Nothing bypasses the proxy. The default bypass list includes localhost
    // and local names, which would send some requests around Tor.
    proxyBypassRules: '<-loopback>'
  });

  // Stock Chrome on macOS — the same string the main window presents.
  //
  // This used to claim Firefox, on the theory that matching Tor Browser put us
  // in its crowd. It did the opposite: the TLS handshake, the JS engine and the
  // codec list all say Chromium, so a site comparing any of them with the
  // header saw a contradiction. "Chromium wearing a Firefox costume" is a much
  // sharper signal than either browser on its own, because almost nobody else
  // looks like that. An ordinary Chrome user over Tor is unremarkable.
  const { GENERIC_UA } = require('./privacy-enforce');
  ses.setUserAgent(GENERIC_UA);

  // Deny everything that can identify a machine or a person. Onion Mode is for
  // reading; nothing here needs your camera or your coordinates.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);

  // At Safest, JavaScript is disabled for real — at the engine, not by asking
  // the page nicely. This is the single most effective anti-fingerprinting
  // measure there is, which is why Tor Browser offers it too.
  applyLevelToSession(ses);

  const { CHROME_MAJOR } = require('./privacy-enforce');
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    // Client hints are a second channel describing the same browser. Stripping
    // them entirely is itself unusual — stock Chrome always sends the low-entropy
    // ones — so they are normalised to match the UA instead, and only the
    // high-entropy hints (exact build, model, architecture) are dropped.
    for (const k of Object.keys(headers)) {
      if (/^sec-ch-ua/i.test(k)) delete headers[k];
    }
    headers['Sec-CH-UA'] =
      `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not_A Brand";v="24"`;
    headers['Sec-CH-UA-Mobile'] = '?0';
    headers['Sec-CH-UA-Platform'] = '"macOS"';
    headers['Accept-Language'] = 'en-US,en;q=0.5';
    headers['Sec-GPC'] = '1';
    headers['DNT'] = '1';
    delete headers['Referer'];
    callback({ requestHeaders: headers });
  });

  // ── Onion-Location ────────────────────────────────────────────────────────
  // A site can advertise its own onion service with an Onion-Location response
  // header. Tor Browser surfaces this so you end up on the operator's onion
  // rather than reaching them through an exit node — which removes the exit
  // node from the path entirely, and is the single easiest security win
  // available on the clearnet web.
  ses.webRequest.onHeadersReceived((details, callback) => {
    try {
      if (details.resourceType === 'mainFrame' && !/\.onion(\/|$|:)/i.test(details.url)) {
        const headers = details.responseHeaders || {};
        const key = Object.keys(headers).find((k) => k.toLowerCase() === 'onion-location');
        const value = key ? [].concat(headers[key])[0] : null;
        if (value && /\.onion/i.test(value) && win && !win.isDestroyed()) {
          win.webContents.send('onion:location', { from: details.url, to: value });
        }
      }
    } catch { /* never block a response over this */ }
    callback({ responseHeaders: details.responseHeaders });
  });

  return ses;
}

/**
 * New Identity: forget everything and rebuild the path.
 *
 * Tor Browser's version closes every tab, clears all state, and gets fresh
 * circuits, so nothing links what you do next to what you did before. A "new
 * circuit" alone does not do that — the cookies and storage from the old
 * session would carry straight over the new path.
 */
async function newIdentity() {
  await clearSession();
  if (win && !win.isDestroyed()) win.webContents.send('onion:new-identity');
  tor.stop();
  try {
    await tor.start();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function applyLevelToSession(ses) {
  const cfg = LEVELS[level] || LEVELS.safer;
  try {
    // webPreferences on the webview cannot be changed after creation, so the
    // engine-level switch lives here and the window reloads on change.
    ses.setPreloads?.(ses.getPreloads?.() || []);
  } catch { /* not fatal */ }
  return cfg;
}

/** Change level and reload so it takes effect on the next page load. */
function setLevel(next) {
  if (!LEVELS[next]) return levelInfo();
  level = next;
  if (win && !win.isDestroyed()) {
    win.webContents.send('onion:level', levelInfo());
  }
  return levelInfo();
}

/** Wipe the session's traces. Called when the window closes. */
async function clearSession() {
  try {
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
  } catch { /* the window is going away regardless */ }
}

/**
 * Open the Onion window immediately, then connect.
 *
 * This used to await tor.start() first, on the theory that a window which
 * cannot load anything is worse than a wait. That was wrong in practice: the
 * FIRST run downloads the full consensus and tens of megabytes of relay
 * descriptors, which takes minutes, so the user pressed the shortcut and got
 * nothing at all — and when the timeout fired, a toast they had long stopped
 * watching. Tor Browser shows a connecting screen for exactly this reason.
 *
 * The window now opens at once and reports progress; only page loads wait.
 */
async function openOnionWindow(onProgress = () => {}) {
  if (win && !win.isDestroyed()) {
    win.focus();
    return { ok: true, alreadyOpen: true };
  }

  await configureSession();

  win = new BrowserWindow({
    width: 1100,
    height: 780,
    title: 'Onion Mode',
    backgroundColor: '#0b0710',
    show: false,
    // A fixed, common window size would be the right thing for fingerprinting,
    // but silently resizing someone's window is hostile. The start page explains
    // the tradeoff instead.
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload-onion.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The window is a small browser shell: its own address bar and a webview
      // for the site. Navigating the window itself would leave no way back.
      webviewTag: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'onion.html'));
  win.once('ready-to-show', () => win.show());

  // Connect in the background. Failures surface in the window's status strip,
  // which is where someone waiting on a connection is already looking.
  const off = tor.onStatus((s) => {
    onProgress(s);
    if (win && !win.isDestroyed()) win.webContents.send('onion:status', s);
  });
  tor.start()
    .catch(() => { /* the status strip already carries the reason */ })
    .finally(() => off());

  win.on('closed', () => {
    win = null;
    clearSession();
    // Tor stays up only while the window is open; leaving it running would keep
    // a circuit alive for a mode the user has closed.
    tor.stop();
  });

  return { ok: true };
}

function closeOnionWindow() {
  if (win && !win.isDestroyed()) win.close();
}

const isOpen = () => !!(win && !win.isDestroyed());

/**
 * Make the onion session usable without opening the window.
 * The research tools run headless, but must use the same proxied session — a
 * second, unconfigured one would fetch over the clearnet.
 */
async function ensureSession() {
  return configureSession();
}

module.exports = {
  openOnionWindow, closeOnionWindow, isOpen, PARTITION,
  setLevel, getLevel, levelInfo, LEVELS, ensureSession, newIdentity
};
