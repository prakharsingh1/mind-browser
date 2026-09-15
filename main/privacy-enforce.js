// =============================================================================
// Local Mind Browser — Privacy Enforcement (session level)
// =============================================================================
// The half of the privacy settings that has to live in the main process:
// permissions, request headers, HTTPS upgrades, prefetch and data clearing.
// The other half — anything a page can only be lied to about from inside the
// page — is applied by the webview preload.
//
// Everything here re-reads the flags on each event rather than capturing them,
// so changing a setting takes effect on the next request instead of needing a
// restart.

const { session, app } = require('electron');
const { effectiveFlags } = require('./privacy');

let getFlags = () => ({});

// Set by index.js once a window exists. Returns a promise for 'allow'/'deny'.
let askUser = () => Promise.resolve('deny');
const setPermissionAsker = (fn) => { askUser = fn; };

// A plain, extremely common Chrome UA. The point is to be boring: naming this
// browser in the UA string would make every user of it trivially identifiable.
/**
 * The user agent we present: stock Chrome on macOS.
 *
 * The version is derived from the engine actually running, not written by hand.
 * A hardcoded "Chrome/131" drifts every time Electron updates, and claiming an
 * older Chrome than you are running is detectable in one line — feature tests
 * find capabilities that version never shipped.
 *
 * Chrome itself reports the patch component as 0.0 under the reduced-UA policy,
 * so matching that both looks right and avoids leaking the exact build.
 *
 * macOS, not Windows: Windows would be a bigger crowd to hide in, but the fonts
 * and metrics underneath are unmistakably a Mac, and a claim the machine
 * contradicts is worse than an honest one. Consistency is the whole point.
 */
const CHROME_MAJOR = (process.versions.chrome || '136').split('.')[0];
const GENERIC_UA =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

/** Client-hint brands matching the UA above, in stock Chrome's shape. */
const UA_BRANDS = [
  { brand: 'Chromium', version: CHROME_MAJOR },
  { brand: 'Google Chrome', version: CHROME_MAJOR },
  { brand: 'Not_A Brand', version: '24' }
];

// Permission → the flag that denies it. Anything not listed keeps Electron's
// default handling.
const PERMISSION_GUARD = {
  geolocation: 'blockLocation',
  media: 'blockCameraMic',
  'display-capture': 'blockCameraMic',
  'speaker-selection': 'blockCameraMic',
  notifications: 'blockNotifications',
  midi: 'blockDeviceApis',
  midiSysex: 'blockDeviceApis',
  usb: 'blockDeviceApis',
  serial: 'blockDeviceApis',
  hid: 'blockDeviceApis',
  'idle-detection': 'blockSensors'
};

function applyToSession(ses) {
  // ── Permissions ───────────────────────────────────────────────────────────
  // Both handlers matter: the request handler covers a site asking, the check
  // handler covers a site quietly querying whether it already has access.
  // Ownership of the two permission handlers moved to main/permissions.js.
  // This used to answer callback(true) for anything the privacy settings did
  // not explicitly block, which handed the camera, microphone, location and
  // notification channel to any page that asked, with no prompt and no record.
  // The privacy flags still get the final say — they are passed in as a hard
  // block that overrides even a previous "allow".
  require('./permissions').guard(
    ses,
    (permission) => {
      const flags = getFlags();
      const guard = PERMISSION_GUARD[permission];
      return Boolean(guard && flags[guard]);
    },
    (request) => askUser(request)
  );

  // ── Request headers ───────────────────────────────────────────────────────
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const flags = getFlags();
    const headers = { ...details.requestHeaders };

    if (flags.sendDNT) headers['DNT'] = '1';
    if (flags.sendGPC) headers['Sec-GPC'] = '1';

    if (flags.spoofUserAgent) {
      headers['User-Agent'] = GENERIC_UA;
      // Client Hints restate the same facts in a second channel, so a spoofed
      // UA with honest hints just advertises that something is being spoofed.
      delete headers['Sec-CH-UA-Full-Version-List'];
      delete headers['Sec-CH-UA-Full-Version'];
      delete headers['Sec-CH-UA-Arch'];
      delete headers['Sec-CH-UA-Model'];
      delete headers['Sec-CH-UA-Platform-Version'];
      delete headers['Sec-CH-UA-Bitness'];
    }

    if (flags.maskTimezoneLang) headers['Accept-Language'] = 'en-US,en;q=0.9';

    // Keep the origin, drop the path: enough for sites that break without a
    // referrer, nothing about which page you were reading.
    if (flags.trimReferrer && headers['Referer']) {
      try { headers['Referer'] = new URL(headers['Referer']).origin + '/'; }
      catch { delete headers['Referer']; }
    }

    callback({ requestHeaders: headers });
  });

  // ── Third-party cookies ───────────────────────────────────────────────────
  ses.cookies.on('changed', (_e, cookie, cause, removed) => {
    if (removed || cause !== 'explicit') return;
    if (!getFlags().blockThirdPartyCookies) return;
    // Electron exposes no "block third-party" switch, so enforce it by removing
    // cookies that arrive for a domain other than the one being visited. This
    // runs after the set, which is why the cookie is deleted rather than denied.
    if (!cookie.sameSite || cookie.sameSite === 'no_restriction') {
      const url = `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`;
      ses.cookies.remove(url, cookie.name).catch(() => {});
    }
  });
}

