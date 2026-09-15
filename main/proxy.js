// =============================================================================
// Local Mind Browser — Proxy / VPN routing
// =============================================================================
// Bring-your-own VPN: route all browser traffic through a SOCKS5 or HTTP proxy
// (your VPN provider's endpoint, a WireGuard/OpenVPN SOCKS bridge, Tor, or an
// SSH tunnel). Applied at the Electron session level, so every tab, webview and
// extension request follows it.
//
// Deliberately NOT a bundled VPN service: shipping one would mean operating
// servers and handling your traffic. This routes through infrastructure you
// already trust and control.

const { session } = require('electron');
const https = require('https');
const { getSettings, saveSettings } = require('./storage');

let current = { enabled: false, mode: 'direct' };

/** Build a Chromium proxy rule string from stored config. */
function ruleFor(cfg) {
  if (!cfg?.host || !cfg?.port) return null;
  const scheme = cfg.type === 'http' ? 'PROXY' : 'SOCKS5';
  return `${scheme} ${cfg.host}:${cfg.port}`;
}

/** Apply (or clear) the proxy on every session the app uses. */
async function apply(cfg) {
  const targets = [session.defaultSession];
  try {
    const priv = session.fromPartition('persist:incognito', { cache: false });
    if (priv) targets.push(priv);
  } catch { /* partition not created yet */ }

  if (!cfg?.enabled) {
    await Promise.all(targets.map((s) => s.setProxy({ mode: 'direct' })));
    current = { enabled: false, mode: 'direct' };
    return { ok: true, enabled: false };
  }

  const rule = ruleFor(cfg);
  if (!rule) return { ok: false, error: 'host and port are required' };

  await Promise.all(targets.map((s) => s.setProxy({
    proxyRules: rule,
    // Keep localhost direct so the app's own local services still work.
    proxyBypassRules: 'localhost,127.0.0.1,<local>'
  })));

  // Credentials, if the proxy needs them, are answered on demand.
  if (cfg.username) {
    const app = require('electron').app;
    app.removeAllListeners('login');
    app.on('login', (event, _wc, _req, authInfo, callback) => {
      if (!authInfo.isProxy) return;
      event.preventDefault();
      callback(cfg.username, cfg.password || '');
    });
  }

  current = { enabled: true, mode: cfg.type || 'socks5', host: cfg.host, port: cfg.port };
  return { ok: true, enabled: true, rule };
}

/** Confirm traffic is actually leaving via the proxy, and report the exit IP. */
function checkIp() {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org?format=json',
      { headers: { 'User-Agent': 'MindBrowser' } },
      (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => {
          try { resolve({ ok: true, ip: JSON.parse(d).ip }); }
          catch { resolve({ ok: false, error: 'unreadable response' }); }
        });
      });
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

function registerProxyHandlers(ipcMain) {
  // Re-apply a saved proxy on launch, so protection survives a restart.
  const saved = getSettings().proxy;
  if (saved?.enabled) apply(saved).catch(() => {});

  ipcMain.handle('proxy:get', () => ({
    config: getSettings().proxy || { enabled: false, type: 'socks5' },
    active: current
  }));

  ipcMain.handle('proxy:set', async (_e, cfg) => {
    const s = getSettings();
    s.proxy = cfg;
    try { saveSettings(s); } catch { /* best effort */ }
    return await apply(cfg);
  });

  ipcMain.handle('proxy:check', () => checkIp());
}

module.exports = { registerProxyHandlers, apply, checkIp };
