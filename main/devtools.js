// =============================================================================
// Local Mind Browser — Developer tools
// =============================================================================
// The things people actually reach for while building a site: a reload that
// truly ignores the cache, device and network emulation, a colour-scheme
// override, and a way to turn JavaScript off.
//
// Almost all of it goes through the Chrome DevTools Protocol rather than being
// approximated. Setting `window.innerWidth` or swapping a user-agent string
// only convinces scripts that ask politely; `Emulation.setDeviceMetricsOverride`
// changes what the renderer itself believes, so media queries, `visualViewport`
// and touch detection all agree. That is the difference between emulation a
// developer can trust and a costume.
//
// The debugger is attached lazily and detached when every override is cleared,
// because an attached debugger shows the "is being debugged" banner and has a
// real cost on page performance.

const { ipcMain, webContents, session, BrowserWindow } = require('electron');
const crashGuard = require('./crash-guard');

// Per-webContents record of what is currently overridden, so we know when it is
// safe to detach and so the UI can show the true state after a tab switch.
const overrides = new Map();      // id -> { device, network, colorScheme, jsDisabled }

const DEVICES = {
  'iphone-15':      { width: 393, height: 852,  dpr: 3, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'iphone-se':      { width: 375, height: 667,  dpr: 2, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'pixel-8':        { width: 412, height: 915,  dpr: 2.6, mobile: true,
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36' },
  'ipad':           { width: 820, height: 1180, dpr: 2, mobile: true,
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'laptop':         { width: 1280, height: 800, dpr: 2, mobile: false, ua: null },
  'desktop-1440':   { width: 1440, height: 900, dpr: 2, mobile: false, ua: null }
};

// Throughput in bytes/sec, latency in ms — the same figures DevTools presets use.
const NETWORKS = {
  offline:  { offline: true,  latency: 0,   download: 0,        upload: 0 },
  'slow-3g': { offline: false, latency: 400, download: 400 * 1024 / 8,  upload: 400 * 1024 / 8 },
  'fast-3g': { offline: false, latency: 150, download: 1600 * 1024 / 8, upload: 750 * 1024 / 8 },
  'slow-4g': { offline: false, latency: 60,  download: 4000 * 1024 / 8, upload: 3000 * 1024 / 8 }
};

function contentsFor(id) {
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) throw new Error('that tab is gone');
  return wc;
}

function stateFor(id) {
  if (!overrides.has(id)) {
    overrides.set(id, { device: null, network: null, colorScheme: null, jsDisabled: false });
  }
  return overrides.get(id);
}

/** Attach the debugger only when something actually needs it. */
function attach(wc) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  return wc.debugger;
}

/** Detach once nothing is overridden, so the page stops paying for it. */
function detachIfIdle(wc, state) {
  if (state.device || state.network || state.colorScheme || state.jsDisabled) return;
  try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* already gone */ }
  overrides.delete(wc.id);
}

async function applyDevice(wc, state, name) {
  const dbg = attach(wc);
  if (!name) {
    await dbg.sendCommand('Emulation.clearDeviceMetricsOverride');
    await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false });
    wc.setUserAgent(wc.session.getUserAgent());
    state.device = null;
    return;
  }
  const d = DEVICES[name];
  if (!d) throw new Error(`unknown device "${name}"`);

  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: d.width, height: d.height,
    deviceScaleFactor: d.dpr, mobile: d.mobile
  });
  // Without touch emulation a "mobile" viewport still reports no touch points,
  // and every script that feature-detects touch takes the desktop branch.
  await dbg.sendCommand('Emulation.setTouchEmulationEnabled', {
    enabled: d.mobile, maxTouchPoints: d.mobile ? 5 : 0
  });
  if (d.ua) wc.setUserAgent(d.ua);
  state.device = name;
}

async function applyNetwork(wc, state, name) {
  const dbg = attach(wc);
  await dbg.sendCommand('Network.enable');
  const n = name ? NETWORKS[name] : null;
  if (name && !n) throw new Error(`unknown network profile "${name}"`);

  await dbg.sendCommand('Network.emulateNetworkConditions', n
    ? { offline: n.offline, latency: n.latency, downloadThroughput: n.download, uploadThroughput: n.upload }
    : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  state.network = name || null;
}

async function applyColorScheme(wc, state, scheme) {
  const dbg = attach(wc);
  await dbg.sendCommand('Emulation.setEmulatedMedia', {
    media: '',
    features: scheme ? [{ name: 'prefers-color-scheme', value: scheme }] : []
  });
  state.colorScheme = scheme || null;
}

async function applyJs(wc, state, disabled) {
  const dbg = attach(wc);
  await dbg.sendCommand('Emulation.setScriptExecutionDisabled', { value: Boolean(disabled) });
  state.jsDisabled = Boolean(disabled);
}

function registerDevHandlers() {
  ipcMain.handle('dev:command', async (_event, { id, action, value }) => {
    try {
      const wc = contentsFor(id);
      const state = stateFor(id);

      switch (action) {
        case 'hard-reload':
          // Not reload(): that will happily serve the page out of cache again.
          wc.reloadIgnoringCache();
          break;

        case 'empty-cache-reload':
          await wc.session.clearCache();
          wc.reloadIgnoringCache();
          break;

        case 'devtools':
          if (wc.isDevToolsOpened()) wc.closeDevTools();
          else wc.openDevTools({ mode: 'detach' });
          break;

        case 'view-source': {
          const url = wc.getURL();
          if (!/^https?:/i.test(url)) throw new Error('only http and https pages have a source view');
          const win = BrowserWindow.getFocusedWindow();
          win?.webContents.send('dev-open-tab', `view-source:${url}`);
          break;
        }

        case 'device':       await applyDevice(wc, state, value); break;
        case 'network':      await applyNetwork(wc, state, value); break;
        case 'color-scheme': await applyColorScheme(wc, state, value); break;
        case 'js':           await applyJs(wc, state, value); break;

        case 'clear-site-data': {
          const origin = new URL(wc.getURL()).origin;
          await wc.session.clearStorageData({ origin });
          await wc.session.clearCache();
          wc.reloadIgnoringCache();
          break;
        }

        case 'reset': {
          await applyDevice(wc, state, null);
          await applyNetwork(wc, state, null);
          await applyColorScheme(wc, state, null);
          await applyJs(wc, state, false);
          break;
        }

        default:
          throw new Error(`unknown developer action "${action}"`);
      }

      detachIfIdle(wc, state);
      return { ok: true, state: overrides.get(id) || stateFor(id) };
    } catch (err) {
      crashGuard.record('dev:command failed', `${action}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('dev:state', (_event, id) => {
    const s = overrides.get(id);
    return s || { device: null, network: null, colorScheme: null, jsDisabled: false };
  });

  ipcMain.handle('dev:devices', () => ({
    devices: Object.entries(DEVICES).map(([id, d]) => ({ id, width: d.width, height: d.height, mobile: d.mobile })),
    networks: Object.keys(NETWORKS)
  }));
}

module.exports = { registerDevHandlers };
