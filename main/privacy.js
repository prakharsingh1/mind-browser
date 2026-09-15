// =============================================================================
// Local Mind Browser — Privacy Levels
// =============================================================================
// One slider from "everything works" to "almost nothing does", plus a switch for
// every individual protection underneath it. The shape is borrowed from Tor
// Browser's security slider, which got the hard part right: people should not
// have to know what a canvas fingerprint is to decide how private they want to
// be, but the people who do know should still be able to reach every dial.
//
// Two honest limits, stated here so nothing downstream oversells them:
//
//   • This is not Tor. Traffic is not routed through anything — your IP is your
//     IP. What is defended here is what a SITE can learn and store about you,
//     not who can see that you connected to it.
//   • Fingerprint masking is a trade. Randomising a value makes you unlike
//     yourself between sessions, but a mask is itself unusual, so it does not
//     make you look like everybody else. It raises the cost of tracking; it does
//     not make it impossible.

const LEVELS = [
  {
    id: 1,
    name: 'Off',
    tagline: 'No extra protection',
    detail: 'Sites behave exactly as they were built to. Nothing is blocked or masked.',
    flags: []
  },
  {
    id: 2,
    name: 'Standard',
    tagline: 'Block ads and trackers',
    detail: 'Stops the advertising and analytics networks that follow you between sites. Everything keeps working.',
    flags: ['blockTrackers', 'blockThirdPartyCookies', 'sendDNT', 'sendGPC']
  },
  {
    id: 3,
    name: 'Strict',
    tagline: 'Hide who you are',
    detail: 'Adds identity masking, so sites cannot recognise this browser by its fingerprint. A few sites may misbehave.',
    flags: [
      'blockTrackers', 'blockThirdPartyCookies', 'sendDNT', 'sendGPC',
      'trimReferrer', 'spoofUserAgent', 'httpsOnly', 'blockWebRTCLeak',
      'maskCanvas', 'maskAudio', 'maskWebGL', 'blockNotifications'
    ]
  },
  {
    id: 4,
    name: 'Hardened',
    tagline: 'Nothing about your device or where you are',
    detail: 'Cuts off location, camera, microphone and sensors, masks your hardware and timezone, and clears site data when you quit. Expect to grant things back on sites you trust.',
    flags: [
      'blockTrackers', 'blockThirdPartyCookies', 'sendDNT', 'sendGPC',
      'trimReferrer', 'spoofUserAgent', 'httpsOnly', 'blockWebRTCLeak',
      'maskCanvas', 'maskAudio', 'maskWebGL', 'blockNotifications',
      'maskHardware', 'maskScreen', 'maskTimezoneLang',
      'blockLocation', 'blockCameraMic', 'blockSensors', 'blockDeviceApis',
      'noPrefetch', 'clearOnExit'
    ]
  },
  {
    id: 5,
    name: 'Maximum',
    tagline: 'Break the web on purpose',
    detail: 'Turns off JavaScript and WebGL entirely. This is the strongest setting and many sites will not work at all. Use it for reading something you do not trust.',
    flags: [
      'blockTrackers', 'blockThirdPartyCookies', 'sendDNT', 'sendGPC',
      'trimReferrer', 'spoofUserAgent', 'httpsOnly', 'blockWebRTCLeak',
      'maskCanvas', 'maskAudio', 'maskWebGL', 'blockNotifications',
      'maskHardware', 'maskScreen', 'maskTimezoneLang',
      'blockLocation', 'blockCameraMic', 'blockSensors', 'blockDeviceApis',
      'noPrefetch', 'clearOnExit',
      'disableJavaScript', 'disableWebGL'
    ]
  }
];

