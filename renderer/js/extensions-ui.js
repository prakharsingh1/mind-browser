// =============================================================================
// Local Mind Browser — Extensions UI
// =============================================================================
// Drives the toolbar Extensions button: a popover listing installed
// extensions (with remove) and a shortcut to the Chrome Web Store.

const ExtensionsUI = (() => {
  const STORE_URL = 'https://chromewebstore.google.com/';

  function init() {
    const btn = document.getElementById('btn-extensions');
    const popover = document.getElementById('ext-popover');
    const storeBtn = document.getElementById('ext-store-btn');
    if (!btn || !popover) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = popover.style.display === 'block';
      if (open) { popover.style.display = 'none'; return; }
      popover.style.display = 'block';
      renderList();
    });

    // Close when clicking elsewhere
    document.addEventListener('click', (e) => {
      if (popover.style.display === 'block' && !popover.contains(e.target) && e.target !== btn) {
        popover.style.display = 'none';
      }
    });

    if (storeBtn) {
      storeBtn.addEventListener('click', () => {
        popover.style.display = 'none';
        TabManager.createTab(STORE_URL, true);
      });
    }
  }

  async function renderList() {
    const list = document.getElementById('ext-list');
    if (!list) return;
    let exts = [];
    if (window.localMind?.listExtensions) {
      try { exts = await window.localMind.listExtensions(); } catch (e) {}
    }

    if (!exts.length) {
      list.innerHTML = `<div style="padding:16px 8px; text-align:center; font-size:12px; color:var(--text-tertiary);">
        No extensions installed.<br>Open the Web Store to add some.</div>`;
      return;
    }

    list.innerHTML = '';
    exts.forEach((ext) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:8px; border-radius:var(--radius-md);';
      row.innerHTML = `
        <div style="flex:1; min-width:0;">
          <div style="font-size:12px; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(ext.name)}</div>
          <div style="font-size:10px; color:var(--text-tertiary);">v${escapeHtml(ext.version || '')}</div>
        </div>
        <button class="ext-remove-btn" data-id="${ext.id}" title="Remove"
          style="font-size:11px; color:var(--error); background:none; border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:3px 8px; cursor:pointer;">Remove</button>
      `;
      row.querySelector('.ext-remove-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (window.localMind?.removeExtension) {
          await window.localMind.removeExtension(ext.id);
          renderList();
        }
      });
      list.appendChild(row);
    });
  }

  return { init };
})();
