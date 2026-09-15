// =============================================================================
// Local Mind Browser — Site information
// =============================================================================
// What you get when you click the padlock, and what Chrome trained everyone to
// expect there: whether the connection is really encrypted, who vouched for it
// and until when, what this site has stored on your machine, what it has been
// allowed to do, and the per-site blocking controls.
//
// The padlock is a claim. The whole point of this panel is that you can check
// it, so the certificate's issuer and expiry are shown as text rather than
// implied by a green icon.
//
// It is anchored under whichever button opened it. It used to be pinned to the
// centre of the window, which left it floating in the middle of the page with
// no visible relationship to the control that produced it.

const Shields = (() => {
  let popover = null;
  let anchorEl = null;

  function init() {
    for (const id of ['btn-site-info', 'btn-adblock']) {
      document.getElementById(id)?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle(document.getElementById(id));
      });
    }
  }

  const hostOf = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  };

  function close() {
    popover?.remove();
    popover = null;
    anchorEl = null;
  }

  /**
   * Put the panel under its button and keep it on screen.
   *
   * Left-aligned to the button where there is room, because the padlock sits at
   * the left end of the address bar and a centred panel reads as belonging to
   * nothing.
   */
  function place() {
    if (!popover || !anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    popover.style.visibility = 'hidden';
    const w = popover.offsetWidth;
    const h = popover.offsetHeight;
    const edge = 10;

    let left = r.left - 6;
    left = Math.max(edge, Math.min(left, window.innerWidth - w - edge));

    let top = r.bottom + 8;
    if (top + h > window.innerHeight - edge) top = Math.max(edge, r.top - h - 8);

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.style.visibility = '';
  }

  const fmtDate = (ms) =>
    ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

  async function toggle(button) {
    if (popover) return close();

    const tab = TabManager.getActiveTab?.();
    const url = tab?.url || '';
    const host = hostOf(url);
    if (!host && !url.startsWith('file:')) {
      Sidebar.showToast?.('Open a website first.');
      return;
    }

    anchorEl = button || document.getElementById('btn-site-info');

    // Everything the panel shows, gathered before it is drawn so it does not
    // appear and then rearrange itself under the cursor.
    const [info, cert, perms, shield, maskState] = await Promise.all([
      window.localMind.siteInfo(url).catch(() => null),
      window.localMind.certFor(host).catch(() => null),
      window.localMind.listPermissions().catch(() => []),
      window.localMind.shieldGet(host).catch(() => null),
      window.localMind.privacySiteState(host).catch(() => 'unavailable')
    ]);

    const mode = shield?.mode || 'standard';
    const blocked = shield?.stats?.totalBlocked || 0;
    const sitePerms = (perms || []).filter((p) => {
      try { return new URL(p.origin).hostname.replace(/^www\./, '') === host; }
      catch { return p.origin === info?.origin; }
    });

    popover = document.createElement('div');
    popover.id = 'shields-popover';
    popover.innerHTML = `
      <div class="si-conn" id="si-conn"></div>

      <div class="si-rows" id="si-rows"></div>

      <div class="sh-divider"></div>
      <div class="sh-head">
        <span class="sh-host"></span>
        <span class="sh-count">${blocked.toLocaleString()}</span>
      </div>
      <div class="sh-sub">trackers &amp; ads blocked since launch</div>
      <div class="sh-modes">
        ${['aggressive', 'standard', 'off'].map((m) => `
          <button class="sh-mode ${m === mode ? 'active' : ''}" data-mode="${m}">
            ${m === 'aggressive' ? 'Aggressive' : m === 'standard' ? 'Standard' : 'Off'}
          </button>`).join('')}
      </div>
      <div class="sh-note" id="sh-note"></div>

      <div class="sh-divider"></div>
      <div class="sh-mask" id="sh-mask">
        <div class="sh-mask-row">
          <span class="sh-mask-label">Identity masking</span>
          <button class="sh-mask-toggle" id="sh-mask-toggle" type="button"></button>
        </div>
        <div class="sh-mask-note" id="sh-mask-note"></div>
      </div>

      <div class="sh-divider"></div>
      <button class="si-clear" id="si-clear">Clear cookies and site data</button>`;

    popover.querySelector('.sh-host').textContent = host || 'This page';
    document.body.appendChild(popover);

    paintConnection(info, cert);
    paintRows(info, sitePerms);
    describe(mode);
    paintMask(maskState);
    place();

    // ── Blocking mode ────────────────────────────────────────────────────────
    popover.querySelectorAll('[data-mode]').forEach((b) => {
      b.addEventListener('click', async () => {
        const next = b.dataset.mode;
        popover.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('active', x === b));
        describe(next);
        try { await window.localMind.shieldSet(host, next); } catch {}
        // Blocking decisions apply at request time, so the page needs a reload.
        reloadSoon();
      });
    });

    // ── Identity masking ─────────────────────────────────────────────────────
    let mask = maskState;
    document.getElementById('sh-mask-toggle')?.addEventListener('click', async () => {
      if (mask !== 'on' && mask !== 'off-for-site') return;
      const wantMasked = mask === 'off-for-site';
      try { mask = await window.localMind.privacySiteSet(host, wantMasked) || mask; } catch { return; }
      paintMask(mask);
      // Masking is injected before the page's scripts run, so it only takes
      // effect on the next load.
      reloadSoon();
    });

    // ── Clear site data ──────────────────────────────────────────────────────
    document.getElementById('si-clear')?.addEventListener('click', async () => {
      if (!info?.origin) return;
      if (!confirm(`Clear cookies and stored data for ${host}? You will be signed out of it.`)) return;
      const res = await window.localMind.clearSiteData(info.origin);
      Sidebar.showToast?.(res?.ok ? `Cleared data for ${host}.` : 'Could not clear that site.');
      close();
      reloadSoon();
    });

    const off = (e) => {
      if (popover && !popover.contains(e.target)
          && !e.target.closest('#btn-adblock') && !e.target.closest('#btn-site-info')) close();
    };
    setTimeout(() => document.addEventListener('mousedown', off), 10);
    window.addEventListener('resize', place, { once: true });
  }

  function reloadSoon() {
    const t = TabManager.getActiveTab?.();
    if (t?.webview) setTimeout(() => { try { t.webview.reload(); } catch {} }, 250);
  }

  /** The headline: is this connection actually protecting anything. */
  function paintConnection(info, cert) {
    const el = popover.querySelector('#si-conn');
    if (!el) return;

    let tone = 'bad';
    let title = 'Not secure';
    let detail = 'Anyone on this network can read and change what you send to this site.';

    if (info?.local) {
      tone = 'neutral';
      title = 'Local content';
      detail = 'This page came from your own machine, so nothing crossed a network.';
    } else if (info?.secure) {
      tone = 'good';
      title = 'Connection is encrypted';
      detail = cert?.issuer
        ? `Verified by ${cert.issuer}. Expires ${fmtDate(cert.validTo)}.`
        : 'The certificate was verified.';
    }

    el.className = `si-conn ${tone}`;
    const t = document.createElement('div');
    t.className = 'si-conn-title';
    t.textContent = title;
    const d = document.createElement('div');
    d.className = 'si-conn-detail';
    // textContent: the issuer name comes from a certificate the site supplied.
    d.textContent = detail;
    el.append(t, d);
  }

  /** Certificate, storage and permissions, as plain labelled rows. */
  function paintRows(info, sitePerms) {
    const host = popover.querySelector('#si-rows');
    if (!host) return;

    const row = (label, value, extra) => {
      const r = document.createElement('div');
      r.className = 'si-row';
      const l = document.createElement('span');
      l.className = 'si-row-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'si-row-value';
      v.textContent = value;
      r.append(l, v);
      if (extra) r.appendChild(extra);
      host.appendChild(r);
    };

    row('Cookies and data', info ? `${info.cookies} cookie${info.cookies === 1 ? '' : 's'}` : '—');

    if (!sitePerms.length) {
      row('Permissions', 'None asked for');
    } else {
      for (const p of sitePerms) {
        const undo = document.createElement('button');
        undo.className = 'si-revoke';
        undo.textContent = 'Reset';
        undo.title = 'Forget this decision — the site will ask again';
        undo.addEventListener('click', async () => {
          await window.localMind.revokePermission(p.origin, p.permission);
          undo.closest('.si-row')?.remove();
          Sidebar.showToast?.('Permission reset.');
        });
        row(capitalise(p.label || p.permission), p.decision === 'allow' ? 'Allowed' : 'Blocked', undo);
      }
    }
  }

  const capitalise = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

  /**
   * Render the four masking states. Saying WHY it is off matters: "you turned
   * it off everywhere" and "this level does not do masking" need different
   * next steps from the user, and a bare off switch tells them neither.
   */
  function paintMask(state) {
    const wrap = document.getElementById('sh-mask');
    const btn = document.getElementById('sh-mask-toggle');
    const note = document.getElementById('sh-mask-note');
    if (!wrap || !btn || !note) return;

    wrap.classList.toggle('disabled', state === 'unavailable' || state === 'globally-off');
    btn.classList.toggle('on', state === 'on');

    if (state === 'on') {
      btn.textContent = 'On for this site';
      note.textContent = 'This site sees generic hardware, not yours. Turn off if the page misbehaves.';
    } else if (state === 'off-for-site') {
      btn.textContent = 'Off for this site';
      note.textContent = 'This site sees your real hardware. Turn back on when you are done.';
    } else if (state === 'globally-off') {
      btn.textContent = 'Off everywhere';
      note.textContent = 'Masking is off in Settings → Privacy, so there is nothing to change here.';
    } else {
      btn.textContent = 'Unavailable';
      note.textContent = 'This privacy level does not mask hardware.';
    }
  }

  function describe(mode) {
    const note = document.getElementById('sh-note');
    if (!note) return;
    note.textContent =
      mode === 'aggressive' ? 'Blocks more, including some first-party scripts. May break sites.'
      : mode === 'standard' ? 'Blocks known ad and tracker domains. Recommended.'
      : 'Nothing is blocked on this site.';
  }

  return { init, close };
})();
