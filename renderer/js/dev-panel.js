// =============================================================================
// Local Mind Browser — Developer panel
// =============================================================================
// The controls a developer reaches for while building a site, in one popover
// rather than scattered between a menu, DevTools and the address bar.
//
// Everything here targets the ACTIVE TAB's webContents, and every override is
// remembered per tab by the main process — switching tabs shows that tab's real
// state rather than whatever was set last.

const DevPanel = (() => {
  let open = false;
  let state = { device: null, network: null, colorScheme: null, jsDisabled: false };

  const $ = (id) => document.getElementById(id);

  const DEVICES = [
    ['', 'Responsive (no override)'],
    ['iphone-15', 'iPhone 15 — 393×852'],
    ['iphone-se', 'iPhone SE — 375×667'],
    ['pixel-8', 'Pixel 8 — 412×915'],
    ['ipad', 'iPad — 820×1180'],
    ['laptop', 'Laptop — 1280×800'],
    ['desktop-1440', 'Desktop — 1440×900']
  ];

  const NETWORKS = [
    ['', 'No throttling'],
    ['slow-3g', 'Slow 3G'],
    ['fast-3g', 'Fast 3G'],
    ['slow-4g', 'Slow 4G'],
    ['offline', 'Offline']
  ];

  const SCHEMES = [['', 'Follow the app'], ['light', 'Light'], ['dark', 'Dark']];

  function init() {
    build();
    EventBus.on('open-dev-panel', toggle);
    EventBus.on('tab-activated', () => { if (open) refresh(); });

    window.localMind?.onAppEvent?.('dev-open-tab', (url) => TabManager.createTab(url, true));
    window.localMind?.onAppEvent?.('menu-dev-panel', () => toggle());

    $('btn-dev')?.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });

    // ⌥⌘D opens the panel; ⌥⌘U is view-source, matching every other browser.
    // Hard reload is already ⌘⇧R through the View menu.
    document.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'd') { e.preventDefault(); toggle(); }
      if (k === 'u') { e.preventDefault(); run('view-source'); }
    });

    document.addEventListener('click', (e) => {
      if (!open) return;
      if (e.target.closest('#dev-panel') || e.target.closest('#btn-dev')) return;
      toggle(false);
    });
  }

  function build() {
    if ($('dev-panel')) return;
    const el = document.createElement('div');
    el.id = 'dev-panel';
    el.innerHTML = `
      <div class="dev-head">
        <span>Developer</span>
        <button class="dev-link" id="dev-reset">Reset all</button>
      </div>

      <div class="dev-row">
        <button class="dev-btn" data-act="hard-reload">Hard reload<span>⌘⇧R</span></button>
        <button class="dev-btn" data-act="empty-cache-reload">Empty cache and reload</button>
      </div>
      <div class="dev-row">
        <button class="dev-btn" data-act="devtools">DevTools<span>⌥⌘I</span></button>
        <button class="dev-btn" data-act="view-source">View source<span>⌥⌘U</span></button>
      </div>

      <label class="dev-field"><span>Device</span>
        <select id="dev-device">${DEVICES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      </label>
      <label class="dev-field"><span>Network</span>
        <select id="dev-network">${NETWORKS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      </label>
      <label class="dev-field"><span>Colour scheme</span>
        <select id="dev-scheme">${SCHEMES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      </label>
      <label class="dev-check"><input type="checkbox" id="dev-nojs"> Disable JavaScript</label>

      <div class="dev-row">
        <button class="dev-btn danger" data-act="clear-site-data">Clear this site's data</button>
      </div>
      <div class="dev-note" id="dev-note"></div>`;
    document.body.appendChild(el);

    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) run(act);
    });
    $('dev-reset').addEventListener('click', () => run('reset'));
    $('dev-device').addEventListener('change', (e) => run('device', e.target.value || null));
    $('dev-network').addEventListener('change', (e) => run('network', e.target.value || null));
    $('dev-scheme').addEventListener('change', (e) => run('color-scheme', e.target.value || null));
    $('dev-nojs').addEventListener('change', (e) => run('js', e.target.checked));
  }

  /** The webContents id of the tab in front, which is what every command targets. */
  function activeId() {
    const wv = TabManager.getActiveTab()?.webview;
    try { return wv?.getWebContentsId?.() ?? null; } catch { return null; }
  }

  async function run(action, value) {
    const id = activeId();
    if (id == null) return note('Open a page first.', true);

    const res = await window.localMind.devCommand({ id, action, value });
    if (!res?.ok) return note(res?.error || 'That did not work.', true);

    state = res.state || state;
    paint();
    note(describe(action, value));
  }

  function describe(action, value) {
    if (action === 'hard-reload') return 'Reloaded, ignoring the cache.';
    if (action === 'empty-cache-reload') return 'Cache emptied and page reloaded.';
    if (action === 'clear-site-data') return "This site's cookies and storage were cleared.";
    if (action === 'reset') return 'All overrides cleared.';
    if (action === 'device') return value ? `Emulating ${value}.` : 'Device override off.';
    if (action === 'network') return value ? `Throttling: ${value}.` : 'Throttling off.';
    if (action === 'color-scheme') return value ? `Forcing ${value} mode.` : 'Colour scheme override off.';
    if (action === 'js') return value ? 'JavaScript disabled — reload to see the effect.' : 'JavaScript re-enabled.';
    return '';
  }

  function note(text, bad = false) {
    const el = $('dev-note');
    el.textContent = text;
    el.className = 'dev-note' + (bad ? ' bad' : '');
  }

  function paint() {
    $('dev-device').value = state.device || '';
    $('dev-network').value = state.network || '';
    $('dev-scheme').value = state.colorScheme || '';
    $('dev-nojs').checked = Boolean(state.jsDisabled);
    // A badge on the toolbar button, so an override left on is never invisible.
    const active = Boolean(state.device || state.network || state.colorScheme || state.jsDisabled);
    $('btn-dev')?.classList.toggle('overridden', active);
  }

  async function refresh() {
    const id = activeId();
    if (id == null) return;
    state = await window.localMind.devState(id);
    paint();
  }

  function toggle(next = !open) {
    open = next;
    $('dev-panel').classList.toggle('open', open);
    $('btn-dev')?.classList.toggle('active', open);
    if (open) { note(''); refresh(); }
  }

  return { init, toggle, run };
})();
