// =============================================================================
// Local Mind Browser — New Tab Page
// =============================================================================
// Owns the greeting, clock, weather, notes, news, shortcuts, recent
// conversations and wallpaper. Every widget renders from cache first and
// upgrades in place, so the page never shows a broken or empty state.

const NewTabPage = (() => {
  // ── Persistence ────────────────────────────────────────────────────────────
  const KEYS = {
    note: 'ntp.note',
    shortcuts: 'ntp.shortcuts',
    recentCollapsed: 'ntp.recentCollapsed',
    weather: 'ntp.weatherCache',
    news: 'ntp.newsCache',
    wallpaper: 'ntp.wallpaper',
    icons: 'ntp.iconCache',
    name: 'ntp.displayName'
  };

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
    }
  };

  const DEFAULT_SHORTCUTS = [
    { id: 's1', name: 'Google', url: 'https://google.com' },
    { id: 's2', name: 'GitHub', url: 'https://github.com' },
    { id: 's3', name: 'HN', url: 'https://news.ycombinator.com' },
    { id: 's4', name: 'Docs', url: 'https://devdocs.io' },
    { id: 's5', name: 'Gmail', url: 'https://mail.google.com' },
    { id: 's6', name: 'YouTube', url: 'https://youtube.com' },
    { id: 's7', name: 'X / Twitter', url: 'https://x.com' },
    { id: 's8', name: 'Reddit', url: 'https://reddit.com' }
  ];

  let clockInterval = null;
  let clockObserver = null;
  let noteTimer = null;
  let newsRotator = null;
  let initialised = false;

  const uid = () => 'sc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const $ = (id) => document.getElementById(id);

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    if (initialised) return;
    initialised = true;

    applyWallpaper();
    initClock();
    initNotes();
    renderShortcuts();
    initRecent();
    initWidgetMenus();

    // One-shot entrance; the class is dropped so later re-renders don't replay it.
    const inner = document.querySelector('.ntp-inner');
    if (inner) {
      inner.classList.add('ntp-enter');
      setTimeout(() => inner.classList.remove('ntp-enter'), 900);
    }

    ensureDisplayName();
    updateGreeting();
    setInterval(updateGreeting, 60_000);

    // Paint cached weather/news instantly, then refresh in the background.
    renderWeather(store.get(KEYS.weather, null), { cached: true });
    renderNews(store.get(KEYS.news, null), { cached: true });
    refreshWeather();
    refreshNews();

    renderRecentChats();
    EventBus.on('chat-saved', renderRecentChats);
    EventBus.on('clock-theme-changed', initClock);
    EventBus.on('ntp-wallpaper-changed', applyWallpaper);
    EventBus.on('ntp-widgets-changed', () => { refreshWeather(true); refreshNews(true); });

    // Re-sync when the New Tab page becomes visible again.
    EventBus.on('tab-activated', (tab) => {
      if (tab && tab.url) return;
      initClock();
      applyWallpaper();
      refreshWeather();
      refreshNews();
    });
  }

  // ── Greeting ───────────────────────────────────────────────────────────────
  function updateGreeting() {
    const el = document.querySelector('#new-tab-page h1');
    if (!el) return;
    // Prefer the name set in Settings; otherwise fall back to the account's
    // first name so the greeting feels personal out of the box.
    const name = window.mindSettings?.profile?.name || store.get(KEYS.name, '') || '';
    el.textContent = getGreeting(name) + '.';
  }

  /** Resolve the OS display name once, then keep it in local storage. */
  function ensureDisplayName() {
    if (store.get(KEYS.name, null) !== null) return;
    window.localMind?.ntpDisplayName?.().then((res) => {
      if (res?.ok && res.data) {
        store.set(KEYS.name, res.data);
        updateGreeting();
      }
    }).catch(() => {});
  }

  // ── Clock ──────────────────────────────────────────────────────────────────
  function clockConfig() {
    return window.mindSettings?.widgets?.clock || { timezone: '', appearance: 'analog' };
  }

  function tzNow(tz) {
    if (!tz) return new Date();
    try { return new Date(new Date().toLocaleString('en-US', { timeZone: tz })); }
    catch { return new Date(); }
  }

  function initClock() {
    const cfg = clockConfig();
    const mount = document.querySelector('.ntp-clock-mount');
    if (!mount) return;

    ClockThemes.mount(mount, ClockThemes.resolveId(cfg), fitScale(mount));

    // The face is the whole widget — the timezone lives in the tooltip so the
    // tile stays clean.
    const tz = cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const place = tz.includes('/') ? tz.split('/').pop().replace(/_/g, ' ') : '';
    mount.closest('.ntp-clock')?.setAttribute('title', place || 'Local time');

    const update = () => ClockThemes.tick(mount, tzNow(cfg.timezone));
    update();
    clearInterval(clockInterval);
    clockInterval = setInterval(update, 1000);

    // Rescale on any layout change so the face fits at every window size / DPI.
    clockObserver?.disconnect();
    clockObserver = new ResizeObserver(() => {
      mount.style.setProperty('--ct-scale', fitScale(mount));
    });
    clockObserver.observe(mount);
  }

  /** Largest scale that fits the 160px face inside its host, with breathing room. */
  function fitScale(mount) {
    const r = mount.getBoundingClientRect();
    const size = Math.min(r.width || 96, r.height || 96);
    return Math.max(0.3, Math.min(1, (size - 6) / 160));
  }

  // ── Notes ──────────────────────────────────────────────────────────────────
  function initNotes() {
    const ta = $('ntp-note');
    const status = $('ntp-note-status');
    const count = $('ntp-note-count');
    const saveBtn = $('ntp-note-save');
    if (!ta) return;

    // The widget is a window onto the real notes store, not a separate buffer —
    // it edits the most recently touched note, so the Notes page and this stay
    // in lockstep.
    let noteId = null;
    const syncFromStore = () => {
      const note = NotesStore.list({ sort: 'updated' })[0];
      noteId = note ? note.id : null;
      ta.value = note ? note.body : '';
      updateCount();
    };
    syncFromStore();
    EventBus.on('notes-changed', () => {
      if (document.activeElement !== ta) syncFromStore();
    });

    const flash = (text, cls = '') => {
      if (!status) return;
      status.textContent = text;
      status.className = `ntp-note-status show ${cls}`;
      clearTimeout(status._t);
      status._t = setTimeout(() => { status.className = 'ntp-note-status'; }, 1600);
    };

    function updateCount() {
      if (count) count.textContent = `${ta.value.length}`;
    }

    function save() {
      const text = ta.value;
      if (!noteId) {
        if (!text.trim()) return;                 // don't create empty notes
        noteId = NotesStore.create(text).id;
      } else {
        const cur = NotesStore.get(noteId);
        if (!cur || cur.body === text) return;
        NotesStore.update(noteId, { body: text });
      }
      flash('Saved', 'saved');
    }

    // Debounced autosave while typing, so we're not hitting storage per keypress.
    ta.addEventListener('input', () => {
      updateCount();
      if (status) { status.textContent = 'Saving…'; status.className = 'ntp-note-status show'; }
      clearTimeout(noteTimer);
      noteTimer = setTimeout(save, 500);
    });
    // Never lose the buffer if the note loses focus or the tab goes away.
    ta.addEventListener('blur', () => { clearTimeout(noteTimer); save(); });
    window.addEventListener('beforeunload', save);

    saveBtn?.addEventListener('click', () => { clearTimeout(noteTimer); save(); });

    ta.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        { label: 'Save Note', action: () => { clearTimeout(noteTimer); save(); } },
        { label: 'Clear Note', action: () => { ta.value = ''; updateCount(); save(); ta.focus(); } },
        { label: 'Open in Notes', action: () => { try { NotesPage.show(); } catch {} } },
        { sep: true },
        {
          label: 'Delete Note', danger: true, action: () => {
            if (noteId) { NotesStore.remove(noteId); noteId = null; }
            ta.value = '';
            updateCount();
            flash('Deleted');
          }
        }
      ]);
    });
  }

  // ── Widget context menus ───────────────────────────────────────────────────
  // Every widget answers a right-click with actions relevant to it, plus a
  // shared route into its settings. (Notes wires its own richer menu.)
  const openSettings = (section) => {
    try { Settings.open(section); } catch { /* settings not ready */ }
  };

  function initWidgetMenus() {
    const menus = {
      'ntp-weather': () => [
        { label: 'Refresh Weather', action: () => { renderWeatherLoading(); refreshWeather(true); } },
        { label: 'Change Location…', action: () => openSettings('widgets') },
        { sep: true },
        { label: 'Widget Settings…', action: () => openSettings('widgets') }
      ],
      'ntp-news': () => [
        { label: 'Next Headline', action: () => refreshNews(true) },
        { label: 'Open Story', action: () => document.getElementById('ntp-news')?.click() },
        { label: 'Open News Hub', action: () => { try { NewsPage.show(); } catch {} } },
        { sep: true },
        { label: 'Change Topic…', action: () => openSettings('news') }
      ]
    };

    Object.entries(menus).forEach(([id, build]) => {
      const el = $(id);
      el?.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, build());
      });
    });

    // Clock lives in a wrapper the theme re-renders into, so bind the widget.
    document.querySelector('.ntp-clock')?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX, e.clientY, [
        { label: 'Change Clock Face…', action: () => openSettings('widgets') },
        { label: 'Change Timezone…', action: () => openSettings('widgets') },
        { sep: true },
        { label: 'Refresh Clock', action: initClock }
      ]);
    });

    // Right-clicking empty page space offers page-level actions.
    document.querySelector('.ntp-scroll')?.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.ntp-widget, .ntp-shortcut, .ntp-chat, #ntp-note')) return;
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        { label: 'Add Shortcut…', action: () => editShortcut(-1) },
        { label: 'Change Wallpaper…', action: () => openSettings('wallpaper') },
        { sep: true },
        { label: 'Refresh Widgets', action: () => { refreshWeather(true); refreshNews(true); initClock(); } }
      ]);
    });
  }

  // ── Weather ────────────────────────────────────────────────────────────────
  function weatherCity() {
    // Empty city => auto-detect from IP.
    return window.mindSettings?.widgets?.weather?.city ?? '';
  }

  async function refreshWeather(force = false) {
    const el = $('ntp-weather');
    if (!el || !window.localMind?.ntpWeather) return;

    const cache = store.get(KEYS.weather, null);
    const fresh = cache && Date.now() - cache.at < 15 * 60_000;
    if (fresh && !force) return;              // cached render already on screen
    if (!cache) renderWeatherLoading();

    try {
      const res = await window.localMind.ntpWeather(weatherCity() || 'auto');
      if (res?.ok) {
        const payload = { ...res.data, at: Date.now() };
        store.set(KEYS.weather, payload);
        renderWeather(payload);
      } else {
        renderWeatherError(cache, res?.error);
      }
    } catch (err) {
      renderWeatherError(cache, err.message);
    }
  }

  function renderWeatherLoading() {
    const el = $('ntp-weather');
    if (!el) return;
    el.className = 'ntp-widget ntp-weather';
    el.innerHTML = `
      <div class="ntp-wx-top">
        <div>
          <div class="ntp-wx-temp">—°</div>
          <div class="ntp-wx-label">Loading…</div>
        </div>
      </div>
      <div class="ntp-wx-bottom"><span class="ntp-wx-city">Locating…</span></div>`;
  }

  function renderWeatherError(cache, reason) {
    // Prefer showing slightly stale data over an error tile.
    if (cache) return renderWeather(cache, { stale: true });
    const el = $('ntp-weather');
    if (!el) return;
    const offline = !navigator.onLine;
    el.className = 'ntp-widget ntp-weather is-error';
    el.innerHTML = `
      <div class="ntp-wx-top">
        <div>
          <div class="ntp-wx-label" style="font-size:12px;margin-top:0">
            ${offline ? 'You’re offline' : 'Weather unavailable'}
          </div>
        </div>
      </div>
      <div class="ntp-wx-bottom">
        <button class="ntp-wx-retry" id="ntp-wx-retry">Try again</button>
      </div>`;
    $('ntp-wx-retry')?.addEventListener('click', () => { renderWeatherLoading(); refreshWeather(true); });
    if (reason) console.debug('[ntp] weather failed:', reason);
  }

  const WX_ICONS = {
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/>',
    'cloud-sun': '<circle cx="8.5" cy="8" r="3"/><path d="M8.5 2.6v1.6M3.1 8h1.6M4.7 4.2l1.1 1.1M12.3 4.2l-1.1 1.1"/><path d="M17.5 20H8a3.7 3.7 0 0 1 0-7.4h.3A5 5 0 0 1 18 13.4a3.3 3.3 0 0 1-.5 6.6z"/>',
    cloud: '<path d="M17.5 19H7.6a4 4 0 0 1 0-8h.3A5.4 5.4 0 0 1 18.3 12a3.5 3.5 0 0 1-.8 7z"/>',
    fog: '<path d="M17.5 15H7.6a4 4 0 0 1 0-8h.3A5.4 5.4 0 0 1 18.3 8a3.5 3.5 0 0 1-.8 7z"/><path d="M4 19h16M7 22h10"/>',
    drizzle: '<path d="M17.5 14H7.6a4 4 0 0 1 0-8h.3A5.4 5.4 0 0 1 18.3 7a3.5 3.5 0 0 1-.8 7z"/><path d="M8 18v1.6M12 18v2.4M16 18v1.6"/>',
    rain: '<path d="M17.5 14H7.6a4 4 0 0 1 0-8h.3A5.4 5.4 0 0 1 18.3 7a3.5 3.5 0 0 1-.8 7z"/><path d="M8 17.5l-1 3M12.5 17.5l-1 3M17 17.5l-1 3"/>',
    sleet: '<path d="M17.5 14H7.6a4 4 0 0 1 0-8h.3A5.4 5.4 0 0 1 18.3 7a3.5 3.5 0 0 1-.8 7z"/><path d="M9 17.5l-1 3M16 17.5l-1 3"/><circle cx="12.5" cy="19" r="1"/>',
    snow: '<path d="M17.5 14H7.6a4 4 0 0 1 0-8h.3A5.4 5.4 0 0 1 18.3 7a3.5 3.5 0 0 1-.8 7z"/><path d="M8 18.5h.01M12 20h.01M16 18.5h.01M10 21h.01M14 21h.01"/>',
    storm: '<path d="M17.5 13H7.6a4 4 0 0 1 0-8h.3A5.4 5.4 0 0 1 18.3 6a3.5 3.5 0 0 1-.8 7z"/><path d="M12.5 15l-2.5 4h3l-2 4"/>'
  };

  function wxIcon(name) {
    return `<svg class="ntp-wx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${WX_ICONS[name] || WX_ICONS.cloud}</svg>`;
  }

  function renderWeather(data, opts = {}) {
    const el = $('ntp-weather');
    if (!el || !data || data.temp == null) return;
    el.className = `ntp-widget ntp-weather${data.isDay ? '' : ' is-night'}`;
    el.innerHTML = `
      <div class="ntp-wx-top">
        <div style="min-width:0">
          <div class="ntp-wx-temp">${data.temp}°</div>
          <div class="ntp-wx-label">${escapeHtml(data.label || '')}</div>
        </div>
        ${wxIcon(data.icon)}
      </div>
      <div class="ntp-wx-bottom">
        <span class="ntp-wx-city">${escapeHtml(data.city || '')}</span>
        <span class="ntp-wx-range">H:${data.high}° L:${data.low}°</span>
      </div>`;
    el.title = `Feels like ${data.feelsLike}° · ${data.label}${opts.stale ? ' (offline — last known)' : ''}`;
  }

  // ── News ───────────────────────────────────────────────────────────────────
  function newsTopic() {
    return window.mindSettings?.widgets?.news?.topic || 'general';
  }

  async function refreshNews(force = false) {
    const el = $('ntp-news');
    if (!el || !window.localMind?.ntpNews) return;

    const cache = store.get(KEYS.news, null);
    const fresh = cache && cache.topic === newsTopic() && Date.now() - cache.at < 10 * 60_000;
    if (fresh && !force) return;

    try {
      const res = await window.localMind.ntpNews(newsTopic());
      if (res?.ok && res.data.articles?.length) {
        const payload = { ...res.data, topic: newsTopic(), at: Date.now() };
        store.set(KEYS.news, payload);
        renderNews(payload);
      } else if (!cache) {
        renderNewsEmpty();
      }
    } catch {
      if (!cache) renderNewsEmpty();
    }
  }

  function renderNewsEmpty() {
    const el = $('ntp-news');
    if (!el) return;
    el.style.cursor = 'default';
    el.innerHTML = `
      <div class="ntp-news-bg"></div><div class="ntp-news-scrim"></div>
      <div class="ntp-news-body">
        <div class="ntp-news-title">${navigator.onLine ? 'Headlines unavailable' : 'You’re offline'}</div>
      </div>`;
  }

  /**
   * A headline only "communicates the story" if it isn't clamped mid-sentence.
   * The tile fits ~3 lines (≈105 chars), so prefer complete headlines that fit
   * and keep the longer ones only as a fallback.
   */
  function readableArticles(articles) {
    const tidy = articles.map(a => ({
      ...a,
      title: a.title
        .replace(/\s*\|\s*.*$/, '')                    // trailing " | Section"
        .replace(/^\s*(LIVE|WATCH|BREAKING)[:\s-]+/i, '') // shouty prefixes
        .trim()
    }));
    const fits = tidy.filter(a => a.title.length <= 105 && a.title.length >= 30);
    const pool = fits.length ? fits : tidy;
    // Keep the tile image-first: rotating onto an art-less story makes it flicker
    // between a photo card and a flat gradient.
    const withArt = pool.filter(a => a.image);
    return withArt.length >= 2 ? withArt : pool;
  }

  function renderNews(data) {
    const el = $('ntp-news');
    if (!el || !data?.articles?.length) return;

    const articles = readableArticles(data.articles);
    let i = 0;
    const paint = () => {
      const a = articles[i % articles.length];
      el.style.cursor = 'pointer';
      el.classList.remove('has-art');
      el.innerHTML = `
        <div class="ntp-news-bg"></div>
        <div class="ntp-news-scrim"></div>
        <div class="ntp-news-body">
          <div class="ntp-news-title">${escapeHtml(a.title)}</div>
        </div>`;

      // Set the artwork as a property, never through an HTML attribute:
      // publisher CDNs use resizer URLs with an already-encoded ?url= param,
      // and running encodeURI over those double-escapes '%' and breaks them.
      // Only flip to the photo treatment once it genuinely decodes, so a dead
      // image leaves the gradient rather than a blank card.
      if (a.image) {
        const probe = new Image();
        probe.onload = () => {
          if (probe.naturalWidth < 200) return;      // placeholder/spacer art
          const bg = el.querySelector('.ntp-news-bg');
          if (!bg) return;
          bg.style.backgroundImage = `url("${a.image.replace(/"/g, '%22')}")`;
          el.classList.add('has-art');
        };
        probe.src = a.image;
      }
      el.onclick = () => a.url && TabManager.navigateTo(a.url);
      el.title = `${a.source || ''}${a.publishedAt ? ' · ' + formatRelativeDate(new Date(a.publishedAt)) : ''}`;
    };

    paint();
    // Cycle headlines slowly so the widget stays alive without distracting.
    clearInterval(newsRotator);
    newsRotator = setInterval(() => { i++; paint(); }, 12_000);
  }

  // ── Shortcuts ──────────────────────────────────────────────────────────────
  function getShortcuts() {
    const saved = store.get(KEYS.shortcuts, null);
    return Array.isArray(saved) && saved.length ? saved : DEFAULT_SHORTCUTS.slice();
  }

  function saveShortcuts(list) {
    store.set(KEYS.shortcuts, list);
    renderShortcuts();
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  /**
   * Resolve a site icon into `box`, which starts as a letter tile.
   * The tile is only swapped for a real image once that image actually decodes,
   * so a blocked, rate-limited or hanging favicon service can never leave an
   * empty white square on screen. Sources are tried in order.
   */
  function loadIcon(box, letter, url, custom) {
    box.classList.add('fallback');
    box.textContent = letter;

    const show = (src) => {
      const img = new Image();
      img.alt = '';
      img.onload = () => {
        if (img.naturalWidth < 2) return;            // generic 1px globe
        box.classList.remove('fallback');
        box.textContent = '';
        box.appendChild(img);
      };
      img.src = src;
    };

    if (custom) return show(custom);

    const host = hostOf(url);
    if (!host) return;

    // Serve from the persistent cache first so icons appear instantly.
    const cache = store.get(KEYS.icons, {});
    if (cache[host]) return show(cache[host]);

    // Resolve in the main process: renderer <img> requests against favicon
    // services can hang without ever firing load/error, which is what left
    // blank tiles here. Node gives us status codes, timeouts and fallbacks.
    if (!window.localMind?.ntpFavicon) return;
    window.localMind.ntpFavicon(url).then((res) => {
      if (!res?.ok || !res.data) return;             // keep the letter tile
      const next = store.get(KEYS.icons, {});
      next[host] = res.data;
      store.set(KEYS.icons, next);
      show(res.data);
    }).catch(() => { /* letter tile stands */ });
  }

  function renderShortcuts() {
    const box = $('ntp-quick-links');
    if (!box) return;
    const list = getShortcuts();
    box.innerHTML = '';

    list.forEach((sc, index) => {
      const card = document.createElement('div');
      card.className = 'ntp-shortcut';
      card.draggable = true;
      card.dataset.index = index;

      const letter = (sc.name || '?').trim().charAt(0).toUpperCase();
      card.innerHTML = `
        <div class="ntp-sc-icon"></div>
        <span class="ntp-sc-name">${escapeHtml(sc.name || sc.url)}</span>`;
      loadIcon(card.querySelector('.ntp-sc-icon'), letter, sc.url, sc.icon);

      card.addEventListener('click', () => TabManager.navigateTo(sc.url));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          { label: 'Edit…', action: () => editShortcut(index) },
          { label: 'Change Icon…', action: () => changeIcon(index) },
          { sep: true },
          { label: 'Remove', danger: true, action: () => {
            const l = getShortcuts(); l.splice(index, 1); saveShortcuts(l);
          }}
        ]);
      });

      wireDrag(card, index);
      box.appendChild(card);
    });

    // Trailing "add" tile
    const add = document.createElement('div');
    add.className = 'ntp-shortcut add';
    add.innerHTML = `
      <div class="ntp-sc-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" style="width:20px;height:20px"><path d="M12 5v14M5 12h14"/></svg>
      </div>
      <span class="ntp-sc-name">Add</span>`;
    add.addEventListener('click', () => editShortcut(-1));
    box.appendChild(add);
  }

  // Drag to reorder, with a live drop indicator.
  let dragFrom = null;
  function wireDrag(card, index) {
    card.addEventListener('dragstart', (e) => {
      dragFrom = index;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(index)); } catch {}
    });
    card.addEventListener('dragend', () => {
      dragFrom = null;
      card.classList.remove('dragging');
      document.querySelectorAll('.ntp-shortcut.drop-target')
        .forEach(el => el.classList.remove('drop-target'));
    });
    card.addEventListener('dragover', (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drop-target');
      if (dragFrom === null || dragFrom === index) return;
      const list = getShortcuts();
      const [moved] = list.splice(dragFrom, 1);
      list.splice(index, 0, moved);
      saveShortcuts(list);
    });
  }

  /** index < 0 adds a new shortcut. */
  function editShortcut(index) {
    const list = getShortcuts();
    const sc = index >= 0 ? list[index] : { name: '', url: '' };
    openDialog(index >= 0 ? 'Edit shortcut' : 'Add shortcut', [
      { key: 'name', label: 'Name', value: sc.name, placeholder: 'GitHub' },
      { key: 'url', label: 'URL', value: sc.url, placeholder: 'https://github.com' }
    ], (vals) => {
      let url = (vals.url || '').trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const name = (vals.name || '').trim() || (() => {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
      })();
      if (index >= 0) list[index] = { ...list[index], name, url };
      else list.push({ id: uid(), name, url });
      saveShortcuts(list);
    });
  }

  function changeIcon(index) {
    const list = getShortcuts();
    openDialog('Change icon', [
      {
        key: 'icon', label: 'Icon URL (blank = site favicon)',
        value: list[index].icon || '', placeholder: 'https://…/icon.png'
      }
    ], (vals) => {
      const icon = (vals.icon || '').trim();
      if (icon) list[index].icon = icon; else delete list[index].icon;
      saveShortcuts(list);
    });
  }

  // ── Recent conversations ───────────────────────────────────────────────────
  function initRecent() {
    const section = $('ntp-recent-section');
    const toggle = $('ntp-recent-toggle');
    if (!section || !toggle) return;

    if (store.get(KEYS.recentCollapsed, false)) section.classList.add('collapsed');
    syncAria();

    const flip = () => {
      section.classList.toggle('collapsed');
      store.set(KEYS.recentCollapsed, section.classList.contains('collapsed'));
      syncAria();
    };
    toggle.addEventListener('click', flip);
    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
    });

    function syncAria() {
      toggle.setAttribute('aria-expanded', String(!section.classList.contains('collapsed')));
    }
  }

  async function renderRecentChats() {
    const list = $('ntp-recent-list');
    const section = $('ntp-recent-section');
    const count = $('ntp-recent-count');
    if (!list || !section) return;

    let chats = [];
    if (window.localMind?.getChatHistory) {
      try { chats = await window.localMind.getChatHistory(); } catch {}
    }
    chats = chats || [];

    if (!chats.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    if (count) count.textContent = String(chats.length);

    // The list has its own max-height + scroll, so showing more can't push the
    // hero off-centre the way the old fixed slice-of-3 layout did.
    list.innerHTML = '';
    chats.slice(0, 20).forEach((chat) => {
      const item = document.createElement('div');
      item.className = 'ntp-chat';
      item.innerHTML = `
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H6l-3 3V4z"/>
        </svg>
        <span class="ntp-chat-title">${escapeHtml(chat.title || 'Untitled')}</span>
        <span class="ntp-chat-date">${formatRelativeDate(chat.date)}</span>`;
      item.addEventListener('click', async () => {
        if (!window.localMind?.getChat) return;
        const full = await window.localMind.getChat(chat.id);
        if (full) AiPanel.loadChat(full);
      });
      list.appendChild(item);
    });
  }

  // ── Wallpaper ──────────────────────────────────────────────────────────────
  function wallpaperConfig() {
    return store.get(KEYS.wallpaper, { mode: 'none' });
  }

  function applyWallpaper() {
    const layer = $('ntp-wallpaper');
    if (!layer) return;
    const cfg = wallpaperConfig();

    layer.style.setProperty('--ntp-dim', String(cfg.dim ?? 0.45));
    layer.style.setProperty('--ntp-blur', `${cfg.blur ?? 0}px`);
    // The filter is only declared when it has something to do — `blur(0px)` is
    // not a no-op, it still builds a full-viewport filter surface.
    layer.classList.toggle('blurred', Number(cfg.blur ?? 0) > 0);
    layer.style.backgroundSize =
      cfg.fit === 'fit' ? 'contain' :
      cfg.fit === 'stretch' ? '100% 100%' :
      cfg.fit === 'center' ? 'auto' : 'cover';

    // Gradients are pure CSS — no download, no decode, instant paint.
    if (cfg.gradient && !cfg.url) {
      layer.style.backgroundImage = cfg.gradient;
      layer.classList.add('loaded');
      document.body.style.setProperty('--ntp-wallpaper-image', cfg.gradient);
      document.body.classList.add('ntp-has-wallpaper');
      return;
    }

    if (!cfg.url) {
      layer.classList.remove('loaded');
      layer.style.backgroundImage = '';
      document.body.style.removeProperty('--ntp-wallpaper-image');
      document.body.classList.remove('ntp-has-wallpaper');
      return;
    }

    // Decode off-screen first so the swap can't flash a half-painted image.
    // If the preload stalls (slow/blocked host) we still hand the URL to CSS
    // rather than silently dropping the wallpaper the user chose.
    const img = new Image();
    let settled = false;
    const show = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      layer.style.backgroundImage = `url("${cfg.url}")`;
      layer.classList.add('loaded');
      // Surfaces that float above the webview (the hover AI panel) can't sample
      // the wallpaper with backdrop-filter, because the page is painted between
      // them and it. They re-draw this same image instead.
      document.body.style.setProperty('--ntp-wallpaper-image', `url("${cfg.url}")`);
      document.body.classList.add('ntp-has-wallpaper');
    };
    const timer = setTimeout(show, 2500);
    img.onload = show;
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      layer.classList.remove('loaded');
      document.body.classList.remove('ntp-has-wallpaper');
    };
    img.src = cfg.url;
  }

  function setWallpaper(patch) {
    const next = { ...wallpaperConfig(), ...patch };
    store.set(KEYS.wallpaper, next);
    applyWallpaper();

    // Pull remote wallpapers down to disk and re-point at the local copy, so
    // they render even when the renderer can't reach the host, and offline.
    if (next.url && /^https?:/i.test(next.url) && window.localMind?.ntpCacheWallpaper) {
      window.localMind.ntpCacheWallpaper(next.url).then((res) => {
        if (!res?.ok || !res.data) return;
        const cur = wallpaperConfig();
        if (cur.url !== next.url) return;            // user moved on already
        store.set(KEYS.wallpaper, { ...cur, url: `file://${res.data}`, remote: next.url });
        applyWallpaper();
      }).catch(() => { /* the remote URL still stands */ });
    }
    return next;
  }

  // ── Shared menu + dialog ───────────────────────────────────────────────────
  function openMenu(x, y, items) {
    document.querySelector('.ntp-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'ntp-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    items.forEach((it) => {
      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'ntp-menu-sep';
        menu.appendChild(s);
        return;
      }
      const el = document.createElement('div');
      el.className = `ntp-menu-item${it.danger ? ' danger' : ''}`;
      el.textContent = it.label;
      el.addEventListener('click', () => { menu.remove(); it.action(); });
      menu.appendChild(el);
    });

    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    if (r.right > innerWidth) menu.style.left = `${innerWidth - r.width - 8}px`;
    if (r.bottom > innerHeight) menu.style.top = `${innerHeight - r.height - 8}px`;

    const close = (e) => {
      if (e.type === 'mousedown' && menu.contains(e.target)) return;
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      menu.remove();
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
    setTimeout(() => {
      document.addEventListener('mousedown', close);
      document.addEventListener('keydown', close);
    }, 10);
  }

  function openDialog(title, fields, onSave) {
    document.querySelector('.ntp-dialog-backdrop')?.remove();
    const back = document.createElement('div');
    back.className = 'ntp-dialog-backdrop';
    back.innerHTML = `
      <div class="ntp-dialog" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        ${fields.map(f => `
          <div class="ntp-field">
            <label for="ntpf-${f.key}">${escapeHtml(f.label)}</label>
            <input id="ntpf-${f.key}" value="${escapeHtml(f.value || '')}"
                   placeholder="${escapeHtml(f.placeholder || '')}" spellcheck="false">
          </div>`).join('')}
        <div class="ntp-dialog-actions">
          <button class="ntp-btn" data-act="cancel">Cancel</button>
          <button class="ntp-btn primary" data-act="save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(back);

    const first = back.querySelector('input');
    first?.focus();
    first?.select();

    const close = () => back.remove();
    const commit = () => {
      const vals = {};
      fields.forEach(f => { vals[f.key] = back.querySelector(`#ntpf-${f.key}`).value; });
      close();
      onSave(vals);
    };

    back.querySelector('[data-act="cancel"]').addEventListener('click', close);
    back.querySelector('[data-act="save"]').addEventListener('click', commit);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') commit();
    });
  }

  return {
    init,
    refreshClock: initClock,
    applyWallpaper,
    setWallpaper,
    getWallpaper: wallpaperConfig,
    refreshWeather: () => refreshWeather(true),
    refreshNews: () => refreshNews(true)
  };
})();
