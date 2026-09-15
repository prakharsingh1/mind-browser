// =============================================================================
// Local Mind Browser — Downloads UI
// =============================================================================
// Chrome-style download bubble: a toolbar button with live progress, and a
// popover listing active + past downloads (open, show in Finder, pause,
// cancel, clear). Files land in the user's real ~/Downloads folder — the
// main-process side lives in main/downloads.js.

const Downloads = (() => {
  let panel = null;
  let items = new Map();     // id → meta (active + history, newest first order kept in render)
  let order = [];            // ids, newest first
  const rowEls = new Map();  // id → row element
  let unseenDone = false;    // a download finished while the panel was closed

  function init() {
    document.getElementById('btn-downloads')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });

    window.localMind?.onDownloadEvent?.((evt) => {
      const meta = evt.item;
      const isNew = !items.has(meta.id);
      items.set(meta.id, meta);
      if (isNew) order.unshift(meta.id);

      if (evt.kind === 'started') {
        open();                      // Chrome behavior: surface the bubble
        TabManager.recoverDownloadTab(meta.url);
      } else if (evt.kind === 'done' && !isOpen()) {
        unseenDone = true;
      }
      updateButton();
      if (isOpen()) renderRow(meta);
    });

    // Load persisted history so the panel is populated after restart
    window.localMind?.downloadsList?.().then(({ active, history }) => {
      [...active, ...history].forEach((m) => {
        if (!items.has(m.id)) { items.set(m.id, m); order.push(m.id); }
      });
      updateButton();
    }).catch(() => {});
  }

  const isOpen = () => !!panel;

  function toggle() { isOpen() ? close() : open(); }

  function open() {
    if (isOpen()) { renderAll(); return; }
    unseenDone = false;
    updateButton();

    panel = document.createElement('div');
    panel.id = 'downloads-panel';
    panel.innerHTML = `
      <div class="dl-head">
        <span>Downloads</span>
        <div class="dl-head-actions">
          <button class="dl-link" id="dl-open-folder">Open folder</button>
          <button class="dl-link" id="dl-clear">Clear</button>
        </div>
      </div>
      <div class="dl-list" id="dl-list"></div>`;
    document.body.appendChild(panel);

    panel.querySelector('#dl-open-folder').addEventListener('click', () => {
      window.localMind?.downloadsOpenFolder?.();
    });
    panel.querySelector('#dl-clear').addEventListener('click', async () => {
      await window.localMind?.downloadsClear?.();
      // Keep in-flight downloads, drop finished ones
      order = order.filter((id) => items.get(id)?.state === 'progressing' || items.get(id)?.state === 'interrupted');
      for (const [id] of items) {
        if (!order.includes(id)) items.delete(id);
      }
      renderAll();
    });

    renderAll();

    const closeOnOutside = (e) => {
      if (panel && !panel.contains(e.target) && !e.target.closest('#btn-downloads')) close();
    };
    const closeOnEsc = (e) => { if (e.key === 'Escape') close(); };
    panel._cleanup = () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEsc);
    };
    setTimeout(() => {
      document.addEventListener('mousedown', closeOnOutside);
      document.addEventListener('keydown', closeOnEsc);
    }, 10);
  }

  function close() {
    panel?._cleanup?.();
    panel?.remove();
    panel = null;
    rowEls.clear();
  }

  // ── Rendering ──

  function renderAll() {
    const list = panel?.querySelector('#dl-list');
    if (!list) return;
    rowEls.clear();
    list.innerHTML = '';
    if (!order.length) {
      list.innerHTML = '<div class="dl-empty">No downloads yet</div>';
      return;
    }
    order.forEach((id) => {
      const meta = items.get(id);
      if (meta) list.appendChild(buildRow(meta));
    });
  }

  function renderRow(meta) {
    const list = panel?.querySelector('#dl-list');
    if (!list) return;
    list.querySelector('.dl-empty')?.remove();
    const existing = rowEls.get(meta.id);
    if (existing) {
      updateRow(existing, meta);
    } else {
      list.prepend(buildRow(meta));
    }
  }

  function buildRow(meta) {
    const row = document.createElement('div');
    row.className = 'dl-row';
    row.dataset.id = meta.id;
    row.innerHTML = `
      <span class="dl-icon">${fileIcon(meta.filename)}</span>
      <div class="dl-main">
        <div class="dl-name" title=""></div>
        <div class="dl-bar"><div class="dl-bar-fill"></div></div>
        <div class="dl-sub"></div>
      </div>
      <div class="dl-actions"></div>`;

    row.querySelector('.dl-name').textContent = meta.filename;
    row.querySelector('.dl-name').title = meta.filename;

    // Clicking a completed row opens the file
    row.addEventListener('click', (e) => {
      if (e.target.closest('.dl-actions')) return;
      const m = items.get(meta.id);
      if (m?.state === 'completed') window.localMind?.downloadOpen?.(m.id);
    });

    rowEls.set(meta.id, row);
    updateRow(row, meta);
    return row;
  }

  function updateRow(row, meta) {
    const bar = row.querySelector('.dl-bar');
    const fill = row.querySelector('.dl-bar-fill');
    const sub = row.querySelector('.dl-sub');
    const actions = row.querySelector('.dl-actions');

    row.classList.toggle('dl-done', meta.state === 'completed');
    row.classList.toggle('dl-failed', meta.state === 'cancelled' || meta.state === 'interrupted');

    if (meta.state === 'progressing') {
      const pct = meta.totalBytes > 0 ? Math.round((meta.receivedBytes / meta.totalBytes) * 100) : null;
      bar.style.display = '';
      fill.style.width = pct == null ? '100%' : pct + '%';
      fill.classList.toggle('dl-indeterminate', pct == null);
      sub.textContent = meta.paused
        ? `Paused — ${fmtBytes(meta.receivedBytes)}${meta.totalBytes ? ' of ' + fmtBytes(meta.totalBytes) : ''}`
        : `${fmtBytes(meta.receivedBytes)}${meta.totalBytes ? ' of ' + fmtBytes(meta.totalBytes) : ''}`;
      setActions(actions, [
        meta.paused
          ? { label: 'Resume', act: () => window.localMind?.downloadResume?.(meta.id) }
          : { label: 'Pause', act: () => window.localMind?.downloadPause?.(meta.id) },
        { label: 'Cancel', danger: true, act: () => window.localMind?.downloadCancel?.(meta.id) }
      ]);
    } else if (meta.state === 'completed') {
      bar.style.display = 'none';
      sub.textContent = `${fmtBytes(meta.receivedBytes)} — Done`;
      // A downloaded PDF should not have to leave the browser to be read. The
      // built-in viewer handles it, and the editor is one more click away.
      const acts = [];
      if (/\.pdf$/i.test(meta.filename || '') && meta.path) {
        const fileUrl = pathToFileUrl(meta.path);
        acts.push({ label: 'Open here', act: () => { TabManager.createTab(fileUrl, true); close(); } });
        acts.push({ label: 'Edit', act: () => { App.openPdfEditor(fileUrl); close(); } });
      }
      acts.push({ label: 'Show in Finder', act: () => window.localMind?.downloadShow?.(meta.id) });
      setActions(actions, acts);
    } else {
      bar.style.display = 'none';
      sub.textContent = meta.state === 'cancelled' ? 'Cancelled' : 'Failed';
      setActions(actions, []);
    }
  }

  /** file:// URL for a local path, with the characters that would break it escaped. */
  function pathToFileUrl(p) {
    return 'file://' + String(p).split('/').map(encodeURIComponent).join('/');
  }

  function setActions(container, defs) {
    const key = defs.map(d => d.label).join('|');
    if (container.dataset.key === key) return;
    container.dataset.key = key;
    container.innerHTML = '';
    defs.forEach((d) => {
      const b = document.createElement('button');
      b.className = 'dl-link' + (d.danger ? ' dl-danger' : '');
      b.textContent = d.label;
      b.addEventListener('click', (e) => { e.stopPropagation(); d.act(); });
      container.appendChild(b);
    });
  }

  // ── Toolbar button state ──

  function updateButton() {
    const ring = document.getElementById('dl-progress-ring');
    const badge = document.getElementById('dl-badge');
    if (!ring || !badge) return;

    const activeMetas = [...items.values()].filter(m => m.state === 'progressing');
    if (activeMetas.length) {
      const total = activeMetas.reduce((s, m) => s + (m.totalBytes || 0), 0);
      const recv = activeMetas.reduce((s, m) => s + (m.receivedBytes || 0), 0);
      const pct = total > 0 ? Math.max(4, Math.round((recv / total) * 100)) : 30;
      ring.style.display = 'block';
      ring.style.background = `conic-gradient(var(--accent) ${pct * 3.6}deg, var(--border-color) 0deg)`;
    } else {
      ring.style.display = 'none';
    }
    badge.style.display = unseenDone ? 'block' : 'none';
  }

  // ── Helpers ──

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
    return n + ' B';
  }

  function fileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const kind =
      ['png','jpg','jpeg','gif','webp','svg','heic'].includes(ext) ? 'img' :
      ['mp4','mov','mkv','webm','avi'].includes(ext) ? 'video' :
      ['mp3','wav','flac','m4a','ogg'].includes(ext) ? 'audio' :
      ['zip','gz','tar','rar','7z','dmg','pkg'].includes(ext) ? 'archive' :
      ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md'].includes(ext) ? 'doc' : 'file';
    const paths = {
      img: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.5" cy="6.5" r="1"/><path d="M2 11l3.5-3 3 2.5L11 8l3 3"/>',
      video: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6.5 6l3.5 2-3.5 2V6z"/>',
      audio: '<path d="M6 12V4l7-1.5V10"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="10" r="1.5"/>',
      archive: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M8 2.5v11M6 5h4M6 8h4"/>',
      doc: '<path d="M4 1.5h5L13 5.5V14a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 4 14V1.5z"/><path d="M9 1.5V6h4"/>',
      file: '<path d="M4 1.5h5L13 5.5V14a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 4 14V1.5z"/>'
    };
    return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${paths[kind]}</svg>`;
  }

  return { init, toggle, open, close };
})();
