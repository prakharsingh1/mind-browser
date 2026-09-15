// =============================================================================
// Local Mind Browser — Page capture
// =============================================================================
// Three kinds of screenshot, because they answer different questions:
//
//   • Visible area — what is on screen right now.
//   • Full page    — the whole document, however long it is.
//   • Selection    — a region the user drags out.
//
// The full-page one goes through the DevTools Protocol rather than the obvious
// route of scrolling and stitching. `Page.captureScreenshot` with
// `captureBeyondViewport` renders the document at its true height in one pass,
// so nothing is duplicated at the seams, sticky headers do not repeat down the
// image, and lazy-loaded content is not caught half-faded. Stitching looks
// fine on a simple page and falls apart on exactly the pages people want to
// capture.
//
// The debugger is attached only for the moment of the capture and detached
// immediately: leaving it on shows Chromium's "is being debugged" banner and
// slows the page down.

const { ipcMain, webContents, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const crashGuard = require('./crash-guard');

// A very long page at device-pixel-ratio 2 can exceed what Skia will allocate,
// and the failure mode is a blank image rather than an error. Capping the
// height keeps a 40,000px page producing something usable.
const MAX_HEIGHT = 16384;

function contentsFor(id) {
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) throw new Error('that tab is gone');
  return wc;
}

/** Attach, run one command, detach — even if the command throws. */
async function withDebugger(wc, fn) {
  let attachedHere = false;
  if (!wc.debugger.isAttached()) {
    wc.debugger.attach('1.3');
    attachedHere = true;
  }
  try {
    return await fn();
  } finally {
    // Only detach what we attached: the developer tools panel may be using it.
    if (attachedHere) {
      try { wc.debugger.detach(); } catch { /* already gone */ }
    }
  }
}

async function fullPagePng(wc) {
  return withDebugger(wc, async () => {
    await wc.debugger.sendCommand('Page.enable');
    const { cssContentSize, cssVisualViewport } =
      await wc.debugger.sendCommand('Page.getLayoutMetrics');

    const width = Math.ceil(cssContentSize?.width || cssVisualViewport?.clientWidth || 1280);
    const height = Math.min(MAX_HEIGHT, Math.ceil(cssContentSize?.height || 800));

    const { data } = await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 }
    });
    return Buffer.from(data, 'base64');
  });
}

async function visiblePng(wc) {
  const image = await wc.capturePage();
  return image.toPNG();
}

/** A filename that says what it is and when, without colliding. */
function suggestName(wc) {
  let host = 'page';
  try { host = new URL(wc.getURL()).hostname.replace(/^www\./, '') || 'page'; } catch { /* keep default */ }
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    + ` at ${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}.${String(now.getSeconds()).padStart(2, '0')}`;
  return `${host} ${stamp}.png`;
}

function registerCaptureHandlers() {
  ipcMain.handle('capture:page', async (event, { id, mode }) => {
    try {
      const wc = contentsFor(id);
      const png = mode === 'full' ? await fullPagePng(wc) : await visiblePng(wc);

      const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: mode === 'full' ? 'Save full page screenshot' : 'Save screenshot',
        defaultPath: suggestName(wc),
        filters: [{ name: 'PNG image', extensions: ['png'] }]
      });
      if (canceled || !filePath) return { ok: false, cancelled: true };

      // Temp-then-rename, so an interrupted write cannot leave a truncated
      // file where something else used to be.
      const tmp = `${filePath}.saving`;
      fs.writeFileSync(tmp, png);
      fs.renameSync(tmp, filePath);

      return { ok: true, path: filePath, name: path.basename(filePath) };
    } catch (err) {
      crashGuard.record('capture failed', err?.message || String(err));
      return { ok: false, error: err?.message || 'Could not capture the page.' };
    }
  });

  // Copy rather than save — the common case is pasting it straight into a chat.
  ipcMain.handle('capture:copy', async (_event, { id, mode }) => {
    try {
      const { clipboard, nativeImage } = require('electron');
      const wc = contentsFor(id);
      const png = mode === 'full' ? await fullPagePng(wc) : await visiblePng(wc);
      clipboard.writeImage(nativeImage.createFromBuffer(png));
      return { ok: true };
    } catch (err) {
      crashGuard.record('capture-copy failed', err?.message || String(err));
      return { ok: false, error: err?.message || 'Could not copy the screenshot.' };
    }
  });
}

module.exports = { registerCaptureHandlers };
