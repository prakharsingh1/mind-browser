// =============================================================================
// Local Mind Browser — Identity Masking (in-page)
// =============================================================================
// Builds the script that lies to a page about the machine it is running on.
//
// This has to run in the PAGE's own world, not the preload's: patching
// navigator here would otherwise only fool the preload. webFrame.executeJavaScript
// crosses that boundary, and running it at preload time puts it ahead of the
// page's own scripts.
//
// The masking is per-session-per-origin, not per-call. A value that changes on
// every read is its own signal — real hardware does not flicker — so each origin
// gets one stable fake for as long as the browser is open, and a different one
// next launch.

/**
 * @param {Object} flags effective privacy flags
 * @param {string|null} origin the page's origin, used to derive its seeds
 * @returns {string} JavaScript to evaluate in the page's main world
 */
function buildMaskScript(flags, origin = null) {
  // Nothing to do: return empty so the caller can skip the injection entirely.
  const wanted = ['maskCanvas', 'maskWebGL', 'maskAudio', 'maskHardware', 'maskScreen',
    'maskTimezoneLang', 'blockLocation', 'blockSensors', 'spoofUserAgent'];
  if (!wanted.some((k) => flags[k])) return '';

  // Same string the request headers use. Spoofing only the header left
  // navigator.userAgent still naming this browser and its Electron version, so
  // a single line of page JavaScript undid the whole disguise.
  const { GENERIC_UA } = require('./privacy-enforce');
  const { seedFor } = require('./privacy-seed');

  // One token per feature per origin. An origin we cannot identify (opaque,
  // about:blank, file://) gets fresh random seeds instead of a shared constant,
  // so those pages cannot be used as a common correlation point.
  const rand = () => (Math.random() * 4294967296) >>> 0;
  const seeds = {};
  for (const feature of ['canvas', 'audio', 'webgl']) {
    seeds[feature] = origin ? seedFor(origin, feature) : rand();
  }

  return `(() => {
  const F = ${JSON.stringify({
    maskCanvas: !!flags.maskCanvas,
    maskWebGL: !!flags.maskWebGL,
    maskAudio: !!flags.maskAudio,
    maskHardware: !!flags.maskHardware,
    maskScreen: !!flags.maskScreen,
    maskTimezoneLang: !!flags.maskTimezoneLang,
    blockLocation: !!flags.blockLocation,
    blockSensors: !!flags.blockSensors,
    spoofUserAgent: !!flags.spoofUserAgent
  })};
  const UA = ${JSON.stringify(GENERIC_UA)};

  // Seeds arrive as literals, computed per origin+feature in the main process.
  // See privacy-seed.js for why they are not kept anywhere the page can read.
  const SEED = ${JSON.stringify(seeds)};

  // One independent generator per feature.
  const gen = (key) => {
    const base = SEED[key] >>> 0;
    let s = base;
    return {
      reseed() { s = base; },
      next() { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }
    };
  };

  const define = (obj, prop, value) => {
    try { Object.defineProperty(obj, prop, { get: () => value, configurable: true }); } catch {}
  };

  // ── Canvas ──────────────────────────────────────────────────────────────
  // A handful of channels nudged by at most one step. Invisible to a person,
  // fatal to a hash.
  if (F.maskCanvas) {
    const g = gen('canvas');
    const noisify = (canvas) => {
      try {
        g.reseed();
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const w = Math.min(canvas.width, 64), h = Math.min(canvas.height, 64);
        if (!w || !h) return;
        const img = ctx.getImageData(0, 0, w, h);
        for (let i = 0; i < img.data.length; i += 997) {
          img.data[i] = Math.max(0, Math.min(255, img.data[i] + (g.next() < 0.5 ? -1 : 1)));
        }
        ctx.putImageData(img, 0, 0);
      } catch {}
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...a) { noisify(this); return origToDataURL.apply(this, a); };
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...a) { noisify(this); return origToBlob.apply(this, a); };
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...a) {
      g.reseed();
      const d = origGetImageData.apply(this, a);
      for (let i = 0; i < d.data.length; i += 997) {
        d.data[i] = Math.max(0, Math.min(255, d.data[i] + (g.next() < 0.5 ? -1 : 1)));
      }
      return d;
    };
  }

  // ── WebGL ───────────────────────────────────────────────────────────────
  if (F.maskWebGL) {
    const RENDERER = 37446, VENDOR = 37445;   // UNMASKED_* from WEBGL_debug_renderer_info
    const patch = (proto) => {
      if (!proto) return;
      const orig = proto.getParameter;
      proto.getParameter = function (p) {
        if (p === RENDERER) return 'ANGLE (Intel, Intel(R) UHD Graphics, OpenGL 4.1)';
        if (p === VENDOR) return 'Intel Inc.';
        return orig.call(this, p);
      };
    };
    patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  }

  // ── Audio ───────────────────────────────────────────────────────────────
  if (F.maskAudio && window.AnalyserNode) {
    const ga = gen('audio');
    const orig = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function (arr) {
      ga.reseed();
      orig.call(this, arr);
      for (let i = 0; i < arr.length; i += 53) arr[i] += (ga.next() - 0.5) * 0.0015;
    };
  }

  // ── User agent ──────────────────────────────────────────────────────────
  if (F.spoofUserAgent) {
    define(navigator, 'userAgent', UA);
    // A plain string, not a regex: this whole block lives inside a template
    // literal, which eats the backslash and would leave an invalid pattern.
    define(navigator, 'appVersion', UA.slice('Mozilla/'.length));
    define(navigator, 'vendor', 'Google Inc.');
    // userAgentData is a second, structured channel saying the same thing.
    if (navigator.userAgentData) {
      define(navigator, 'userAgentData', {
        brands: [
          { brand: 'Chromium', version: '131' },
          { brand: 'Google Chrome', version: '131' },
          { brand: 'Not_A Brand', version: '24' }
        ],
        mobile: false,
        platform: 'macOS',
        getHighEntropyValues: () => Promise.resolve({ platform: 'macOS', platformVersion: '', architecture: 'x86', model: '', uaFullVersion: '131.0.0.0' }),
        toJSON() { return { brands: this.brands, mobile: false, platform: 'macOS' }; }
      });
    }
  }

  // ── Hardware ────────────────────────────────────────────────────────────
  if (F.maskHardware) {
    define(navigator, 'hardwareConcurrency', 8);
    define(navigator, 'deviceMemory', 8);
    define(navigator, 'maxTouchPoints', 0);
    define(navigator, 'platform', 'MacIntel');
  }

  // ── Screen ──────────────────────────────────────────────────────────────
  // Rounded to a coarse grid: an unusual monitor size is otherwise a strong ID.
  if (F.maskScreen) {
    const round = (n) => Math.max(600, Math.round(n / 100) * 100);
    const w = round(screen.width), h = round(screen.height);
    define(screen, 'width', w);
    define(screen, 'height', h);
    define(screen, 'availWidth', w);
    define(screen, 'availHeight', h);
    define(screen, 'colorDepth', 24);
    define(screen, 'pixelDepth', 24);
  }

  // ── Timezone and language ───────────────────────────────────────────────
  if (F.maskTimezoneLang) {
    define(navigator, 'language', 'en-US');
    define(navigator, 'languages', Object.freeze(['en-US', 'en']));
    try {
      const OrigDTF = Intl.DateTimeFormat;
      const Patched = function (...a) {
        const opts = a[1] ? { ...a[1] } : {};
        opts.timeZone = opts.timeZone || 'UTC';
        return new OrigDTF(a[0] || 'en-US', opts);
      };
      Patched.prototype = OrigDTF.prototype;
      Patched.supportedLocalesOf = OrigDTF.supportedLocalesOf;
      Intl.DateTimeFormat = Patched;
      Date.prototype.getTimezoneOffset = function () { return 0; };
    } catch {}
  }

  // ── Location ────────────────────────────────────────────────────────────
  // Denied at the session level too; this makes the failure look like an
  // ordinary user refusal rather than a missing API, which sites handle better.
  if (F.blockLocation && navigator.geolocation) {
    const denied = (_ok, err) => {
      if (typeof err === 'function') {
        err({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
      }
    };
    navigator.geolocation.getCurrentPosition = denied;
    navigator.geolocation.watchPosition = () => { return 0; };
  }

  // ── Motion sensors ──────────────────────────────────────────────────────
  if (F.blockSensors) {
    for (const evt of ['devicemotion', 'deviceorientation', 'deviceorientationabsolute']) {
      window.addEventListener(evt, (e) => { e.stopImmediatePropagation(); }, true);
    }
    if (window.DeviceOrientationEvent?.requestPermission) {
      window.DeviceOrientationEvent.requestPermission = () => Promise.resolve('denied');
    }
    if (window.DeviceMotionEvent?.requestPermission) {
      window.DeviceMotionEvent.requestPermission = () => Promise.resolve('denied');
    }
  }
})();`;
}

module.exports = { buildMaskScript };
