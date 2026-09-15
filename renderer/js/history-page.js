// =============================================================================
// Local Mind Browser — History
// =============================================================================
// Every page you have visited: searchable, filterable by date and by site,
// and removable one at a time, by site, in bulk, or wholesale.
//
// The data was already being recorded and capped at 2000 entries; it just had
// nowhere to be seen. It fed address-bar autocomplete and the command palette,
// which meant pages you had visited kept resurfacing with no way to look at the
// list or delete anything from it. For a browser that leads on privacy, being
// unable to clear your own history is the wrong gap to have.
//
// Two things shape the layout. Most history questions are "when was that?" or
// "what was that site?", so the date range and the site list are the primary
// controls rather than search alone. And removal is the point of the page, so
// every row carries its own delete, and selection turns the header into a bulk
// bar rather than hiding deletion behind a mode switch.

const HistoryPage = (() => {
  let built = false;
  let query = '';
  let range = 'all';                  // all | today | yesterday | 7d | 30d
  let site = null;                    // hostname filter, or null
  let group = 'day';                  // day | site
  const picked = new Map();           // "url\0ts" -> entry

  const $ = (id) => document.getElementById(id);
  const page = () => $('history-page');

  const RANGES = [
    ['all', 'All time'],
    ['today', 'Today'],
    ['yesterday', 'Yesterday'],
    ['7d', 'Last 7 days'],
    ['30d', 'Last 30 days']
  ];

  const ICONS = {
    newTab: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2.5h4.5V7"/><path d="M13.5 2.5L7.5 8.5"/><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>',
    trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10"/><path d="M6.5 4.5V3h3v1.5"/><path d="M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8"/></svg>'
  };

  function init() {
    // Lives in the top bar rather than the sidebar's page list — history is
    // something you reach for mid-browse, not a place you park in.
    document.getElementById('btn-history')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });

    // Same contract every other full-page view here follows: opening a tab
    // means the user wants to browse, so step aside.
    EventBus.on('tab-activated', hide);
    EventBus.on('leave-page-views', hide);
    EventBus.on('history-changed', () => { if (isOpen()) render(); });
  }

  function build() {
    if (built) return;
    const el = page();
    if (!el) return;

    el.innerHTML = `
      <div class="hist-head">
        <div>
          <h1 class="hist-title">History</h1>
          <div class="hist-sub" id="hist-sub"></div>
        </div>
        <div class="hist-actions">
          <input id="hist-search" class="hist-search" type="text"
                 placeholder="Search history" spellcheck="false" autocomplete="off">
          <div class="hist-menu-wrap">
            <button class="hist-btn" id="hist-clear">Clear ▾</button>
            <div class="hist-menu" id="hist-clear-menu">
              <button data-clear="hour">Last hour</button>
              <button data-clear="today">Today</button>
              <button data-clear="7d">Last 7 days</button>
              <hr>
              <button class="danger" data-clear="all">Everything</button>
            </div>
          </div>
        </div>
      </div>

      <div class="hist-filters">
        ${RANGES.map(([k, label]) =>
          `<button class="hist-chip" data-range="${k}">${label}</button>`).join('')}
        <span class="sep" style="width:1px;height:18px;background:var(--border-color);margin:0 4px"></span>
        <button class="hist-chip" data-group="day">By day</button>
        <button class="hist-chip" data-group="site">By site</button>
        <span class="hist-gap"></span>
        <div class="hist-bulk" id="hist-bulk">
          <span class="hist-bulk-count" id="hist-bulk-count"></span>
          <button class="hist-btn" id="hist-bulk-clear">Cancel</button>
          <button class="hist-btn danger" id="hist-bulk-delete">Delete selected</button>
        </div>
      </div>

      <div class="hist-body">
        <aside class="hist-rail">
          <div class="hist-rail-title">Top sites</div>
          <div id="hist-sites"></div>
        </aside>
        <div class="hist-list" id="hist-list"></div>
      </div>`;

    $('hist-search').addEventListener('input', (e) => {
      query = e.target.value.trim().toLowerCase();
      render();
    });

    el.querySelectorAll('[data-range]').forEach((b) => {
      b.addEventListener('click', () => { range = b.dataset.range; render(); });
    });
    el.querySelectorAll('[data-group]').forEach((b) => {
      b.addEventListener('click', () => { group = b.dataset.group; render(); });
    });

    // ── Clear menu ──────────────────────────────────────────────────────────
    const menu = $('hist-clear-menu');
    $('hist-clear').addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('on');
    });
    document.addEventListener('click', () => menu.classList.remove('on'));
    menu.addEventListener('click', (e) => {
      const which = e.target.closest('button')?.dataset.clear;
      if (!which) return;
      menu.classList.remove('on');
      clearRange(which);
    });

    $('hist-bulk-clear').addEventListener('click', () => { picked.clear(); render(); });
    $('hist-bulk-delete').addEventListener('click', () => {
      const n = picked.size;
      if (!n) return;
      TabManager.removeHistoryEntries([...picked.values()]);
      picked.clear();
      Sidebar.showToast?.(`Removed ${n} ${n === 1 ? 'entry' : 'entries'}.`);
    });

    built = true;
  }

  // ── Filtering ──────────────────────────────────────────────────────────────
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

  function inRange(ts) {
    const day = 86400000;
    const today = startOfToday();
    switch (range) {
      case 'today': return ts >= today;
      case 'yesterday': return ts >= today - day && ts < today;
      case '7d': return ts >= today - 6 * day;
      case '30d': return ts >= today - 29 * day;
      default: return true;
    }
  }

  const hostOf = (url) => {
    try {
      const u = new URL(url);
      // file:// has no hostname, which left a nameless row in the site rail.
      if (!u.hostname) return u.protocol === 'file:' ? 'Local files' : u.protocol.replace(':', '');
      return u.hostname.replace(/^www\./, '');
    } catch { return url; }
  };

  function filtered() {
    return (TabManager.getHistory() || []).filter((h) => {
      if (!inRange(h.ts)) return false;
      if (site && hostOf(h.url) !== site) return false;
      if (!query) return true;
      return (h.title || '').toLowerCase().includes(query) ||
             (h.url || '').toLowerCase().includes(query);
    });
  }

  // ── Labels ─────────────────────────────────────────────────────────────────
  function dayLabel(ts) {
    const d = new Date(ts);
    const today = startOfToday();
    const day = new Date(ts); day.setHours(0, 0, 0, 0);
    const diff = Math.round((today - day.getTime()) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  const time = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    if (!built) return;
    syncChips();
    renderSites();
    renderList();
    renderBulk();
  }

  function syncChips() {
    const el = page();
    el.querySelectorAll('[data-range]').forEach((b) =>
      b.classList.toggle('on', b.dataset.range === range));
    el.querySelectorAll('[data-group]').forEach((b) =>
      b.classList.toggle('on', b.dataset.group === group));
  }

  /** The rail counts across the current date range, but ignores the site
      filter — otherwise picking a site would leave a list of one. */
  function renderSites() {
    const host = $('hist-sites');
    const counts = new Map();
    for (const h of TabManager.getHistory() || []) {
      if (!inRange(h.ts)) continue;
      const s = hostOf(h.url);
      counts.set(s, (counts.get(s) || 0) + 1);
    }

    // Deleting the last entry for the filtered site would otherwise leave the
    // page stranded on an empty list with no obvious way back.
    if (site && !counts.has(site)) site = null;

    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    host.innerHTML = '';

    const all = document.createElement('div');
    all.className = `hist-site${site ? '' : ' on'}`;
    all.innerHTML = `<span class="hist-site-name">All sites</span>
                     <span class="hist-site-count">${counts.size}</span>`;
    all.addEventListener('click', () => { site = null; render(); });
    host.appendChild(all);

    for (const [name, n] of top) {
      const row = document.createElement('div');
      row.className = `hist-site${site === name ? ' on' : ''}`;

      const label = document.createElement('span');
      label.className = 'hist-site-name';
      label.textContent = name;                 // hostnames come from the web

      const count = document.createElement('span');
      count.className = 'hist-site-count';
      count.textContent = String(n);

      const x = document.createElement('button');
      x.className = 'hist-site-x';
      x.title = `Remove every entry from ${name}`;
      x.textContent = '×';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Remove all ${n} ${n === 1 ? 'entry' : 'entries'} from ${name}?`)) return;
        TabManager.removeHistorySite(name);
        if (site === name) site = null;
        Sidebar.showToast?.(`Removed ${name} from history.`);
      });

      row.append(label, count, x);
      row.addEventListener('click', () => { site = site === name ? null : name; render(); });
      host.appendChild(row);
    }
  }

  function renderList() {
    const host = $('hist-list');
    const items = filtered();
    const all = TabManager.getHistory() || [];

    // Header line: what you are looking at, and over what span.
    const sub = $('hist-sub');
    if (sub) {
      const sites = new Set(items.map((h) => hostOf(h.url))).size;
      const oldest = items.length ? items[items.length - 1].ts : null;
      const bits = [`${items.length} ${items.length === 1 ? 'entry' : 'entries'}`];
      if (sites) bits.push(`${sites} ${sites === 1 ? 'site' : 'sites'}`);
      if (items.length !== all.length) bits.push(`of ${all.length} total`);
      if (oldest && range === 'all') {
        bits.push(`back to ${new Date(oldest).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`);
      }
      sub.textContent = bits.join(' · ');
    }

    if (!items.length) {
      host.innerHTML = `<div class="hist-empty">${
        query || site || range !== 'all'
          ? 'Nothing matches those filters.'
          : 'Nothing here yet. Pages you visit will show up as you browse.'
      }</div>`;
      return;
    }

    // How many times each URL appears in the current view, so a page you keep
    // going back to says so instead of repeating identically twenty times.
    const visits = new Map();
    for (const h of items) visits.set(h.url, (visits.get(h.url) || 0) + 1);

    host.innerHTML = '';

    if (group === 'site') {
      // One section per site, busiest first — not one section per run of
      // consecutive visits, which listed the same site over and over.
      const bySite = new Map();
      const seen = new Set();
      for (const entry of items) {
        // Within a site, a page it lists once with a visit count, not once
        // per visit.
        if (seen.has(entry.url)) continue;
        seen.add(entry.url);
        const s = hostOf(entry.url);
        if (!bySite.has(s)) bySite.set(s, []);
        bySite.get(s).push(entry);
      }

      const order = [...bySite.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

      for (const [name, rows] of order) {
        const h = document.createElement('div');
        h.className = 'hist-day';
        h.textContent = `${name} · ${rows.length} ${rows.length === 1 ? 'page' : 'pages'}`;
        host.appendChild(h);
        for (const entry of rows) host.appendChild(rowFor(entry, visits.get(entry.url) || 1));
      }
      return;
    }

    let current = null;
    for (const entry of items) {
      const heading = dayLabel(entry.ts);
      if (heading !== current) {
        current = heading;
        const h = document.createElement('div');
        h.className = 'hist-day';
        h.textContent = heading;
        host.appendChild(h);
      }
      host.appendChild(rowFor(entry, visits.get(entry.url) || 1));
    }
  }

  function rowFor(entry, visitCount) {
    const key = `${entry.url} ${entry.ts}`;
    const row = document.createElement('div');
    row.className = `hist-row${picked.has(key) ? ' picked' : ''}`;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'hist-check';
    check.checked = picked.has(key);
    check.addEventListener('click', (e) => e.stopPropagation());
    check.addEventListener('change', () => {
      if (check.checked) picked.set(key, { url: entry.url, ts: entry.ts });
      else picked.delete(key);
      row.classList.toggle('picked', check.checked);
      renderBulk();
    });

    const t = document.createElement('span');
    t.className = 'hist-time';
    t.textContent = group === 'site'
      ? new Date(entry.ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      : time(entry.ts);

    row.append(check, t, iconFor(entry));

    const main = document.createElement('div');
    main.className = 'hist-main';
    const title = document.createElement('div');
    title.className = 'hist-name';
    // textContent: titles come from arbitrary web pages.
    title.textContent = entry.title || entry.url;
    const url = document.createElement('div');
    url.className = 'hist-url';
    url.textContent = entry.url;
    main.append(title, url);
    row.appendChild(main);

    if (visitCount > 1) {
      const v = document.createElement('span');
      v.className = 'hist-visits';
      v.textContent = `${visitCount} visits`;
      row.appendChild(v);
    }

    const actions = document.createElement('div');
    actions.className = 'hist-row-actions';
    actions.append(
      act(ICONS.newTab, 'Open in a new tab', () => TabManager.createTab(entry.url, false)),
      act(ICONS.copy, 'Copy link', async (btn) => {
        await window.localMind?.writeClipboardText?.(entry.url);
        btn.classList.add('ok');
        Sidebar.showToast?.('Link copied.');
      }),
      act(ICONS.trash, 'Remove this entry', () => TabManager.removeHistoryEntry(entry.url, entry.ts), true)
    );
    row.appendChild(actions);

    row.addEventListener('click', () => {
      TabManager.createTab(entry.url, true);
      hide();
    });
    return row;
  }

  function act(svg, title, fn, danger = false) {
    const b = document.createElement('button');
    b.className = `hist-act${danger ? ' danger' : ''}`;
    b.title = title;
    b.innerHTML = svg;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
    return b;
  }

  /** A real favicon when we captured one, a letter tile when we did not —
      rather than asking a third party for an icon and leaking the visit. */
  function iconFor(entry) {
    if (entry.favicon && /^(https?:|data:)/i.test(entry.favicon)) {
      const img = document.createElement('img');
      img.className = 'hist-icon';
      img.src = entry.favicon;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.replaceWith(letterTile(entry)), { once: true });
      return img;
    }
    return letterTile(entry);
  }

  function letterTile(entry) {
    const d = document.createElement('span');
    d.className = 'hist-letter';
    d.textContent = (hostOf(entry.url)[0] || '?');
    return d;
  }

  function renderBulk() {
    const bar = $('hist-bulk');
    if (!bar) return;
    bar.classList.toggle('on', picked.size > 0);
    document.body.classList.toggle('hist-selecting', picked.size > 0);
    $('hist-bulk-count').textContent =
      `${picked.size} selected`;
  }

  // ── Clearing ───────────────────────────────────────────────────────────────
  function clearRange(which) {
    const day = 86400000;
    if (which === 'all') {
      // Irreversible, and the one option people hit by accident.
      if (!confirm('Delete your entire browsing history? This cannot be undone.')) return;
      TabManager.clearHistory();
      Sidebar.showToast?.('History cleared.');
      return;
    }
    const since = which === 'hour' ? Date.now() - 3600000
      : which === 'today' ? startOfToday()
      : startOfToday() - 6 * day;
    const label = which === 'hour' ? 'the last hour'
      : which === 'today' ? 'today' : 'the last 7 days';
    TabManager.clearHistory(since);
    Sidebar.showToast?.(`Cleared ${label}.`);
  }

  // ── Visibility ─────────────────────────────────────────────────────────────
  const markButton = () =>
    document.getElementById('btn-history')?.classList.toggle('active', isOpen());

  function show() {
    build();
    NewsPage?.hide?.();
    FinancePage?.hide?.();
    NotesPage?.hide?.();
    if (typeof CompanyPage !== 'undefined') CompanyPage.hide();
    if (typeof StoryPage !== 'undefined') StoryPage.hide();

    page().style.display = 'flex';
    render();
    markButton();
    setTimeout(() => $('hist-search')?.focus(), 40);
  }

  function hide() {
    const el = page();
    if (el) el.style.display = 'none';
    picked.clear();
    document.body.classList.remove('hist-selecting');
    markButton();
  }

  const isOpen = () => page()?.style.display === 'flex';
  const toggle = () => (isOpen() ? hide() : show());

  return { init, show, hide, toggle, isOpen };
})();
