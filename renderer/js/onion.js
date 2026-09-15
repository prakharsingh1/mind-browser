// =============================================================================
// Local Mind Browser — Onion Mode shell
// =============================================================================
// Address bar, navigation and the start page directory.
//
// The directory lists services that have a genuine reason to run on Tor:
// search that does not log, newsrooms reachable from countries that block them,
// and SecureDrop instances for people who need to hand something to a
// journalist without being traced. It is deliberately not a marketplace index.
//
// Onion addresses rotate, and a wrong one is a phishing risk rather than a dead
// link, so the start page tells people to verify against the organisation's own
// clearnet site.

const DIRECTORY = {
  'g-search': [
    { n: 'DuckDuckGo', d: 'Search with no logging and no result personalisation.',
      h: 'duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion' },
    { n: 'Ahmia', d: 'Indexes onion services and filters out abuse material.',
      h: 'juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion' }
  ],
  'g-news': [
    { n: 'BBC News', d: 'Reachable from places where the BBC is blocked.',
      h: 'bbcnewsd73hkzno2ini43t4gblxvycyac5aw4gnv7t2rccijh7745uqd.onion' },
    { n: 'ProPublica', d: 'The first major newsroom to run an onion service.',
      h: 'p53lf57qovyuvwsc6xnrppyply3vtqm7l6pcobkmyqsiofyeznfu5uqd.onion' },
    { n: 'Deutsche Welle', d: 'German international broadcaster.',
      h: 'dwnewsvdyyiamwnp.onion' }
  ],
  'g-drop': [
    { n: 'SecureDrop directory', d: 'The Freedom of the Press Foundation list of verified newsroom drops.',
      h: 'sdolvtfhatvsysc6l34d65ymdwxcujausv7k5jk4cy5ttzhjoi6fzvyd.onion' },
    { n: 'The Guardian', d: 'Send documents to Guardian journalists.',
      h: '33y6fjyhs3phzfjj.onion' }
  ],
  'g-tools': [
    { n: 'Tor Project', d: 'Documentation, downloads and how Tor actually works.',
      h: '2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion' },
    { n: 'Riseup', d: 'Email and organising tools for activists.',
      h: 'vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion' },
    { n: 'Debian', d: 'Official package archive over Tor.',
      h: 'sejnfjrq6szgca7v.onion' }
  ]
};

const SEARCH = 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/?q=';

const $ = (id) => document.getElementById(id);
const view = $('view');

// ── Directory ────────────────────────────────────────────────────────────────
for (const [groupId, entries] of Object.entries(DIRECTORY)) {
  const host = $(groupId);
  if (!host) continue;
  for (const e of entries) {
    const card = document.createElement('button');
    card.className = 'card';
    card.type = 'button';
    // textContent throughout: these are constants today, but a directory is
    // exactly the kind of list that later gets loaded from somewhere.
    const n = document.createElement('div'); n.className = 'n'; n.textContent = e.n;
    const d = document.createElement('div'); d.className = 'd'; d.textContent = e.d;
    const h = document.createElement('div'); h.className = 'h'; h.textContent = e.h;
    card.append(n, d, h);
    card.addEventListener('click', () => go('http://' + e.h));
    host.appendChild(card);
  }
}

// ── Navigation ───────────────────────────────────────────────────────────────
function normalize(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  // A bare onion or domain is an address; anything with a space is a search.
  if (/^[\w.-]+\.(onion|[a-z]{2,})(\/|$)/i.test(s) && !/\s/.test(s)) {
    return (/\.onion(\/|$)/i.test(s) ? 'http://' : 'https://') + s;
  }
  return SEARCH + encodeURIComponent(s);
}

function go(url) {
  if (!url) return;
  document.body.classList.add('browsing');
  $('url').value = url;
  view.src = url;
}

function home() {
  document.body.classList.remove('browsing');
  $('url').value = '';
  // Blanking the webview stops the previous page running in the background.
  try { view.src = 'about:blank'; } catch {}
  syncNav();
}

$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  go(normalize($('q').value) || SEARCH + encodeURIComponent($('q').value));
});

$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') go(normalize($('url').value));
});

$('back').addEventListener('click', () => { if (view.canGoBack()) view.goBack(); });
$('fwd').addEventListener('click', () => { if (view.canGoForward()) view.goForward(); });
$('reload').addEventListener('click', () => { if (document.body.classList.contains('browsing')) view.reload(); });
$('home').addEventListener('click', home);

function syncNav() {
  const browsing = document.body.classList.contains('browsing');
  try {
    $('back').disabled = !browsing || !view.canGoBack();
    $('fwd').disabled = !browsing || !view.canGoForward();
  } catch {
    $('back').disabled = $('fwd').disabled = true;
  }
}

for (const evt of ['did-navigate', 'did-navigate-in-page', 'did-stop-loading']) {
  view.addEventListener(evt, (e) => {
    if (e.url && e.url !== 'about:blank') $('url').value = e.url;
    syncNav();
  });
}

view.addEventListener('did-fail-load', (e) => {
  if (e.errorCode === -3) return;                    // aborted, normal
  $('statusText').textContent = `Could not load that address (${e.errorDescription || e.errorCode}).`;
});

