// =============================================================================
// Local Mind Browser — Ctrl+Tab Tab Switcher
// =============================================================================
// Ctrl+Tab goes to the tab you used most recently, not the one sitting next to
// it in the sidebar — the same model as Cmd+Tab between apps. Hold Ctrl and tap
// Tab to walk further back; release Ctrl to commit.
//
// Two things make this feel right, and both are easy to get wrong:
//   • The order freezes while the switcher is open. Otherwise each step
//     reshuffles the list under you and Ctrl+Tab just toggles two tabs.
//   • The switch happens on release, not on every tap, so walking past four
//     tabs does not load four pages.

const TabSwitcher = (() => {
  let open = false;
  let index = 0;
  let ordered = [];
  let el = null;

  function init() {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    // Keys the focused page would otherwise swallow, forwarded by the main
    // process. Same handlers: a Ctrl+Tab is a Ctrl+Tab wherever focus sits.
    window.localMind?.onChromeKey?.((e) => {
      if (e.type === 'keyDown') onKeyDown({ key: e.key, ctrlKey: e.control, shiftKey: e.shift, preventDefault() {} });
      else onKeyUp({ key: e.key, preventDefault() {} });
    });

    // If the window loses focus the Ctrl keyup never arrives, which would
    // otherwise strand the overlay on screen forever.
    window.addEventListener('blur', () => { if (open) commit(); });
  }

  function onKeyDown(e) {
    if (e.key !== 'Tab' || !e.ctrlKey) return;
    e.preventDefault();

    if (!open) {
      ordered = TabManager.getMruTabs();
      if (ordered.length < 2) return;          // nothing to switch between
      TabManager.freezeMru();
      open = true;
      index = 1;                               // start on the previous tab
      render();
      return;
    }
    // Shift walks forward again through the list
    index = (index + (e.shiftKey ? -1 : 1) + ordered.length) % ordered.length;
    paint();
  }

  function onKeyUp(e) {
    if (open && e.key === 'Control') commit();
  }

  function commit() {
    const pick = ordered[index];
    close();
    if (pick) {
      TabManager.activateTab(pick.id);
      TabManager.unfreezeMru(pick.id);
    } else {
      TabManager.unfreezeMru();
    }
  }

  function close() {
    open = false;
    el?.remove();
    el = null;
  }

  function render() {
    if (!el) {
      el = document.createElement('div');
      el.className = 'tab-switcher';
      document.body.appendChild(el);
    }
    el.innerHTML = '';

    const list = document.createElement('div');
    list.className = 'tab-switcher-list';

    ordered.forEach((tab, i) => {
      const row = document.createElement('div');
      row.className = 'tab-switcher-item';

      // An <img> with no src never fires onerror, so it would sit there as an
      // empty box. Only make one when there is actually an icon to show.
      let icon = null;
      if (tab.favicon) {
        icon = document.createElement('img');
        icon.className = 'tab-switcher-favicon';
        icon.src = tab.favicon;
        icon.onerror = () => { icon.style.visibility = 'hidden'; };
      } else {
        icon = document.createElement('span');
        icon.className = 'tab-switcher-favicon tab-switcher-favicon-empty';
      }

      const label = document.createElement('div');
      label.className = 'tab-switcher-labels';
      const title = document.createElement('div');
      title.className = 'tab-switcher-title';
      // textContent throughout: titles and URLs come from the pages themselves.
      title.textContent = tab.title || 'New Tab';
      const host = document.createElement('div');
      host.className = 'tab-switcher-host';
      host.textContent = hostOf(tab.url);
      label.append(title, host);

      row.append(icon, label);
      // Repainting on hover rather than re-rendering: rebuilding the list here
      // destroyed the very row the pointer was mid-click on, so clicking a tab
      // silently did nothing.
      row.addEventListener('mouseenter', () => { index = i; paint(); });
      row.addEventListener('click', commit);
      list.appendChild(row);
    });

    el.appendChild(list);

    const hint = document.createElement('div');
    hint.className = 'tab-switcher-hint';
    hint.textContent = 'Hold Ctrl and press Tab to go further back';
    el.appendChild(hint);

    paint();
  }

  /** Move the highlight without touching the DOM structure. */
  function paint() {
    if (!el) return;
    const rows = el.querySelectorAll('.tab-switcher-item');
    rows.forEach((r, i) => r.classList.toggle('selected', i === index));
    rows[index]?.scrollIntoView({ block: 'nearest' });
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  return { init };
})();
