// =============================================================================
// Local Mind Browser — Task manager
// =============================================================================
// Which tab is eating the battery. Chrome has had this since forever and it is
// the only honest answer to "why is my fan on" — the alternative is closing
// tabs at random until it stops.
//
// `app.getAppMetrics()` reports one row per OS process with CPU and memory.
// Turning that into something a person can act on means mapping each renderer
// process back to the tab living in it, which the process reports as its own
// pid on the webContents. Processes with no tab (the GPU, the network service,
// extensions) are still listed, because "the GPU process is using 40%" is
// itself the answer often enough to be worth showing.

const { app, ipcMain, webContents, BrowserWindow } = require('electron');

const TYPE_LABELS = {
  Browser: 'Browser (main process)',
  GPU: 'GPU process',
  Utility: 'Utility',
  Zygote: 'Zygote',
  Sandbox: 'Sandbox helper',
  'Pepper Plugin': 'Plugin',
  Unknown: 'Unknown'
};

/** Everything the renderer needs to draw one row, already sorted. */
function snapshot() {
  const metrics = app.getAppMetrics();

  // pid -> the pages living in it. A single renderer process can host more
  // than one tab when Chromium decides they can share.
  const pages = new Map();
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    let pid;
    try { pid = wc.getOSProcessId(); } catch { continue; }
    if (!pid) continue;

    let label = null;
    const type = wc.getType();
    if (type === 'webview') {
      let host = '';
      try { host = new URL(wc.getURL()).hostname.replace(/^www\./, ''); } catch { /* about:blank */ }
      label = wc.getTitle() || host || 'Tab';
    } else if (type === 'window') {
      label = 'Browser interface';
    } else if (type === 'browserView' || type === 'remote') {
      label = wc.getTitle() || type;
    }
    if (!label) continue;

    if (!pages.has(pid)) pages.set(pid, []);
    pages.get(pid).push({ id: wc.id, label, type });
  }

  const rows = metrics.map((m) => {
    const owned = pages.get(m.pid) || [];
    const name = owned.length
      ? owned.map((o) => o.label).join(', ')
      : (TYPE_LABELS[m.type] || m.type || 'Process');

    return {
      pid: m.pid,
      name,
      kind: owned.length ? 'tab' : 'system',
      // Chromium reports CPU as a percentage of ONE core, so a busy process can
      // legitimately exceed 100 on a multi-core machine. Passed through as-is
      // rather than normalised, which is what Activity Monitor shows too.
      cpu: Math.round((m.cpu?.percentCPUUsage || 0) * 10) / 10,
      memoryKb: m.memory?.workingSetSize || 0,
      // Only tabs can be closed from here; killing the GPU process from a menu
      // would be a way to break the window with one click.
      contentsIds: owned.filter((o) => o.type === 'webview').map((o) => o.id)
    };
  });

  rows.sort((a, b) => b.memoryKb - a.memoryKb);
  return rows;
}

function registerTaskManagerHandlers() {
  ipcMain.handle('tasks:list', () => {
    try { return { ok: true, rows: snapshot() }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // Closing the tab rather than killing the process: a killed renderer leaves
  // an empty tab behind, which looks like a crash rather than something the
  // user asked for.
  ipcMain.handle('tasks:close', (_event, contentsId) => {
    try {
      const wc = webContents.fromId(contentsId);
      if (!wc || wc.isDestroyed()) return { ok: true };
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) win.webContents.send('close-tab-by-contents-id', contentsId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerTaskManagerHandlers, snapshot };
