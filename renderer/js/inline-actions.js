// =============================================================================
// Local Mind Browser — Declarative element actions
// =============================================================================
// The replacement for inline `onerror=` / `onclick=` attributes in generated
// markup.
//
// Those attributes are what force `script-src 'unsafe-inline'` into the
// Content-Security-Policy, and a policy carrying that cannot stop injected
// script from running in the window that holds the privileged bridge. Since
// almost every one of them was doing the same handful of things — hide a broken
// favicon, drop a broken image, copy a code block — they are expressed as data
// attributes here and handled once.
//
// The image handlers are registered in the CAPTURE phase on purpose: `error`
// and `load` do not bubble, so a listener on the document only ever sees them
// on the way down.

const InlineActions = (() => {
  /** What to do with an element whose resource failed to load. */
  const ON_ERROR = {
    hide:       (el) => { el.style.display = 'none'; },
    invisible:  (el) => { el.style.visibility = 'hidden'; },
    remove:     (el) => el.remove(),
    'remove-figure': (el) => (el.closest('.md-figure') || el).remove(),
    'logo-failed':   (el) => el.parentElement?.classList.add('fin-logo-failed'),
    // Finance logos try a chain of sources before giving up.
    'logo-next': (el) => { if (typeof finLogoNext === 'function') finLogoNext(el); }
  };

  const ON_LOAD = {
    'logo-check': (el) => { if (typeof finLogoCheck === 'function') finLogoCheck(el); }
  };

  function init() {
    document.addEventListener('error', (e) => {
      const el = e.target;
      const key = el?.dataset?.onError;
      if (!key) return;
      ON_ERROR[key]?.(el);
    }, true);

    document.addEventListener('load', (e) => {
      const el = e.target;
      const key = el?.dataset?.onLoad;
      if (!key) return;
      ON_LOAD[key]?.(el);
    }, true);

    // Buttons inside rendered markdown: copy a code block, or flip a preview
    // back to its source.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-md-act]');
      if (!btn) return;
      const act = btn.dataset.mdAct;
      if (act === 'copy' && typeof copyCode === 'function') copyCode(btn);
      if (act === 'preview' && typeof togglePreview === 'function') togglePreview(btn);
    });
  }

  return { init };
})();
