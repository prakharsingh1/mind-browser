// =============================================================================
// Local Mind Browser — Command Palette (⌘K)
// =============================================================================
// Universal search + action palette.

const CommandPalette = (() => {
  let isOpen = false;
  let selectedIndex = 0;
  let results = [];

  const defaultActions = [
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M12 5v14M5 12h14"/></svg>', text: 'New Tab', shortcut: '⌘T', action: () => TabManager.createTab('', true) },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 16h.01M16 16h.01"/></svg>', text: 'Toggle AI Panel', shortcut: '⌘⇧L', action: () => AiPanel.toggle() },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M3 12a9 9 0 1 0 2.6-6.4"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/></svg>', text: 'History', shortcut: '⌘Y', action: () => HistoryPage.show() },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15l2-2 4 4"/></svg>', text: 'Edit this PDF', action: () => App.openPdfEditor?.() },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>', text: 'Summarize Page', action: () => { EventBus.emit('ai-command', { type: 'ask', query: 'Summarize this page' }); } },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>', text: 'Research Mode', action: () => AiPanel.setMode('research') },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>', text: 'Reading Mode', shortcut: '⌘⇧R', action: () => EventBus.emit('toggle-reading-mode') },
    // The guided tour was only ever reachable on first run, which meant nobody
    // who had already used the browser could find out what the new buttons do.
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>', text: 'Show me around', shortcut: null, action: () => Onboarding.startTour() },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M5.5 5L2 8l3.5 3"/><path d="M18.5 5L22 8l-3.5 3"/><path d="M14 4l-4 16"/></svg>', text: 'Developer tools', shortcut: '⌥⌘D', action: () => DevPanel.toggle() },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>', text: 'Split View', shortcut: '⌘\\', action: () => EventBus.emit('toggle-split-view') },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>', text: 'Query Across Tabs (@tab)', action: () => { EventBus.emit('ai-command', { type: 'tab', query: '' }); } },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>', text: 'Open Settings', shortcut: '⌘,', action: () => Settings.open() },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>', text: 'Reload Page', shortcut: '⌘R', action: () => TabManager.reload() },
    { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>', text: 'Toggle Sidebar', shortcut: '⌘B', action: () => Sidebar.toggle() },
  ];

  function init() {
    // Global keyboard shortcut
    document.addEventListener('keydown', (e) => {
      // ⌘K — open palette
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        toggle();
      }

      // Escape — close
      if (e.key === 'Escape' && isOpen) {
        close();
      }

      // Arrow navigation when open
      if (isOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
          renderResults();
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectedIndex = Math.max(selectedIndex - 1, 0);
          renderResults();
        }
        if (e.key === 'Enter' && results[selectedIndex]) {
          e.preventDefault();
          executeResult(results[selectedIndex]);
          close();
        }
      }
    });

    // Top bar button
    document.getElementById('btn-command-palette')?.addEventListener('click', toggle);

    // Search input
    const searchInput = document.getElementById('cp-search');
    if (searchInput) {
      searchInput.addEventListener('input', debounce((e) => {
        search(e.target.value);
      }, 150));
    }

    // Click on overlay to close
    const overlay = document.getElementById('command-palette-overlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });
    }
  }

  function toggle() {
    isOpen ? close() : open();
  }

  function open() {
    isOpen = true;
    selectedIndex = 0;
    const overlay = document.getElementById('command-palette-overlay');
    if (overlay) overlay.classList.remove('hidden');

    const input = document.getElementById('cp-search');
    if (input) {
      input.value = '';
      input.focus();
    }

    // Show default results
    search('');
  }

  function close() {
    isOpen = false;
    const overlay = document.getElementById('command-palette-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function search(query) {
    results = [];

    if (!query) {
      // Show default actions
      results = defaultActions.map((a, i) => ({ ...a, category: 'Actions', index: i }));
    } else {
      const q = query.toLowerCase();

      // Search actions
      const matchingActions = defaultActions.filter(a =>
        a.text.toLowerCase().includes(q)
      ).map((a, i) => ({ ...a, category: 'Actions', index: i }));
      results.push(...matchingActions);

      // Search open tabs
      const tabs = TabManager.getAllTabs();
      const matchingTabs = tabs.filter(t =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.url || '').toLowerCase().includes(q)
      ).map(t => ({
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
        text: t.title || t.url,
        category: 'Open Tabs',
        action: () => TabManager.activateTab(t.id)
      }));
      results.push(...matchingTabs);

      // Search browsing history
      const matchingHistory = TabManager.getHistory().filter(h =>
        (h.title || '').toLowerCase().includes(q) ||
        (h.url || '').toLowerCase().includes(q)
      ).slice(0, 8).map(h => ({
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
        text: h.title || h.url,
        category: 'History',
        action: () => TabManager.navigateTo(h.url)
      }));
      results.push(...matchingHistory);
    }

    selectedIndex = 0;
    renderResults();
  }

  function renderResults() {
    const container = document.getElementById('cp-results');
    if (!container) return;

    container.innerHTML = '';

    if (results.length === 0) {
      container.innerHTML = '<div class="cp-empty">No results found</div>';
      return;
    }

    let currentCategory = '';
    results.forEach((r, i) => {
      if (r.category !== currentCategory) {
        currentCategory = r.category;
        const catEl = document.createElement('div');
        catEl.className = 'cp-category';
        catEl.textContent = currentCategory;
        container.appendChild(catEl);
      }

      const item = document.createElement('div');
      item.className = `cp-item${i === selectedIndex ? ' selected' : ''}`;
      item.innerHTML = `
        <span class="cp-item-icon">${r.icon || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'}</span>
        <span class="cp-item-text">${escapeHtml(r.text)}</span>
        ${r.shortcut ? `<span class="cp-item-shortcut">${r.shortcut}</span>` : ''}
      `;
      item.addEventListener('click', () => {
        executeResult(r);
        close();
      });
      container.appendChild(item);
    });
  }

  function executeResult(result) {
    if (result.action) result.action();
  }

  return { init, open, close, toggle };
})();