// Every switch, grouped the way the settings page shows them. `page` marks the
// ones enforced inside the page by the webview preload rather than by the
// session — the settings UI does not care, but it keeps the split explicit.
const CONTROLS = [
  { group: 'Blocking', items: [
    { key: 'blockTrackers', label: 'Block ads and trackers', desc: 'Cuts off known advertising and analytics domains before they load.' },
    { key: 'blockThirdPartyCookies', label: 'Block third-party cookies', desc: 'Stops sites setting cookies for other companies embedded in them.' }
  ]},
  { group: 'Identity masking', items: [
    { key: 'maskCanvas', label: 'Mask canvas fingerprint', desc: 'Adds tiny noise to drawn images so they cannot be used as an ID.', page: true },
    { key: 'maskWebGL', label: 'Mask graphics card', desc: 'Hides the exact GPU model your machine reports.', page: true },
    { key: 'maskAudio', label: 'Mask audio fingerprint', desc: 'Perturbs audio processing output, which is otherwise unique per device.', page: true },
    { key: 'maskHardware', label: 'Mask hardware details', desc: 'Reports generic CPU core count and memory instead of yours.', page: true },
    { key: 'maskScreen', label: 'Mask screen size', desc: 'Rounds your screen dimensions so an unusual monitor is not a giveaway.', page: true },
    { key: 'maskTimezoneLang', label: 'Mask timezone and language', desc: 'Reports UTC and English rather than your real locale.', page: true },
    { key: 'spoofUserAgent', label: 'Mask browser identity', desc: 'Presents a common Chrome user agent instead of naming this browser.' }
  ]},
  { group: 'Tracking signals', items: [
    { key: 'sendDNT', label: 'Send Do Not Track', desc: 'Asks sites not to track you. Most ignore it, but it costs nothing.' },
    { key: 'sendGPC', label: 'Send Global Privacy Control', desc: 'A legally recognised opt-out in some regions, unlike Do Not Track.' },
    { key: 'trimReferrer', label: 'Trim referrers', desc: 'Tells a site you came from another domain, not which exact page.' }
  ]},
  { group: 'Device access', items: [
    { key: 'blockLocation', label: 'Block location', desc: 'No site can ask where you are. Requests are denied, not prompted.', page: true },
    { key: 'blockCameraMic', label: 'Block camera and microphone', desc: 'Denies all capture requests outright.' },
    { key: 'blockNotifications', label: 'Block notification prompts', desc: 'No more "allow notifications?" pop-ups.' },
    { key: 'blockSensors', label: 'Block motion sensors', desc: 'Hides accelerometer and orientation, which can identify a device.', page: true },
    { key: 'blockDeviceApis', label: 'Block USB, Serial, MIDI and HID', desc: 'Denies direct access to attached hardware.' }
  ]},
  { group: 'Network', items: [
    { key: 'httpsOnly', label: 'HTTPS only', desc: 'Upgrades insecure page loads, and refuses ones that cannot be upgraded.' },
    { key: 'blockWebRTCLeak', label: 'Block WebRTC IP leak', desc: 'Stops video-call APIs revealing your real local network address.' },
    { key: 'noPrefetch', label: 'Disable prefetching', desc: 'Stops the browser quietly contacting pages you have not opened.' }
  ]},
  { group: 'Data', items: [
    { key: 'clearOnExit', label: 'Clear site data on quit', desc: 'Cookies, storage and caches are wiped every time you close the browser.' }
  ]},
  { group: 'Extreme', items: [
    { key: 'disableJavaScript', label: 'Disable JavaScript', desc: 'The single most effective protection there is, and the most destructive. Most sites will break.' },
    { key: 'disableWebGL', label: 'Disable WebGL', desc: 'Removes 3D graphics, a rich source of fingerprinting.' }
  ]}
];

const ALL_KEYS = CONTROLS.flatMap((g) => g.items.map((i) => i.key));

/**
 * Resolve the switches actually in force.
 *
 * A level is a starting point, not a cage: anything the user has explicitly
 * toggled wins over the level's preset, and the UI then shows "Custom".
 */
function effectiveFlags(privacy = {}) {
  const level = LEVELS.find((l) => l.id === (privacy.level ?? 2)) || LEVELS[1];
  const out = {};
  for (const key of ALL_KEYS) out[key] = level.flags.includes(key);

  const overrides = privacy.overrides || {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key in out) out[key] = !!value;
  }
  return out;
}

/** True when the user has bent the level out of shape. */
function isCustom(privacy = {}) {
  const level = LEVELS.find((l) => l.id === (privacy.level ?? 2)) || LEVELS[1];
  const overrides = privacy.overrides || {};
  return Object.entries(overrides).some(([k, v]) => ALL_KEYS.includes(k) && !!v !== level.flags.includes(k));
}

