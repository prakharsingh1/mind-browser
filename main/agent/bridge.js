// =============================================================================
// Local Mind Browser — Agent ⇄ Renderer Bridge
// =============================================================================
// Request/response IPC for tools that need the renderer (webviews live there).
//
// The previous agent fired one-way IPC and slept a fixed delay, so a "read the
// page" step reported success while returning nothing — the model then
// "analyzed" content it never received. Every call here is correlated by id and
// resolves with the renderer's actual result (or a timeout error).

let getWindow = () => null;
const pending = new Map();   // id → { resolve, timer, timeout }
let seq = 0;

function initBridge(ipcMain, windowGetter) {
  getWindow = windowGetter;

  // A tool that stops to ask the user can sit there for minutes. Without this
  // the call hit its deadline, the agent assumed failure and retried — putting
  // a second confirmation on screen while the first was still waiting.
  ipcMain.on('agent:timeout-hold', (_e, { id }) => {
    const entry = pending.get(id);
    if (entry) clearTimeout(entry.timer);
  });

  ipcMain.on('agent:timeout-release', (_e, { id }) => {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      pending.delete(id);
      entry.resolve({ ok: false, error: `timeout after ${Math.round(entry.timeout / 1000)}s` });
    }, entry.timeout);
  });

  ipcMain.on('agent:result', (_e, { id, ok, data, error }) => {
    const entry = pending.get(id);
    if (!entry) return;                    // late reply after timeout
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(ok ? { ok: true, data } : { ok: false, error: error || 'failed' });
  });
}

/**
 * Ask the renderer to perform `action` and wait for its result.
 * @returns {Promise<{ok:boolean, data?:any, error?:string}>}
 */
function callRenderer(action, params = {}, timeout = 30000) {
  const win = getWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return Promise.resolve({ ok: false, error: 'browser-window-unavailable' });
  }
  const id = `ag${Date.now().toString(36)}${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `timeout after ${Math.round(timeout / 1000)}s` });
    }, timeout);
    pending.set(id, { resolve, timer, timeout });
    win.webContents.send('agent:call', { id, action, params });
  });
}

module.exports = { initBridge, callRenderer };
