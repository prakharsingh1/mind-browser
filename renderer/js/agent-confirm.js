// =============================================================================
// Local Mind Browser — Irreversible Action Confirmation
// =============================================================================
// The agent may click, type and submit on real pages. Navigation and reading
// are safe to do freely, but some controls cannot be taken back once pressed:
// sending a message, placing an order, deleting something, publishing a post.
//
// Those pause and ask. The prompt names the actual control the agent is about
// to press, because "allow this click?" tells the user nothing useful.

const AgentConfirm = (() => {
  // Verbs that mean "this happens for real, and you cannot undo it".
  const RISKY = [
    'buy', 'purchase', 'order', 'checkout', 'pay', 'payment', 'place order',
    'send', 'submit', 'post', 'publish', 'tweet', 'reply',
    'delete', 'remove', 'discard', 'trash', 'deactivate', 'close account',
    'confirm', 'transfer', 'withdraw', 'donate',
    'subscribe', 'sign up', 'sign in', 'log in', 'register',
    'accept', 'agree', 'i agree', 'apply now'
  ];

  /** Does this control's label look irreversible? */
  function isRisky(label) {
    const s = String(label || '').toLowerCase().trim();
    if (!s) return false;
    return RISKY.some((v) => s === v || s.includes(v));
  }

  let seq = 0;
  let callId = null;

  /** The bridge call currently being served, so its deadline can be paused. */
  const setCallId = (id) => { callId = id; };

  /**
   * Render a confirmation card into the chat and resolve with the user's choice.
   * Resolves false if the panel is missing, so an unanswerable prompt blocks the
   * action rather than silently allowing it.
   */
  function ask({ title, detail, danger }) {
    return new Promise((resolve) => {
      const host = document.getElementById('chat-container');
      if (!host) return resolve(false);

      const empty = document.getElementById('ai-empty-state');
      if (empty) empty.style.display = 'none';

      const id = `confirm-${++seq}`;
      const card = document.createElement('div');
      card.className = 'agent-confirm';
      card.id = id;
      card.innerHTML = `
        <div class="agent-confirm-head">
          <span class="agent-confirm-badge">Needs your OK</span>
          <span class="agent-confirm-title"></span>
        </div>
        <div class="agent-confirm-detail"></div>
        <div class="agent-confirm-actions">
          <button class="agent-confirm-no">Don't do it</button>
          <button class="agent-confirm-yes${danger ? ' danger' : ''}">Allow</button>
        </div>`;
      // textContent, never innerHTML: title and detail come from the page the
      // agent is on, which is untrusted.
      card.querySelector('.agent-confirm-title').textContent = title;
      card.querySelector('.agent-confirm-detail').textContent = detail;
      host.appendChild(card);
      host.scrollTop = host.scrollHeight;

      // Freeze the bridge deadline: a person may take minutes, and a timeout
      // here made the agent retry and stack up duplicate prompts.
      const held = callId;
      try { window.localMind?.agentHoldTimeout?.(held); } catch {}

      const shownAt = Date.now();

      // Never let the freshly added buttons steal focus: if one is focused, a
      // stray Enter aimed at the page activates it.
      card.querySelectorAll('button').forEach((b) => b.setAttribute('tabindex', '-1'));

      let settled = false;
      const finish = (allowed) => {
        if (settled) return;
        settled = true;
        try { window.localMind?.agentReleaseTimeout?.(held); } catch {}
        card.classList.add(allowed ? 'allowed' : 'blocked');
        card.querySelector('.agent-confirm-actions').innerHTML =
          `<span class="agent-confirm-outcome">${allowed ? 'Allowed' : 'Blocked'}</span>`;
        resolve(allowed);
      };

      // Allowing is deliberately hard to trigger by accident.
      //
      // The agent drives the page with real input events, and Electron routes a
      // sendInputEvent to whatever currently has focus — which can be this panel
      // rather than the webview. A stray Enter then landed on a focused Allow
      // button and approved the very action it was meant to gate. Observed:
      // the gate approved a form submission with no one touching the mouse.
      //
      // So Allow requires a pointer press (detail > 0 — keyboard-generated
      // clicks report 0), and no activation counts until the card has been on
      // screen long enough for a person to have read it. Blocking stays
      // available by any means: the safe direction should never be hard.
      const GRACE_MS = 700;
      card.querySelector('.agent-confirm-yes').addEventListener('click', (ev) => {
        if (Date.now() - shownAt < GRACE_MS) return;
        if (!ev.isTrusted || ev.detail === 0) return;
        finish(true);
      });
      card.querySelector('.agent-confirm-no').addEventListener('click', () => finish(false));
    });
  }

  /**
   * Gate one action. Returns true to proceed.
   * `label` is the control's own text where we have it.
   */
  async function gate({ action, label, url }) {
    const where = url ? ` on ${(() => { try { return new URL(url).hostname; } catch { return url; } })()}` : '';
    return ask({
      title: `${action}${where}`,
      detail: label ? `Control: "${label}"` : 'This cannot be undone.',
      danger: true
    });
  }

  return { isRisky, gate, ask, setCallId };
})();
