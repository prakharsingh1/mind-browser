// =============================================================================
// Local Mind Browser — Sidebar Controller
// =============================================================================
// Clean sidebar with pin-to-keep system (like Spotify).
// Users browse Quick Links, Bookmarks, AI Features and pin their favorites.

const Sidebar = (() => {
  let isCollapsed = false;
  let pinnedItems = []; // { id, title, url, icon }

  function init() {
    // Load pinned items from localStorage
    try {
      pinnedItems = JSON.parse(localStorage.getItem('mind-pinned') || '[]');
    } catch { pinnedItems = []; }

    // Toggle sidebar
    document.getElementById('sidebar-toggle')?.addEventListener('click', toggle);

    // Section collapse/expand
    document.querySelectorAll('.section-header').forEach(header => {
      header.addEventListener('click', () => {
        const content = header.nextElementSibling;
        const icon = header.querySelector('.collapse-icon');
        if (content) {
          content.classList.toggle('collapsed');
          if (icon) icon.style.transform = content.classList.contains('collapsed') ? 'rotate(-90deg)' : '';
        }
      });
    });

    // Settings button
    document.getElementById('sidebar-settings')?.addEventListener('click', () => Settings.open());

    // New-tab button in the Open Tabs header (primary control in left-tab mode)
    document.getElementById('sidebar-new-tab')?.addEventListener('click', (e) => {
      e.stopPropagation(); // don't toggle the section collapse
      TabManager.createTab('', true);
    });

    // ── Quick Links: click to navigate, pin button to pin ──
    document.querySelectorAll('.pinnable-item').forEach(item => {
      const url = item.dataset.url;
      const title = item.dataset.title;

      // Click the item itself → navigate
      item.addEventListener('click', (e) => {
        if (e.target.closest('.pin-btn')) return; // Don't navigate on pin click
        if (url) TabManager.navigateTo(url);
      });
      item.style.cursor = 'pointer';

      // Pin button click
      const pinBtn = item.querySelector('.pin-btn');
      if (pinBtn) {
        pinBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          pinItem({ id: uid(), title: title || url, url: url });
          showToast(`Pinned "${title}"`);
        });
      }
    });

    // ── AI Features sidebar items ──
    document.getElementById('sidebar-ai-chat')?.addEventListener('click', () => {
      EventBus.emit('ai-command', { type: 'ask', query: '' });
      // Ensure AI panel is visible
      if (document.body.classList.contains('ai-panel-hidden')) {
        document.body.classList.remove('ai-panel-hidden');
      }
    });

    document.getElementById('sidebar-ai-agent')?.addEventListener('click', () => {
      EventBus.emit('ai-command', { type: 'agent', query: '' });
      if (document.body.classList.contains('ai-panel-hidden')) {
        document.body.classList.remove('ai-panel-hidden');
      }
    });

    document.getElementById('sidebar-ai-research')?.addEventListener('click', () => {
      EventBus.emit('ai-command', { type: 'research', query: '' });
      if (document.body.classList.contains('ai-panel-hidden')) {
        document.body.classList.remove('ai-panel-hidden');
      }
    });

    document.getElementById('sidebar-ai-summarize')?.addEventListener('click', () => {
      EventBus.emit('ai-command', { type: 'page', query: 'Summarize this page' });
      if (document.body.classList.contains('ai-panel-hidden')) {
        document.body.classList.remove('ai-panel-hidden');
      }
    });

    document.getElementById('sidebar-reading-mode')?.addEventListener('click', () => {
      if (typeof ReadingMode !== 'undefined') ReadingMode.toggle();
    });

    // Listen for tab updates to render active tabs list
    EventBus.on('tabs-updated', renderOpenTabs);

    // History lives in the top bar now, not in this list.
    document.getElementById('sidebar-notes')?.addEventListener('click', () => {
      if (typeof NotesPage !== 'undefined') NotesPage.show();
    });

    initHoverPeek();
    initRailPeek();
    const savedMode = window.mindSettings?.appearance?.sidebarMode || 'docked';
    // Seed the return-to mode so ⌘B gives an auto-hide user auto-hide back.
    if (savedMode !== 'docked') hiddenMode = savedMode;
    applySidebarMode(savedMode);
    initTabPeek();
    initThumbCapture();

    // Render pinned items & mark already-pinned items
    renderPinnedItems();
    updatePinButtonStates();
  }

  /** The layout mode actually on screen, read from the DOM rather than tracked
   *  separately — the two used to drift apart. */
  function currentMode() {
    const c = document.body.classList;
    if (c.contains('sidebar-rail')) return 'autohide';
    // While hover-peeking, `sidebar-collapsed` is lifted so the panel can widen,
    // but the resting state is still collapsed. Reading only the class made ⌘B
    // during a hover collapse an already-open sidebar instead of pinning it.
    const el = document.getElementById('sidebar');
    if (c.contains('sidebar-collapsed') || el?.classList.contains('hover-open')) return 'icons';
    return 'docked';
  }

  // Which non-docked mode ⌘B should return to. Seeded from the user's setting
  // so auto-hide users get auto-hide back, not icons.
  let hiddenMode = 'icons';

  /**
   * Collapse button / ⌘B / menu / command palette.
   *
   * This used to flip `sidebar-collapsed` directly, which had three problems:
   * it added that class ON TOP of `sidebar-rail` in auto-hide mode, leaving two
   * mutually exclusive layout modes applied at once; it never wrote the change
   * back, so the Appearance setting and the screen disagreed and the toggle was
   * forgotten on restart; and the button never changed, so once collapsed there
   * was nothing indicating how to get back.
   *
   * It now drives the same setting the Appearance dropdown does, so there is
   * exactly one source of truth.
   */
  function toggle() {
    const mode = currentMode();
    if (mode === 'docked') {
      applySidebarMode(hiddenMode, true);
    } else {
      hiddenMode = mode;                     // come back to whichever it was
      applySidebarMode('docked', true);
    }
  }

  /** Keep the button pointing the way it will actually move. */
  function syncToggleButton(mode) {
    const btn = document.getElementById('sidebar-toggle');
    if (!btn) return;
    const collapsed = mode !== 'docked';
    btn.title = collapsed ? 'Show sidebar (⌘B)' : 'Hide sidebar (⌘B)';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-expanded', String(!collapsed));
    // Chevron points the direction the panel will travel.
    btn.innerHTML = collapsed
      ? `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
           <path d="M6.5 4.5L10 8l-3.5 3.5"/><path d="M3.5 3v10"/>
         </svg>`
      : `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
           <path d="M9.5 4.5L6 8l3.5 3.5"/><path d="M12.5 3v10"/>
         </svg>`;
  }

  // ── Hover-to-expand ────────────────────────────────────────────────────────
  // Only while collapsed. The panel floats over the content (see sidebar.css),
  // so peeking never reflows the page. A short close delay keeps it from
  // flickering when the cursor clips the edge on its way somewhere else.
  function initHoverPeek() {
    const el = document.getElementById('sidebar');
    if (!el) return;
    let closeTimer = null;

    // isCollapsed = the user's chosen resting state. On hover we DOCK the real
    // sidebar open (remove the collapsed class → it widens and pushes content,
    // identical to clicking the collapse button), and mark it `hover-open` so we
    // know to collapse it again on leave. The logical state stays collapsed.
    const openOnHover = () => {
      if (!isCollapsed || el.classList.contains('hover-open')) return;
      clearTimeout(closeTimer);
      el.classList.add('hover-open');
      document.body.classList.remove('sidebar-collapsed');
    };
    const collapseBack = () => {
      if (isCollapsed && el.classList.contains('hover-open')) {
        el.classList.remove('hover-open');
        document.body.classList.add('sidebar-collapsed');
      }
    };
    const closeOnLeave = () => {
      if (!el.classList.contains('hover-open')) return;
      clearTimeout(closeTimer);
      // Short delay: survives the cursor clipping the edge, still snaps shut.
      closeTimer = setTimeout(collapseBack, 90);
    };

    // Bound to #sidebar itself — because it now docks in-flow, the element IS
    // the full 260px while open, so the cursor stays "inside" it and hover holds
    // until you actually leave. (The old overlay floated outside #sidebar, which
    // is why moving onto it counted as leaving.)
    el.addEventListener('mouseenter', openOnHover);
    el.addEventListener('mouseleave', closeOnLeave);
    window.addEventListener('blur', collapseBack);
  }

  // ── Auto-hide (rail) ───────────────────────────────────────────────────────
  // Mirrors the AI panel: the sidebar leaves the layout entirely and its content
  // floats over the page, sliding in when the cursor reaches the left edge.
  // Because nothing reflows, this is the smooth one — the docked mode has to
  // resize the webview on every frame no matter how the easing is tuned.
  function initRailPeek() {
    const el = document.getElementById('sidebar');
    const zone = document.getElementById('sidebar-hotzone');
    if (!el) return;
    let closeTimer = null;

    const railed = () => document.body.classList.contains('sidebar-rail');
    const open = () => {
      if (!railed()) return;
      clearTimeout(closeTimer);
      el.classList.add('peek');
    };
    const close = () => {
      clearTimeout(closeTimer);
      // Short grace period so clipping the edge on the way past does not
      // slam it shut mid-movement.
      closeTimer = setTimeout(() => el.classList.remove('peek'), 140);
    };

    zone?.addEventListener('mouseenter', open);
    el.addEventListener('mouseenter', open);
    el.addEventListener('mousemove', open);
    el.addEventListener('mouseleave', close);
    window.addEventListener('blur', () => el.classList.remove('peek'));

    // Position, not enter/leave bookkeeping, is what actually decides this.
    //
    // The panel is revealed by the hot zone, which is a SIBLING of #sidebar, so
    // the pointer can end up over the open panel without ever having produced a
    // mouseenter on #sidebar — and with no enter there is no matching leave, so
    // the panel stayed open forever once shown. Measuring where the cursor is
    // sidesteps that entirely, and also catches fast flicks and the webview
    // boundary, which swallow synthetic enter/leave events.
    document.addEventListener('mousemove', (e) => {
      if (!railed()) return;
      if (e.clientX <= 3) { open(); return; }
      if (!el.classList.contains('peek')) return;
      const w = el.querySelector('.sidebar-inner')?.getBoundingClientRect().width || 260;
      if (e.clientX > w) close();
    });
  }

  /**
   * Apply the user's chosen sidebar behaviour.
   * 'docked'   — always in the layout (default)
   * 'icons'    — collapsed to icons, hover docks it open
   * 'autohide' — out of the layout entirely, floats in from the edge
   */
  function applySidebarMode(mode, persist = false) {
    if (!['docked', 'icons', 'autohide'].includes(mode)) mode = 'docked';

    const body = document.body;
    const el = document.getElementById('sidebar');

    // Clear every mode first. Setting one without clearing the others is how
    // `sidebar-rail` and `sidebar-collapsed` ended up applied together.
    body.classList.remove('sidebar-rail', 'sidebar-collapsed');
    el?.classList.remove('peek', 'hover-open');

    if (mode === 'autohide') body.classList.add('sidebar-rail');
    if (mode === 'icons') body.classList.add('sidebar-collapsed');
    isCollapsed = mode === 'icons';
    if (mode !== 'docked') hiddenMode = mode;

    syncToggleButton(mode);

    if (persist) {
      const st = window.mindSettings || {};
      st.appearance = st.appearance || {};
      if (st.appearance.sidebarMode !== mode) {
        st.appearance.sidebarMode = mode;
        window.mindSettings = st;
        // Written back so the Appearance dropdown and the sidebar cannot
        // disagree, and so the choice survives a restart.
        try { window.localMind?.saveSettings?.(st); } catch { /* best effort */ }
      }
    }
  }

  // ── Tab hover preview ──────────────────────────────────────────────────────
  // Sweeping the cursor down the tab list pops a preview out of the hovered row.
  let peekEl = null;
  let peekTimer = null;

  // A background tab's webview isn't painted, so capturePage() comes back empty
  // — which is why inactive tabs previewed with no image. Snapshot each tab
  // while it IS visible and keep the last frame for later previews.
  const thumbCache = new Map();   // tabId → data URL

  function cacheThumb(tab) {
    if (!tab?.webview || !window.localMind?.captureTab) return;
    let wcId;
    try { wcId = tab.webview.getWebContentsId(); } catch { return; }
    window.localMind.captureTab(wcId).then((res) => {
      if (res?.ok && res.data) thumbCache.set(String(tab.id), res.data);
    }).catch(() => {});
  }

  function initThumbCapture() {
    // Snapshot shortly after a tab becomes visible, once it's had time to paint.
    EventBus.on('tab-activated', (tab) => {
      if (!tab?.webview) return;
      setTimeout(() => cacheThumb(tab), 1200);
    });
    // Refresh the active tab's snapshot periodically so previews don't go stale.
    setInterval(() => {
      const active = TabManager.getActiveTab?.();
      if (active?.webview) cacheThumb(active);
    }, 20000);
    // Navigating inside a tab doesn't re-fire 'tab-activated', so the snapshot
    // has to be taken when the page finishes loading too — otherwise a tab you
    // opened and navigated once never gets one.
    let settleTimer = null;
    EventBus.on('tabs-updated', (tabs) => {
      const live = new Set((tabs || []).map(t => String(t.id)));
      for (const id of thumbCache.keys()) if (!live.has(id)) thumbCache.delete(id);

      const active = TabManager.getActiveTab?.();
      if (active?.webview && !active.isLoading) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => cacheThumb(active), 900);
      }
    });
  }

  function initTabPeek() {
    const list = document.getElementById('open-tabs-list');
    if (!list) return;

    list.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.sidebar-item[data-tab-id]');
      if (!row) return;
      clearTimeout(peekTimer);
      peekTimer = setTimeout(() => showTabPeek(row), 260);
    });
    list.addEventListener('mouseout', (e) => {
      if (e.relatedTarget && list.contains(e.relatedTarget)) return;
      clearTimeout(peekTimer);
      hideTabPeek();
    });
    list.addEventListener('mousedown', hideTabPeek);
    document.addEventListener('scroll', hideTabPeek, true);
  }

  function showTabPeek(row) {
    // Tab ids are opaque strings, not numbers — compare as strings.
    const id = row.dataset.tabId;
    const tab = TabManager.getAllTabs?.().find(t => String(t.id) === id);
    if (!tab) return;

    hideTabPeek();
    peekEl = document.createElement('div');
    peekEl.id = 'tab-peek';
    peekEl.innerHTML = `
      <div class="peek-title">${escapeHtml(tab.title || 'New Tab')}</div>
      <div class="peek-url">${escapeHtml(prettyUrl(tab.url))}</div>`;
    document.body.appendChild(peekEl);

    // Anchor to the row, clamped to the viewport.
    const r = row.getBoundingClientRect();
    const h = peekEl.offsetHeight;
    peekEl.style.left = `${r.right + 10}px`;
    peekEl.style.top = `${Math.max(8, Math.min(r.top + r.height / 2 - h / 2, innerHeight - h - 8))}px`;

    const paintShot = (src) => {
      if (!peekEl || peekEl.dataset.shot === src) return;
      let img = peekEl.querySelector('.peek-shot');
      if (!img) {
        img = document.createElement('img');
        img.className = 'peek-shot';
        peekEl.appendChild(img);
      }
      img.src = src;
      peekEl.dataset.shot = src;
      // Re-centre: the card just got taller.
      const rr = row.getBoundingClientRect();
      const hh = peekEl.offsetHeight;
      peekEl.style.top = `${Math.max(8, Math.min(rr.top + rr.height / 2 - hh / 2, innerHeight - hh - 8))}px`;
    };

    // Show the cached frame straight away — for a background tab this is the
    // only thing that can be shown, since its webview isn't being painted.
    const cached = thumbCache.get(String(tab.id));
    if (cached) paintShot(cached);

    // If it's the visible tab, grab a fresh frame and refresh the cache.
    const isActive = TabManager.getActiveTab?.()?.id === tab.id;
    if (isActive && tab.webview && window.localMind?.captureTab) {
      try {
        const wcId = tab.webview.getWebContentsId();
        window.localMind.captureTab(wcId).then((res) => {
          if (!res?.ok || !res.data) return;
          thumbCache.set(String(tab.id), res.data);
          paintShot(res.data);
        }).catch(() => {});
      } catch { /* webview not attached yet */ }
    }
  }

  function hideTabPeek() {
    peekEl?.remove();
    peekEl = null;
  }

  function prettyUrl(url) {
    if (!url) return 'New Tab';
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  }

  // ── Pin System ──

  function pinItem(item) {
    if (pinnedItems.find(p => p.url === item.url)) return; // Already pinned
    pinnedItems.push(item);
    savePinned();
    renderPinnedItems();
    updatePinButtonStates();
  }

  function unpinItem(id) {
    pinnedItems = pinnedItems.filter(p => p.id !== id);
    savePinned();
    renderPinnedItems();
    updatePinButtonStates();
  }

  function savePinned() {
    localStorage.setItem('mind-pinned', JSON.stringify(pinnedItems));
  }

  function updatePinButtonStates() {
    // Visually mark items that are already pinned
    document.querySelectorAll('.pinnable-item').forEach(item => {
      const url = item.dataset.url;
      const isPinned = pinnedItems.some(p => p.url === url);
      const pinBtn = item.querySelector('.pin-btn');
      if (pinBtn) {
        if (isPinned) {
          pinBtn.style.opacity = '1';
          pinBtn.style.color = 'var(--accent)';
          pinBtn.title = 'Already pinned';
        } else {
          pinBtn.style.opacity = '';
          pinBtn.style.color = '';
          pinBtn.title = 'Pin to sidebar';
        }
      }
    });
  }

  function renderPinnedItems() {
    const container = document.getElementById('pinned-list');
    const emptyHint = document.getElementById('pinned-empty');
    if (!container) return;

    // Clear existing pinned items (but not the empty hint)
    container.querySelectorAll('.pinned-item').forEach(el => el.remove());

    if (pinnedItems.length === 0) {
      if (emptyHint) emptyHint.style.display = '';
      return;
    }

    if (emptyHint) emptyHint.style.display = 'none';

    pinnedItems.forEach(pin => {
      const item = document.createElement('div');
      item.className = 'sidebar-item pinned-item';
      item.dataset.pinnedId = pin.id;
      item.innerHTML = `
        <span class="sidebar-item-icon">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px">
            <path d="M4 2h8a1 1 0 0 1 1 1v11l-5-3-5 3V3a1 1 0 0 1 1-1z"/>
          </svg>
        </span>
        <span class="sidebar-label truncate">${escapeHtml(pin.title)}</span>
        <button class="unpin-btn" title="Unpin">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:10px;height:10px">
            <path d="M3 3l6 6M9 3l-6 6"/>
          </svg>
        </button>
      `;

      // Click to navigate
      item.addEventListener('click', (e) => {
        if (e.target.closest('.unpin-btn')) return;
        if (pin.url) TabManager.navigateTo(pin.url);
      });

      // Unpin button
      item.querySelector('.unpin-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        unpinItem(pin.id);
      });

      container.appendChild(item);
    });
  }

  // ── Toast Notification ──

  function showToast(message) {
    let toast = document.getElementById('sidebar-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'sidebar-toast';
      toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--bg-elevated);color:var(--text-primary);padding:8px 20px;border-radius:var(--radius-md);font-size:13px;border:1px solid var(--accent-dim);z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.3s ease;';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    setTimeout(() => { toast.style.opacity = '0'; }, 2000);
  }

  // ── Open Tabs (incremental — one element per tab, updated in place) ──

  const SPEAKER_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3L4.8 5.6H2.5v4.8h2.3L8 13z"/><path d="M10.6 6.1a2.8 2.8 0 0 1 0 3.8"/></svg>';
  const SPEAKER_MUTED_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3L4.8 5.6H2.5v4.8h2.3L8 13z"/><path d="M10.5 6.5l3 3M13.5 6.5l-3 3"/></svg>';

  const HOME_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M2.5 6.5L8 2l5.5 4.5V13a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V6.5z"/><path d="M6 14V9h4v5"/></svg>';
  const GLOBE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><circle cx="8" cy="8" r="6"/><line x1="2" y1="8" x2="14" y2="8"/><path d="M8 2a10 10 0 0 1 2.5 6 10 10 0 0 1-2.5 6 10 10 0 0 1-2.5-6A10 10 0 0 1 8 2z"/></svg>';
  const openTabEls = new Map(); // tabId → element

  function renderOpenTabs(tabsList) {
    const container = document.getElementById('open-tabs-list');
    if (!container) return;

    // Drop elements for tabs that no longer exist
    const liveIds = new Set(tabsList.map(t => t.id));
    for (const [id, el] of openTabEls) {
      if (!liveIds.has(id)) { openTabEls.delete(id); el.remove(); }
    }

    // Group bands are rebuilt each pass rather than diffed: there are only ever
    // a handful, and keeping them in sync with tab membership by hand was more
    // code than redrawing them.
    container.querySelectorAll('.tab-group-head').forEach((el) => el.remove());

    const groups = TabManager.getGroups?.() || [];
    const groupHeads = new Map();
    for (const g of groups) {
      const count = tabsList.filter((t) => t.groupId === g.id).length;
      if (!count) continue;
      groupHeads.set(g.id, buildGroupHead(g, count));
    }

    let prev = null;
    const placedGroups = new Set();
    tabsList.forEach(tab => {
      let item = openTabEls.get(tab.id);
      if (!item) {
        item = document.createElement('div');
        item.className = 'sidebar-item';
        item.dataset.tabId = tab.id;      // anchor for the hover preview
        item.innerHTML = `
          <span class="sidebar-item-icon"></span>
          <span class="sidebar-label"></span>
          <button class="tab-audio" type="button" hidden></button>
          <span class="close-tab-btn" title="Close">×</span>
        `;
        item.addEventListener('click', (e) => {
          if (!e.target.classList.contains('close-tab-btn')) TabManager.activateTab(tab.id);
        });
        item.addEventListener('auxclick', (e) => {
          if (e.button === 1) { e.preventDefault(); TabManager.closeTab(tab.id); }
        });
        item.querySelector('.close-tab-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          TabManager.closeTab(tab.id);
        });
        item.querySelector('.tab-audio').addEventListener('click', (e) => {
          // Not a tab switch: silencing the noisy tab you are NOT looking at is
          // the whole point of the control.
          e.stopPropagation();
          TabManager.toggleTabMuted(item._tab?.id ?? tab.id);
        });
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showContextMenu(e.clientX, e.clientY, item._tab || tab);
        });
        openTabEls.set(tab.id, item);
      }
      item._tab = tab; // context menu reads latest title/url

      // Speaker badge: shown while a tab is making sound, or while it is muted
      // so there is something to click to get the sound back.
      const audio = item.querySelector('.tab-audio');
      const showAudio = Boolean(tab.audible || tab.muted);
      audio.hidden = !showAudio;
      if (showAudio) {
        audio.classList.toggle('muted', !!tab.muted);
        audio.title = tab.muted ? 'Unmute this tab' : 'Mute this tab';
        audio.innerHTML = tab.muted ? SPEAKER_MUTED_ICON : SPEAKER_ICON;
      }

      item.classList.toggle('active', !!tab.active);
      const iconKey = !tab.url ? 'home' : (tab.favicon || 'globe');
      const iconEl = item.querySelector('.sidebar-item-icon');
      if (iconEl.dataset.icon !== iconKey) {
        iconEl.dataset.icon = iconKey;
        iconEl.innerHTML = !tab.url ? HOME_ICON
          : tab.favicon ? `<img src="${escapeHtml(tab.favicon)}" width="14" height="14" data-on-error="hide">`
          : GLOBE_ICON;
      }
      const label = truncate(tab.title, 22);
      const labelEl = item.querySelector('.sidebar-label');
      if (labelEl.textContent !== label) labelEl.textContent = label;

      // A group's band goes in immediately before its first tab, so the band
      // sits where the group actually starts rather than at a fixed position.
      const head = tab.groupId ? groupHeads.get(tab.groupId) : null;
      if (head && !placedGroups.has(tab.groupId)) {
        placedGroups.add(tab.groupId);
        container.insertBefore(head, prev ? prev.nextSibling : container.firstChild);
        prev = head;
      }

      const group = tab.groupId ? TabManager.groupById?.(tab.groupId) : null;
      item.classList.toggle('in-group', Boolean(group));
      item.style.setProperty('--group-color', group ? (TabManager.GROUP_COLORS[group.color] || group.color) : 'transparent');
      // A collapsed group hides its tabs but keeps them open.
      //
      // A class, not the `hidden` attribute: `hidden` only supplies
      // `display: none` as a UA default, and `.sidebar-item { display: flex }`
      // beats it — so the attribute was set correctly and changed nothing.
      item.classList.toggle('group-collapsed', Boolean(group?.collapsed));

      // Keep DOM order in sync with tab order
      if (item.previousElementSibling !== prev || item.parentElement !== container) {
        container.insertBefore(item, prev ? prev.nextSibling : container.firstChild);
      }
      prev = item;
    });
  }

  // ── Context Menu ──

  const GROUP_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><rect x="2" y="3" width="12" height="4" rx="1.5"/><rect x="2" y="9" width="8" height="4" rx="1.5"/></svg>';

  /**
   * The grouping entries for a tab's context menu.
   *
   * Existing groups are listed by name so "add to the group I already made" is
   * one click, rather than making a second group with the same name because
   * the first one was not offered.
   */
  function groupMenuItems(tab) {
    const groups = TabManager.getGroups?.() || [];
    const items = [];

    items.push({
      icon: GROUP_ICON,
      label: 'New group with this tab',
      action: () => {
        // Electron has no window.prompt — it is the one dialog Chromium does
        // not implement here. The group is created straight away and named in
        // place, which is fewer steps than a modal would have been anyway.
        const g = TabManager.createGroup('New group', null, [tab.id]);
        if (g) startRenameGroup(g.id, true);
      }
    });

    for (const g of groups.filter((x) => x.id !== tab.groupId)) {
      items.push({
        icon: `<span style="width:10px;height:10px;border-radius:50%;flex:0 0 auto;background:${TabManager.GROUP_COLORS[g.color] || g.color}"></span>`,
        label: `Add to “${g.name}”`,
        action: () => TabManager.assignToGroup(tab.id, g.id)
      });
    }

    if (tab.groupId) {
      items.push({
        icon: GROUP_ICON,
        label: 'Remove from group',
        action: () => TabManager.assignToGroup(tab.id, null)
      });
    }
    return items;
  }

  /**
   * Dismiss a context menu on anything that should dismiss it.
   *
   * An outside-click listener on `document` is not enough on its own: a click
   * that lands inside a <webview> is delivered to the guest, not to us, so
   * clicking the page left the menu floating over the sidebar with no way to
   * get rid of it but clicking the sidebar again. Losing window focus covers
   * that case, and Escape covers the keyboard.
   */
  function autoDismiss(menu) {
    const close = () => {
      menu.remove();
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
    };
    const onClick = (e) => { if (!menu.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };

    setTimeout(() => {
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', close);
    }, 10);
    return close;
  }

  /**
   * Rename a group in place, in its own band.
   *
   * @param selectAll true right after creation, so the placeholder name is
   *                  replaced by whatever is typed rather than appended to.
   */
  function startRenameGroup(groupId, selectAll = false) {
    // The band is redrawn on every tabs-updated, so wait a frame for the one
    // belonging to this group to exist before reaching for it.
    requestAnimationFrame(() => {
      const head = document.querySelector(`.tab-group-head[data-group-id="${groupId}"]`);
      const label = head?.querySelector('.tg-name');
      if (!head || !label) return;

      const input = document.createElement('input');
      input.className = 'tg-rename';
      input.value = TabManager.groupById(groupId)?.name || '';
      label.replaceWith(input);

      let done = false;
      const finish = (keep) => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (keep && name) TabManager.updateGroup(groupId, { name });
        else EventBus.emit('tabs-updated', TabManager.getAllTabs());   // redraw the band back
      };

      input.addEventListener('click', (e) => e.stopPropagation());   // not a collapse
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });

      input.focus();
      if (selectAll) input.select();
    });
  }

  /** The coloured, named, collapsible header that introduces a group. */
  function buildGroupHead(group, count) {
    const el = document.createElement('div');
    el.className = 'tab-group-head';
    el.dataset.groupId = group.id;
    el.style.setProperty('--group-color', TabManager.GROUP_COLORS[group.color] || group.color);
    el.classList.toggle('collapsed', Boolean(group.collapsed));

    const chevron = document.createElement('span');
    chevron.className = 'tg-chevron';
    chevron.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5L7.5 6 4 9.5"/></svg>';

    const dot = document.createElement('span');
    dot.className = 'tg-dot';

    const name = document.createElement('span');
    name.className = 'tg-name';
    // textContent: the name is whatever the user typed.
    name.textContent = group.name;

    const num = document.createElement('span');
    num.className = 'tg-count';
    num.textContent = String(count);

    el.append(chevron, dot, name, num);
    el.title = `${group.name} — ${count} tab${count === 1 ? '' : 's'}`;

    el.addEventListener('click', () => TabManager.toggleGroupCollapsed(group.id));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showGroupMenu(e.clientX, e.clientY, group);
    });
    return el;
  }

  /** Rename, recolour, ungroup or close everything in a group. */
  function showGroupMenu(x, y, group) {
    const items = [
      { label: 'Rename', action: () => startRenameGroup(group.id) },
      // Named rows rather than a strip of bare swatches: they are built by the
      // same code path as every other row here, and a name is clearer than an
      // unlabelled dot anyway.
      ...Object.entries(TabManager.GROUP_COLORS || {}).map(([key, hex]) => ({
        icon: `<span style="width:11px;height:11px;border-radius:50%;flex:0 0 auto;display:inline-block;background:${hex}"></span>`,
        label: key.charAt(0).toUpperCase() + key.slice(1),
        checked: group.color === key,
        action: () => TabManager.updateGroup(group.id, { color: key })
      })),
      { label: 'Ungroup', action: () => TabManager.ungroup(group.id) },
      { label: 'Close group', danger: true, action: () => {
        const n = TabManager.getAllTabs().filter((t) => t.groupId === group.id).length;
        if (confirm(`Close all ${n} tab${n === 1 ? '' : 's'} in "${group.name}"?`)) {
          TabManager.closeGroup(group.id);
        }
      }}
    ];
    buildGroupMenu(x, y, items, group);
  }

  /**
   * The group menu's own renderer.
   *
   * Named distinctly on purpose. It was called buildMenu, which collides with
   * the bookmarks menu builder declared further down this same file — and
   * because function declarations hoist, the LATER one won. Every call from
   * here was silently rendering through the bookmarks builder, which draws a
   * label and nothing else, so the colour dots never appeared and the swatch
   * row came out empty.
   */
  function buildGroupMenu(x, y, items, group) {
    document.getElementById('sidebar-context-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'sidebar-context-menu';
    menu.style.cssText = `
      position: fixed; left: ${x}px; top: ${y}px; z-index: 99999;
      background: var(--bg-elevated); border: 1px solid var(--border-color);
      border-radius: var(--radius-md); padding: 4px; min-width: 190px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5); animation: fadeIn 0.1s ease;
    `;

    for (const it of items) {

      const btn = document.createElement('div');
      btn.style.cssText = `display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;
        border-radius:6px;color:${it.danger ? 'var(--error)' : 'var(--text-secondary)'};font-size:13px;`;
      btn.innerHTML = `${it.icon || ''}<span class="mi-label"></span>`
        + (it.checked ? '<span style="margin-left:auto;color:var(--accent)">✓</span>' : '');
      // Targeted by class, not by tag. querySelector('span') took the FIRST
      // span in the row — and a colour row's icon IS a span, so the label was
      // written into the coloured dot and wiped it out. Rows with an <svg>
      // icon were unaffected, which is why only the colours lost their dots.
      //
      // textContent, never innerHTML: a group name is whatever the user typed.
      btn.querySelector('.mi-label').textContent = it.label;
      btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-tertiary)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
      btn.addEventListener('click', () => { it.action(); menu.remove(); });
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    autoDismiss(menu);
  }

  function showContextMenu(x, y, tab) {
    document.getElementById('sidebar-context-menu')?.remove();

    const isPinned = pinnedItems.some(p => p.url === tab.url);

    const menu = document.createElement('div');
    menu.id = 'sidebar-context-menu';
    menu.style.cssText = `
      position: fixed; left: ${x}px; top: ${y}px; z-index: 99999;
      background: var(--bg-elevated); border: 1px solid var(--border-color);
      border-radius: var(--radius-md); padding: 4px; min-width: 160px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5); animation: fadeIn 0.1s ease;
    `;

    const pinAction = isPinned ? 'Unpin' : 'Pin to Sidebar';
    const pinIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M9 2l5 5-3 3-2-1-3 3-1-1-3 3v-2l3-3-1-2 3-3z"/></svg>';

    const menuItems = [
      { icon: pinIcon, label: pinAction, action: () => {
        if (isPinned) {
          const pin = pinnedItems.find(p => p.url === tab.url);
          if (pin) unpinItem(pin.id);
        } else {
          pinItem({ id: uid(), title: tab.title || tab.url || 'Untitled', url: tab.url || '' });
        }
      }},
      { icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><rect x="2" y="2" width="12" height="12" rx="2"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="8" y1="6" x2="8" y2="2"/></svg>', label: 'Duplicate Tab', action: () => {
        TabManager.createTab(tab.url || '', true);
      }},
      { icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M2 8a6 6 0 1 0 2-4.5M2 2v3h3"/></svg>', label: 'Reopen Closed Tab', disabled: !TabManager.hasClosedTabs(), action: () => {
        TabManager.reopenClosedTab();
      }},
      ...groupMenuItems(tab),
      { icon: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:14px;height:14px"><path d="M3 3l6 6M9 3l-6 6"/></svg>', label: 'Close Tab', action: () => {
        TabManager.closeTab(tab.id);
      }},
      { icon: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><rect x="2" y="2" width="10" height="10" rx="2"/><path d="M5 5l4 4M9 5l-4 4"/></svg>', label: 'Close Other Tabs', disabled: TabManager.getAllTabs().length < 2, action: () => {
        TabManager.closeOtherTabs(tab.id);
      }}
    ];

    menuItems.forEach(mi => {
      const btn = document.createElement('div');
      const dim = mi.disabled ? 'opacity:0.4;pointer-events:none;' : '';
      btn.style.cssText = `display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;border-radius:6px;color:var(--text-secondary);font-size:13px;transition:all 0.15s ease;${dim}`;
      btn.innerHTML = `${mi.icon}<span class="mi-label"></span>`;
      // Was `<span>${mi.label}</span>`. "Add to <group name>" puts a
      // user-typed string in here, so interpolating it as markup would let a
      // group name inject HTML into the browser's own privileged window.
      btn.querySelector('.mi-label').textContent = mi.label;
      btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-tertiary)'; btn.style.color = 'var(--text-primary)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; btn.style.color = 'var(--text-secondary)'; });
      btn.addEventListener('click', () => { mi.action(); menu.remove(); });
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    autoDismiss(menu);
  }

  // ── Bookmarks (populated via import) ──

  // Render the bookmark tree (folders + links) into the sidebar. Folders are
  // collapsible; their expanded/collapsed state is remembered per title+depth.
  let showHiddenBookmarks = false;

  function loadBookmarks(nodes) {
    const section = document.getElementById('bookmarks-section');
    const list = document.getElementById('bookmarks-list');
    if (!section || !list) return;

    if (!Array.isArray(nodes) || nodes.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    list.innerHTML = '';
    renderNodes(nodes, list, 0);

    // "Show hidden folders" affordance (counts hidden folders at any depth)
    const countHidden = (arr) => arr.reduce((sum, n) => {
      if (n.type !== 'folder') return sum;
      return sum + (n.hidden ? 1 : 0) + countHidden(n.children || []);
    }, 0);
    const hiddenCount = countHidden(nodes);
    if (hiddenCount > 0) {
      const toggle = document.createElement('div');
      toggle.className = 'sidebar-item';
      toggle.style.cssText = 'cursor:pointer;padding-left:8px;color:var(--text-tertiary);font-size:12px;';
      toggle.innerHTML = `<span class="sidebar-label">${showHiddenBookmarks ? 'Hide' : 'Show'} ${hiddenCount} hidden folder${hiddenCount === 1 ? '' : 's'}</span>`;
      toggle.addEventListener('click', () => { showHiddenBookmarks = !showHiddenBookmarks; loadBookmarks(nodes); });
      list.appendChild(toggle);
    }

    updatePinButtonStates();
  }

  function renderNodes(nodes, container, depth) {
    // Folders first, then links — reads cleaner
    const folders = nodes.filter(n => n.type === 'folder' && (showHiddenBookmarks || !n.hidden));
    const links = nodes.filter(n => n.type !== 'folder' && n.url);

    folders.forEach((folder) => {
      const key = `bmfolder:${folder.id || folder.title}`;
      const collapsed = localStorage.getItem(key) === '1';

      const row = document.createElement('div');
      row.className = 'sidebar-item bookmark-folder';
      row.style.cssText = `cursor:pointer;padding-left:${8 + depth * 12}px;${folder.hidden ? 'opacity:0.5;' : ''}`;
      row.innerHTML = `
        <span class="sidebar-item-icon" style="transition:transform .15s;transform:rotate(${collapsed ? '-90deg' : '0deg'});">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5l3 3 3-3"/></svg>
        </span>
        <span class="sidebar-label truncate" style="font-weight:500;">${escapeHtml(folder.title)}${folder.hidden ? ' <span style="font-weight:400;font-size:10px;">(hidden)</span>' : ''}</span>
        <span style="font-size:10px;color:var(--text-tertiary);margin-left:auto;padding-right:6px;">${countLinks(folder)}</span>
      `;

      const childWrap = document.createElement('div');
      childWrap.className = 'bookmark-folder-children';
      childWrap.style.display = collapsed ? 'none' : '';

      row.addEventListener('click', () => {
        const nowCollapsed = childWrap.style.display !== 'none';
        childWrap.style.display = nowCollapsed ? 'none' : '';
        row.querySelector('.sidebar-item-icon').style.transform = `rotate(${nowCollapsed ? '-90deg' : '0deg'})`;
        localStorage.setItem(key, nowCollapsed ? '1' : '0');
      });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); showBookmarkMenu(e.clientX, e.clientY, folder); });

      container.appendChild(row);
      container.appendChild(childWrap);
      renderNodes(folder.children || [], childWrap, depth + 1);
    });

    links.forEach((bm) => {
      let domain = '';
      try { domain = new URL(bm.url).hostname; } catch {}
      const item = document.createElement('div');
      item.className = 'sidebar-item pinnable-item';
      item.dataset.url = bm.url;
      item.dataset.title = bm.title;
      item.style.cssText = `cursor:pointer;padding-left:${8 + depth * 12}px;`;
      item.innerHTML = `
        <span class="sidebar-item-icon">
          <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" style="width:14px;height:14px;" data-on-error="invisible">
        </span>
        <span class="sidebar-label truncate">${escapeHtml(bm.title || bm.url)}</span>
        <button class="pin-btn" title="Pin to sidebar">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:10px;height:10px"><path d="M9 2l5 5-3 3-2-1-3 3-1-1-3 3v-2l3-3-1-2 3-3z"/></svg>
        </button>
      `;
      item.addEventListener('click', (e) => {
        if (e.target.closest('.pin-btn')) return;
        TabManager.navigateTo(bm.url);
      });
      item.querySelector('.pin-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        pinItem({ id: uid(), title: bm.title || bm.url, url: bm.url });
        showToast(`Pinned "${bm.title}"`);
      });
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); showBookmarkMenu(e.clientX, e.clientY, bm); });
      container.appendChild(item);
    });
  }

  function countLinks(folder) {
    let n = 0;
    (folder.children || []).forEach((c) => {
      if (c.type === 'folder') n += countLinks(c);
      else if (c.url) n += 1;
    });
    return n;
  }

  // ── Bookmark right-click menu (rename / move / hide / delete) ──
  function showBookmarkMenu(x, y, node) {
    document.getElementById('sidebar-context-menu')?.remove();
    const isFolder = node.type === 'folder';
    const items = [];

    if (!isFolder) {
      items.push({ label: 'Open', action: () => TabManager.navigateTo(node.url) });
      items.push({ label: 'Open in New Tab', action: () => TabManager.createTab(node.url, true) });
      items.push({ separator: true });
    }
    items.push({ label: 'Rename…', action: async () => {
      const name = await promptModal(isFolder ? 'Rename folder' : 'Rename bookmark', node.title || '');
      if (name) Bookmarks.renameNode(node.id, name);
    }});
    items.push({ label: 'Move to Folder…', action: () => showMoveMenu(x, y, node) });
    if (isFolder) {
      items.push({ label: node.hidden ? 'Show in sidebar' : 'Hide from sidebar', action: () => Bookmarks.toggleHidden(node.id) });
    }
    items.push({ separator: true });
    items.push({ label: isFolder ? 'Delete folder' : 'Delete', danger: true, action: () => Bookmarks.removeNode(node.id) });

    buildMenu(x, y, items);
  }

  function showMoveMenu(x, y, node) {
    document.getElementById('sidebar-context-menu')?.remove();
    const folders = Bookmarks.listFolders().filter(f => f.id !== node.id);
    const items = [{ label: '↑ Top level', action: () => Bookmarks.moveNode(node.id, null) }];
    folders.forEach((f) => items.push({ label: f.path, action: () => Bookmarks.moveNode(node.id, f.id) }));
    buildMenu(x, y, items);
  }

  function buildMenu(x, y, items) {
    const menu = document.createElement('div');
    menu.id = 'sidebar-context-menu';
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:99999;background:var(--bg-elevated);border:1px solid var(--border-color);border-radius:var(--radius-md);padding:4px;min-width:180px;max-height:60vh;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,0.5);animation:fadeIn 0.1s ease;`;
    items.forEach((mi) => {
      if (mi.separator) {
        const sep = document.createElement('div');
        sep.style.cssText = 'height:1px;background:var(--border-color);margin:4px 6px;';
        menu.appendChild(sep);
        return;
      }
      const btn = document.createElement('div');
      btn.style.cssText = `display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;border-radius:6px;font-size:13px;color:${mi.danger ? 'var(--error)' : 'var(--text-secondary)'};transition:all 0.15s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
      btn.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;">${escapeHtml(mi.label)}</span>`;
      btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-tertiary)'; if (!mi.danger) btn.style.color = 'var(--text-primary)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; if (!mi.danger) btn.style.color = 'var(--text-secondary)'; });
      btn.addEventListener('click', () => { mi.action(); menu.remove(); });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    // keep on-screen
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 8}px`;
    if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 8}px`;

    autoDismiss(menu);
  }

  // Small modal input (window.prompt is disabled in Electron)
  function promptModal(title, defaultValue = '') {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';
      overlay.innerHTML = `
        <div style="background:var(--bg-elevated);border:1px solid var(--border-color);border-radius:var(--radius-lg);padding:20px;width:340px;box-shadow:0 16px 48px rgba(0,0,0,0.6);">
          <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:12px;">${escapeHtml(title)}</div>
          <input type="text" id="prompt-modal-input" style="width:100%;padding:8px 10px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-primary);font-size:13px;outline:none;">
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
            <button id="prompt-cancel" style="padding:6px 14px;background:transparent;border:1px solid var(--border-color);border-radius:var(--radius-md);color:var(--text-secondary);font-size:13px;cursor:pointer;">Cancel</button>
            <button id="prompt-ok" style="padding:6px 14px;background:var(--accent);border:none;border-radius:var(--radius-md);color:#fff;font-size:13px;cursor:pointer;">Save</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('#prompt-modal-input');
      input.value = defaultValue;
      input.focus(); input.select();
      const done = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelector('#prompt-ok').addEventListener('click', () => done(input.value.trim()));
      overlay.querySelector('#prompt-cancel').addEventListener('click', () => done(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(input.value.trim());
        if (e.key === 'Escape') done(null);
      });
    });
  }

  return { init, toggle, pinItem, unpinItem, loadBookmarks, showToast, applySidebarMode };
})();