// A new window would escape this session's proxy and preload, so links that ask
// for one are loaded here instead.
view.addEventListener('new-window', (e) => { e.preventDefault?.(); go(e.url); });

// ── Tor status ───────────────────────────────────────────────────────────────
function paint(s) {
  const box = $('status');
  const text = $('statusText');
  if (!box || !text) return;
  box.className = s.state === 'ready' ? 'ready' : s.state === 'failed' ? 'failed' : 'connecting';
  text.textContent =
    s.state === 'ready' ? 'Connected to Tor. Your IP address is hidden.'
    : s.state === 'failed' ? (s.error || 'Tor failed to start.')
    : s.progress ? `Connecting to Tor… ${s.progress}%`
    : 'Starting Tor…';
}

window.onion?.status().then(paint).catch(() => {});
window.onion?.onStatus(paint);

$('circuit').addEventListener('click', async () => {
  $('statusText').textContent = 'Building a new circuit…';
  try { await window.onion.newCircuit(); } catch {}
});

// The page preload path is owned by the main process; the webview needs it as
// an absolute file URL.
window.onion?.pagePreload().then((p) => { if (p) view.setAttribute('preload', p); }).catch(() => {});

// ── Security level ───────────────────────────────────────────────────────────
// Tor Browser's model, and the honest one: the things that identify you are the
// things that make the web work, so the user chooses where to sit on that line.
//
// Safest disables JavaScript at the ENGINE via the webview's webpreferences,
// not by patching APIs from a script. A page cannot opt out of a disabled
// engine, and that is the only version of this worth offering.
function applyLevel(info) {
  if (!info?.level) return;
  const meta = info.levels?.[info.level];
  const sel = $('level');
  if (sel && sel.value !== info.level) sel.value = info.level;
  const note = $('levelNote');
  if (note && meta) note.textContent = `${meta.name} — ${meta.detail}`;

  const wantsJs = meta ? meta.javascript : true;
  const attr = wantsJs ? 'javascript=yes' : 'javascript=no';
  if (view.getAttribute('webpreferences') !== attr) {
    view.setAttribute('webpreferences', attr);
    // webpreferences is read when the webview is attached, so an already-loaded
    // page keeps the old setting until it reloads.
    if (document.body.classList.contains('browsing') && view.src && view.src !== 'about:blank') {
      const url = view.src;
      view.src = 'about:blank';
      setTimeout(() => { view.src = url; }, 60);
    }
  }
}

$('level')?.addEventListener('change', async (e) => {
  try { applyLevel(await window.onion.setLevel(e.target.value)); } catch {}
});

window.onion?.level().then(applyLevel).catch(() => {});
window.onion?.onLevel(applyLevel);

// ── New Identity ─────────────────────────────────────────────────────────────
// Distinct from "New circuit": a new circuit only changes the path, so the
// cookies and storage from before would travel over it and link the two.
// New Identity throws the state away as well.
$('identity')?.addEventListener('click', async () => {
  $('statusText').textContent = 'Clearing everything and rebuilding…';
  try { await window.onion.newIdentity(); } catch {}
});

window.onion?.onNewIdentity(() => {
  home();
  $('q') && ($('q').value = '');
  hideOnionLoc();
});

// ── Onion-Location ───────────────────────────────────────────────────────────
// A site can advertise its own onion address. Taking it removes the exit node
// from the path entirely, so it is worth surfacing — but not worth hijacking
// navigation over, so it is an offer rather than an automatic redirect.
let pendingOnion = null;

function hideOnionLoc() {
  pendingOnion = null;
  $('onionloc')?.classList.remove('show');
}

window.onion?.onOnionLocation(({ to }) => {
  if (!to) return;
  pendingOnion = to;
  const el = $('onionlocText');
  if (el) el.textContent = 'This site runs its own onion service. Using it keeps your traffic inside the Tor network.';
  $('onionloc')?.classList.add('show');
});

$('onionlocGo')?.addEventListener('click', () => {
  const target = pendingOnion;
  hideOnionLoc();
  if (target) go(target);
});
$('onionlocNo')?.addEventListener('click', hideOnionLoc);

// A new page means the previous offer no longer applies.
view.addEventListener('did-start-loading', hideOnionLoc);

// ── Letterboxing ─────────────────────────────────────────────────────────────
// Quantise the content area to a 200x100 grid, exactly as Tor Browser does.
//
// The point is that thousands of people report the same viewport instead of
// their own unique window size. Doing it for REAL matters: an earlier version
// only overrode window.innerWidth, which left clientWidth, getBoundingClientRect
// and CSS media queries reporting the true size. That mismatch is easy to spot
// and marks the user as running anti-fingerprinting — a stronger signal than
// the honest measurement would have been.
function letterbox() {
  const stage = $('stage');
  if (!stage || !view) return;
  const floor = (n, step) => Math.max(step, Math.floor(n / step) * step);
  const w = floor(stage.clientWidth, 200);
  const h = floor(stage.clientHeight, 100);
  view.style.width = w + 'px';
  view.style.height = h + 'px';
  // The start page is ours, not a site, so it keeps the full area.
  const start = $('start');
  if (start) start.style.inset = '0';
}

letterbox();
window.addEventListener('resize', letterbox);
