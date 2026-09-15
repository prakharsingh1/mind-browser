// =============================================================================
// Local Mind Browser — Renderer error reporting
// =============================================================================
// A thrown error in the UI does not crash the app; it just stops whatever was
// half-done and leaves no trace. That is worse than a crash in one respect —
// the interface quietly misbehaves and nobody can say why.
//
// These forward to the same crash log the main process writes, so a bug that
// only shows up on someone else's machine is at least recorded.
//
// Loaded first, before any other renderer script, so it catches failures in
// their setup too.
(() => {
  const seen = new Set();          // one report per unique error, not per repaint

  const send = (kind, detail) => {
    const key = kind + '|' + detail.slice(0, 200);
    if (seen.has(key)) return;
    seen.add(key);
    try { window.localMind?.reportError?.(`${kind}\n${detail}`); } catch {}
  };

  window.addEventListener('error', (e) => {
    // Failed <img>/<script> loads surface here too; they are noise, not bugs.
    if (!e.error && !e.message) return;
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
    send('renderer uncaught error', `${e.message}${where}\n${e.error?.stack || ''}`);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    send('renderer unhandled rejection', r instanceof Error ? `${r.message}\n${r.stack || ''}` : String(r));
  });
})();