/**
 * HTTPS-only, as a pure decision rather than its own webRequest listener.
 *
 * Electron allows exactly ONE listener per webRequest event — registering a
 * second onBeforeRequest silently REPLACES the first. The content blocker
 * already owns that event, so this is handed to it instead. Registering our own
 * here disabled ad blocking entirely and was invisible until traffic was
 * inspected.
 *
 * @returns {string|null} a URL to redirect to, or null to leave the request be
 */
function httpsUpgrade(url) {
  if (!getFlags().httpsOnly || !url.startsWith('http://')) return null;

  // Localhost is exempt: it never leaves the machine, and forcing HTTPS there
  // only breaks local development for no privacy gain.
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')) return null;
  } catch { return null; }

  return url.replace(/^http:/, 'https:');
}

/**
 * Wipe what SITES have stored. Used by "clear on quit".
 *
 * The browser's own interface is a file:// page in this same session, and it
 * keeps real user data in localStorage — the wallpaper, notes, pinned items,
 * history, open tabs. A blanket clearStorageData() therefore deleted the user's
 * notes as a side effect of a privacy setting, which is about the worst thing a
 * privacy setting could do. Excluding the app's own origin keeps the promise
 * ("sites cannot follow you") without destroying anything the user made.
 */
const APP_ORIGIN = 'file://';

async function clearSiteData(ses) {
  // Throw the fingerprint seeds away with everything else. They are not stored
  // in any site's data, so nothing here would touch them otherwise — and noise
  // that survives a wipe is a stronger identifier than the cookies just
  // deleted, which inverts the point of clearing.
  try { require('./privacy-seed').rotateSeeds(); } catch { /* non-fatal */ }

  try {
    await ses.clearData({ excludeOrigins: [APP_ORIGIN] });
  } catch {
    // Older Electron without clearData's exclusion support: fall back to
    // clearing only the things that cannot belong to the app's own UI.
    try {
      await ses.clearStorageData({ storages: ['cookies', 'serviceworkers', 'cachestorage', 'indexdb', 'websql', 'filesystem'] });
      await ses.clearCache();
    } catch { /* best effort — never block quit on this */ }
  }
}

/**
 * @param {Function} flagsGetter returns the current effective flags
 */
function initPrivacyEnforcement(flagsGetter) {
  getFlags = flagsGetter;

  applyToSession(session.defaultSession);

  // Incognito tabs use their own partition, which needs the same treatment.
  try { applyToSession(session.fromPartition('incognito')); } catch { /* created lazily */ }

  app.on('before-quit', async () => {
    if (!getFlags().clearOnExit) return;
    await clearSiteData(session.defaultSession);
  });
}

/** Switches that can only be set once, at startup, before the first window. */
function applyStartupSwitches(flags) {
  if (flags.blockWebRTCLeak) {
    // Confines WebRTC to the public interface, so a site cannot enumerate your
    // LAN addresses through a peer connection.
    app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'default_public_interface_only');
  }
  if (flags.noPrefetch) {
    app.commandLine.appendSwitch('disable-features', 'PreconnectToSearch,NetworkPrediction');
  }
  if (flags.disableWebGL) {
    app.commandLine.appendSwitch('disable-webgl');
    app.commandLine.appendSwitch('disable-webgl2');
  }
}

/**
 * Point the resolver at an encrypted DNS provider.
 *
 * configureHostResolver rather than command-line switches: it can be re-applied
 * when the user changes provider, where a switch would need a restart.
 * 'secure' refuses to fall back to plaintext — a fallback would silently undo
 * the whole point the first time the resolver hiccuped.
 */
function applyDnsSettings(privacy) {
  const { dnsProvider } = require('./privacy');
  const provider = dnsProvider(privacy);
  try {
    if (!provider.servers.length) {
      app.configureHostResolver({ secureDnsMode: 'off', secureDnsServers: [] });
    } else {
      app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: provider.servers });
    }
    return provider.id;
  } catch {
    return null;               // older Electron: leave the system resolver alone
  }
}

module.exports = { initPrivacyEnforcement, applyStartupSwitches, applyDnsSettings, clearSiteData, httpsUpgrade, GENERIC_UA, UA_BRANDS, CHROME_MAJOR,
  setPermissionAsker
};
