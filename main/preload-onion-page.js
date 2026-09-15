// =============================================================================
// Local Mind Browser — Onion page guard
// =============================================================================
// Runs inside every page loaded in Onion Mode, before the page's own scripts.
//
// The HTTP proxy does not cover WebRTC. A peer connection gathers ICE
// candidates straight from the network stack, so a page can learn your real
// local and public addresses while every HTTP request is dutifully going
// through Tor. It is the single most common way a proxied browser gives itself
// away, so the APIs are removed outright rather than restricted.

const { webFrame, ipcRenderer } = require('electron');

// The level is needed before the page's first script runs, so this is sync on
// purpose — an async round trip would lose that race.
let LEVEL = 'safer';
try { LEVEL = ipcRenderer.sendSync('onion:level-sync') || 'safer'; } catch { /* default */ }

const { CHROME_MAJOR } = require('./privacy-enforce');

webFrame.executeJavaScript(`(() => {
  const LEVEL = ${JSON.stringify(LEVEL)};
  const UA_MAJOR = ${JSON.stringify(String(CHROME_MAJOR))};
  const atLeast = (l) => ({ standard: 0, safer: 1, safest: 2 })[LEVEL] >= ({ standard: 0, safer: 1, safest: 2 })[l];

  const define = (obj, prop, value) => {
    try { Object.defineProperty(obj, prop, { get: () => value, configurable: true }); } catch {}
  };

  const block = (name) => {
    try {
      Object.defineProperty(window, name, {
        configurable: false,
        get() { throw new TypeError(name + ' is disabled in Onion Mode'); }
      });
    } catch {}
  };

  // Every spelling and vendor prefix: leaving one behind leaves the leak.
  for (const n of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection',
                   'RTCDataChannel', 'RTCIceGatherer']) {
    block(n);
  }

  // Capture and enumeration would both name real hardware.
  if (navigator.mediaDevices) {
    try {
      navigator.mediaDevices.enumerateDevices = () => Promise.resolve([]);
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
      navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
    } catch {}
  }

  // Match the user agent the session sends, so the header and the DOM agree.
  // The session presents stock Chrome on macOS, so these say the same.
  define(navigator, 'platform', 'MacIntel');
  define(navigator, 'vendor', 'Google Inc.');
  define(navigator, 'hardwareConcurrency', 4);
  define(navigator, 'deviceMemory', 8);
  define(navigator, 'maxTouchPoints', 0);
  define(navigator, 'language', 'en-US');
  define(navigator, 'languages', Object.freeze(['en-US', 'en']));
  define(navigator, 'plugins', Object.freeze([]));
  define(navigator, 'webdriver', false);

  // userAgentData and window.chrome are kept, because stock Chrome has them and
  // removing them would be the anomaly. They are normalised so the structured
  // channel says exactly what the UA header says — including the high-entropy
  // values, which otherwise report the true build and architecture.
  try {
    const BRANDS = [
      { brand: 'Chromium', version: UA_MAJOR },
      { brand: 'Google Chrome', version: UA_MAJOR },
      { brand: 'Not_A Brand', version: '24' }
    ];
    define(navigator, 'userAgentData', {
      brands: BRANDS,
      mobile: false,
      platform: 'macOS',
      toJSON() { return { brands: BRANDS, mobile: false, platform: 'macOS' }; },
      getHighEntropyValues: () => Promise.resolve({
        architecture: 'x86',
        bitness: '64',
        brands: BRANDS,
        fullVersionList: BRANDS.map((b) => ({ brand: b.brand, version: UA_MAJOR + '.0.0.0' })),
        mobile: false,
        model: '',
        platform: 'macOS',
        platformVersion: '15.0.0',
        uaFullVersion: UA_MAJOR + '.0.0.0',
        wow64: false
      })
    });
  } catch {}

  // Timezone: the clock is otherwise a strong, stable location signal.
  try {
    const Orig = Intl.DateTimeFormat;
    const Patched = function (...a) {
      const opts = a[1] ? { ...a[1] } : {};
      opts.timeZone = opts.timeZone || 'UTC';
      return new Orig(a[0] || 'en-US', opts);
    };
    Patched.prototype = Orig.prototype;
    Patched.supportedLocalesOf = Orig.supportedLocalesOf;
    Intl.DateTimeFormat = Patched;
    Date.prototype.getTimezoneOffset = function () { return 0; };
  } catch {}

  // Battery level and charge time are a short-lived cross-site identifier.
  try { delete navigator.getBattery; } catch {}

  // ── Screen and viewport ─────────────────────────────────────────────────
  // The viewport is already quantised for real by the shell, which sizes the
  // content box to a 200x100 grid. So innerWidth, clientWidth,
  // getBoundingClientRect and media queries are ALL genuinely the rounded
  // value and none of them is patched here — an earlier version overrode only
  // innerWidth, and the resulting disagreement was itself a fingerprint.
  //
  // screen.* is different: it describes the monitor, which the shell cannot
  // change, and a 3024x1964 panel is far rarer than a 1400x900 viewport. It is
  // reported as the content area, which is what Tor Browser does.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  define(screen, 'width', vw);
  define(screen, 'height', vh);
  define(screen, 'availWidth', vw);
  define(screen, 'availHeight', vh);
  define(screen, 'availLeft', 0);
  define(screen, 'availTop', 0);
  define(screen, 'colorDepth', 24);
  define(screen, 'pixelDepth', 24);
  define(window, 'screenX', 0);
  define(window, 'screenY', 0);
  define(window, 'outerWidth', vw);
  define(window, 'outerHeight', vh);
  // A Retina display reports 2 and a standard one 1, which splits the world
  // neatly in half before anything else is measured.
  define(window, 'devicePixelRatio', 1);

  // ── Media queries ───────────────────────────────────────────────────────
  // matchMedia leaks the same facts CSS can see: colour scheme, contrast
  // preference, reduced motion, pointer type, even DPI through resolution
  // queries. Answering uniformly costs nothing and removes a whole family.
  try {
    const FIXED = {
      'prefers-color-scheme': 'dark',
      'prefers-reduced-motion': 'no-preference',
      'prefers-contrast': 'no-preference',
      'prefers-reduced-transparency': 'no-preference',
      'forced-colors': 'none',
      'inverted-colors': 'none',
      'pointer': 'fine',
      'any-pointer': 'fine',
      'hover': 'hover',
      'any-hover': 'hover'
    };
    const origMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = function (query) {
      const q = String(query || '');
      for (const [feature, value] of Object.entries(FIXED)) {
        if (q.includes(feature)) {
          const wanted = new RegExp(feature + '\\s*:\\s*' + value);
          const result = origMatchMedia(q);
          // Report the fixed answer, keeping the real object's API surface.
          return Object.create(result, {
            matches: { value: wanted.test(q), enumerable: true },
            media: { value: q, enumerable: true }
          });
        }
      }
      return origMatchMedia(q);
    };
  } catch {}

  // ── Speech synthesis ────────────────────────────────────────────────────
  // The installed voice list is long, varies by OS version and language packs,
  // and is readable without any permission — a strong, stable identifier.
  try {
    if (window.speechSynthesis) {
      window.speechSynthesis.getVoices = () => [];
    }
  } catch {}

  // ── Safer and above ─────────────────────────────────────────────────────
  if (atLeast('safer')) {
    // WebGL is a rich, stable hardware signature. At this level it is not
    // masked, it is removed — a masked GPU is still a GPU that answered.
    for (const n of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      try { Object.defineProperty(window, n, { get() { return undefined; }, configurable: true }); } catch {}
    }
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (/webgl|experimental-webgl/i.test(String(type))) return null;
      return origGetContext.call(this, type, ...rest);
    };

    // Canvas readback returns blank rather than noise. Noise makes you
    // uncommon; a uniform blank makes you identical to every other user here,
    // which is the actual goal.
    const blank = (w, h) => {
      const c = document.createElement('canvas');
      c.width = w || 1; c.height = h || 1;
      return c;
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...a) {
      return origToDataURL.apply(blank(this.width, this.height), a);
    };
    try {
      const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h, ...rest) {
        const d = origGetImageData.call(this, x, y, w, h, ...rest);
        d.data.fill(0);
        return d;
      };
    } catch {}

    // Audio, and the media APIs that report codec support per device.
    for (const n of ['AudioContext', 'webkitAudioContext', 'OfflineAudioContext']) {
      try { Object.defineProperty(window, n, { get() { return undefined; }, configurable: true }); } catch {}
    }

    // ── Fonts ─────────────────────────────────────────────────────────────
    // The installed font list is one of the strongest signals in existence:
    // measure a string in 300 candidate fonts, see which ones change the
    // width, and the set is close to unique per machine. Blocking the
    // enumeration API is not enough, because measurement works without it.
    //
    // Tor Browser solves this by shipping its own fixed font set. We cannot
    // do that, so the next best thing is to force every element onto one
    // stack: substitution then makes every candidate measure identically,
    // which is what the attack is looking for.
    try {
      if (document.fonts) {
        document.fonts.check = () => false;
        Object.defineProperty(document.fonts, 'size', { get: () => 0, configurable: true });
        document.fonts.forEach = () => {};
        document.fonts[Symbol.iterator] = function* () {};
      }
      const pin = document.createElement('style');
      pin.textContent =
        '*, *::before, *::after { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important; }' +
        'code, pre, kbd, samp, tt { font-family: ui-monospace, Menlo, Consolas, monospace !important; }';
      const attach = () => (document.head || document.documentElement).appendChild(pin);
      if (document.head) attach(); else document.addEventListener('DOMContentLoaded', attach, { once: true });
    } catch {}

    // ── Timer precision ───────────────────────────────────────────────────
    // High-resolution timers turn every other measurement into a fingerprint:
    // how long a canvas draw or a font layout takes is hardware-specific.
    // Rounding to 100µs, as Tor Browser does, keeps animation smooth while
    // removing the resolution those attacks need.
    try {
      const coarse = (t) => Math.floor(t / 0.1) * 0.1;
      const origNow = performance.now.bind(performance);
      performance.now = () => coarse(origNow());
      const OrigDate = Date;
      Date.now = () => Math.floor(OrigDate.now() / 10) * 10;
    } catch {}
  }

  // ── Safest ──────────────────────────────────────────────────────────────
  // JavaScript is switched off at the engine by the shell, so almost nothing
  // here runs. What is left is a guard for pages served before that applies.
  if (atLeast('safest')) {
    for (const n of ['WebAssembly', 'SharedArrayBuffer']) {
      try { Object.defineProperty(window, n, { get() { return undefined; }, configurable: true }); } catch {}
    }
  }
})();`).catch(() => { /* page died mid-load */ });
