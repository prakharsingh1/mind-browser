// =============================================================================
// Local Mind Browser — Agent Monitor
// =============================================================================
// Live view of what the agent is doing: one row per tool call, updated in place
// as it moves active → completed/error. Showing the real steps (and what each
// returned) is what makes the agent feel trustworthy instead of a black box.
//
// Once a run finishes the card gets out of the way. A step COUNT is not a
// result — nobody needs to know it took fourteen calls — so the finished card
// reports what was actually consulted (which sites, how long) and keeps the
// step list one click away.

const AgentMonitor = (() => {
  const rows = new Map();   // step key → element
  let card = null;
  let sources = [];         // {host, url} in visit order, deduped by host

  function init() {
    window.localMind?.onAgentProgress?.((data) => addStep(data));
  }

  const container = () => document.getElementById('chat-container');

  /** Open a fresh run card for `task`. */
  function begin(task) {
    const host = container();
    if (!host) return;
    rows.clear();
    sources = [];
    card = document.createElement('div');
    card.className = 'agent-run';
    card.innerHTML = `
      <div class="agent-run-head">
        <span class="agent-spinner"></span>
        <span class="agent-run-title">Working on it…</span>
        <span class="agent-run-meta"></span>
        <svg class="agent-run-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </div>
      <div class="agent-run-task"></div>
      <div class="agent-sources"></div>
      <div class="agent-steps"></div>`;
    card.querySelector('.agent-run-task').textContent = task;
    host.appendChild(card);
    host.scrollTop = host.scrollHeight;
  }

  /** Hostname without www, or '' for anything that isn't a real URL. */
  function hostOf(url) {
    try {
      const h = new URL(String(url)).hostname.replace(/^www\./, '');
      return h.includes('.') ? h : '';
    } catch { return ''; }
  }

  function noteSource(url) {
    const host = hostOf(url);
    if (!host || sources.some((s) => s.host === host)) return;
    sources.push({ host, url });
  }

  function renderSources() {
    const strip = card?.querySelector('.agent-sources');
    if (!strip) return;
    // Favicons come from the site itself, never from a third-party favicon
    // service — routing them through Google would hand over the full list of
    // pages the agent visited, which is exactly what this browser exists to
    // avoid. If a site has no /favicon.ico the monogram underneath shows.
    strip.innerHTML = sources.map(({ host, url }) => `
      <a class="agent-source" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(host)}">
        <span class="agent-source-mark" data-letter="${escapeHtml(host[0].toUpperCase())}">
          <img src="https://${escapeHtml(host)}/favicon.ico" alt="" loading="lazy"
               data-on-error="remove">
        </span>
        <span class="agent-source-host">${escapeHtml(host)}</span>
      </a>`).join('');
    strip.style.display = sources.length ? '' : 'none';
  }

  function addStep(data) {
    if (!card) return;                     // progress arriving with no open run
    const list = card.querySelector('.agent-steps');
    if (!list) return;

    if (data.url) { noteSource(data.url); renderSources(); }

    const key = `${data.step}-${data.action}`;
    let row = rows.get(key);
    if (!row) {
      row = document.createElement('div');
      row.innerHTML = `
        <span class="agent-step-icon"></span>
        <div class="agent-step-body">
          <div class="agent-step-action"></div>
          <div class="agent-step-detail"></div>
        </div>`;
      rows.set(key, row);
      list.appendChild(row);
    }

    row.className = `agent-step ${data.status || ''}`;
    const ic = row.querySelector('.agent-step-icon');
    ic.textContent = data.icon || '';
    ic.style.display = data.icon ? '' : 'none';
    row.querySelector('.agent-step-action').textContent = data.action || 'Working…';
    // Raw JSON dumps are noise — show a short human line instead.
    let d = String(data.detail || '');
    if (d.startsWith('{') || d.startsWith('[')) {
      const chars = /"?(text|typed)"?\s*:\s*"?(\d+)/.exec(d);
      d = chars ? `${chars[2]} chars` : 'done';
    }
    if (d.length > 90) d = d.slice(0, 90) + '…';
    const detail = row.querySelector('.agent-step-detail');
    detail.textContent = d;
    detail.style.display = d ? '' : 'none';

    // While a run is live, the head shows what's happening right now rather
    // than a static "Working on it…".
    const title = card.querySelector('.agent-run-title');
    if (title && data.status === 'active' && data.action) title.textContent = data.action;

    const host = container();
    if (host) host.scrollTop = host.scrollHeight;
  }

  /**
   * Wrap up the run card.
   *
   * On success the card is removed outright. While the agent is working the
   * live step list is the whole point, but once the answer is on screen a
   * leftover "Done · 6s" box is just a lid sitting above the thing you actually
   * wanted to read.
   *
   * Failures keep their card: it is where the step trace and the reason live,
   * and a run that stops silently is much worse than one extra box.
   */
  function finish(success) {
    if (!card) return;

    if (success) {
      card.remove();
      card = null;
      rows.clear();
      return;
    }

    const done = card;                     // `card` is cleared before the click
    done.classList.add('failed', 'collapsed');

    const head = done.querySelector('.agent-run-head');
    if (head) {
      head.title = 'Show what the agent did';
      head.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;  // let source links open normally
        done.classList.toggle('collapsed');
      });
    }
    done.querySelector('.agent-spinner')?.remove();

    const title = done.querySelector('.agent-run-title');
    if (title) title.textContent = 'Stopped';

    // Sources are the one part worth seeing without expanding.
    done.querySelector('.agent-sources')?.classList.add('always-on');

    card = null;
  }

  /** Wipe every run card out of the panel, not just the internal state.
      Run cards carry class `agent-run`, which is neither `.chat-message` nor
      `#agent-monitor`, so they used to survive "new chat" and pile up under the
      empty state as orphaned finished boxes. */
  function clear() {
    rows.clear();
    sources = [];
    card = null;
    container()?.querySelectorAll('.agent-run').forEach((el) => el.remove());
  }

  return { init, addStep, begin, finish, clear };
})();
