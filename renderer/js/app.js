// =============================================================================
// Local Mind Browser — App Controller
// =============================================================================
// Initializes all modules and handles global keyboard shortcuts.

const App = (() => {
  async function init() {
    console.log('🧠 Mind Browser initializing...');

    // Tag the platform so the chrome can reserve space for the native window
    // controls on the correct side (see #top-bar in layout.css).
    const plat = window.localMind?.platform || 'darwin';
    document.body.classList.add(
      plat === 'win32' ? 'platform-win' : plat === 'darwin' ? 'platform-mac' : 'platform-linux'
    );

    // Load settings first — other modules read window.mindSettings
    // ── Apply Appearance Settings ──
    window.applyAppearanceSettings = (settings) => {
      const a = settings?.appearance || {};
      
      // Theme
      const isDark = a.theme === 'dark' || (a.theme === 'device' && window.matchMedia('(prefers-color-scheme: dark)').matches) || !a.theme;
      document.body.dataset.theme = isDark ? 'dark' : 'light';
      document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
      
      // Animations
      document.body.classList.toggle('disable-animations', a.showAnimations === false);

      // Tab layout: 'left' hides the top tab bar and uses the sidebar's
      // Open Tabs list as the primary (Arc-style) vertical tab strip.
      document.body.classList.toggle('tabs-left', a.tabLayout === 'left');
      
      // Home Button visibility
      const homeBtn = document.getElementById('btn-home');
      if (homeBtn) homeBtn.style.display = a.showHomeButton !== false ? 'flex' : 'none';

      // Bookmarks bar
      const bookmarksBar = document.getElementById('bookmarks-bar');
      if (bookmarksBar) {
        if (a.showBookmarksBar) {
          bookmarksBar.style.display = 'flex';
        } else if (a.showBookmarksOnNtp && TabManager?.getActiveTab?.()?.url === 'local://newtab') {
          bookmarksBar.style.display = 'flex';
        } else {
          bookmarksBar.style.display = 'none';
        }
      }

      // Font Size Preset
      const fontSizeMap = { small: '12px', medium: '14px', large: '16px' };
      document.documentElement.style.fontSize = fontSizeMap[a.fontSizePreset] || '14px';

      // Page Zoom
      if (a.pageZoom) {
        if (window.TabManager && TabManager.getAllTabs) {
          TabManager.getAllTabs().forEach(t => {
            if (t.webview && typeof t.webview.setZoomFactor === 'function') {
              try { t.webview.setZoomFactor(a.pageZoom / 100); } catch(e){}
            }
          });
        }
      }
      
      // Update Address Bar if format changed
      if (window.TabManager && TabManager.getActiveTab) {
        const activeTab = TabManager.getActiveTab();
        if (activeTab && activeTab.url !== 'local://newtab') {
          const input = document.getElementById('address-input');
          if (input) {
            let displayUrl = activeTab.url;
            if (a.alwaysShowFullUrls === false) {
              displayUrl = displayUrl.replace(/^https?:\/\/(www\.)?/, '');
            }
            if (document.activeElement !== input) {
              input.value = displayUrl;
            }
          }
        }
      }
    };
    
    if (window.localMind) {
      try {
        window.mindSettings = await window.localMind.getSettings();
        // Migration for autofill profiles
        if (!window.mindSettings.autofill) window.mindSettings.autofill = { profiles: [] };
        if (!window.mindSettings.autofill.profiles) window.mindSettings.autofill.profiles = [];
        if (window.mindSettings.profile && (window.mindSettings.profile.name || window.mindSettings.profile.email) && window.mindSettings.autofill.profiles.length === 0) {
          window.mindSettings.autofill.profiles.push({
            id: 'default',
            label: 'Primary',
            name: window.mindSettings.profile.name || '',
            email: window.mindSettings.profile.email || '',
            isDefault: true
          });
          window.localMind.saveSettings(window.mindSettings);
        }
      } catch { window.mindSettings = { autofill: { profiles: [] } }; }
      
      window.applyAppearanceSettings(window.mindSettings);
    }

    // Initialize all modules
    AddressBar.init();
    Downloads.init();
    Sidebar.init();
    AiPanel.init();
    AgentMonitor.init();
    CommandPalette.init();
    Settings.init();
    ReadingMode.init();
    InlineActions.init();
    Speech.init();
    TaskManager.init();
    Appearance.init();
    Volume.init();
    DevPanel.init();
    SplitView.init();
    SmartHighlights.init();
    NewTabPage.init();
    FindBar.init();
    ExtensionsUI.init();
    Bookmarks.init();
    NewsPage.init();
    StoryPage.init();
    CompanyPage.init();
    NotesPage.init();
    HistoryPage.init();
    AgentExecutor.init();
    TabSwitcher.init();
    Shields.init();
    FinancePage.init();

    // First run only. Waits a beat so the chrome has laid out before the tour
    // measures anything, and no-ops entirely once general.onboardedAt is set.
    setTimeout(() => Onboarding?.init(), 600);

    // Private-mode splash search box
    document.getElementById('incognito-search')?.addEventListener('keydown', (e) => {
      const v = e.target.value.trim();
      if (e.key === 'Enter' && v) TabManager.navigateTo(v);
    });

    // Restore the last session, start empty, or recover from a crash.
    //
    // "Restore last session" is a preference. Recovering from a crash is not —
    // if the browser went down without reaching its exit path the tabs were
    // taken away rather than closed, and every other browser puts them back.
    restoreSession();

    // Set up new tab page greeting
    const greeting = document.getElementById('ntp-greeting');
    if (greeting) greeting.textContent = getGreeting(window.mindSettings?.profile?.name || '');

    // New tab button
    document.getElementById('new-tab-btn')?.addEventListener('click', () => {
      TabManager.createTab('', true);
    });

    // Menu button (hamburger) dropdown
    document.getElementById('btn-menu')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAppMenu();
    });

    // New tab page search
    const ntpSearch = document.getElementById('ntp-search');
    if (ntpSearch) {
      ntpSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const query = ntpSearch.value.trim();
          if (query) {
            TabManager.navigateTo(query);
            ntpSearch.value = '';
          }
        }
      });
    }

    // ── Smart Autofill Handlers ──
    EventBus.on('webview:request-autofill', ({ tabId }) => {
      const tab = TabManager.getAllTabs().find(t => t.id === tabId);
      if (tab && tab.webview && window.mindSettings?.autofill?.profiles) {
        tab.webview.send('autofill-data', window.mindSettings.autofill.profiles);
      }
    });

    EventBus.on('webview:form-submitted', ({ data }) => {
      if (window.mindSettings && window.localMind) {
        let changed = false;
        if (!window.mindSettings.autofill) window.mindSettings.autofill = { profiles: [] };
        if (!window.mindSettings.autofill.profiles) window.mindSettings.autofill.profiles = [];
        
        const profiles = window.mindSettings.autofill.profiles;
        
        // Check if exact email/name already exists
        const exists = profiles.some(p => 
          (data.email && p.email === data.email) || 
          (data.name && p.name === data.name && !data.email)
        );

        if (!exists && (data.email || data.name)) {
          profiles.push({
            id: Date.now().toString(),
            label: 'Learned Profile',
            name: data.name || '',
            email: data.email || '',
            isDefault: profiles.length === 0
          });
          changed = true;
        }
        
        if (changed) {
          window.localMind.saveSettings(window.mindSettings);
          // Auto-refresh settings UI if open
          if (window.renderAutofillProfiles) {
            window.renderAutofillProfiles();
          }
        }
      }
    });

    // ── Agent IPC Bindings ──
    if (window.localMind) {
      window.localMind.onAgentNavigate?.((data) => {
        TabManager.navigateTo(data.url);
      });
      window.localMind.onAgentNavigateNewTab?.((data) => {
        TabManager.createTab(data.url, false); // Create in background
      });
      window.localMind.onAgentAction?.((data) => {
        const active = TabManager.getActiveTab();
        if (!active || !active.webview) return;
        
        if (data.action === 'click') {
          active.webview.executeJavaScript(`
            (function() {
              const el = document.querySelector("${data.params.selector.replace(/"/g, '\\"')}");
              if (el) { el.scrollIntoView({block: 'center'}); el.click(); }
            })();
          `);
        } else if (data.action === 'type') {
          active.webview.executeJavaScript(`
            (function() {
              const el = document.querySelector("${data.params.selector.replace(/"/g, '\\"')}");
              if (el) { el.scrollIntoView({block: 'center'}); el.value = "${data.params.text.replace(/"/g, '\\"')}"; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }
            })();
          `);
        }
      });

      // ── Chrome Extension tab callbacks ──
      // An extension called chrome.tabs.create — open a webview tab and hand
      // its guest webContents id back to the main process.
      window.localMind.onExtCreateTab?.(({ requestId, url, active }) => {
        const tab = TabManager.createTab(url || '', active !== false);
        const ack = () => {
          try { window.localMind.extTabCreated(requestId, tab.webview.getWebContentsId()); }
          catch (e) {}
        };
        if (tab.webview) {
          tab.webview.addEventListener('dom-ready', ack, { once: true });
        }
      });

      // chrome.tabs.update({active:true}) — focus the matching tab
      window.localMind.onExtActivateTab?.((wcId) => {
        const tab = TabManager.getTabByWebContentsId(wcId);
        if (tab) TabManager.activateTab(tab.id);
      });

      // chrome.tabs.remove — close the matching tab
      window.localMind.onExtCloseTab?.((wcId) => {
        const tab = TabManager.getTabByWebContentsId(wcId);
        if (tab) TabManager.closeTab(tab.id);
      });
    }

    // ── Global Keyboard Shortcuts ──
    // e.key is normalized to lowercase so CapsLock / Shift don't break matches.
    document.addEventListener('keydown', (e) => {
      const cmd = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const shift = e.shiftKey;

      // Escape — stop loading the active page (when not typing in a field)
      if (!cmd && e.key === 'Escape' && !isTypingTarget(e.target)) {
        TabManager.stopLoading();
        return;
      }

      if (!cmd) return;

      // ⌘⇧T — Reopen Closed Tab (checked before ⌘T)
      if (shift && key === 't') {
        e.preventDefault();
        TabManager.reopenClosedTab();
        return;
      }

      // ⌘T — New Tab
      if (!shift && key === 't') {
        e.preventDefault();
        TabManager.createTab('', true);
      }

      // ⌘W — Close Tab
      if (!shift && key === 'w') {
        e.preventDefault();
        const active = TabManager.getActiveTab();
        if (active) TabManager.closeTab(active.id);
      }

      // ⌘L — Focus Address Bar
      if (!shift && key === 'l') {
        e.preventDefault();
        const input = document.getElementById('address-input');
        input?.focus();
        input?.select();
      }

      // ⌘B — Toggle Sidebar
      if (!shift && key === 'b') {
        e.preventDefault();
        Sidebar.toggle();
      }

      // ⌘⇧L — Toggle AI Panel
      if (shift && key === 'l') {
        e.preventDefault();
        AiPanel.toggle();
      }

      // ⌘R — Reload · ⌘⇧R — Force Reload (Chrome parity)
      if (key === 'r') {
        e.preventDefault();
        if (shift) {
          const wv = TabManager.getActiveTab()?.webview;
          if (wv) { try { wv.reloadIgnoringCache(); } catch { wv.reload(); } }
        } else {
          TabManager.reload();
        }
      }

      // ⌘, — Settings
      if (key === ',') {
        e.preventDefault();
        Settings.open();
      }

      // ⌘⇧] / ⌘⇧[ — Next / Previous Tab
      if (shift && (key === ']' || key === '}')) {
        e.preventDefault();
        cycleTab(1);
      }
      if (shift && (key === '[' || key === '{')) {
        e.preventDefault();
        cycleTab(-1);
      }

      // ⌘⇧E — Reading Mode
      if (shift && key === 'e') {
        e.preventDefault();
        ReadingMode.toggle();
      }

      // ⌘\ — Split View
      if (key === '\\') {
        e.preventDefault();
        SplitView.toggle();
      }

      // ⌘F — Find in Page
      if (!shift && key === 'f') {
        e.preventDefault();
        FindBar.open();
      }

      // ⌘D — Bookmark (pin) current page
      if (!shift && key === 'd') {
        e.preventDefault();
        const active = TabManager.getActiveTab();
        if (active?.url) {
          Sidebar.pinItem({ id: uid(), title: active.title || active.url, url: active.url });
        }
      }

      // ⌘⇧J — Downloads (Chrome parity)
      if (shift && key === 'j') {
        e.preventDefault();
        Downloads.toggle();
      }

      // ⌘⇧N — Incognito Tab
      if (shift && key === 'n') {
        e.preventDefault();
        TabManager.createTab('', true, { incognito: true });
      }

      // ⌘Y is handled by the View menu's accelerator, which opens the real
      // History page. It used to open the command palette here as a stand-in
      // because no History page existed; leaving both in place meant the menu
      // and this handler fired together and cancelled each other out.

      // ⌘1…⌘9 — Jump to tab N (⌘9 = last tab, Chrome parity)
      if (!shift && key >= '1' && key <= '9') {
        e.preventDefault();
        const tabs = TabManager.getAllTabs();
        const idx = key === '9' ? tabs.length - 1 : Number(key) - 1;
        if (tabs[idx]) TabManager.activateTab(tabs[idx].id);
      }

      // ⌘+ / ⌘- / ⌘0 — Zoom
      if (key === '=' || key === '+' || key === '-' || key === '0') {
        e.preventDefault();
        adjustZoom(key === '0' ? 0 : key === '-' ? -0.1 : 0.1);
      }
    });

    // ── Native application menu (macOS menu bar) ──
    if (window.localMind?.onMenuAction) {
      const menuActions = {
        'open-settings': () => Settings.open(),
        'open-settings-shortcuts': () => Settings.open('shortcuts'),
        'menu-new-tab': () => TabManager.createTab('', true),
        'menu-close-tab': () => {
          const active = TabManager.getActiveTab();
          if (active) TabManager.closeTab(active.id);
        },
        'menu-find': () => FindBar.open(),
        'menu-toggle-sidebar': () => Sidebar.toggle(),
        'menu-toggle-ai': () => AiPanel.toggle(),
        'menu-reading-mode': () => ReadingMode.toggle(),
        'menu-split-view': () => SplitView.toggle(),
        'menu-focus-mode': () => FocusMode.toggle(),
        'menu-onion-mode': () => openOnionMode(),
        'menu-history': () => HistoryPage.toggle(),
        'menu-edit-pdf': () => openPdfEditor(),
        'menu-task-manager': () => TaskManager.toggle(),
        'menu-capture-full': () => capturePage('full', 'save'),
        'menu-capture-visible': () => capturePage('visible', 'save'),
        'menu-capture-copy': () => capturePage('full', 'copy'),
        'menu-print': () => {
          // The page's own webContents, not the window's — printing the window
          // would print the browser chrome instead of the page.
          const wv = TabManager.getActiveTab()?.webview;
          if (wv) { try { wv.print(); } catch { Sidebar.showToast?.('Nothing to print.'); } }
          else Sidebar.showToast?.('Open a page first.');
        },
        'menu-copy-url': async () => {
          const url = TabManager.getActiveTab()?.url;
          if (!url) return;
          const ok = await window.localMind?.writeClipboardText?.(url);
          Sidebar.showToast(ok ? 'Page URL copied' : 'Could not copy the URL');
        },
        'menu-command-palette': () => CommandPalette.toggle(),
        'menu-ask-ai': () => document.getElementById('ai-input')?.focus(),
        'menu-summarize': () => EventBus.emit('ai-command', { type: 'ask', query: 'Summarize this page' }),
        'menu-agent-mode': () => AiPanel.setMode('agent'),
        'menu-research-mode': () => AiPanel.setMode('research'),
        'menu-compare': () => AiPanel.setMode('compare'),
        'menu-next-tab': () => cycleTab(1),
        'menu-prev-tab': () => cycleTab(-1),
        'menu-help': () => Settings.open('about'),
        'menu-reload-page': () => TabManager.reload(),
        'menu-force-reload': () => {
          const wv = TabManager.getActiveTab()?.webview;
          if (wv) { try { wv.reloadIgnoringCache(); } catch { wv.reload(); } }
        },
        'menu-zoom-in': () => adjustZoom(0.1),
        'menu-zoom-out': () => adjustZoom(-0.1),
        'menu-zoom-reset': () => adjustZoom(0),
        'menu-reopen-tab': () => TabManager.reopenClosedTab(),
        'menu-downloads': () => Downloads.toggle()
      };
      window.localMind.onMenuAction((channel) => {
        menuActions[channel]?.();
      });
    }

    // Popup / target=_blank links from webviews → open in a new tab
    if (window.localMind?.onOpenUrl) {
      window.localMind.onOpenUrl((url) => {
        if (url) TabManager.createTab(url, true);
      });
    }

    // Check Ollama connection in the background — never block startup on it
    window.localMind?.checkOllama().then((result) => {
      if (result.connected) {
        console.log(`✅ Ollama connected (${result.models.length} models)`);
      } else {
        console.log('⚠️ Ollama not detected — local models unavailable');
      }
    }).catch(() => {});

    console.log('✅ Mind Browser ready');
  }

  // ── Per-site zoom ──────────────────────────────────────────────────────────
  // Zoom used to apply to the current view and then vanish: revisit the site and
  // you were back at 100%, so anyone who zooms because a site's type is too
  // small had to redo it on every visit. Every mainstream browser remembers this
  // per domain, and for an accessibility setting that is the difference between
  // a preference and a chore.
  const ZOOM_KEY = 'mind-site-zoom';

  const zoomStore = (() => {
    try { return JSON.parse(localStorage.getItem(ZOOM_KEY) || '{}'); } catch { return {}; }
  })();

  const zoomHostOf = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  };

  const persistZoom = debounce(() => {
    try { localStorage.setItem(ZOOM_KEY, JSON.stringify(zoomStore)); } catch { /* quota */ }
  }, 400);

  /** The remembered factor for a URL, or the global default. */
  /**
   * Open the previous session's tabs, or a fresh one.
   *
   * Deliberately not awaited by init(): the marker check is a round trip to the
   * main process, and blocking the first paint on it would make every launch
   * feel slower to save a case that happens rarely.
   */
  async function restoreSession() {
    const wantsLast = window.mindSettings?.general?.startupPage === 'last';

    let crashed = false;
    try { crashed = Boolean(await window.localMind?.sessionWasUnclean?.()); }
    catch { crashed = false; }

    const session = TabManager.getLastSession();
    const restoring = (wantsLast || crashed) && session.tabs.length > 0;

    if (!restoring) {
      TabManager.createTab('', true);
      return;
    }

    // Groups first: the tabs reference them by id, so they have to exist before
    // the tabs are put back or the restored tabs land ungrouped.
    TabManager.restoreGroups(session.groups);

    const active = Math.min(Math.max(0, session.activeIndex), session.tabs.length - 1);
    session.tabs.forEach((t, i) => {
      const tab = TabManager.createTab(t.url, i === active);
      if (t.groupId && tab?.id) TabManager.assignToGroup(tab.id, t.groupId);
    });

    // Only say something when the tabs came back from a crash. After a normal
    // "restore last session" start this is just what the user asked for, and
    // announcing it every launch would be noise.
    if (crashed) {
      const n = session.tabs.length;
      Sidebar.showToast?.(`Restored ${n} tab${n === 1 ? '' : 's'} after an unexpected shutdown.`);
    }
  }

  /**
   * Screenshot the current page.
   *
   * @param mode 'full' for the whole document, 'visible' for what is on screen
   * @param how  'save' to a file, 'copy' to the clipboard
   */
  async function capturePage(mode = 'full', how = 'save') {
    const wv = TabManager.getActiveTab()?.webview;
    let id = null;
    try { id = wv?.getWebContentsId?.() ?? null; } catch { id = null; }
    if (!id) { Sidebar.showToast?.('Open a page first.'); return; }

    Sidebar.showToast?.(mode === 'full' ? 'Capturing the full page…' : 'Capturing…');
    const res = how === 'copy'
      ? await window.localMind.captureCopy(id, mode)
      : await window.localMind.capturePage(id, mode);

    if (res?.ok) Sidebar.showToast?.(how === 'copy' ? 'Screenshot copied.' : `Saved ${res.name}`);
    else if (res?.cancelled) Sidebar.showToast?.('Cancelled.');
    else Sidebar.showToast?.(res?.error || 'Could not capture the page.');
  }

  function zoomFor(url) {
    const host = zoomHostOf(url);
    if (host && zoomStore[host]) return zoomStore[host];
    const pct = window.mindSettings?.appearance?.pageZoom;
    return pct ? pct / 100 : 1;
  }

  /** Re-apply a site's zoom after it loads. */
  function applyStoredZoom(tab) {
    if (!tab?.webview || !tab.url) return;
    const factor = zoomFor(tab.url);
    try { if (Math.abs(tab.webview.getZoomFactor() - factor) > 0.001) tab.webview.setZoomFactor(factor); }
    catch { /* webview not ready */ }
  }

  /** Zoom the active page. delta 0 = reset to the site's default. */
  // The toolbar's zoom-out button routes through the same path as ⌘− so the
  // two cannot drift apart.
  EventBus.on('zoom-step', (dir) => adjustZoom(dir * 0.1));

  function adjustZoom(delta) {
    const tab = TabManager.getActiveTab();
    const wv = tab?.webview;
    if (!wv) return;
    try {
      let next;
      if (delta === 0) {
        next = 1;
        // Resetting means "forget my override for this site", not "store 100%",
        // so the global default applies again next visit.
        const host = zoomHostOf(tab.url);
        if (host) delete zoomStore[host];
      } else {
        next = Math.min(3, Math.max(0.3, wv.getZoomFactor() + delta));
        const host = zoomHostOf(tab.url);
        if (host) zoomStore[host] = next;
      }
      wv.setZoomFactor(next);
      persistZoom();
      Sidebar.showToast?.(`Zoom ${Math.round(next * 100)}%`);
    } catch {}
  }

  // ── PDF editing ────────────────────────────────────────────────────────────
  // Chromium's viewer renders PDFs but cannot annotate them, so this opens the
  // same document in the editor instead. A second mode rather than a
  // replacement: the native viewer is faster and has better text selection, so
  // it stays the default and editing is something you ask for.
  // `src` lets a caller name the document directly — the downloads panel opens
  // a file that is not the tab currently in front.
  function openPdfEditor(src) {
    const tab = TabManager.getActiveTab();
    const url = src || tab?.url || '';

    // The editor's own address ends in ".pdf" as well, because the document it
    // is showing rides along as a query parameter. Without this the test below
    // passes and the editor gets wrapped in a second copy of itself, which
    // then tries to parse its own HTML as a PDF.
    if (!src && url.includes('pdf-editor.html')) {
      Sidebar.showToast?.('Already editing this PDF.');
      return;
    }

    if (!/\.pdf(\?|#|$)/i.test(url)) {
      Sidebar.showToast?.('Open a PDF first, then choose Edit PDF.');
      return;
    }
    // Sibling of index.html, not a parent — '../' resolved outside the app
    // bundle and gave ERR_FILE_NOT_FOUND.
    const editor = new URL('pdf-editor.html', window.location.href);
    editor.searchParams.set('src', url);
    TabManager.createTab(editor.toString(), true);
  }

  // Re-apply on every load: a webview resets to 1 on navigation.
  EventBus.on('tab-loaded', (tab) => applyStoredZoom(tab));
  EventBus.on('tab-activated', (tab) => applyStoredZoom(tab));

  /** True when the event target is a place the user types. */
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  // Cycle to the next/previous tab
  function cycleTab(direction) {
    const tabs = TabManager.getAllTabs();
    const activeTab = TabManager.getActiveTab();
    if (!activeTab || tabs.length < 2) return;
    const idx = tabs.findIndex(t => t.id === activeTab.id);
    const nextIdx = (idx + direction + tabs.length) % tabs.length;
    TabManager.activateTab(tabs[nextIdx].id);
  }

  // ── App Menu (hamburger dropdown) ──

  function toggleAppMenu() {
    const existing = document.getElementById('app-menu');
    if (existing) {
      existing.remove();
      return;
    }

    const btn = document.getElementById('btn-menu');
    if (!btn) return;

    const menu = document.createElement('div');
    menu.id = 'app-menu';
    const rect = btn.getBoundingClientRect();
    menu.style.cssText = `
      position: fixed; top: ${rect.bottom + 6}px; right: ${window.innerWidth - rect.right}px; z-index: 99999;
      background: var(--bg-elevated); border: 1px solid var(--border-color);
      border-radius: var(--radius-md); padding: 4px; min-width: 200px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5); animation: fadeIn 0.1s ease;
    `;

    const menuItems = [
      { label: 'New Tab', shortcut: '⌘T', action: () => TabManager.createTab('', true) },
      { label: 'New Incognito Tab', shortcut: '⌘⇧N', action: () => TabManager.createTab('', true, { incognito: true }) },
      { label: 'Open Onion Mode (Tor)', action: () => openOnionMode() },
      { label: 'History', shortcut: '⌘Y', action: () => HistoryPage.show() },
      { label: 'Command Palette', shortcut: '⌘K', action: () => CommandPalette.open() },
      { divider: true },
      { label: 'Downloads', shortcut: '⌘⇧J', action: () => Downloads.open() },
      { label: 'Find in Page', shortcut: '⌘F', action: () => FindBar.open() },
      { label: 'Reopen Closed Tab', shortcut: '⌘⇧T', action: () => TabManager.reopenClosedTab() },
      { label: 'Reading Mode', shortcut: '⌘⇧E', action: () => ReadingMode.toggle() },
      { label: 'Split View', shortcut: '⌘\\', action: () => SplitView.toggle() },
      { label: 'Toggle Sidebar', shortcut: '⌘B', action: () => Sidebar.toggle() },
      { label: 'Toggle AI Panel', shortcut: '⌘⇧L', action: () => AiPanel.toggle() },
      { divider: true },
      // Lives here rather than in the toolbar: a debugging control does not
      // belong between the AI panel and the menu for someone who is just
      // browsing. Settings → Appearance can put it back on the toolbar.
      { label: 'Developer Tools', shortcut: '⌥⌘D', action: () => DevPanel.toggle() },
      { label: 'Task Manager', shortcut: '⇧Esc', action: () => TaskManager.toggle() },
      { label: 'Capture Full Page…', shortcut: '⌘⇧S', action: () => capturePage('full', 'save') },
      { label: 'New Conversation', action: () => AiPanel.newChat() },
      { divider: true },
      { label: 'Settings', shortcut: '⌘,', action: () => Settings.open() }
    ];

    menuItems.forEach(mi => {
      if (mi.divider) {
        const div = document.createElement('div');
        div.style.cssText = 'height:1px;background:var(--border-color);margin:4px 8px;';
        menu.appendChild(div);
        return;
      }
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px;padding:6px 12px;cursor:pointer;border-radius:6px;color:var(--text-secondary);font-size:13px;transition:all 0.15s ease;';
      item.innerHTML = `<span>${mi.label}</span>${mi.shortcut ? `<span style="font-size:11px;color:var(--text-tertiary);">${mi.shortcut}</span>` : ''}`;
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--bg-tertiary)'; item.style.color = 'var(--text-primary)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'none'; item.style.color = 'var(--text-secondary)'; });
      item.addEventListener('click', () => { menu.remove(); mi.action(); });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);

    // Close on click outside or Escape
    const closeMenu = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type === 'click' && menu.contains(e.target)) return;
      menu.remove();
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('keydown', closeMenu);
    };
    setTimeout(() => {
      document.addEventListener('click', closeMenu);
      document.addEventListener('keydown', closeMenu);
    }, 10);
  }

  // ── Onion Mode ────────────────────────────────────────────────────────────
  // Starting Tor takes a few seconds, so the entry point reports progress
  // rather than appearing to do nothing. A missing binary is a setup problem
  // with a specific fix, not a failure — say which.
  async function openOnionMode() {
    if (!window.localMind?.onionOpen) return;

    const off = window.localMind.onOnionStatus?.((s) => {
      if (s.state === 'failed') return;
      const msg = s.state === 'ready'
        ? 'Connected to Tor.'
        : s.progress ? `Connecting to Tor… ${s.progress}%` : 'Starting Tor…';
      Sidebar.showToast?.(msg);
    });

    try {
      const res = await window.localMind.onionOpen();
      if (!res?.ok) {
        Sidebar.showToast?.(res?.error || 'Onion Mode could not start.');
      }
    } catch (err) {
      Sidebar.showToast?.(err?.message || 'Onion Mode could not start.');
    } finally {
      off?.();
    }
  }

  // Initialize when DOM is ready
  document.addEventListener('DOMContentLoaded', init);

  return { init, openPdfEditor };
})();
