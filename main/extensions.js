// =============================================================================
// Local Mind Browser — Chrome Extensions & Web Store
// =============================================================================
// Integrates `electron-chrome-extensions` (extension runtime: content scripts,
// background pages, popups, chrome.* APIs) and `electron-chrome-web-store`
// (installing/updating extensions straight from chromewebstore.google.com).
//
// Tabs in this browser are <webview> guests, so each guest webContents is
// registered with the extension system as a "tab".

const { app, session, webContents, BrowserWindow } = require('electron');
const crashGuard = require('./crash-guard');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, uninstallExtension } = require('electron-chrome-web-store');

let extensions = null;
let fallbackWc = null;   // main-window page, used as the active tab on the NTP
const pendingTabCreates = new Map();

let shuttingDown = false;
app.on('before-quit', () => { shuttingDown = true; });

function getMainWindow() {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;
}

/**
 * Notify the renderer, but only if it's actually still there.
 * These callbacks fire while the app is tearing down (the window's own
 * webContents is registered as the fallback extension tab, so destroying it
 * triggers removeTab). A bare `if (win)` isn't enough — the window object can
 * outlive its webContents, and send() then throws "Object has been destroyed".
 */
function notifyRenderer(channel, payload) {
  if (shuttingDown) return;
  const win = getMainWindow();
  if (!win) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  try { wc.send(channel, payload); } catch { /* renderer went away mid-send */ }
}

// ── Sync setup: must run before the main window loads so the extension-API
//    preload is registered on the session in time for <browser-action-list>. ──
function initExtensions() {
  const ses = session.defaultSession;

  // Required so <browser-action-list> can render extension icons via crx://
  ElectronChromeExtensions.handleCRXProtocol(ses);

  extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: ses,
    createTab: (details) => createTabFromExtension(details),
    selectTab: (tab) => notifyRenderer('ext:activate-tab', tab.id),
    removeTab: (tab) => notifyRenderer('ext:close-tab', tab.id),
    createWindow: async () => getMainWindow(),
    removeWindow: () => {}
  });
  console.log('[extensions] runtime ready (electron-chrome-extensions)');

  // Register every <webview> guest as an extension tab
  app.on('web-contents-created', (_event, wc) => {
    if (wc.getType() !== 'webview') return;
    const win = getMainWindow();
    if (win) {
      try { extensions.addTab(wc, win); } catch (e) { /* window not ready */ }
    }
    wc.once('destroyed', () => {
      try { extensions.removeTab(wc); } catch (e) {}
    });
  });

  // Enable Web Store installs + load already-installed extensions (async).
  installChromeWebStore({
    session: ses,
    allowUnpackedExtensions: true,
    autoUpdate: true
  }).then(() => {
    const count = ses.getAllExtensions().length;
    console.log(`[extensions] web store ready — ${count} extension(s) loaded`);
  }).catch((err) => console.error('[extensions] web store init failed:', err.message));
}

// chrome.tabs.create → ask the renderer to open a webview tab and hand back its
// guest webContents so the extension system can track it.
function createTabFromExtension(details) {
  return new Promise((resolve) => {
    const win = getMainWindow();
    if (shuttingDown || !win || win.webContents.isDestroyed()) return resolve(undefined);

    const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const timer = setTimeout(() => {
      pendingTabCreates.delete(requestId);
      resolve(undefined);
    }, 10000);

    pendingTabCreates.set(requestId, (wcId) => {
      clearTimeout(timer);
      pendingTabCreates.delete(requestId);
      const wc = webContents.fromId(wcId);
      resolve(wc && !wc.isDestroyed() ? [wc, win] : undefined);
    });

    win.webContents.send('ext:create-tab', {
      requestId,
      url: details.url || '',
      active: details.active !== false
    });
  });
}

function registerExtensionIpc(ipcMain) {
  // Renderer tells us which tab is active so chrome.tabs.query({active}) works.
  // A null id means the new-tab page is showing with no webview behind it —
  // fall back to the main window's own page so the extension runtime always has
  // an active tab and popups (translate, etc.) can still open. A real webview
  // overrides this the moment one is activated.
  crashGuard.safeOn(ipcMain, 'ext:select-tab', (_e, wcId) => {
    if (!extensions) return;
    if (wcId == null) {
      const win = getMainWindow();
      if (!win) return;
      const wc = win.webContents;
      if (fallbackWc !== wc) {
        try { extensions.addTab(wc, win); } catch (e) { return; }
        fallbackWc = wc;
        // Drop it before teardown, so destroying the window doesn't fire
        // removeTab back into a renderer that no longer exists.
        win.once('close', () => {
          fallbackWc = null;
          try { extensions.removeTab(wc); } catch { /* already gone */ }
        });
      }
      try { extensions.selectTab(wc); } catch (e) {}
      return;
    }
    const wc = webContents.fromId(wcId);
    if (wc && !wc.isDestroyed()) {
      try { extensions.selectTab(wc); } catch (e) {}
    }
  });

  // Renderer acks a createTab request with the new guest's webContents id
  crashGuard.safeOn(ipcMain, 'ext:tab-created', (_e, payload) => {
    // Destructuring in the parameter list threw on an undefined payload, and a
    // throw in a bare .on listener is an uncaught exception — which ends the
    // whole app over one malformed message.
    const { requestId, webContentsId } = payload || {};
    if (requestId == null) return;
    const cb = pendingTabCreates.get(requestId);
    if (cb) cb(webContentsId);
  });

  ipcMain.handle('ext:list', () => {
    return session.defaultSession.getAllExtensions().map((e) => ({
      id: e.id,
      name: e.name,
      version: e.version,
      description: e.manifest?.description || ''
    }));
  });

  ipcMain.handle('ext:remove', async (_e, id) => {
    try {
      await uninstallExtension(id, { session: session.defaultSession });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { initExtensions, registerExtensionIpc };
