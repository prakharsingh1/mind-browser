// =============================================================================
// Local Mind Browser — Bookmarks
// =============================================================================
// Bookmarks are a tree of nodes:
//   { type: 'folder', title, children: [...] }  |  { type: 'link', title, url }
// Manages the address-bar star toggle, persistence, browser import (with
// folders preserved), and rendering into the sidebar + bookmarks bar.

const Bookmarks = (() => {
  let tree = [];

  async function init() {
    if (window.localMind?.getBookmarks) {
      try { tree = (await window.localMind.getBookmarks()) || []; } catch { tree = []; }
    }
    if (!Array.isArray(tree)) tree = [];
    if (ensureIds(tree)) persist();
    render();
    updateStar();

    document.getElementById('btn-bookmark')?.addEventListener('click', toggleCurrent);
    EventBus.on('tab-activated', updateStar);
    EventBus.on('tab-title-changed', updateStar);
    EventBus.on('bookmarks-updated', updateStar);
  }

  // Walk every link node in the tree
  function forEachLink(nodes, fn) {
    nodes.forEach((n) => {
      if (n.type === 'folder') forEachLink(n.children || [], fn);
      else if (n.url) fn(n);
    });
  }

  function isBookmarked(url) {
    if (!url) return false;
    let found = false;
    forEachLink(tree, (l) => { if (l.url === url) found = true; });
    return found;
  }

  // Remove every link node matching url (used when un-bookmarking)
  function removeUrl(nodes, url) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.type === 'folder') removeUrl(n.children || [], url);
      else if (n.url === url) nodes.splice(i, 1);
    }
  }

  async function persist() {
    if (window.localMind?.saveBookmarks) {
      try { await window.localMind.saveBookmarks(tree); } catch {}
    }
  }

  // ── Node identity & CRUD (for context-menu operations) ──
  function newId() { return 'bm_' + Math.random().toString(36).slice(2, 9); }

  function ensureIds(nodes) {
    let changed = false;
    const walk = (arr) => arr.forEach((n) => {
      if (!n.id) { n.id = newId(); changed = true; }
      if (n.type === 'folder') walk(n.children || []);
    });
    walk(nodes);
    return changed;
  }

  function findNode(id, nodes = tree, parent = null) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.id === id) return { node: n, arr: nodes, index: i, parent };
      if (n.type === 'folder') {
        const r = findNode(id, n.children || [], n);
        if (r) return r;
      }
    }
    return null;
  }

  function isDescendant(folder, id) {
    return (folder.children || []).some((c) => c.id === id || (c.type === 'folder' && isDescendant(c, id)));
  }

  async function commit() {
    await persist();
    render();
    EventBus.emit('bookmarks-updated', tree);
  }

  async function renameNode(id, title) {
    const r = findNode(id);
    if (!r || !title) return;
    r.node.title = title;
    await commit();
  }

  async function removeNode(id) {
    const r = findNode(id);
    if (!r) return;
    r.arr.splice(r.index, 1);
    await commit();
  }

  async function moveNode(id, targetFolderId) {
    const r = findNode(id);
    if (!r) return;
    if (r.node.type === 'folder' && targetFolderId && (id === targetFolderId || isDescendant(r.node, targetFolderId))) return;
    const [node] = r.arr.splice(r.index, 1);
    if (!targetFolderId) {
      tree.push(node);
    } else {
      const t = findNode(targetFolderId);
      if (t && t.node.type === 'folder') { t.node.children = t.node.children || []; t.node.children.push(node); }
      else tree.push(node);
    }
    await commit();
  }

  async function toggleHidden(id) {
    const r = findNode(id);
    if (!r || r.node.type !== 'folder') return;
    r.node.hidden = !r.node.hidden;
    await commit();
  }

  // Flat list of folders with breadcrumb paths (for the "Move to folder" picker)
  function listFolders() {
    const out = [];
    const walk = (nodes, prefix) => nodes.forEach((n) => {
      if (n.type === 'folder') {
        const p = prefix ? `${prefix} / ${n.title}` : n.title;
        out.push({ id: n.id, title: n.title, path: p, hidden: !!n.hidden });
        walk(n.children || [], p);
      }
    });
    walk(tree, '');
    return out;
  }

  async function toggleCurrent() {
    const tab = TabManager.getActiveTab?.();
    if (!tab || !tab.url) return;
    if (isBookmarked(tab.url)) removeUrl(tree, tab.url);
    else tree.unshift({ type: 'link', title: tab.title || tab.url, url: tab.url, id: newId() });
    await persist();
    render();
    EventBus.emit('bookmarks-updated', tree);
  }

  // Merge an imported tree (from a browser import), de-duping links by URL.
  async function addMany(importedTree) {
    const existing = new Set();
    forEachLink(tree, (l) => existing.add(l.url));

    // Prune already-known links out of the imported nodes, drop empty folders
    function prune(nodes) {
      const out = [];
      nodes.forEach((n) => {
        if (n.type === 'folder') {
          const kids = prune(n.children || []);
          if (kids.length) out.push({ type: 'folder', title: n.title, children: kids });
        } else if (n.url && !existing.has(n.url)) {
          existing.add(n.url);
          out.push({ type: 'link', title: n.title || n.url, url: n.url });
        }
      });
      return out;
    }

    const merged = prune(Array.isArray(importedTree) ? importedTree : []);
    tree.push(...merged);
    ensureIds(tree);
    await persist();
    render();
    EventBus.emit('bookmarks-updated', tree);
  }

  function updateStar() {
    const btn = document.getElementById('btn-bookmark');
    if (!btn) return;
    const tab = TabManager.getActiveTab?.();
    const on = tab && isBookmarked(tab.url);
    btn.classList.toggle('bookmarked', !!on);
    btn.title = on ? 'Remove bookmark' : 'Bookmark this page';
    const svg = btn.querySelector('svg');
    if (svg) svg.setAttribute('fill', on ? 'currentColor' : 'none');
  }

  function render() {
    if (typeof Sidebar !== 'undefined' && Sidebar.loadBookmarks) Sidebar.loadBookmarks(tree);

    // Bookmarks bar: show only top-level links + folder chips
    const bar = document.getElementById('bookmarks-bar');
    if (!bar) return;
    bar.innerHTML = '';
    const topLinks = tree.filter((n) => n.type === 'link');
    const topFolders = tree.filter((n) => n.type === 'folder');
    if (!topLinks.length && !topFolders.length) {
      bar.innerHTML = '<span style="color:var(--text-tertiary);">No bookmarks yet — click the ☆ in the address bar to add this page.</span>';
      return;
    }
    topLinks.slice(0, 30).forEach((bm) => bar.appendChild(barItem(bm)));
    topFolders.slice(0, 12).forEach((f) => {
      const chip = document.createElement('div');
      chip.className = 'bookmark-bar-item';
      chip.title = f.title;
      chip.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:default;white-space:nowrap;padding:2px 6px;border-radius:4px;color:var(--text-secondary);';
      chip.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:13px;height:13px;flex-shrink:0;"><path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4z"/></svg><span>${escapeHtml(truncate(f.title, 18))}</span>`;
      bar.appendChild(chip);
    });
  }

  function barItem(bm) {
    let domain = '';
    try { domain = new URL(bm.url).hostname; } catch {}
    const el = document.createElement('div');
    el.className = 'bookmark-bar-item';
    el.title = bm.url;
    el.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;padding:2px 6px;border-radius:4px;';
    el.innerHTML = `
      <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" style="width:14px;height:14px;flex-shrink:0;" data-on-error="invisible">
      <span>${escapeHtml(truncate(bm.title || bm.url, 22))}</span>`;
    el.addEventListener('click', () => TabManager.navigateTo(bm.url));
    el.addEventListener('mouseenter', () => { el.style.background = 'var(--bg-tertiary)'; });
    el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });
    return el;
  }

  /** Flat list of every bookmark link — used by the omnibox. */
  function listLinks() {
    const out = [];
    forEachLink(tree, (l) => out.push(l));
    return out;
  }

  return {
    init, toggleCurrent, isBookmarked, addMany, getAll: () => tree,
    getTree: () => tree, findNode, renameNode, removeNode, moveNode, toggleHidden, listFolders,
    listLinks
  };
})();