// ── Encrypted DNS ────────────────────────────────────────────────────────────
// Ordinary DNS is plaintext: every domain you visit is readable by your ISP and
// anyone on the network, no matter how much of the page itself is encrypted.
// DNS-over-HTTPS closes that gap. The resolver still sees your lookups, so the
// choice is really "who do you prefer to trust" — hence a list rather than a
// switch, with what each one actually does spelled out.
const DNS_PROVIDERS = [
  { id: 'system', name: 'System default', detail: 'Whatever your operating system is set to. Usually your ISP, unencrypted.', servers: [] },
  { id: 'cloudflare', name: 'Cloudflare', detail: 'Fast, no logging of identifying data. Does not filter anything.', servers: ['https://cloudflare-dns.com/dns-query'] },
  { id: 'quad9', name: 'Quad9', detail: 'Swiss non-profit. Blocks known malware and phishing domains.', servers: ['https://dns.quad9.net/dns-query'] },
  { id: 'mullvad', name: 'Mullvad', detail: 'Privacy-focused, no logs, runs on their own infrastructure.', servers: ['https://dns.mullvad.net/dns-query'] },
  { id: 'adguard', name: 'AdGuard', detail: 'Blocks ads and trackers at the DNS level, before a request is made.', servers: ['https://dns.adguard-dns.com/dns-query'] }
];

const dnsProvider = (privacy) =>
  DNS_PROVIDERS.find((p) => p.id === (privacy?.dnsProvider || 'system')) || DNS_PROVIDERS[0];

// ── Per-site exceptions ──────────────────────────────────────────────────────
// Identity masking is the part that breaks sites: a bank that fingerprints its
// login page, a canvas-based game, a video call. Global-only masking means one
// awkward site costs you protection EVERYWHERE, so people turn the whole thing
// off and never turn it back on. An exception is one site's worth of damage.
//
// Four states, so the UI can say which of the reasons applies rather than just
// showing an off switch:
//   unavailable   the current level does no page masking at all
//   globally-off  masking exists but the user has switched it off everywhere
//   off-for-site  on in general, deliberately excepted here
//   on            active on this page

/** The page-level masks. Blocking and header rewriting are NOT affected by an
 *  exception — Shields already has its own per-site control for those. */
const PAGE_MASK_KEYS = [
  'maskCanvas', 'maskWebGL', 'maskAudio', 'maskHardware',
  'maskScreen', 'maskTimezoneLang'
];

/** Compare hosts the way the UI shows them, so "www." never splits a site. */
const normalizeHost = (host) => String(host || '').toLowerCase().replace(/^www\./, '');

function hostFromUrl(url) {
  try { return normalizeHost(new URL(url).hostname); } catch { return ''; }
}

/** True when this site has been excepted. */
function isSiteExcepted(privacy, host) {
  const h = normalizeHost(host);
  return !!h && !!(privacy?.siteExceptions || {})[h];
}

/**
 * @returns {'unavailable'|'globally-off'|'off-for-site'|'on'}
 */
function maskingStateFor(privacy, host) {
  const flags = effectiveFlags(privacy || {});
  if (!PAGE_MASK_KEYS.some((k) => flags[k])) {
    // Nothing is on. Distinguish "this level has none" from "you turned it off"
    // so the UI can offer the useful next step in each case.
    const levelId = privacy?.level ?? 2;
    const level = LEVELS.find((l) => l.id === levelId) || LEVELS[1];
    return PAGE_MASK_KEYS.some((k) => level.flags.includes(k)) ? 'globally-off' : 'unavailable';
  }
  return isSiteExcepted(privacy, host) ? 'off-for-site' : 'on';
}

/** Flags with the page masks stripped, for an excepted site. */
function flagsForSite(privacy, host) {
  const flags = effectiveFlags(privacy || {});
  if (!isSiteExcepted(privacy, host)) return flags;
  const out = { ...flags };
  for (const k of PAGE_MASK_KEYS) out[k] = false;
  // Location and sensors stay blocked: an exception is about a site rendering
  // correctly, not about handing it the camera and your coordinates.
  return out;
}

module.exports = {
  LEVELS, CONTROLS, ALL_KEYS, effectiveFlags, isCustom,
  DNS_PROVIDERS, dnsProvider,
  PAGE_MASK_KEYS, normalizeHost, hostFromUrl,
  isSiteExcepted, maskingStateFor, flagsForSite
};
