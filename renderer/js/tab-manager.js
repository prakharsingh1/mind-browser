// =============================================================================
// Local Mind Browser — Tab Manager
// =============================================================================
// Manages browser tabs: creation, switching, closing, and webview lifecycle.
//
// Rendering strategy: the tab bar is updated INCREMENTALLY. Each tab owns one
// DOM element (created once, listeners attached once); state changes only
// touch the attributes that actually changed. The previous version rebuilt
// every element on every loading/title/favicon event, which caused favicon
// flicker, listener churn, and visible jank while pages loaded.

const TabManager = (() => {
  const tabs = [];              // Array of tab objects
  let activeTabId = null;       // Currently active tab ID

  // Most-recently-used order, newest first. Ctrl+Tab walks this instead of the
  // sidebar order, so bouncing between the two tabs you are actually working in
  // is one shortcut no matter how many tabs sit between them.
  //
  // It is frozen while the switcher is open: without that, each step would
  // reorder the list under the selection and Ctrl+Tab could only ever toggle
  // between two tabs.
  let mru = [];
  let mruFrozen = false;

  function touchMru(id) {
    if (mruFrozen) return;
    mru = [id, ...mru.filter((x) => x !== id)];
  }

  /** Live tabs in MRU order; anything never activated falls in behind. */
  function getMruTabs() {
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const ordered = mru.map((id) => byId.get(id)).filter(Boolean);
    const seen = new Set(ordered.map((t) => t.id));
    return [...ordered, ...tabs.filter((t) => !seen.has(t.id))];
  }

  const freezeMru = () => { mruFrozen = true; };

  /** Close the switcher, promoting whatever the user landed on. */
  function unfreezeMru(commitId) {
    mruFrozen = false;
    if (commitId) touchMru(commitId);
  }
  const tabEls = new Map();     // tabId → tab-bar DOM element
  const closedStack = [];       // recently closed tabs (for ⌘⇧T), most recent last
  const CLOSED_MAX = 25;
  const webviewContainer = () => document.getElementById('webview-container');
  const tabBar = () => document.getElementById('tab-bar');
  const newTabPage = () => document.getElementById('new-tab-page');
  const preloadPath = '../main/preload-webview.js';

  const HISTORY_KEY = 'mind-history';
  const HISTORY_MAX = 2000;
  const LAST_TABS_KEY = 'mind-last-tabs';

  // ── Browsing history: in-memory, persisted lazily ──
  // The old implementation JSON-parsed and re-serialized the whole list on
  // EVERY navigation (synchronously, on the UI thread). Now the array lives in
  // memory and writes are debounced.
  let history = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      // Entries recorded before internal pages were excluded — the browser's
      // own editor and reader listed as places the user had been. Drop them
      // once on load rather than leaving them to be deleted by hand.
      return Array.isArray(saved) ? saved.filter((h) => !isInternalUrl(h?.url)) : [];
    } catch { return []; }
  })();
  const persistHistory = debounce(() => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch {}
  }, 800);

  const persistOpenTabs = debounce(() => {
    // Title and icon as well as the URL: a restored session that shows twenty
    // identical "Loading…" tabs is much harder to pick your way back into than
    // one that still looks like the session you lost. Private tabs are left
    // out — restoring them would defeat the point of opening them.
    const open = tabs
      .filter((t) => t.url && !t.incognito)
      .map((t) => ({
        url: t.url, title: t.title || '', favicon: t.favicon || '',
        pinned: !!t.pinned, groupId: t.groupId || null
      }));
    const activeIndex = Math.max(0, open.findIndex((t) => {
      const cur = tabs.find((x) => x.id === activeTabId);
      return cur && t.url === cur.url;
    }));
    try {
      localStorage.setItem(LAST_TABS_KEY, JSON.stringify({ v: 3, tabs: open, activeIndex, groups }));
    } catch { /* quota */ }
  }, 500);

  // Settle both on the way out. Quitting inside the debounce window otherwise
  // dropped the write entirely: a page visited seconds before quitting never
  // reached history, and a tab opened just before quitting was missing from the
  // restored session.
  // pagehide as well as beforeunload — beforeunload does not always fire when a
  // renderer is torn down.
  for (const evt of ['beforeunload', 'pagehide']) {
    window.addEventListener(evt, () => {
      persistHistory.flush();
      persistOpenTabs.flush();
    });
  }

  /**
   * Create a new tab.
   * @param {string} url - URL to load (empty = new tab page)
   * @param {boolean} activate - Whether to activate this tab immediately
   * @param {object} opts - { incognito: boolean }
   * @returns {object} tab object
   */
  // ── PDF routing ────────────────────────────────────────────────────────────
  // Chromium's built-in viewer renders a PDF and stops there — no highlighting,
  // no notes, no export. Ours does all of that and renders the same document,
  // so a PDF opened from the web goes to ours unless the user turns this off.
  const PDF_PREF_KEY = 'mind-pdf-own-viewer';
  const useOwnPdfViewer = () => localStorage.getItem(PDF_PREF_KEY) !== 'off';

  const looksLikePdf = (url) => /^https?:\/\/[^#]*\.pdf(\?|#|$)/i.test(String(url || ''));

  /**
   * The editor's own URL for a document. Returns null when the URL should be
   * loaded normally — including, importantly, when it is already the editor,
   * which would otherwise recurse.
   */
  function pdfViewerUrl(url) {
    if (!useOwnPdfViewer()) return null;
    if (!looksLikePdf(url)) return null;
    const editor = new URL('pdf-editor.html', window.location.href);
    editor.searchParams.set('src', url);
    return editor.toString();
  }

  function createTab(url = '', activate = true, opts = {}) {
    url = pdfViewerUrl(url) || url;
    const id = uid();
    const tab = {
      id,
      title: url ? 'Loading...' : (opts.incognito ? 'Incognito' : 'New Tab'),
      url: url || '',
      favicon: '',
      isLoading: false,
      failed: false,
      incognito: !!opts.incognito,
      sleeping: false,
      lastActiveAt: Date.now(),
      webview: null
    };

    tabs.push(tab);

    if (url) {
      attachWebview(tab, url);
    }

    syncTabBar();

    if (activate) {
      activateTab(id);
    }

    EventBus.emit('tab-created', tab);
    return tab;
  }

  /**
   * Create the webview element for a tab and wire up all its events.
   */
  function attachWebview(tab, url) {
    const wv = document.createElement('webview');
    wv.id = `webview-${tab.id}`;
    wv.src = url;
    wv.setAttribute('preload', preloadPath);
    wv.setAttribute('allowpopups', '');

    // Maximum privacy turns JavaScript off. webpreferences is read when the
    // webview is created and cannot be changed afterwards, which is why this
    // only takes effect on tabs opened after the setting changes.
    const priv = window.mindSettings?.privacy || {};
    const jsOff = priv.overrides?.disableJavaScript ?? (priv.level >= 5);
    if (jsOff) wv.setAttribute('webpreferences', 'javascript=no');
    if (tab.incognito) {
      // In-memory session (no "persist:" prefix) — nothing written to disk
      wv.setAttribute('partition', 'incognito');
    }
    // Chromium's PDF engine (PDFium) ships with Electron but stays off unless
    // plugins are enabled. Without it a PDF link downloads the file instead of
    // opening in place. This is the same engine Edge renders PDFs with.
    wv.setAttribute('plugins', '');

    wv.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;display:none;';

    wv.addEventListener('did-start-loading', () => {
      tab.isLoading = true;
      tab.failed = false;
      syncTab(tab);
      updateAddressBar(tab);
      updateProgressBar();
      updateReloadButton();
    });

    wv.addEventListener('did-stop-loading', () => {
      tab.isLoading = false;
      syncTab(tab);
      updateNavButtons();
      updateProgressBar();
      updateReloadButton();
      // Anything that has to re-apply itself after a navigation hangs off this
      // — a webview resets its zoom factor on every load, for one.
      EventBus.emit('tab-loaded', tab);
    });

    // Render a friendly in-place error page on main-frame load failures.
    // errorCode -3 (ERR_ABORTED) fires on normal stop()/redirects — ignore it.
    wv.addEventListener('did-fail-load', (e) => {
      if (!e.isMainFrame || e.errorCode === -3) return;
      tab.isLoading = false;
      tab.failed = true;
      tab.title = 'Page unavailable';
      syncTab(tab);
      updateProgressBar();
      updateReloadButton();
      showErrorPage(wv, e.validatedURL || tab.url, e.errorDescription || 'unknown error');
    });

    // A tab whose renderer dies goes blank and stays blank — no message, no way
    // back, and the page simply vanishes. Chrome shows "Aw, Snap!" for exactly
    // this. Recover in place instead of leaving an empty rectangle.
    const onGone = (reason) => {
      tab.isLoading = false;
      tab.failed = true;
      tab.title = 'Tab crashed';
      syncTab(tab);
      updateProgressBar();
      updateReloadButton();
      showCrashPage(wv, tab, reason);
    };
    wv.addEventListener('crashed', () => onGone('the page stopped responding'));
    wv.addEventListener('render-process-gone', (e) => {
      // A clean exit is a normal teardown, not a crash.
      const reason = e?.details?.reason || e?.reason;
      if (reason === 'clean-exit') return;
      onGone(reason === 'oom' ? 'the page ran out of memory' : 'the page stopped responding');
    });

    // Chromium fires this when the page has blocked its own thread. Left alone
    // the tab looks frozen with no explanation.
    wv.addEventListener('unresponsive', () => {
      Sidebar.showToast?.(`"${(tab.title || 'A tab').slice(0, 40)}" is not responding.`);
    });

    wv.addEventListener('page-title-updated', (e) => {
      tab.title = e.title || 'Untitled';
      syncTab(tab);
      updateHistoryTitle(tab);
      EventBus.emit('tab-title-changed', tab);
    });

    wv.addEventListener('page-favicon-updated', (e) => {
      if (e.favicons && e.favicons.length > 0 && tab.favicon !== e.favicons[0]) {
        tab.favicon = e.favicons[0];
        syncTab(tab);
        // The icon lands after the entry was recorded, so backfill it — this is
        // what lets the history page show real icons without asking a third
        // party for them.
        updateHistoryTitle(tab);
      }
    });

    wv.addEventListener('did-navigate', (e) => {
      tab.url = e.url;
      updateAddressBar(tab);
      updateNavButtons();
      recordHistory(tab);
      persistOpenTabs();
    });

    wv.addEventListener('did-navigate-in-page', (e) => {
      if (e.isMainFrame) {
        tab.url = e.url;
        updateAddressBar(tab);
        updateNavButtons();
        recordHistory(tab);
      }
    });

    // Chromium tells us when a tab actually starts making sound, which is a far
    // more reliable signal than watching the DOM for <video> elements.
    wv.addEventListener('media-started-playing', () => {
      tab.audible = true;
      // A tab muted before it started playing has to be muted again here: the
      // guest's audio state resets across navigations, so the flag on the tab
      // is the source of truth rather than whatever the webview currently has.
      if (tab.muted) { try { wv.setAudioMuted(true); } catch {} }
      EventBus.emit('tab-audio-started', tab);
      // The sidebar redraws on 'tabs-updated'. Without this the speaker badge
      // never appeared, because becoming audible is not otherwise a tab change.
      EventBus.emit('tabs-updated', getAllTabs());
    });
    wv.addEventListener('media-paused', () => {
      tab.audible = false;
      EventBus.emit('tab-audio-stopped', tab);
      EventBus.emit('tabs-updated', getAllTabs());
    });

    // Handle messages from webview preload
    wv.addEventListener('ipc-message', (e) => {
      EventBus.emit(`webview:${e.channel}`, { tabId: tab.id, data: e.args[0] });
    });

    tab.webview = wv;
    webviewContainer().appendChild(wv);
    return wv;
  }

  /** Inject a clean error page into a webview whose main-frame load failed. */
  /**
   * Shown when a tab's renderer process dies.
   *
   * Deliberately separate from the network error page: nothing is wrong with
   * the site or the connection, so telling someone the site "refused to
   * connect" would send them chasing the wrong problem.
   */
  function showCrashPage(wv, tab, reason) {
    const url = String(tab.url || '');
    const html = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  min-height:80vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                  background:#101410;color:#e8ece8;text-align:center;padding:24px;">
        <div style="font-size:44px;margin-bottom:18px;">😵</div>
        <div style="font-size:19px;font-weight:600;margin-bottom:8px;">This tab crashed</div>
        <div style="font-size:13.5px;color:#9aa39a;max-width:430px;line-height:1.6;margin-bottom:22px;">
          ${String(reason).replace(/[<>&]/g, '')}. Your other tabs are unaffected, and reloading
          usually fixes it.</div>
        <button onclick="location.reload()" style="background:#2bd473;color:#08150c;border:none;border-radius:8px;
                padding:9px 22px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;">Reload the page</button>
      </div>`;
    try {
      // The webview has no live renderer to inject into, so reload it onto the
      // crash notice rather than trying to script the dead one.
      wv.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        `<!doctype html><meta charset="utf-8"><title>Tab crashed</title>` +
        `<style>html,body{margin:0;background:#101410;height:100%}</style>${html}` +
        `<script>history.replaceState(null,'',${JSON.stringify(url)})<\/script>`
      ));
    } catch { /* the tab is being closed */ }
  }

  function showErrorPage(wv, failedUrl, description) {
    let host = failedUrl;
    try { host = new URL(failedUrl).hostname; } catch {}
    const html = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  min-height:80vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                  background:#101410;color:#e8ece8;text-align:center;padding:24px;">
        <div style="font-size:44px;margin-bottom:18px;">🌐</div>
        <div style="font-size:19px;font-weight:600;margin-bottom:8px;">This site can’t be reached</div>
        <div style="font-size:13.5px;color:#9aa39a;max-width:420px;line-height:1.6;margin-bottom:6px;">
          <b style="color:#c9d1c9;">${host.replace(/[<>&]/g, '')}</b> refused to connect or could not be found.</div>
        <div style="font-size:12px;color:#6d766d;margin-bottom:22px;">${String(description).replace(/[<>&]/g, '')}</div>
        <button onclick="location.reload()" style="background:#2bd473;color:#08150c;border:none;border-radius:8px;
                padding:9px 22px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;">Retry</button>
      </div>`;
    try {
      // Also flatten the failed document's own body margin/background so no
      // white frame shows around the injected page.
      wv.executeJavaScript(
        `document.documentElement.innerHTML = ${JSON.stringify(html)};
         document.documentElement.style.cssText = 'background:#101410;height:100%;';
         document.body.style.cssText = 'margin:0;background:#101410;min-height:100%;';
         undefined;`
      ).catch(() => {});
    } catch {}
  }

  /**
   * Activate a tab by ID.
   */
  function activateTab(id) {
    if (activeTabId === id && tabs.find(t => t.id === id)?.webview?.style.display !== 'none') {
      // already active and visible — nothing to do
    }
    const prevActive = activeTabId;
    activeTabId = id;
    const tab = tabs.find(t => t.id === id);
    if (tab) tab.lastActiveAt = Date.now();
    touchMru(id);

    // Wake a sleeping tab by recreating its webview
    if (tab && tab.sleeping && tab.url) {
      tab.sleeping = false;
      tab.title = 'Loading...';
      attachWebview(tab, tab.url);
    }

    // Hide all webviews except the active one
    tabs.forEach(t => {
      if (t.webview) t.webview.style.display = (t.id === id) ? 'flex' : 'none';
    });

    // Show new tab page, private splash, or webview
    const ntp = newTabPage();
    const inc = document.getElementById('incognito-page');
    document.body.classList.toggle('incognito-active', !!(tab && tab.incognito));

    if (tab && tab.webview) {
      if (ntp) ntp.style.display = 'none';
      if (inc) inc.style.display = 'none';
      // Lets the wallpaper layer show through only on the New Tab page
      document.body.classList.remove('ntp-visible');
      updateAddressBar(tab);
      // Tell the extension system which tab is active
      try { window.localMind?.extSelectTab?.(tab.webview.getWebContentsId()); } catch (e) {}
    } else {
      const isIncognitoNewTab = tab && tab.incognito;
      if (ntp) ntp.style.display = isIncognitoNewTab ? 'none' : 'flex';
      if (inc) inc.style.display = isIncognitoNewTab ? 'flex' : 'none';
      document.body.classList.toggle('ntp-visible', !isIncognitoNewTab);
      // Clear address bar for new tab
      const addressInput = document.getElementById('address-input');
      if (addressInput) {
        addressInput.value = '';
        addressInput.placeholder = isIncognitoNewTab ? 'Search privately or enter address…' : 'Search or enter URL...';
      }
      // The new-tab page is a DOM overlay, not a webview, so the extension
      // runtime has no page to treat as the active tab — clicking an extension
      // icon here would throw "Unable to get active tab". Keep the most recent
      // real webview selected so extension popups still work from the NTP.
      const fallback = [...tabs].reverse().find(t => t.webview);
      try {
        window.localMind?.extSelectTab?.(fallback ? fallback.webview.getWebContentsId() : null);
      } catch (e) {}
    }

    // Only the two affected tab elements change state
    if (prevActive !== id) {
      const prevTab = tabs.find(t => t.id === prevActive);
      if (prevTab) syncTab(prevTab);
    }
    if (tab) syncTab(tab);
    emitTabsUpdated();
    updateNavButtons();
    updateProgressBar();
    updateReloadButton();
    EventBus.emit('tab-activated', tab);
  }

  /**
   * Close a tab by ID (with a quick collapse animation in the tab bar).
   */
  function closeTab(id) {
    const index = tabs.findIndex(t => t.id === id);
    if (index === -1) return;
    // Deferred: the tab is still in the array at this point, so pruning now
    // would keep a group alive on the strength of the tab being closed.
    setTimeout(pruneGroups, 0);

    const tab = tabs[index];

    // Push onto the reopen stack (skip empty/incognito tabs)
    if (tab.url && !tab.incognito) {
      closedStack.push({ url: tab.url, title: tab.title });
      if (closedStack.length > CLOSED_MAX) closedStack.shift();
    }

    // Remove webview immediately (frees the renderer process)
    if (tab.webview) {
      tab.webview.remove();
    }

    tabs.splice(index, 1);

    // Animate the tab element out, then drop it
    const el = tabEls.get(id);
    tabEls.delete(id);
    if (el) {
      el.classList.add('tab-closing');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      // Fallback removal in case transitions are disabled
      setTimeout(() => el.remove(), 200);
    }

    mru = mru.filter((x) => x !== id);

    // If we closed the active tab, fall back to the one used most recently
    // rather than whatever happens to sit next to it in the sidebar.
    if (activeTabId === id) {
      if (tabs.length > 0) {
        const next = getMruTabs()[0] || tabs[Math.min(index, tabs.length - 1)];
        activateTab(next.id);
      } else {
        createTab('', true);
      }
    } else {
      emitTabsUpdated();
    }

    persistOpenTabs();
    EventBus.emit('tab-closed', { id });
  }

  /**
   * A navigation turned out to be a file download — the page never commits,
   * leaving the tab blank on "Loading...". Recover like Chrome: go back to
   * the previous page if there is one, otherwise reset to the new-tab page.
   */
  function recoverDownloadTab(url) {
    const tab = tabs.find(t => t.url === url) ||
                (getActiveTab()?.title === 'Loading...' ? getActiveTab() : null);
    if (!tab || !tab.webview) return;
    tab.isLoading = false;
    let recovered = false;
    try {
      if (tab.webview.canGoBack()) {
        tab.webview.goBack();
        recovered = true;
      }
    } catch {}
    if (!recovered) {
      // No page to return to — reset the tab to a fresh new-tab state
      try { tab.webview.remove(); } catch {}
      tab.webview = null;
      tab.url = '';
      tab.title = tab.incognito ? 'Incognito' : 'New Tab';
      tab.favicon = '';
      if (tab.id === activeTabId) activateTab(tab.id);
    }
    syncTab(tab);
    updateProgressBar();
    updateReloadButton();
  }

  /** Reopen the most recently closed tab (⌘⇧T). */
  function reopenClosedTab() {
    const entry = closedStack.pop();
    if (entry) createTab(entry.url, true);
  }

  /** Duplicate a tab (defaults to the active one). */
  function duplicateTab(id = activeTabId) {
    const tab = tabs.find(t => t.id === id);
    if (tab) createTab(tab.url || '', true, { incognito: tab.incognito });
  }

  /** Close every tab except the given one. */
  function closeOtherTabs(id = activeTabId) {
    tabs.filter(t => t.id !== id).forEach(t => closeTab(t.id));
  }

  /** Whether there's a closed tab to reopen — lets the sidebar menu enable/disable its item. */
  function hasClosedTabs() {
    return closedStack.length > 0;
  }

  /**
   * Navigate the active tab to a URL.
   */
  // A PDF whose URL gave no hint — the main process spotted it in the response
  // headers. Swap that tab over to our viewer.
  window.localMind?.onAppEvent?.('pdf-detected', ({ url, webContentsId }) => {
    if (!useOwnPdfViewer()) return;
    const tab = tabs.find((t) => {
      try { return t.webview?.getWebContentsId?.() === webContentsId; } catch { return false; }
    });
    if (!tab?.webview) return;
    const editor = new URL('pdf-editor.html', window.location.href);
    editor.searchParams.set('src', url);
    // Guard against re-entering on the editor's own load.
    if (String(tab.webview.src).includes('pdf-editor.html')) return;
    tab.webview.src = editor.toString();
  });

  function navigateTo(url) {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;

    // News, Finance, Notes and History are full-page views layered over the
    // content area. They only stepped aside when a TAB was activated, so
    // typing an address while one was open loaded the page invisibly behind
    // it — the address bar changed and nothing else did.
    EventBus.emit('leave-page-views');

    url = normalizeInput(url);
    url = pdfViewerUrl(url) || url;

    if (tab.webview) {
      tab.webview.src = url;
    } else {
      // Tab didn't have a webview yet (was on new tab page)
      tab.url = url;
      tab.title = 'Loading...';
      attachWebview(tab, url);
      tab.webview.style.display = 'flex';

      // Hide new tab page and private splash
      const ntp = newTabPage();
      if (ntp) ntp.style.display = 'none';
      const inc = document.getElementById('incognito-page');
      if (inc) inc.style.display = 'none';
    }

    tab.url = url;
    updateAddressBar(tab);
    syncTab(tab);
  }

  /**
   * Turn address-bar input into a URL: pass URLs through (adding https:// when
   * missing), send everything else to the configured search engine.
   */
  // ── Search bangs ───────────────────────────────────────────────────────────
  // "!g cats" searches Google, "!yt lofi" searches YouTube. Only the common
  // ones live here; anything unrecognised is handed to DuckDuckGo, which
  // resolves the full public catalogue of thousands. That way the useful ones
  // are instant and offline, without shipping a giant table nobody reads.
  const BANGS = {
    g: 'https://www.google.com/search?q=%s',
    ddg: 'https://duckduckgo.com/?q=%s',
    b: 'https://www.bing.com/search?q=%s',
    gm: 'https://www.google.com/maps/search/%s',
    maps: 'https://www.google.com/maps/search/%s',
    yt: 'https://www.youtube.com/results?search_query=%s',
    w: 'https://en.wikipedia.org/w/index.php?search=%s',
    gh: 'https://github.com/search?q=%s',
    so: 'https://stackoverflow.com/search?q=%s',
    mdn: 'https://developer.mozilla.org/en-US/search?q=%s',
    npm: 'https://www.npmjs.com/search?q=%s',
    r: 'https://www.reddit.com/search/?q=%s',
    a: 'https://www.amazon.com/s?k=%s',
    img: 'https://duckduckgo.com/?q=%s&iax=images&ia=images',
    t: 'https://translate.google.com/?text=%s'
  };

  /**
   * Pull a leading or trailing "!bang" out of the input.
   * @returns {string|null} a URL, or null when there is no bang to act on.
   */
  function resolveBang(input) {
    const m = /^!(\S+)\s+([\s\S]+)$/.exec(input) || /^([\s\S]+?)\s+!(\S+)$/.exec(input);
    if (!m) return null;
    // The two patterns capture in opposite orders.
    const bang = (input.startsWith('!') ? m[1] : m[2]).toLowerCase();
    const query = (input.startsWith('!') ? m[2] : m[1]).trim();
    if (!query) return null;

    // A user's own bangs win, so they can redirect !g at something else.
    const custom = window.mindSettings?.general?.customBangs || {};
    const template = custom[bang] || BANGS[bang];
    if (template) return template.replace('%s', encodeURIComponent(query));

    // Unknown: let DuckDuckGo resolve it against the full catalogue.
    return 'https://duckduckgo.com/?q=' + encodeURIComponent('!' + bang + ' ' + query);
  }

  function normalizeInput(raw) {
    const input = raw.trim();
    if (/^(https?|file|view-source|about|chrome):/i.test(input)) return input;

    const bang = resolveBang(input);
    if (bang) return bang;
    // localhost[:port], IPs, or anything with a dot and no spaces → URL
    if (/^localhost(:\d+)?(\/|$)/i.test(input) ||
        /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(input) ||
        (input.includes('.') && !input.includes(' '))) {
      return 'https://' + input;
    }
    return searchUrl(input);
  }

  /** Build a search URL from the configured search engine setting. */
  function searchUrl(query) {
    const engine = window.mindSettings?.general?.searchEngine || 'duckduckgo';
    const engines = {
      duckduckgo: 'https://duckduckgo.com/?q=',
      google: 'https://www.google.com/search?q=',
      bing: 'https://www.bing.com/search?q='
    };
    return (engines[engine] || engines.duckduckgo) + encodeURIComponent(query);
  }

  /**
   * Update the address bar to reflect a tab's state.
   */
  function updateAddressBar(tab) {
    if (!tab || tab.id !== activeTabId) return;
    const input = document.getElementById('address-input');
    if (input && tab.url && tab.url !== 'local://newtab') {
      let displayUrl = tab.url;
      if (window.mindSettings?.appearance?.alwaysShowFullUrls === false && document.activeElement !== input) {
        displayUrl = displayUrl.replace(/^https?:\/\/(www\.)?/, '');
      }
      if (document.activeElement !== input) {
        input.value = displayUrl;
      }
    } else if (input && tab.url === 'local://newtab') {
      input.value = '';
    }
    // Update security icon
    const lockIcon = document.querySelector('#address-bar .address-security');
    if (lockIcon && tab.url) {
      const secure = tab.url.startsWith('https://');
      lockIcon.style.color = secure ? 'var(--accent)' : 'var(--warning)';
      lockIcon.title = secure ? 'Secure connection' : 'Connection is not secure';
    }
  }

  /** Enable/disable the back and forward buttons for the active tab. */
  function updateNavButtons() {
    const tab = tabs.find(t => t.id === activeTabId);
    const backBtn = document.getElementById('btn-back');
    const fwdBtn = document.getElementById('btn-forward');
    let canBack = false, canFwd = false;
    try {
      if (tab?.webview) {
        canBack = tab.webview.canGoBack();
        canFwd = tab.webview.canGoForward();
      }
    } catch { /* webview not attached yet */ }
    if (backBtn) backBtn.disabled = !canBack;
    if (fwdBtn) fwdBtn.disabled = !canFwd;
  }

  /** Show/hide the thin loading bar above the page for the active tab. */
  function updateProgressBar() {
    const bar = document.getElementById('page-progress');
    if (!bar) return;
    const tab = tabs.find(t => t.id === activeTabId);
    const loading = !!tab?.isLoading;
    bar.classList.toggle('hidden', !loading);
    bar.classList.toggle('loading', loading);
    if (!loading) bar.style.width = '0%';
  }

  /** Swap the reload button between ↻ (idle) and ✕ (loading → stop). */
  function updateReloadButton() {
    const btn = document.getElementById('btn-reload');
    if (!btn) return;
    const tab = tabs.find(t => t.id === activeTabId);
    const loading = !!tab?.isLoading;
    if (btn.dataset.mode === (loading ? 'stop' : 'reload')) return;
    btn.dataset.mode = loading ? 'stop' : 'reload';
    btn.title = loading ? 'Stop loading (Esc)' : 'Reload';
    btn.innerHTML = loading
      ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
      : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5V5H11"/></svg>';
  }

  /** Stop loading the active tab. */
  function stopLoading() {
    const tab = tabs.find(t => t.id === activeTabId);
    try { tab?.webview?.stop(); } catch {}
  }

  // ── Browsing History ──

  function getHistory() {
    return history;
  }

  /**
   * Forget browsing history.
   *
   * There was previously no way to do this at all: history accumulated to 2000
   * entries and fed the address bar forever, with no page to see it and nothing
   * to clear it. In a browser that leads on privacy that is a conspicuous gap —
   * "clear site data on quit" said nothing about the list of every page visited.
   *
   * @param {number} [since] epoch ms; omit to clear everything
   */
  function clearHistory(since) {
    history = since ? history.filter((h) => h.ts < since) : [];
    persistHistory();
    EventBus.emit('history-changed');
    return history.length;
  }

  /** Remove one entry, matched on url+timestamp so duplicates stay distinct. */
  function removeHistoryEntry(url, ts) {
    const before = history.length;
    history = history.filter((h) => !(h.url === url && h.ts === ts));
    if (history.length !== before) {
      persistHistory();
      EventBus.emit('history-changed');
    }
    return before - history.length;
  }

  /**
   * Mute or unmute one tab.
   *
   * Per tab, not per site: the thing people want to silence is the tab that
   * started playing something, and they want the one they are watching to keep
   * its sound. The flag is kept on the tab so it survives a navigation within
   * that tab, which is what makes muting an autoplaying news site actually
   * stick as you click through it.
   */
  function setTabMuted(id, muted) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return false;
    tab.muted = Boolean(muted);
    try { tab.webview?.setAudioMuted(tab.muted); } catch { /* not attached yet */ }
    syncTab(tab);
    EventBus.emit('tabs-updated', getAllTabs());
    return tab.muted;
  }

  const toggleTabMuted = (id) => {
    const tab = tabs.find((t) => t.id === id);
    return setTabMuted(id, !tab?.muted);
  };

  // ── Tab groups ─────────────────────────────────────────────────────────────
  // Chrome's model, adapted to a vertical tab list: a group is a coloured,
  // named, collapsible band and a tab belongs to at most one.
  //
  // The group lives on the tab as `groupId` rather than the group holding a
  // list of tab ids. With one owner per tab there is no second copy of the
  // relationship to fall out of sync, and closing a tab needs no cleanup.
  const GROUP_COLORS = {
    grey:   '#9aa4b2',
    blue:   '#5b9dff',
    green:  '#2bd473',
    yellow: '#f5b544',
    red:    '#f4708f',
    purple: '#a78bfa',
    teal:   '#31c8c0'
  };

  let groups = [];        // { id, name, color, collapsed }

  const getGroups = () => groups;
  const groupById = (id) => groups.find((g) => g.id === id) || null;

  function createGroup(name, color, tabIds = []) {
    const used = new Set(groups.map((g) => g.color));
    const free = Object.keys(GROUP_COLORS).find((c) => !used.has(c));
    const group = {
      id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      name: name || 'New group',
      // Pick a colour nobody is using yet, so two groups are told apart at a
      // glance instead of both being blue.
      color: color || free || 'blue',
      collapsed: false
    };
    groups.push(group);
    for (const id of tabIds) assignToGroup(id, group.id);
    persistOpenTabs();
    EventBus.emit('tabs-updated', getAllTabs());
    return group;
  }

  function updateGroup(id, patch) {
    const g = groupById(id);
    if (!g) return null;
    Object.assign(g, patch);
    persistOpenTabs();
    EventBus.emit('tabs-updated', getAllTabs());
    return g;
  }

  function assignToGroup(tabId, groupId) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.groupId = groupId || null;
    // A tab pulled out of a collapsed group has to become visible again,
    // otherwise it is in the list but hidden with no way to reach it.
    if (!groupId) tab.hidden = false;
    persistOpenTabs();
    EventBus.emit('tabs-updated', getAllTabs());
  }

  /** Dissolve a group, leaving its tabs open and ungrouped. */
  function ungroup(groupId) {
    for (const t of tabs) if (t.groupId === groupId) { t.groupId = null; t.hidden = false; }
    groups = groups.filter((g) => g.id !== groupId);
    persistOpenTabs();
    EventBus.emit('tabs-updated', getAllTabs());
  }

  function closeGroup(groupId) {
    for (const t of tabs.filter((x) => x.groupId === groupId)) closeTab(t.id);
    groups = groups.filter((g) => g.id !== groupId);
    persistOpenTabs();
    EventBus.emit('tabs-updated', getAllTabs());
  }

  function toggleGroupCollapsed(groupId) {
    const g = groupById(groupId);
    if (!g) return;
    g.collapsed = !g.collapsed;

    // Collapsing the group holding the active tab would leave the page on
    // screen with nothing selected in the list. Move to a visible tab first.
    if (g.collapsed) {
      const active = tabs.find((t) => t.id === activeTabId);
      if (active?.groupId === groupId) {
        const other = tabs.find((t) => t.id !== activeTabId && t.groupId !== groupId);
        if (other) activateTab(other.id);
      }
    }
    persistOpenTabs();
    EventBus.emit('tabs-updated', getAllTabs());
  }

  /** Drop groups that no longer hold any tabs. */
  function pruneGroups() {
    const alive = new Set(tabs.map((t) => t.groupId).filter(Boolean));
    const before = groups.length;
    groups = groups.filter((g) => alive.has(g.id));
    if (groups.length !== before) persistOpenTabs();
  }

  /** Search history by substring across url+title. Returns newest-first. */
  function searchHistory(query, limit = 8) {
    const q = query.toLowerCase();
    const out = [];
    for (const h of history) {
      if (h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q)) {
        out.push(h);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /**
   * Pages that belong to the browser itself, not to the user's browsing.
   *
   * The PDF editor, the reader and the error pages all live on file:// inside
   * the app bundle. Recording them meant a run of "PDF Editor" entries in
   * someone's history for a document they opened once — our own furniture
   * presented as somewhere they had been.
   */
  function isInternalUrl(url) {
    if (!url) return true;
    if (/^(about:|chrome:|devtools:|data:|blob:)/i.test(url)) return true;
    // Our own pages, wherever the bundle happens to live.
    if (/^file:\/\//i.test(url) && /(app\.asar|local-mind-browser)\/renderer\//i.test(url)) return true;
    return false;
  }

  function recordHistory(tab) {
    if (tab.incognito || !tab.url || tab.url === 'about:blank') return;
    if (isInternalUrl(tab.url)) return;
    // Collapse consecutive duplicates
    if (history[0]?.url === tab.url) return;
    history.unshift({
      url: tab.url,
      title: tab.title || tab.url,
      ts: Date.now(),
      // Kept so the history page can show a real icon rather than inventing
      // one, and without asking a third party for it.
      favicon: tab.favicon || null
    });
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    persistHistory();
  }

  function updateHistoryTitle(tab) {
    if (tab.incognito || !tab.url) return;
    if (history[0]?.url === tab.url && (tab.title || tab.favicon)) {
      if (tab.title) history[0].title = tab.title;
      // The icon usually arrives after the title, so take it whenever it lands.
      if (tab.favicon) history[0].favicon = tab.favicon;
      persistHistory();
    }
  }

  /** Drop every entry for one site. */
  function removeHistorySite(host) {
    const before = history.length;
    history = history.filter((h) => {
      try { return new URL(h.url).hostname.replace(/^www\./, '') !== host; }
      catch { return true; }
    });
    if (history.length !== before) {
      persistHistory();
      EventBus.emit('history-changed');
    }
    return before - history.length;
  }

  /** Remove a specific set of entries, keyed on url+timestamp. */
  function removeHistoryEntries(keys) {
    const drop = new Set(keys.map((k) => `${k.url}\u0000${k.ts}`));
    const before = history.length;
    history = history.filter((h) => !drop.has(`${h.url}\u0000${h.ts}`));
    if (history.length !== before) {
      persistHistory();
      EventBus.emit('history-changed');
    }
    return before - history.length;
  }

  // ── Memory Saver: sleep inactive background tabs ──
  // Removing the <webview> kills its renderer process and frees the RAM;
  // the tab wakes (reloads) when activated again.

  const SLEEP_CHECK_MS = 60 * 1000;

  function sleepTab(id) {
    const tab = tabs.find(t => t.id === id);
    if (!tab || !tab.webview || tab.sleeping || id === activeTabId) return false;
    // Don't sleep the visible half of a split view
    if (tab.webview.classList?.contains('split-right')) return false;
    try { tab.webview.remove(); } catch {}
    tab.webview = null;
    tab.sleeping = true;
    tab.isLoading = false;
    syncTab(tab);
    return true;
  }

  /**
   * Sleep background tabs. When force=true, sleeps all of them regardless
   * of the timeout; otherwise only those inactive past the configured limit.
   * @returns {number} how many tabs were put to sleep
   */
  function sleepInactiveTabs(force = false) {
    const perf = window.mindSettings?.performance || {};
    if (!force && perf.tabSleepEnabled === false) return 0;
    const timeout = (perf.tabSleepMinutes || 15) * 60 * 1000;
    const now = Date.now();
    let slept = 0;

    tabs.forEach(t => {
      if (t.id === activeTabId || !t.webview || t.sleeping) return;
      if (!force && now - (t.lastActiveAt || now) < timeout) return;
      // Sleeping DISCARDS the page — a half-written email or a filled-in form
      // does not survive the reload. Sites the user has excluded stay awake
      // even on an explicit "sleep now".
      if (isSleepExempt(t.url, perf)) return;
      // Keep tabs that are playing audio awake
      let audible = false;
      try { audible = t.webview.isCurrentlyAudible(); } catch {}
      if (audible) return;
      if (sleepTab(t.id)) slept++;
    });
    return slept;
  }

  /** Does this URL match one of the "never sleep" entries? */
  function isSleepExempt(url, perf = window.mindSettings?.performance || {}) {
    const list = perf.neverSleep;
    if (!Array.isArray(list) || !list.length) return false;
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return false; }
    if (!host) return false;
    // An entry covers its subdomains, so "google.com" also spares mail.google.com.
    return list.some(entry => {
      const e = String(entry).trim().replace(/^www\./, '').toLowerCase();
      return e && (host === e || host.endsWith(`.${e}`));
    });
  }

  setInterval(() => sleepInactiveTabs(false), SLEEP_CHECK_MS);

  /**
   * The previous session, as { tabs: [{url,title,favicon,pinned}], activeIndex }.
   * Accepts the old format — a bare array of URLs — so an upgrade does not
   * throw away the session that was open at the time.
   */
  function getLastSession() {
    try {
      const raw = JSON.parse(localStorage.getItem(LAST_TABS_KEY) || 'null');
      if (Array.isArray(raw)) {
        return { tabs: raw.filter(Boolean).map((url) => ({ url })), activeIndex: 0, groups: [] };
      }
      if (raw && Array.isArray(raw.tabs)) {
        return {
          tabs: raw.tabs.filter((t) => t && t.url),
          activeIndex: raw.activeIndex || 0,
          groups: Array.isArray(raw.groups) ? raw.groups : []
        };
      }
    } catch { /* unreadable */ }
    return { tabs: [], activeIndex: 0, groups: [] };
  }

  /** Put back the groups a restored session belonged to. */
  function restoreGroups(saved) {
    groups = (saved || []).filter((g) => g && g.id).map((g) => ({
      id: g.id,
      name: g.name || 'Group',
      color: g.color || 'blue',
      collapsed: Boolean(g.collapsed)
    }));
  }

  /** Kept for callers that only want the URLs. */
  function getLastOpenTabs() {
    return getLastSession().tabs.map((t) => t.url);
  }

  /** Go back in the active tab */
  function goBack() {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab?.webview?.canGoBack()) tab.webview.goBack();
  }

  /** Go forward in the active tab */
  function goForward() {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab?.webview?.canGoForward()) tab.webview.goForward();
  }

  /** Reload the active tab */
  function reload() {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab?.webview) tab.webview.reload();
  }

  // ── Tab bar rendering (incremental) ──

  const SPINNER_SVG = '<svg class="spin-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>';
  const GLOBE_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><circle cx="8" cy="8" r="6"/><line x1="2" y1="8" x2="14" y2="8"/><path d="M8 2a10 10 0 0 1 2.5 6 10 10 0 0 1-2.5 6 10 10 0 0 1-2.5-6A10 10 0 0 1 8 2z"/></svg>';

  /** Create the (one) DOM element for a tab. Listeners are attached once. */
  function createTabEl(tab) {
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.dataset.tabId = tab.id;
    tabEl.innerHTML = `
      <span class="tab-favicon-slot"></span>
      <span class="tab-title"></span>
      <span class="tab-close" title="Close tab">×</span>
    `;

    tabEl.addEventListener('click', (e) => {
      if (!e.target.classList.contains('tab-close')) {
        activateTab(tab.id);
      }
    });
    // Middle-click closes (Chrome behavior)
    tabEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(tab.id); }
    });
    tabEl.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    tabEls.set(tab.id, tabEl);
    return tabEl;
  }

  /** Update one tab's element in place — touch only what changed. */
  function syncTab(tab) {
    const el = tabEls.get(tab.id);
    if (!el) return syncTabBar();
    syncTabUi(tab, el);
    emitTabsUpdated();
  }

  /** Ensure the tab bar has one element per tab, in order. */
  function syncTabBar() {
    const bar = tabBar();
    if (!bar) return;
    const newTabBtn = bar.querySelector('#new-tab-btn');

    // Remove elements for tabs that no longer exist (skip ones mid-animation)
    for (const [id, el] of tabEls) {
      if (!tabs.some(t => t.id === id)) {
        tabEls.delete(id);
        el.remove();
      }
    }

    // Insert/move elements into the right order
    let prev = null;
    for (const tab of tabs) {
      let el = tabEls.get(tab.id);
      if (!el) el = createTabEl(tab);
      const expectedPrev = prev;
      if (el.previousElementSibling !== expectedPrev || el.parentElement !== bar) {
        bar.insertBefore(el, expectedPrev ? expectedPrev.nextSibling : bar.firstChild);
      }
      prev = el;
      syncTabUi(tab, el);
    }
    // Keep the new-tab button last
    if (newTabBtn && newTabBtn.nextSibling) bar.appendChild(newTabBtn);

    emitTabsUpdated();
  }

  // Update element state without re-emitting tabs-updated (syncTabBar emits once)
  function syncTabUi(tab, el) {
    const active = tab.id === activeTabId;
    el.classList.toggle('active', active);
    el.classList.toggle('tab-loading', tab.isLoading);
    el.classList.toggle('tab-sleeping', tab.sleeping);
    const titleText = `${tab.sleeping ? '💤 ' : ''}${tab.incognito ? '🕶 ' : ''}${truncate(tab.title, 25)}`;
    const titleEl = el.querySelector('.tab-title');
    if (titleEl.textContent !== titleText) titleEl.textContent = titleText;
    const slot = el.querySelector('.tab-favicon-slot');
    const iconKey = tab.isLoading ? 'spinner' : (tab.favicon || 'globe');
    if (slot.dataset.icon !== iconKey) {
      slot.dataset.icon = iconKey;
      slot.innerHTML = tab.isLoading
        ? `<div class="tab-favicon">${SPINNER_SVG}</div>`
        : tab.favicon
          ? `<img class="tab-favicon" src="${escapeHtml(tab.favicon)}" width="16" height="16" data-on-error="hide">`
          : `<div class="tab-favicon">${GLOBE_SVG}</div>`;
    }
  }

  // Sidebar & other listeners get a lightweight snapshot. Coalesce bursts
  // (e.g. several tabs loading at once) into one emit per frame.
  let tabsUpdateQueued = false;
  function emitTabsUpdated() {
    if (tabsUpdateQueued) return;
    tabsUpdateQueued = true;
    requestAnimationFrame(() => {
      tabsUpdateQueued = false;
      // Everything the sidebar draws has to be in here. It used to carry only
      // id/title/url/favicon/active, so group membership, mute state and pinning
      // silently vanished on every coalesced update — the sidebar was drawing
      // from a snapshot that had already thrown those fields away.
      EventBus.emit('tabs-updated', tabs.map(t => ({
        id: t.id, title: t.title, url: t.url, favicon: t.favicon,
        active: t.id === activeTabId,
        groupId: t.groupId || null,
        audible: !!t.audible,
        muted: !!t.muted,
        pinned: !!t.pinned
      })));
    });
  }

  /** Get the active tab */
  function getActiveTab() {
    return tabs.find(t => t.id === activeTabId) || null;
  }

  /** Get all tabs */
  function getAllTabs() {
    return tabs;
  }

  /** Find the tab whose webview hosts the given guest webContents id */
  function getTabByWebContentsId(wcId) {
    return tabs.find(t => {
      try { return t.webview && t.webview.getWebContentsId() === wcId; }
      catch (e) { return false; }
    }) || null;
  }

  return {
    createTab,
    activateTab,
    closeTab,
    recoverDownloadTab,
    reopenClosedTab,
    duplicateTab,
    closeOtherTabs,
    hasClosedTabs,
    navigateTo,
    normalizeInput,
    resolveBang,
    searchUrl,
    goBack,
    goForward,
    reload,
    stopLoading,
    getActiveTab,
    getAllTabs,
    getTabByWebContentsId,
    getHistory,
    searchHistory,
    clearHistory,
    removeHistoryEntry,
    removeHistoryEntries,
    removeHistorySite,
    getLastOpenTabs,
    getLastSession,
    setTabMuted,
    toggleTabMuted,
    GROUP_COLORS,
    getGroups,
    groupById,
    createGroup,
    updateGroup,
    assignToGroup,
    ungroup,
    closeGroup,
    toggleGroupCollapsed,
    restoreGroups,
    sleepTab,
    sleepInactiveTabs,
    isSleepExempt,
    getMruTabs,
    freezeMru,
    unfreezeMru
  };
})();
