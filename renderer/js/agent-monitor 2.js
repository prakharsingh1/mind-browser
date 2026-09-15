// =============================================================================
// Local Mind Browser — Agent Monitor
// =============================================================================
// Live view of what the agent is doing: one row per tool call, updated in place
// as it moves active → completed/error. Showing the real steps (and what each
// returned) is what makes the agent feel trustworthy instead of a black box.

const AgentMonitor = (() => {
  const rows = new Map();   // step key → element
  let card = null;

  function init() {
    window.localMind?.onAgentProgress?.((data) => addStep(data));
  }

  const container = () => document.getElementById('chat-container');

  /** Open a fresh run card for `task`. */
  function begin(task) {
    const host = container();
    if (!host) return;
    rows.clear();
    card = document.createElement('div');
    card.className = 'agent-run';
    card.innerHTML = `
      <div class="agent-run-head">
        <span class="agent-spinner"></span>
        <span class="agent-run-title">Working on it…</span>
      </div>
      <div class="agent-run-task"></div>
      <div class="agent-steps"></div>`;
    card.querySelector('.agent-run-task').textContent = task;
    host.appendChild(card);
    host.scrollTop = host.scrollHeight;
  }

  function addStep(data) {
    if (!card) return;                     // progress arriving with no open run
    const list = card.querySelector('.agent-steps');
    if (!list) return;

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

    const host = container();
    if (host) host.scrollTop = host.scrollHeight;
  }

  /** Collapse the run card into a finished summary. */
  function finish(success) {
    if (!card) return;
    card.classList.add(success ? 'done' : 'failed');
    // Collapse once finished — the detail is available on click, but the
    // default view stays quiet.
    card.classList.add('collapsed');
    const head = card.querySelector('.agent-run-head');
    if (head) {
      head.style.cursor = 'pointer';
      head.title = 'Show steps';
      head.addEventListener('click', () => card.classList.toggle('collapsed'));
    }
    card.querySelector('.agent-spinner')?.remove();
    const title = card.querySelector('.agent-run-title');
    if (title) {
      const n = rows.size;
      title.textContent = success ? `Finished · ${n} step${n === 1 ? '' : 's'}` : 'Stopped';
    }
    card = null;
  }

  /** Wipe every run card out of the panel, not just the internal state.
      Run cards carry class `agent-run`, which is neither `.chat-message` nor
      `#agent-monitor`, so they used to survive "new chat" and pile up under the
      empty state as orphaned "Finished · N steps" boxes. */
  function clear() {
    rows.clear();
    card = null;
    container()?.querySelectorAll('.agent-run').forEach((el) => el.remove());
  }

  return { init, addStep, begin, finish, clear };
})();
