// =============================================================================
// Local Mind Browser — Notes Store
// =============================================================================
// Single source of truth for notes, shared by the Notes page and the New Tab
// widget. Anything that mutates notes goes through here and broadcasts
// 'notes-changed', so both surfaces stay in sync without knowing about
// each other.

const NotesStore = (() => {
  const KEY = 'notes.items';
  const LEGACY_KEY = 'ntp.note';   // the old single-string scratchpad

  let items = null;   // lazily loaded cache

  const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function load() {
    if (items) return items;
    try {
      const raw = localStorage.getItem(KEY);
      items = raw ? JSON.parse(raw) : [];
    } catch { items = []; }
    if (!Array.isArray(items)) items = [];

    // One-time migration: fold the old scratchpad into a real note so nothing
    // the user typed before this existed is lost.
    if (!items.length) {
      try {
        const legacy = localStorage.getItem(LEGACY_KEY);
        const text = legacy ? JSON.parse(legacy) : '';
        if (text && String(text).trim()) {
          items = [{
            id: uid(), body: String(text), pinned: false,
            created: Date.now(), updated: Date.now()
          }];
          persist();
        }
      } catch { /* nothing to migrate */ }
    }
    return items;
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* quota */ }
    try { EventBus.emit('notes-changed'); } catch { /* bus not ready */ }
  }

  /** First non-empty line, used as the display title. */
  function titleOf(note) {
    const line = (note.body || '').split('\n').find(l => l.trim());
    return line ? line.trim().slice(0, 80) : 'Untitled note';
  }

  /** Everything after the title line, for the list preview. */
  function previewOf(note) {
    const lines = (note.body || '').split('\n');
    const i = lines.findIndex(l => l.trim());
    return lines.slice(i + 1).join(' ').trim().slice(0, 140);
  }

  function list({ query = '', sort = 'updated' } = {}) {
    let out = load().slice();

    const q = query.trim().toLowerCase();
    if (q) out = out.filter(n => (n.body || '').toLowerCase().includes(q));

    const byUpdated = (a, b) => (b.updated || 0) - (a.updated || 0);
    if (sort === 'alpha') {
      out.sort((a, b) => titleOf(a).localeCompare(titleOf(b), undefined, { sensitivity: 'base' }));
    } else if (sort === 'pinned') {
      out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || byUpdated(a, b));
    } else {
      out.sort(byUpdated);
    }
    return out;
  }

  const get = (id) => load().find(n => n.id === id) || null;

  function create(body = '') {
    const note = { id: uid(), body, pinned: false, created: Date.now(), updated: Date.now() };
    load().unshift(note);
    persist();
    return note;
  }

  function update(id, patch) {
    const note = get(id);
    if (!note) return null;
    Object.assign(note, patch, { updated: Date.now() });
    persist();
    return note;
  }

  function remove(id) {
    const i = load().findIndex(n => n.id === id);
    if (i < 0) return false;
    items.splice(i, 1);
    persist();
    return true;
  }

  function togglePin(id) {
    const note = get(id);
    if (!note) return null;
    note.pinned = !note.pinned;
    // Pinning isn't an edit — don't let it reshuffle "recently edited".
    persist();
    return note;
  }

  /**
   * The note the New Tab widget writes into: the most recently touched one,
   * created on demand so an empty store doesn't need special-casing.
   */
  function quickNote() {
    const all = list({ sort: 'updated' });
    return all[0] || create('');
  }

  const count = () => load().length;

  return {
    list, get, create, update, remove, togglePin,
    quickNote, count, titleOf, previewOf
  };
})();
