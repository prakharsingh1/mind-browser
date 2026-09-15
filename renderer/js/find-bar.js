// =============================================================================
// Local Mind Browser — Find in Page (⌘F)
// =============================================================================
// In-page search bar for the active tab's webview.

const FindBar = (() => {
  let isOpen = false;
  let currentQuery = '';

  function init() {
    // Bar is built lazily on first open
  }

  function buildBar() {
    const bar = document.createElement('div');
    bar.id = 'find-bar';
    bar.innerHTML = `
      <input type="text" id="find-input" placeholder="Find in page..." autocomplete="off" spellcheck="false">
      <span id="find-count"></span>
      <button class="find-btn" id="find-prev" title="Previous match">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><path d="M3 10l5-5 5 5"/></svg>
      </button>
      <button class="find-btn" id="find-next" title="Next match">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><path d="M3 6l5 5 5-5"/></svg>
      </button>
      <button class="find-btn" id="find-close" title="Close (Esc)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:12px;height:12px"><path d="M4 4l8 8M12 4l-8 8"/></svg>
      </button>
    `;
    document.getElementById('browser-viewport')?.appendChild(bar);

    const input = bar.querySelector('#find-input');
    input.addEventListener('input', () => find(input.value, true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        find(input.value, false, !e.shiftKey);
      }
      if (e.key === 'Escape') close();
    });
    bar.querySelector('#find-prev').addEventListener('click', () => find(input.value, false, false));
    bar.querySelector('#find-next').addEventListener('click', () => find(input.value, false, true));
    bar.querySelector('#find-close').addEventListener('click', close);

    return bar;
  }

  // Escape has to be caught in two places, because it arrives by two routes.
  //
  // It was originally bound only to the find input, so one click into the page
  // and the bar could no longer be dismissed with the key its own tooltip
  // advertises. A document listener is not enough on its own either: a focused
  // webview swallows the keystroke and the host window never sees it. The main
  // process already forwards Escape out of webviews on the chrome-key channel
  // for the tab switcher, so this listens there too.
  const escapeIfOpen = () => { if (isOpen) close(); };

  document.addEventListener('keydown', (e) => {
    if (isOpen && e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  window.localMind?.onChromeKey?.((e) => {
    if (e.type === 'keyDown' && e.key === 'Escape') escapeIfOpen();
  });

  function open() {
    const tab = TabManager.getActiveTab();
    if (!tab?.webview) return; // Nothing to search on the new tab page

    let bar = document.getElementById('find-bar');
    if (!bar) bar = buildBar();
    bar.classList.remove('hidden');
    isOpen = true;

    // Show match counts
    if (!tab.webview._findListenerAdded) {
      tab.webview.addEventListener('found-in-page', (e) => {
        const el = document.getElementById('find-count');
        if (el && e.result) {
          el.textContent = e.result.matches > 0
            ? `${e.result.activeMatchOrdinal}/${e.result.matches}`
            : 'No matches';
        }
      });
      tab.webview._findListenerAdded = true;
    }

    const input = bar.querySelector('#find-input');
    input.focus();
    input.select();
  }

  function find(query, isNewSearch, forward = true) {
    const tab = TabManager.getActiveTab();
    if (!tab?.webview) return;

    if (!query) {
      tab.webview.stopFindInPage('clearSelection');
      const el = document.getElementById('find-count');
      if (el) el.textContent = '';
      currentQuery = '';
      return;
    }

    tab.webview.findInPage(query, {
      forward,
      findNext: !isNewSearch && query === currentQuery
    });
    currentQuery = query;
  }

  function close() {
    isOpen = false;
    const bar = document.getElementById('find-bar');
    if (bar) bar.classList.add('hidden');
    const tab = TabManager.getActiveTab();
    if (tab?.webview) {
      try { tab.webview.stopFindInPage('clearSelection'); } catch {}
    }
    currentQuery = '';
    const el = document.getElementById('find-count');
    if (el) el.textContent = '';
  }

  function toggle() {
    isOpen ? close() : open();
  }

  return { init, open, close, toggle };
})();
