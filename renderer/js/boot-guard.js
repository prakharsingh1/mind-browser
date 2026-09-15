// =============================================================================
// Local Mind Browser — Boot guard
// =============================================================================
// Belt and braces for a corruption we have actually seen, not a hypothetical.
//
// On some launches after a rebuild the main document arrived with raw bytes
// from neighbouring files in app.asar glued to the front of it. The browser
// parses that leading junk as text and hoists it into <body>, which shoves the
// entire interface down the page and looks like the app is broken.
//
// The real fix is upstream (the document URL is now cache-busted per launch).
// This only removes any stray text that still manages to land ahead of the
// shell, so a bad read degrades to a cosmetic non-event instead of a wrecked
// window. It touches nothing else: only text nodes, only before #app.
//
// Lives in its own file rather than inline because the chrome document now
// carries a Content-Security-Policy, and `script-src 'self'` has no exemption
// for inline script — which is the entire point of setting it.
document.addEventListener('DOMContentLoaded', function stripLeadingJunk() {
  const app = document.getElementById('app');
  if (!app) return;
  let n = document.body.firstChild;
  while (n && n !== app) {
    const next = n.nextSibling;
    if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) n.remove();
    n = next;
  }
});
