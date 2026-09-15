// =============================================================================
// Local Mind Browser — Crash Guard
// =============================================================================
// Electron's default for an uncaught exception in the main process is to tear
// the whole application down. For a browser that is the worst possible
// response: one bad IPC payload, one unreadable file, one provider returning
// something unexpected, and every open tab disappears along with whatever the
// user was in the middle of.
//
// So nothing here tries to be clever. It keeps the process alive, writes what
// happened somewhere the user can actually find it, and — for the failures that
// DO leave a window unusable, like a dead renderer — puts it back.
//
// This is a net, not an excuse. Every specific bug it catches should still be
// fixed at the source; the log exists so those bugs are discoverable rather
// than silent.

const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

let logPath = null;
const MAX_LOG_BYTES = 512 * 1024;      // keep it small enough to open and read

function logFile() {
  if (logPath) return logPath;
  try {
    logPath = path.join(app.getPath('userData'), 'crash.log');
  } catch {
    logPath = null;
  }
  return logPath;
}

/** Append one entry, trimming the file if it has grown too large. */
function record(kind, detail) {
  const stamp = new Date().toISOString();
  const entry = `\n[${stamp}] ${kind}\n${detail}\n`;

  // Always to the console: in dev this is the fastest way to see it.
  console.error(entry);

  const file = logFile();
  if (!file) return;
  try {
    // A crash log that grows without bound eventually becomes its own problem.
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        const kept = fs.readFileSync(file, 'utf8').slice(-MAX_LOG_BYTES / 2);
        fs.writeFileSync(file, `[log trimmed]\n${kept}`, 'utf8');
      }
    } catch { /* no existing file, or unreadable — the append below still tries */ }
    fs.appendFileSync(file, entry, 'utf8');
  } catch { /* if we cannot even log, there is nothing further to do */ }
}

const describe = (err) => {
  if (err instanceof Error) return `${err.name}: ${err.message}\n${err.stack || ''}`;
  try { return JSON.stringify(err); } catch { return String(err); }
};

function install() {
  // ── The two that kill the process ────────────────────────────────────────
  process.on('uncaughtException', (err) => {
    record('uncaughtException (main process kept alive)', describe(err));
  });

  process.on('unhandledRejection', (reason) => {
    record('unhandledRejection', describe(reason));
  });

  app.whenReady().then(() => {
    // ── A dead renderer leaves a blank window ──────────────────────────────
    // The process is fine, but the user is staring at nothing, so reload it.
    // Only once per window: a page that crashes on load would otherwise spin.
    const reloaded = new WeakSet();
    app.on('render-process-gone', (_event, contents, details) => {
      record('render-process-gone', `reason=${details.reason} exitCode=${details.exitCode} url=${safeUrl(contents)}`);
      if (details.reason === 'clean-exit' || details.reason === 'killed') return;
      try {
        if (contents.isDestroyed() || reloaded.has(contents)) return;
        reloaded.add(contents);
        contents.reload();
      } catch { /* it is already gone */ }
    });

    // GPU or utility process died. Chromium usually recovers on its own; this
    // is here so a pattern of them is visible in the log.
    app.on('child-process-gone', (_event, details) => {
      record('child-process-gone', `type=${details.type} reason=${details.reason}`);
    });
  }).catch((err) => record('app.whenReady failed', describe(err)));
}

function safeUrl(contents) {
  try { return contents.getURL(); } catch { return '(unavailable)'; }
}

/**
 * Wrap an ipcMain.on listener so a throw inside it cannot kill the process.
 *
 * ipcMain.handle is already safe — a rejection travels back to the caller. The
 * `.on` form is not: it runs on the event loop, so an exception there is
 * uncaught. Sync listeners get a second problem, because a renderer blocked on
 * sendSync waits forever if no returnValue is ever set.
 */
function safeOn(ipcMain, channel, handler, fallbackReturnValue) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      handler(event, ...args);
    } catch (err) {
      record(`ipcMain.on("${channel}") threw`, describe(err));
      // Unblock a synchronous caller rather than leaving its renderer frozen.
      if (fallbackReturnValue !== undefined && event.returnValue === undefined) {
        try { event.returnValue = fallbackReturnValue; } catch { /* async listener */ }
      }
    }
  });
}

/** Show the log location on request — used by the About page. */
function crashLogPath() { return logFile(); }

module.exports = { install, safeOn, record, crashLogPath };
