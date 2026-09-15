// =============================================================================
// Local Mind Browser — Reader
// =============================================================================
// Serves the article-extraction library to the renderer, which injects it into
// whatever page is being read.
//
// It lives here rather than in the webview preload because the preload is
// parsed on EVERY page load, and this is ninety kilobytes that almost no page
// will ever need. Reading it once, on demand, and caching the string keeps the
// cost where it belongs — on the reader, not on browsing.

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

let cached = null;

function readerSource() {
  if (cached) return cached;
  const file = path.join(__dirname, '..', 'renderer', 'vendor', 'readability.js');
  cached = fs.readFileSync(file, 'utf8');
  return cached;
}

function registerReaderHandlers() {
  ipcMain.handle('reader:script', () => {
    try {
      return { ok: true, source: readerSource() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerReaderHandlers };
