// =============================================================================
// Local Mind Browser — Focus Mode
// =============================================================================
// Hides the sidebar and the top bar so the page gets the entire window. This is
// the thing vertical tabs are really for: no toolbar stealing a strip of screen
// height above every page you read.
//
// The chrome is hidden, not gone. Push the pointer against the top or left edge
// and it slides back for as long as you stay there, so nothing is unreachable
// without remembering a shortcut.

const FocusMode = (() => {
  let on = false;
  let zones = [];

  function toggle() {
    on ? exit() : enter();
  }

  let listeningToPage = false;

  function enter() {
    if (on) return;
    on = true;
    document.body.classList.add('focus-mode');
    zones = [makeZone('top'), makeZone('left')];
    document.addEventListener('keydown', onKey);

    // Escape has to work while you are reading, and reading means the page has
    // focus — at which point the host document never sees the key at all. The
    // main process forwards it; this is subscribed once and then just ignored
    // whenever focus mode is off.
    if (!listeningToPage) {
      listeningToPage = true;
      window.localMind?.onChromeKey?.((e) => {
        if (on && e.type === 'keyDown' && e.key === 'Escape') exit();
      });
    }

    // ⌘⇧F is the promise made here because it is the one that always holds: it
    // is a menu accelerator, so it works no matter what has focus. Escape is
    // wired up too and is handy, but a page with focus can swallow it, so it is
    // not what the hint tells people to reach for.
    Sidebar.showToast('Focus mode on — press ⌘⇧F to exit');
  }

  function exit() {
    if (!on) return;
    on = false;
    document.body.classList.remove('focus-mode', 'focus-peek-top', 'focus-peek-left');
    zones.forEach((z) => z.remove());
    zones = [];
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    // Only when nothing is being typed into — Esc has other jobs in a field.
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === 'Escape' && !typing) exit();
  }

  /** Invisible strip along one edge that reveals that piece of chrome. */
  function makeZone(edge) {
    const z = document.createElement('div');
    z.className = `focus-zone focus-zone-${edge}`;
    z.addEventListener('mouseenter', () => document.body.classList.add(`focus-peek-${edge}`));
    z.addEventListener('mouseleave', () => document.body.classList.remove(`focus-peek-${edge}`));
    document.body.appendChild(z);
    return z;
  }

  return { toggle, enter, exit, isOn: () => on };
})();
