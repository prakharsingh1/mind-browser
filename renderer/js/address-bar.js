// =============================================================================
// Local Mind Browser — Address Bar / Omnibox
// =============================================================================
// Chrome-grade omnibox: instant local suggestions (open tabs, history,
// bookmarks) rendered synchronously on every keystroke, network search
// completions merged in asynchronously, inline autocomplete, and full
// keyboard navigation (↑↓ Enter Esc Tab).

const AddressBar = (() => {
  let input;
  let dropdown;

  // Omnibox state
  let results = [];          // currently displayed suggestion rows
  let selected = -1;         // index into results (-1 = raw typed input)
  let typedValue = '';       // what the user actually typed (pre-autocomplete)
  let deleting = false;      // last keystroke was deletion → skip autocomplete
  let suggestSeq = 0;        // stale-response guard for network suggestions

  const MAX_ROWS = 8;

  // ── Icons (16px, stroke follows text color) ──
  const ICONS = {
    search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M13.5 13.5L10.3 10.3"/></svg>',
    url: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><line x1="2" y1="8" x2="14" y2="8"/><path d="M8 2a10 10 0 0 1 2.5 6 10 10 0 0 1-2.5 6 10 10 0 0 1-2.5-6A10 10 0 0 1 8 2z"/></svg>',
    history: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></svg>',
    bookmark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h8a1 1 0 0 1 1 1v11l-5-3-5 3V3a1 1 0 0 1 1-1z"/></svg>',
    tab: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/></svg>',
    suggest: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M13.5 13.5L10.3 10.3"/></svg>'
  };

  function init() {
    input = document.getElementById('address-input');
    if (!input) return;

    // Dropdown lives inside #address-bar so it tracks its width/position
    const bar = document.getElementById('address-bar');
    dropdown = document.createElement('div');
    dropdown.id = 'omnibox-dropdown';
    dropdown.hidden = true;
    bar.appendChild(dropdown);

    // Row events via delegation — rows are re-rendered on every keystroke
    dropdown.addEventListener('mousedown', (e) => e.preventDefault()); // keep input focus
    dropdown.addEventListener('click', (e) => {
      const row = e.target.closest('.omni-row');
      if (row) acceptResult(results[Number(row.dataset.i)], e.metaKey || e.ctrlKey);
    });
    dropdown.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.omni-row');
      if (row && Number(row.dataset.i) !== selected) {
        selected = Number(row.dataset.i);
        paintSelection();
      }
    });

    input.addEventListener('keydown', onKeydown);
    input.addEventListener('input', onInput);
    input.addEventListener('contextmenu', showInputMenu);

    // Focus: show the full URL and select it (Chrome behavior)
    input.addEventListener('focus', () => {
      const activeTab = TabManager.getActiveTab();
      if (activeTab && activeTab.url && activeTab.url !== 'local://newtab') {
        input.value = activeTab.url;
      }
      requestAnimationFrame(() => input.select());
    });

    input.addEventListener('blur', () => {
      closeDropdown();
      const activeTab = TabManager.getActiveTab();
      if (activeTab && activeTab.url && activeTab.url !== 'local://newtab') {
        let displayUrl = activeTab.url;
        if (window.mindSettings?.appearance?.alwaysShowFullUrls === false) {
          displayUrl = displayUrl.replace(/^https?:\/\/(www\.)?/, '');
        }
        input.value = displayUrl;
      }
    });

    // Navigation buttons
    document.getElementById('btn-back')?.addEventListener('click', () => TabManager.goBack());
    document.getElementById('btn-forward')?.addEventListener('click', () => TabManager.goForward());
    // The reload button doubles as a stop button while the page is loading
    document.getElementById('btn-reload')?.addEventListener('click', (e) => {
      if (e.currentTarget.dataset.mode === 'stop') TabManager.stopLoading();
      else TabManager.reload();
    });
    document.getElementById('btn-home')?.addEventListener('click', () => TabManager.createTab('', true));

    // Zoom out. The zoom-in button used to be the only one, which meant the
    // only way back down was to cycle all the way past 150% to 100%.
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
      EventBus.emit('zoom-step', -1);
    });

    // Zoom Button
    document.getElementById('btn-zoom')?.addEventListener('click', () => {
      const activeTab = TabManager.getActiveTab();
      if (activeTab && activeTab.webview) {
        const currentZoom = activeTab.webview.getZoomFactor();
        let newZoom = currentZoom >= 1.5 ? 1.0 : currentZoom + 0.25;
        activeTab.webview.setZoomFactor(newZoom);
        if (window.localMind && window.localMind.showNotification) {
          window.localMind.showNotification('Zoom Level', `Set to ${Math.round(newZoom * 100)}%`);
        }
      }
    });

    // Page Info popover
    document.getElementById('address-visibility-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePageInfo();
    });

    // Ad Blocker Toggle
    let adBlockEnabled = true;
    const adBlockBtn = document.getElementById('btn-adblock');
    if (adBlockBtn) {
      adBlockBtn.addEventListener('click', async () => {
        adBlockEnabled = !adBlockEnabled;
        if (window.localMind && window.localMind.toggleBlocker) {
          await window.localMind.toggleBlocker(adBlockEnabled);
        }
        adBlockBtn.style.color = adBlockEnabled ? 'var(--accent)' : 'var(--text-tertiary)';
        adBlockBtn.title = adBlockEnabled ? 'Ad Blocker (Active)' : 'Ad Blocker (Disabled)';
      });
    }
  }

  // ── Input handling ──

  function onKeydown(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (dropdown.hidden) return;
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      selected = (selected + dir + results.length + 1) % (results.length + 1) - 1;
      // -1 means "the raw typed text" — restore it in the input
      if (selected === -1) {
        input.value = typedValue;
      } else {
        const r = results[selected];
        input.value = r.type === 'search' || r.type === 'suggest' ? r.query : r.url;
      }
      paintSelection();
      return;
    }

    if (e.key === 'Escape') {
      if (!dropdown.hidden) {
        e.preventDefault();
        closeDropdown();
        input.value = typedValue;
      } else {
        // Restore the page URL (Chrome behavior)
        const activeTab = TabManager.getActiveTab();
        if (activeTab?.url && activeTab.url !== 'local://newtab') input.value = activeTab.url;
        input.select();
      }
      return;
    }

    // Tab accepts the inline autocomplete (when present)
    if (e.key === 'Tab' && input.selectionEnd > input.selectionStart) {
      e.preventDefault();
      input.setSelectionRange(input.value.length, input.value.length);
      typedValue = input.value;
      return;
    }

    if (e.key === 'Backspace' || e.key === 'Delete') deleting = true;

    if (e.key === 'Enter') {
      e.preventDefault();
      const value = input.value.trim();
      if (!value) return;

      // @commands → route to AI panel
      const cmd = value.match(/^@(ask|tab|agent|search|research)\s+(.*)$/s);
      if (cmd) {
        EventBus.emit('ai-command', { type: cmd[1], query: cmd[2] });
        closeDropdown();
        input.blur();
        return;
      }
      if (value.startsWith('@compare')) {
        EventBus.emit('ai-command', { type: 'compare' });
        closeDropdown();
        input.blur();
        return;
      }

      if (selected >= 0 && results[selected]) {
        acceptResult(results[selected], e.metaKey || e.ctrlKey);
      } else {
        navigate(value, e.metaKey || e.ctrlKey);
      }
    }
  }

  function onInput() {
    typedValue = input.value;
    const q = typedValue.trim();
    if (!q) { closeDropdown(); deleting = false; return; }

    // 1) Local results — synchronous, zero latency
    results = buildLocalResults(q);

    // 2) Inline autocomplete from the best URL match (never on deletion)
    if (!deleting && !q.includes(' ')) applyInlineComplete(q);
    deleting = false;

    selected = -1;
    renderDropdown(q);

    // 3) Network search suggestions — merged in when they arrive
    fetchSuggestions(q);
  }

  // ── Suggestion engine ──

  const stripUrl = (u) => u.replace(/^https?:\/\/(www\.)?/i, '');

  function looksLikeUrl(q) {
    return /^(https?|file|view-source|about|chrome):/i.test(q) ||
      /^localhost(:\d+)?(\/|$)/i.test(q) ||
      /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(q) ||
      (q.includes('.') && !q.includes(' '));
  }

  function buildLocalResults(q) {
    const ql = q.toLowerCase();
    const seen = new Set();
    const scored = [];

    const push = (r, score) => {
      const key = (r.url || r.query || '').replace(/\/$/, '');
      if (seen.has(key)) return;
      seen.add(key);
      scored.push({ ...r, score });
    };

    // Open tabs → "Switch to tab"
    for (const t of TabManager.getAllTabs()) {
      if (!t.url) continue;
      const hay = (stripUrl(t.url) + ' ' + (t.title || '')).toLowerCase();
      if (hay.includes(ql)) {
        push({ type: 'tab', url: t.url, title: t.title || t.url, tabId: t.id }, 300);
      }
    }

    // Bookmarks
    const links = (typeof Bookmarks !== 'undefined' && Bookmarks.listLinks) ? Bookmarks.listLinks() : [];
    for (const b of links) {
      const stripped = stripUrl(b.url).toLowerCase();
      const hay = stripped + ' ' + (b.title || '').toLowerCase();
      const idx = hay.indexOf(ql);
      if (idx === -1) continue;
      let score = 140 - Math.min(idx * 2, 80);
      if (stripped.startsWith(ql)) score += 160;
      push({ type: 'bookmark', url: b.url, title: b.title || b.url }, score);
    }

    // History (newest-first, frecency-lite)
    const now = Date.now();
    const history = TabManager.getHistory();
    let scanned = 0;
    for (const h of history) {
      if (++scanned > 600) break;   // most-recent window is plenty
      const stripped = stripUrl(h.url).toLowerCase();
      const hay = stripped + ' ' + (h.title || '').toLowerCase();
      const idx = hay.indexOf(ql);
      if (idx === -1) continue;
      const days = (now - (h.ts || 0)) / 86400000;
      let score = 120 - Math.min(idx * 2, 80) + 60 / (1 + days);
      if (stripped.startsWith(ql)) score += 160;
      push({ type: 'history', url: h.url, title: h.title || h.url }, score);
    }

    scored.sort((a, b) => b.score - a.score);

    // Default action row is always first: direct URL or engine search
    const rows = [];
    if (looksLikeUrl(q)) {
      rows.push({ type: 'url', url: TabManager.normalizeInput(q), title: q });
    } else {
      rows.push({ type: 'search', query: q, title: q });
    }
    return rows.concat(scored.slice(0, 5));
  }

  function applyInlineComplete(q) {
    const ql = q.toLowerCase();
    // Best autocomplete candidate: a result whose stripped URL starts with q
    const cand = results.find(r =>
      (r.type === 'history' || r.type === 'bookmark' || r.type === 'tab') &&
      stripUrl(r.url).toLowerCase().startsWith(ql));
    if (!cand) return;
    const full = stripUrl(cand.url);
    if (full.length <= q.length) return;
    input.value = q + full.slice(q.length);
    input.setSelectionRange(q.length, input.value.length);
  }

  function fetchSuggestions(q) {
    if (!window.localMind?.omniboxSuggest || looksLikeUrl(q)) return;
    const seq = ++suggestSeq;
    const engine = window.mindSettings?.general?.searchEngine || 'duckduckgo';
    debouncedSuggest(q, engine, seq);
  }

  const debouncedSuggest = debounce(async (q, engine, seq) => {
    let list = [];
    try { list = await window.localMind.omniboxSuggest(q, engine); } catch {}
    // Stale or the user moved on → drop
    if (seq !== suggestSeq || dropdown.hidden || input.value.trim().split(/\s+/)[0] !== q.split(/\s+/)[0]) return;
    const existing = new Set(results.map(r => (r.query || r.title || '').toLowerCase()));
    const add = list
      .filter(s => s && s.toLowerCase() !== q.toLowerCase() && !existing.has(s.toLowerCase()))
      .slice(0, MAX_ROWS - results.length)
      .map(s => ({ type: 'suggest', query: s, title: s }));
    if (add.length) {
      results = results.concat(add);
      renderDropdown(q, true);
    }
  }, 120);

  // ── Rendering ──

  function renderDropdown(q, keepSelection = false) {
    if (!results.length) { closeDropdown(); return; }
    if (!keepSelection) selected = -1;

    const ql = q.toLowerCase();
    const engine = window.mindSettings?.general?.searchEngine || 'duckduckgo';
    const engineName = { duckduckgo: 'DuckDuckGo', google: 'Google', bing: 'Bing' }[engine] || 'DuckDuckGo';

    dropdown.innerHTML = results.slice(0, MAX_ROWS).map((r, i) => {
      let main, sub = '', badge = '';
      switch (r.type) {
        case 'search':
          main = highlight(r.query, ql);
          sub = `Search ${engineName}`;
          break;
        case 'suggest':
          main = highlight(r.query, ql);
          sub = `Search ${engineName}`;
          break;
        case 'url':
          main = highlight(r.title, ql);
          sub = 'Open URL';
          break;
        case 'tab':
          main = highlight(r.title, ql);
          sub = escapeHtml(shortUrl(r.url));
          badge = '<span class="omni-badge">Switch to tab</span>';
          break;
        default: // history | bookmark
          main = highlight(r.title, ql);
          sub = escapeHtml(shortUrl(r.url));
      }
      return `
        <div class="omni-row${i === selected ? ' selected' : ''}" data-i="${i}">
          <span class="omni-icon">${ICONS[r.type] || ICONS.url}</span>
          <span class="omni-main">${main}</span>
          ${sub ? `<span class="omni-sub">— ${sub}</span>` : ''}
          ${badge}
        </div>`;
    }).join('');

    results = results.slice(0, MAX_ROWS);
    dropdown.hidden = false;
  }

  function paintSelection() {
    dropdown.querySelectorAll('.omni-row').forEach((el, i) => {
      el.classList.toggle('selected', i === selected);
    });
  }

  function closeDropdown() {
    dropdown.hidden = true;
    results = [];
    selected = -1;
  }

  /** Bold the matched substring (escapes everything first). */
  function highlight(text, ql) {
    const safe = escapeHtml(truncate(text, 70));
    if (!ql) return safe;
    const idx = safe.toLowerCase().indexOf(escapeHtml(ql).toLowerCase());
    if (idx === -1) return safe;
    const end = idx + escapeHtml(ql).length;
    return safe.slice(0, idx) + '<b>' + safe.slice(idx, end) + '</b>' + safe.slice(end);
  }

  function shortUrl(u) {
    return truncate(stripUrl(u).replace(/\/$/, ''), 60);
  }

  // ── Actions ──

  function acceptResult(r, newTab = false) {
    if (!r) return;
    closeDropdown();
    if (r.type === 'tab' && !newTab) {
      TabManager.activateTab(r.tabId);
      input.blur();
      return;
    }
    const target = r.url || TabManager.searchUrl(r.query);
    navigate(target, newTab);
  }

  function navigate(value, newTab = false) {
    closeDropdown();
    if (newTab) {
      TabManager.createTab(TabManager.normalizeInput(value), true);
    } else {
      TabManager.navigateTo(value);
    }
    input.blur();
  }

  // ── Address input context menu (Cut/Copy/Paste/Paste and Go) ──

  async function showInputMenu(e) {
    e.preventDefault();
    document.getElementById('addressbar-menu')?.remove();

    const hasSelection = input.selectionEnd > input.selectionStart;
    let clip = '';
    try { clip = (await window.localMind?.readClipboardText?.()) || ''; } catch {}

    const insertText = (text) => {
      const s = input.selectionStart, epos = input.selectionEnd;
      input.setRangeText(text, s, epos, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const items = [
      { label: 'Cut', enabled: hasSelection, action: () => document.execCommand('cut') },
      { label: 'Copy', enabled: hasSelection, action: () => document.execCommand('copy') },
      { label: 'Paste', enabled: !!clip, action: () => insertText(clip) },
      { label: 'Paste and Go', enabled: !!clip.trim(), action: () => navigate(clip.trim()) },
      { divider: true },
      { label: 'Select All', enabled: true, action: () => input.select() }
    ];

    const menu = document.createElement('div');
    menu.id = 'addressbar-menu';
    menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:99999;
      background:var(--bg-elevated);border:1px solid var(--border-color);border-radius:var(--radius-md);
      padding:4px;min-width:160px;box-shadow:0 8px 24px rgba(0,0,0,0.5);animation:fadeIn 0.1s ease;`;

    items.forEach((mi) => {
      if (mi.divider) {
        const d = document.createElement('div');
        d.style.cssText = 'height:1px;background:var(--border-color);margin:4px 8px;';
        menu.appendChild(d);
        return;
      }
      const row = document.createElement('div');
      row.textContent = mi.label;
      row.style.cssText = `padding:6px 12px;border-radius:6px;font-size:13px;
        color:${mi.enabled ? 'var(--text-secondary)' : 'var(--text-tertiary)'};
        cursor:${mi.enabled ? 'pointer' : 'default'};opacity:${mi.enabled ? 1 : 0.5};`;
      if (mi.enabled) {
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-tertiary)'; row.style.color = 'var(--text-primary)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'none'; row.style.color = 'var(--text-secondary)'; });
        row.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep input focus
        row.addEventListener('click', () => { menu.remove(); mi.action(); });
      }
      menu.appendChild(row);
    });

    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 8}px`;
    if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 8}px`;

    const close = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 10);
  }

  // ── Page info popover ──

  function togglePageInfo() {
    const existing = document.getElementById('page-info-popover');
    if (existing) {
      existing.remove();
      return;
    }

    const btn = document.getElementById('address-visibility-btn');
    if (!btn) return;

    const tab = TabManager.getActiveTab();
    const url = tab?.url || '';
    let host = '';
    try { host = url ? new URL(url).hostname : ''; } catch {}

    const secure = url.startsWith('https://');
    const statusColor = url ? (secure ? 'var(--success)' : 'var(--warning)') : 'var(--text-tertiary)';
    const statusText = url
      ? (secure ? 'Connection is secure' : 'Connection is not secure')
      : 'New Tab — no page loaded';

    const popover = document.createElement('div');
    popover.id = 'page-info-popover';
    const rect = btn.getBoundingClientRect();
    popover.style.cssText = `
      position: fixed; top: ${rect.bottom + 8}px; left: ${Math.max(8, rect.right - 280)}px; z-index: 99999;
      width: 280px; background: var(--bg-elevated); border: 1px solid var(--border-color);
      border-radius: var(--radius-md); padding: 12px 14px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5); animation: fadeIn 0.1s ease;
    `;
    popover.innerHTML = `
      <div style="font-size:13px;font-weight:600;color:${statusColor};margin-bottom:4px;">${statusText}</div>
      ${host ? `<div style="font-size:12px;color:var(--text-secondary);word-break:break-all;">${escapeHtml(host)}</div>` : ''}
    `;

    document.body.appendChild(popover);

    const closePopover = (e) => {
      if (popover.contains(e.target)) return;
      popover.remove();
      document.removeEventListener('click', closePopover);
    };
    setTimeout(() => document.addEventListener('click', closePopover), 10);
  }

  return { init };
})();
