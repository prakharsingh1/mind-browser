// =============================================================================
// Local Mind Browser — Notes
// =============================================================================
// A lightweight notes app: searchable list on the left, editor on the right.
// All state lives in NotesStore, so edits here show up in the New Tab widget
// immediately and vice-versa.

const NotesPage = (() => {
  let built = false;
  let activeId = null;
  let query = '';
  let sort = 'updated';
  let saveTimer = null;

  const $ = (id) => document.getElementById(id);
  const page = () => $('notes-page');

  function init() {
    // Selecting a tab means the user wants to browse — step out of the way.
    // (Same contract every other full-page view here follows.)
    EventBus.on('tab-activated', hide);
    EventBus.on('leave-page-views', hide);

    // Re-render the list when the widget (or anything else) changes a note,
    // but never yank the editor out from under the user mid-typing.
    EventBus.on('notes-changed', () => {
      if (page()?.style.display === 'flex' && !isEditorFocused()) renderList();
      updateSidebarCount();
    });
    updateSidebarCount();
  }

  const isEditorFocused = () => document.activeElement === $('notes-editor');

  function updateSidebarCount() {
    const el = $('notes-count');
    if (!el) return;
    const n = NotesStore.count();
    el.textContent = n ? String(n) : '';
  }

  // ── Shell ──────────────────────────────────────────────────────────────────
  function build() {
    if (built) return;
    built = true;
    page().innerHTML = `
      <div class="notes-sidebar">
        <div class="notes-head">
          <h2>Notes</h2>
          <button class="notes-new" id="notes-new" title="New note (⌘N)">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
              <path d="M8 3.5v9M3.5 8h9"/>
            </svg>
          </button>
        </div>
        <div class="notes-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>
          </svg>
          <input type="text" id="notes-search" placeholder="Search notes" spellcheck="false">
        </div>
        <div class="notes-sortbar" id="notes-sortbar">
          <button data-sort="updated" class="active">Recent</button>
          <button data-sort="alpha">A–Z</button>
          <button data-sort="pinned">Pinned</button>
        </div>
        <div class="notes-list" id="notes-list"></div>
      </div>
      <div class="notes-detail" id="notes-detail"></div>`;

    $('notes-new').addEventListener('click', () => {
      const note = NotesStore.create('');
      open(note.id);
      renderList();
      setTimeout(() => $('notes-editor')?.focus(), 40);
    });

    const search = $('notes-search');
    search.addEventListener('input', () => { query = search.value; renderList(); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { search.value = ''; query = ''; renderList(); }
    });

    $('notes-sortbar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sort]');
      if (!btn) return;
      sort = btn.dataset.sort;
      $('notes-sortbar').querySelectorAll('button')
        .forEach(b => b.classList.toggle('active', b === btn));
      renderList();
    });
  }

  // ── List ───────────────────────────────────────────────────────────────────
  function renderList() {
    const box = $('notes-list');
    if (!box) return;
    const notes = NotesStore.list({ query, sort });

    if (!notes.length) {
      box.innerHTML = query
        ? `<div class="notes-empty">
             <p class="notes-empty-title">No matches</p>
             <p class="notes-empty-sub">Nothing here for “${escapeHtml(query)}”.</p>
           </div>`
        : `<div class="notes-empty">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
               <rect x="4" y="3" width="16" height="18" rx="2.5"/>
               <path d="M8 8h8M8 12h8M8 16h4"/>
             </svg>
             <p class="notes-empty-title">No notes yet</p>
             <p class="notes-empty-sub">Create your first note.</p>
             <button class="notes-empty-btn" id="notes-empty-new">New note</button>
           </div>`;
      $('notes-empty-new')?.addEventListener('click', () => $('notes-new').click());
      if (!notes.length && !query) renderDetail(null);
      return;
    }

    box.innerHTML = '';
    notes.forEach((n) => {
      const row = document.createElement('div');
      row.className = `notes-row${n.id === activeId ? ' active' : ''}`;
      row.innerHTML = `
        <div class="notes-row-main">
          <div class="notes-row-title">
            ${n.pinned ? '<span class="notes-pin-dot" title="Pinned"></span>' : ''}
            ${escapeHtml(NotesStore.titleOf(n))}
          </div>
          <div class="notes-row-sub">
            <span class="notes-row-date">${formatRelativeDate(n.updated)}</span>
            <span class="notes-row-preview">${escapeHtml(NotesStore.previewOf(n)) || 'No additional text'}</span>
          </div>
        </div>`;
      row.addEventListener('click', () => open(n.id));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        rowMenu(e.clientX, e.clientY, n);
      });
      box.appendChild(row);
    });
  }

  function rowMenu(x, y, note) {
    document.querySelector('.ntp-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'ntp-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    [
      { label: note.pinned ? 'Unpin' : 'Pin', act: () => { NotesStore.togglePin(note.id); renderList(); } },
      { label: 'Duplicate', act: () => { const c = NotesStore.create(note.body); open(c.id); renderList(); } },
      { sep: true },
      { label: 'Delete', danger: true, act: () => deleteNote(note.id) }
    ].forEach((it) => {
      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'ntp-menu-sep';
        menu.appendChild(s);
        return;
      }
      const el = document.createElement('div');
      el.className = `ntp-menu-item${it.danger ? ' danger' : ''}`;
      el.textContent = it.label;
      el.addEventListener('click', () => { menu.remove(); it.act(); });
      menu.appendChild(el);
    });
    document.body.appendChild(menu);
    const close = (e) => {
      if (e.type === 'mousedown' && menu.contains(e.target)) return;
      menu.remove();
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
    setTimeout(() => {
      document.addEventListener('mousedown', close);
      document.addEventListener('keydown', close);
    }, 10);
  }

  function deleteNote(id) {
    NotesStore.remove(id);
    if (activeId === id) activeId = null;
    renderList();
    renderDetail(activeId ? NotesStore.get(activeId) : null);
  }

  // ── Editor ─────────────────────────────────────────────────────────────────
  function open(id) {
    activeId = id;
    renderList();
    renderDetail(NotesStore.get(id));
  }

  function renderDetail(note) {
    const box = $('notes-detail');
    if (!box) return;

    if (!note) {
      box.innerHTML = `
        <div class="notes-empty notes-empty-detail">
          <p class="notes-empty-title">Nothing selected</p>
          <p class="notes-empty-sub">Pick a note, or create a new one.</p>
        </div>`;
      return;
    }

    box.innerHTML = `
      <div class="notes-detail-bar">
        <span class="notes-detail-date">Edited ${formatRelativeDate(note.updated)}</span>
        <div class="notes-detail-actions">
          <button class="notes-act${note.pinned ? ' on' : ''}" id="note-pin" title="${note.pinned ? 'Unpin' : 'Pin'}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 2l5 5-3 3-2-1-3 3-1-1-3 3v-2l3-3-1-2 3-3z"/>
            </svg>
          </button>
          <button class="notes-act danger" id="note-delete" title="Delete">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8"/>
            </svg>
          </button>
        </div>
      </div>
      <textarea id="notes-editor" spellcheck="true" placeholder="Start writing…"></textarea>
      <div class="notes-detail-foot">
        <span id="notes-stats"></span>
        <span class="notes-saved" id="notes-saved"></span>
      </div>`;

    const ta = $('notes-editor');
    ta.value = note.body || '';
    stats(ta.value);

    ta.addEventListener('input', () => {
      stats(ta.value);
      const saved = $('notes-saved');
      if (saved) { saved.textContent = 'Saving…'; saved.className = 'notes-saved show'; }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => commit(note.id, ta.value), 400);
    });
    ta.addEventListener('blur', () => { clearTimeout(saveTimer); commit(note.id, ta.value); });

    $('note-pin').addEventListener('click', () => {
      NotesStore.togglePin(note.id);
      renderList();
      renderDetail(NotesStore.get(note.id));
    });
    $('note-delete').addEventListener('click', () => deleteNote(note.id));
  }

  function commit(id, body) {
    const cur = NotesStore.get(id);
    if (!cur || cur.body === body) return;
    NotesStore.update(id, { body });
    const saved = $('notes-saved');
    if (saved) {
      saved.textContent = 'Saved';
      saved.className = 'notes-saved show ok';
      setTimeout(() => { saved.className = 'notes-saved'; }, 1400);
    }
    // Refresh titles/order without stealing focus from the caret.
    renderList();
  }

  function stats(text) {
    const el = $('notes-stats');
    if (!el) return;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    el.textContent = `${words} word${words === 1 ? '' : 's'} · ${text.length} characters`;
  }

  // ── Visibility ─────────────────────────────────────────────────────────────
  function show() {
    build();
    NewsPage?.hide?.();
    FinancePage?.hide?.();
    if (typeof CompanyPage !== 'undefined') CompanyPage.hide();
    if (typeof StoryPage !== 'undefined') StoryPage.hide();
    page().style.display = 'flex';
    document.getElementById('sidebar-notes')?.classList.add('active');

    const notes = NotesStore.list({ sort });
    renderList();
    renderDetail(activeId ? NotesStore.get(activeId) : notes[0] || null);
    if (!activeId && notes[0]) activeId = notes[0].id;
    setTimeout(() => $('notes-search')?.focus(), 60);
  }

  function hide() {
    if (page()) page().style.display = 'none';
    document.getElementById('sidebar-notes')?.classList.remove('active');
  }

  const isOpen = () => page()?.style.display === 'flex';

  function toggle() { isOpen() ? hide() : show(); }

  return { init, show, hide, toggle, isOpen, openNote: open };
})();
