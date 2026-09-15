// =============================================================================
// Local Mind Browser — PDF load / save
// =============================================================================
// The editor page runs on a file:// origin, so it cannot fetch an https PDF
// itself — every remote document would be blocked by CORS, and a local one by
// the file:// sandbox. The main process has no such limits, so it does the I/O
// and hands the bytes over.
//
// Saving goes through a real save dialog rather than the download folder: an
// edited document is the user's work, and they should choose where it lands and
// see that it landed.

const { ipcMain, dialog, net, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const MAX_BYTES = 300 * 1024 * 1024;      // refuse absurd files rather than OOM

/** Read a PDF from disk or the network into a Buffer. */
function loadBytes(src) {
  return new Promise((resolve, reject) => {
    if (!src) return reject(new Error('no source given'));

    // Local file, either as a path or a file:// URL.
    if (src.startsWith('file://') || path.isAbsolute(src)) {
      try {
        const file = src.startsWith('file://') ? fileURLToPath(src) : src;
        const stat = fs.statSync(file);
        if (stat.size > MAX_BYTES) return reject(new Error('that PDF is too large to open'));
        return resolve(fs.readFileSync(file));
      } catch (err) {
        return reject(new Error(`could not read the file (${err.message})`));
      }
    }

    const req = net.request({ url: src, method: 'GET', redirect: 'follow' });
    const chunks = [];
    let size = 0;
    let contentType = '';

    req.on('response', (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`the server returned HTTP ${res.statusCode}`));
      }
      // Kept so a non-PDF response can name itself in the error below.
      contentType = String(res.headers['content-type'] || res.headers['Content-Type'] || '');
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          try { req.abort(); } catch {}
          return reject(new Error('that PDF is too large to open'));
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // A login wall, a consent interstitial or a bot check answers with 200
        // and a page of HTML. Letting that through means the parser reports
        // "Invalid PDF structure", which tells the user nothing about what
        // actually happened.
        if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
          const looksHtml = /^\s*<(!doctype|html)/i.test(buf.subarray(0, 200).toString('latin1'));
          return reject(new Error(
            looksHtml
              ? 'that address returned a web page, not a PDF — it may need you to sign in first'
              : `that address did not return a PDF (${contentType || 'unknown type'}, ${buf.length} bytes)`
          ));
        }
        resolve(buf);
      });
      res.on('error', reject);
    });
    req.on('error', (err) => reject(new Error(`could not download it (${err.message})`)));
    req.end();
  });
}

/** A sensible default filename for the save dialog. */
function suggestName(src) {
  try {
    const base = src.startsWith('file://')
      ? path.basename(fileURLToPath(src))
      : path.basename(new URL(src).pathname);
    const name = decodeURIComponent(base || 'document.pdf');
    return /\.pdf$/i.test(name) ? name.replace(/\.pdf$/i, ' (edited).pdf') : `${name} (edited).pdf`;
  } catch {
    return 'document (edited).pdf';
  }
}

function registerPdfHandlers() {
  ipcMain.handle('pdf:load', async (_e, src) => {
    try {
      const buf = await loadBytes(src);
      // Transferring as a plain array keeps this working across the context
      // bridge, which does not pass Buffers through intact.
      return { ok: true, bytes: Array.from(buf), name: suggestName(src) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // `overwrite` is a path the renderer already knows to be the document's own
  // file. It only ever arrives when the user picked "Save" over "Save a copy",
  // and it skips the dialog — that is the whole point of the distinction.
  ipcMain.handle('pdf:save', async (event, { bytes, name, overwrite }) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
      let filePath = overwrite || null;

      if (!filePath) {
        const picked = await dialog.showSaveDialog(win, {
          title: 'Save PDF',
          defaultPath: name || 'document.pdf',
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        });
        if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
        filePath = picked.filePath;
      }

      // Write to a sibling then rename: a failure part-way through must not
      // leave a truncated file where the user's document used to be. This
      // matters most for the overwrite path, where the target IS the original.
      const tmp = `${filePath}.saving`;
      fs.writeFileSync(tmp, Buffer.from(bytes));
      fs.renameSync(tmp, filePath);

      return { ok: true, path: filePath, url: pathToFileURL(filePath).toString() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Export ────────────────────────────────────────────────────────────────
  // One converted file (PPTX, DOCX, a single page image, plain text).
  ipcMain.handle('file:saveAs', async (event, { bytes, name, extension, label }) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: `Export ${label || extension.toUpperCase()}`,
        defaultPath: name,
        filters: [{ name: label || extension.toUpperCase(), extensions: [extension] }]
      });
      if (canceled || !filePath) return { ok: false, cancelled: true };

      const tmp = `${filePath}.saving`;
      fs.writeFileSync(tmp, Buffer.from(bytes));
      fs.renameSync(tmp, filePath);
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // A page-per-image export is many files, so it asks for a folder once rather
  // than opening a save dialog per page.
  ipcMain.handle('file:saveMany', async (event, { files, folderName }) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Choose where to put the exported pages',
        properties: ['openDirectory', 'createDirectory']
      });
      if (canceled || !filePaths?.length) return { ok: false, cancelled: true };

      // Everything lands in its own subfolder; dropping 200 PNGs loose into
      // someone's Documents folder would be hostile.
      let dir = path.join(filePaths[0], folderName || 'Exported pages');
      let n = 2;
      while (fs.existsSync(dir)) dir = path.join(filePaths[0], `${folderName} ${n++}`);
      fs.mkdirSync(dir, { recursive: true });

      for (const f of files) {
        // Names are generated here, but guard anyway — a path separator in a
        // filename must never let a write escape the chosen folder.
        const safe = path.basename(String(f.name));
        fs.writeFileSync(path.join(dir, safe), Buffer.from(f.bytes));
      }
      return { ok: true, path: dir, count: files.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('pdf:reveal', (_e, filePath) => {
    try { shell.showItemInFolder(filePath); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}


/**
 * Route PDFs that are served without a .pdf URL into our own viewer.
 *
 * The renderer already redirects anything whose URL ends in .pdf, but plenty of
 * documents arrive from a path that gives no hint — /download?id=8842 with a
 * Content-Type of application/pdf. Only the response headers know, so this
 * watches for that and tells the renderer which tab to swap.
 *
 * Deliberately advisory: it cannot redirect from here (onHeadersReceived has no
 * redirect), so it reports and lets the renderer decide. That also keeps the
 * user's "use the built-in viewer" preference in one place.
 */
function watchForPdfResponses(ses, getWindow) {
  ses.webRequest.onHeadersReceived((details, callback) => {
    try {
      if (details.resourceType === 'mainFrame') {
        const raw = details.responseHeaders || {};
        const key = Object.keys(raw).find((k) => k.toLowerCase() === 'content-type');
        const type = key ? String(raw[key]).toLowerCase() : '';
        const disposition = Object.keys(raw).find((k) => k.toLowerCase() === 'content-disposition');
        const isAttachment = disposition && /attachment/i.test(String(raw[disposition]));

        // An attachment is a download, not something to display, so leave it be.
        if (type.includes('application/pdf') && !isAttachment) {
          getWindow()?.webContents.send('pdf-detected', {
            url: details.url,
            webContentsId: details.webContentsId
          });
        }
      }
    } catch { /* never let this interfere with the response */ }
    callback({ cancel: false, responseHeaders: details.responseHeaders });
  });
}

module.exports = { registerPdfHandlers, loadBytes, watchForPdfResponses };
