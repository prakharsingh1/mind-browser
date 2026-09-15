// =============================================================================
// Local Mind Browser — Download Manager (main process)
// =============================================================================
// Intercepts every download (all sessions, including the incognito partition),
// saves to the user's real ~/Downloads folder with filename de-duplication,
// streams progress to the renderer, and persists a bounded history.

const { app, session, shell, dialog, BrowserWindow } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const active = new Map();   // id → { meta, item }
let history = [];           // completed/cancelled items, newest first
const HISTORY_MAX = 100;
let historyPath = '';
let sendToWindow = () => {};
const attached = new WeakSet();

/**
 * Extensions macOS will execute, or that carry an installer payload.
 *
 * Downloading one of these is not itself dangerous — it is running it that is —
 * so this asks rather than blocks, the way every other browser does. The point
 * is that a drive-by download of a .dmg cannot land silently in ~/Downloads
 * looking like something the user asked for.
 */
const EXECUTABLE_EXT = new Set([
  '.dmg', '.pkg', '.mpkg', '.app', '.command', '.sh', '.bash', '.zsh',
  '.scpt', '.scptd', '.workflow', '.action', '.osax', '.kext', '.jar',
  '.exe', '.msi', '.bat', '.cmd', '.scr', '.com', '.vbs', '.ps1', '.deb', '.rpm'
]);

/** "example.com", for telling the user where a file actually came from. */
function shortHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url || 'an unknown site'; }
}

const isExecutable = (name) => EXECUTABLE_EXT.has(path.extname(String(name)).toLowerCase());

/**
 * Mark a downloaded file as having come from the internet.
 *
 * This is the same quarantine flag Safari and Chrome set. Without it Gatekeeper
 * never inspects the file, so an app downloaded through this browser would
 * launch with fewer checks than one downloaded through any other — a real
 * downgrade in the user's protection that they would have no way to notice.
 */
function quarantine(filePath, sourceUrl) {
  if (process.platform !== 'darwin') return;
  // 0181 = QTN_FLAG_DOWNLOAD; then a timestamp, the agent name, and the source.
  const value = `0181;${Math.floor(Date.now() / 1000).toString(16)};Mind Browser;${sourceUrl || ''}`;
  execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, filePath], () => {
    /* best effort: a failure here costs the flag, not the download */
  });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** "file.zip" → "file (1).zip" until the name is free in ~/Downloads. */
function dedupePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n++})${ext}`);
  }
  return candidate;
}

function persistHistory() {
  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify(history.slice(0, HISTORY_MAX)), 'utf-8');
  } catch { /* history is best-effort */ }
}

function publicMeta(meta) {
  // strip nothing today, but keep one place that decides what renderer sees
  return meta;
}

function attach(ses) {
  if (attached.has(ses)) return;
  attached.add(ses);

  ses.on('will-download', (event, item) => {
    const id = uid();
    const suggested = item.getFilename() || 'download';

    if (isExecutable(suggested)) {
      // Synchronous by necessity: once this handler returns, the download is
      // already underway and setSavePath can no longer be called.
      const win = BrowserWindow.getFocusedWindow();
      const choice = dialog.showMessageBoxSync(win || undefined, {
        type: 'warning',
        buttons: ['Cancel', 'Download anyway'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: `${suggested} is an application or installer.`,
        detail: 'Files like this can run code on your Mac. Only keep it if you '
              + 'trust the site you got it from.\n\nFrom: ' + shortHost(item.getURL())
      });
      if (choice !== 1) {
        item.cancel();
        return;
      }
    }

    const savePath = dedupePath(app.getPath('downloads'), suggested);
    item.setSavePath(savePath);

    const meta = {
      id,
      filename: path.basename(savePath),
      path: savePath,
      url: item.getURL(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: 'progressing',
      paused: false,
      startedAt: Date.now()
    };
    active.set(id, { meta, item });
    sendToWindow('download-event', { kind: 'started', item: publicMeta(meta) });

    item.on('updated', (_e, state) => {
      meta.receivedBytes = item.getReceivedBytes();
      meta.totalBytes = item.getTotalBytes();
      meta.paused = item.isPaused();
      meta.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      sendToWindow('download-event', { kind: 'updated', item: publicMeta(meta) });
    });

    item.once('done', (_e, state) => {
      meta.state = state; // 'completed' | 'cancelled' | 'interrupted'
      meta.receivedBytes = item.getReceivedBytes();
      meta.completedAt = Date.now();
      // Tell macOS this came from the internet, so Gatekeeper inspects it the
      // first time it is opened.
      if (state === 'completed') quarantine(savePath, meta.url);
      active.delete(id);
      history.unshift(meta);
      if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
      persistHistory();
      sendToWindow('download-event', { kind: 'done', item: publicMeta(meta) });
    });
  });
}

/**
 * Initialize download handling and IPC.
 * @param {Electron.IpcMain} ipcMain
 * @param {() => Electron.BrowserWindow} getWindow
 */
function initDownloads(ipcMain, getWindow) {
  historyPath = path.join(app.getPath('userData'), 'local-mind-data', 'downloads', 'history.json');
  try { history = JSON.parse(fs.readFileSync(historyPath, 'utf-8')); } catch { history = []; }
  if (!Array.isArray(history)) history = [];

  sendToWindow = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  attach(session.defaultSession);
  // Covers the incognito partition (created lazily) and any future session
  app.on('session-created', (ses) => attach(ses));

  ipcMain.handle('downloads:list', () => ({
    active: [...active.values()].map(({ meta }) => publicMeta(meta)),
    history: history.map(publicMeta)
  }));

  ipcMain.handle('downloads:cancel', (_e, id) => {
    active.get(id)?.item.cancel();
    return { success: true };
  });

  ipcMain.handle('downloads:pause', (_e, id) => {
    active.get(id)?.item.pause();
    return { success: true };
  });

  ipcMain.handle('downloads:resume', (_e, id) => {
    const entry = active.get(id);
    if (entry?.item.canResume()) entry.item.resume();
    return { success: true };
  });

  ipcMain.handle('downloads:open', (_e, id) => {
    const meta = findMeta(id);
    if (meta?.path && fs.existsSync(meta.path)) return shell.openPath(meta.path);
    return 'missing';
  });

  ipcMain.handle('downloads:show', (_e, id) => {
    const meta = findMeta(id);
    if (meta?.path && fs.existsSync(meta.path)) shell.showItemInFolder(meta.path);
    return { success: true };
  });

  ipcMain.handle('downloads:clear', () => {
    history = [];
    persistHistory();
    return { success: true };
  });

  ipcMain.handle('downloads:open-folder', () => {
    shell.openPath(app.getPath('downloads'));
    return { success: true };
  });
}

function findMeta(id) {
  return active.get(id)?.meta || history.find(h => h.id === id) || null;
}

module.exports = { initDownloads };
