// =============================================================================
// Local Mind Browser — Content Blocker (Ad/Tracker Blocker)
// =============================================================================
// Network-level content blocking using Electron's webRequest API.
// Blocks ads, trackers, and known malicious domains.

// Common ad/tracker domains to block
const BLOCKED_DOMAINS = new Set([
  // Advertising
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'googletagmanager.com', 'moatads.com', 'amazon-adsystem.com',
  'adnxs.com', 'adsrvr.org', 'adform.net', 'criteo.com', 'criteo.net',
  'taboola.com', 'outbrain.com', 'pubmatic.com', 'openx.net',
  'rubiconproject.com', 'casalemedia.com', 'advertising.com',
  'adcolony.com', 'ad.doubleclick.net', 'pagead2.googlesyndication.com',
  'tpc.googlesyndication.com', 'securepubads.g.doubleclick.net',

  // Tracking / Analytics
  'facebook.net', 'connect.facebook.net', 'pixel.facebook.com',
  'analytics.google.com', 'google-analytics.com', 'googletagservices.com',
  'hotjar.com', 'mixpanel.com', 'amplitude.com', 'segment.com',
  'fullstory.com', 'mouseflow.com', 'clarity.ms', 'newrelic.com',
  'nr-data.net', 'sentry.io', 'bugsnag.com', 'crashlytics.com',

  // Fingerprinting / Cross-site
  'scorecardresearch.com', 'quantserve.com', 'bluekai.com',
  'exelator.com', 'everesttech.net', 'demdex.net',
  'krxd.net', 'rlcdn.com', 'omtrdc.net', 'adsymptotic.com',
  'chartbeat.com', 'chartbeat.net', 'parsely.com',

  // Malware / Suspicious
  'malware-check.disconnect.me'
]);

let enabled = true;
let totalBlocked = 0;
let perTabBlocked = new Map();
let whitelistedDomains = new Set();

/**
 * Check if a URL's hostname matches any blocked domain.
 */
function isBlocked(urlString) {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();

    // Check whitelist first
    for (const wd of whitelistedDomains) {
      if (hostname === wd || hostname.endsWith('.' + wd)) return false;
    }

    // Check against blocked domains
    for (const blocked of BLOCKED_DOMAINS) {
      if (hostname === blocked || hostname.endsWith('.' + blocked)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Initialize content blocking on a session.
 * @param {Electron.Session} sessionObj - The session to apply blocking to
 */
// Per-site overrides, Brave-style: aggressive / standard / off, remembered per
// hostname. A global switch forces users to choose between broken pages and no
// protection at all; per-site is why people actually keep blocking turned on.
const siteModes = new Map();   // hostname -> 'aggressive' | 'standard' | 'off'

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function getSiteMode(host) { return siteModes.get(String(host || '').replace(/^www\./, '')) || 'standard'; }
function setSiteMode(host, mode) {
  const h = String(host || '').replace(/^www\./, '');
  if (!h) return { ok: false };
  if (mode === 'standard') siteModes.delete(h); else siteModes.set(h, mode);
  return { ok: true, host: h, mode: getSiteMode(h) };
}

// Set by the privacy engine. The blocker keeps its own manual toggle for the
// shields popup, but the privacy level is what decides whether it runs at all —
// two independent on/off switches for one behaviour would be a trap.
let privacyAllows = () => true;
const setPrivacyGate = (fn) => { privacyAllows = fn; };

// Electron permits ONE onBeforeRequest listener per session, so everything that
// needs to inspect a request before it goes out has to come through here.
// Returns a redirect URL, or null to carry on.
let prefilter = () => null;
const setRequestPrefilter = (fn) => { prefilter = fn; };

function initContentBlocker(sessionObj) {
  sessionObj.webRequest.onBeforeRequest((details, callback) => {
    // Upgrade before blocking: an http:// URL that would have been blocked
    // should still be blocked, but one that survives must not go out insecure.
    let redirectURL = null;
    try { redirectURL = prefilter(details); } catch { /* never break browsing */ }
    if (redirectURL) { callback({ redirectURL }); return; }

    if (!enabled || !privacyAllows()) {
      callback({ cancel: false });
      return;
    }

    // The page's own site decides the policy, not the request's host.
    const pageHost = hostOf(details.referrer || details.url);
    const mode = getSiteMode(pageHost);
    if (mode === 'off') { callback({ cancel: false }); return; }

    // Aggressive additionally blocks common third-party trackers/beacons.
    const aggressiveHit = mode === 'aggressive' &&
      /(\/|\.)(analytics|telemetry|beacon|pixel|collect|track(ing)?)([./?]|$)/i.test(details.url) &&
      hostOf(details.url) !== pageHost;

    if (isBlocked(details.url) || aggressiveHit) {
      totalBlocked++;
      // Track per-webContents (closest to per-tab)
      const wcId = details.webContentsId;
      if (wcId) {
        perTabBlocked.set(wcId, (perTabBlocked.get(wcId) || 0) + 1);
      }
      callback({ cancel: true });
      return;
    }

    callback({ cancel: false });
  });
}

function getStats(webContentsId) {
  return {
    enabled,
    totalBlocked,
    currentTab: webContentsId ? (perTabBlocked.get(webContentsId) || 0) : 0
  };
}

function toggle(isEnabled) {
  enabled = isEnabled;
  return { enabled };
}

function addWhitelist(domain) {
  whitelistedDomains.add(domain.toLowerCase());
}

function removeWhitelist(domain) {
  whitelistedDomains.delete(domain.toLowerCase());
}

module.exports = {
  setPrivacyGate,
  setRequestPrefilter,
  getSiteMode,
  setSiteMode,
  initContentBlocker,
  getStats,
  toggle,
  addWhitelist,
  removeWhitelist
};
