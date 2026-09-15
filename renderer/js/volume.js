// =============================================================================
// Local Mind Browser — Volume
// =============================================================================
// A per-tab volume control that goes past 100%, in the toolbar, so nobody has
// to install a "volume booster" extension to watch a quiet video. The icon only
// appears while a tab is actually making sound.
//
// The amplification itself happens in the page (see the audio boost block in
// preload-webview.js); this is the control surface and the memory of what each
// site was set to.

const Volume = (() => {
  const STORE_KEY = 'mind-site-volume';
  const DEFAULT = 100;

  let levels = {};              // origin -> percent
  let current = DEFAULT;
  let open = false;

  const $ = (id) => document.getElementById(id);
  const wrap = () => $('volume-wrap');

  function init() {
    try { levels = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { levels = {}; }

    $('btn-volume')?.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    $('vol-slider')?.addEventListener('input', (e) => apply(Number(e.target.value)));
    $('vol-reset')?.addEventListener('click', () => { apply(DEFAULT); });
    $('volume-popover')?.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { if (open) toggle(false); });

    // The page reports back whether the boost actually took effect. It cannot
    // always: protected or cross-origin audio is out of the page's reach.
    EventBus.on('webview:audio-boost-state', ({ tabId, data }) => {
      if (tabId !== TabManager.getActiveTab()?.id) return;
      const note = $('vol-note');
      if (!note) return;
      if (data?.ok === false) {
        note.textContent = data.reason || 'This page will not allow a boost above 100%.';
        note.className = 'warn';
        $('vol-slider').value = String(Math.min(100, current));
        showLevel(Math.min(100, current));
      } else {
        note.textContent = data?.boosted
          ? 'Boosted above the site’s own maximum.'
          : '';
        note.className = '';
      }
    });

    // Audible state drives whether the control is shown at all.
    // The New Tab page's turntable spins while something is playing, so the
    // audible state is published on the body as well as driving this control.
    const markPlaying = () => document.body.classList.toggle(
      'media-playing', TabManager.getAllTabs?.().some((t) => t.audible) ?? false);

    EventBus.on('tab-audio-started', () => { refreshVisibility(); markPlaying(); });
    EventBus.on('tab-audio-stopped', () => { refreshVisibility(); markPlaying(); });
    EventBus.on('tab-activated', () => { syncToActiveTab(); refreshVisibility(); });
    EventBus.on('tab-loaded', (tab) => {
      if (tab?.id === TabManager.getActiveTab()?.id) syncToActiveTab();
    });
  }

  const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

  function refreshVisibility() {
    const tab = TabManager.getActiveTab();
    const audible = Boolean(tab?.audible);
    wrap().hidden = !audible && current === DEFAULT;
    if (wrap().hidden && open) toggle(false);
  }

  /** Re-apply the remembered level for whatever site is now in front. */
  function syncToActiveTab() {
    const tab = TabManager.getActiveTab();
    const origin = originOf(tab?.url);
    current = (origin && levels[origin]) || DEFAULT;
    $('vol-slider').value = String(current);
    showLevel(current);
    if (current !== DEFAULT) send(current);
  }

  function showLevel(pct) {
    $('vol-level').textContent = `${pct}%`;
    const badge = $('volume-badge');
    // Only worth a badge when it is doing something out of the ordinary.
    badge.textContent = pct > 100 ? `${Math.round(pct / 100)}×` : (pct === 0 ? '0' : '');
    badge.hidden = !badge.textContent;
    $('btn-volume').classList.toggle('boosted', pct > 100);
    $('btn-volume').classList.toggle('muted', pct === 0);
  }

  function apply(pct) {
    current = pct;
    showLevel(pct);
    send(pct);

    const origin = originOf(TabManager.getActiveTab()?.url);
    if (origin) {
      // Only remember a deliberate change; storing 100% for every site visited
      // would fill the store with nothing.
      if (pct === DEFAULT) delete levels[origin];
      else levels[origin] = pct;
      try { localStorage.setItem(STORE_KEY, JSON.stringify(levels)); } catch { /* full */ }
    }
  }

  function send(pct) {
    const wv = TabManager.getActiveTab()?.webview;
    try { wv?.send('audio-boost-set', pct / 100); } catch { /* not ready yet */ }
  }

  function toggle(next = !open) {
    open = next;
    $('volume-popover').classList.toggle('open', open);
    $('btn-volume').classList.toggle('active', open);
    if (open) {
      $('vol-note').textContent = '';
      try { TabManager.getActiveTab()?.webview?.send('audio-boost-query'); } catch { /* ignore */ }
    }
  }

  return { init, refreshVisibility };
})();
