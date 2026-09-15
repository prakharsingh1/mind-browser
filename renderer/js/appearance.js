// =============================================================================
// Local Mind Browser — Appearance
// =============================================================================
// Two things people ask for in every browser and rarely get together: control
// over which buttons are in the toolbar, and control over the colour.
//
// Toolbar
//   Safari's model: a fixed set of optional controls, each on or off. Not
//   drag-and-drop reordering — the order in the markup is already the sensible
//   one, and a reorderable toolbar mostly produces toolbars people regret.
//   Developer tools ship OFF, because a browser aimed at everyone should not
//   put a debugging control between the AI panel and the menu by default.
//
// Colour and type
//   The accent is one hue expressed as five tokens (base, ink, hover, dim,
//   glow). Deriving all five from a single hex keeps them consistent — a
//   hand-picked "hover" that is not actually lighter than its base is the usual
//   way custom themes end up looking broken.
//
//   --accent-ink is deliberately separate: it is the accent used for TEXT, and
//   a colour that reads well as a button fill is often too light to read as a
//   label on a pale background. The design system already made that split; this
//   respects it rather than flattening the two.

const Appearance = (() => {
  // id -> { label, hint, defaultOn }. The id matches data-tb in the markup.
  const ITEMS = {
    'zoom-out':        { label: 'Zoom out',        defaultOn: true },
    'zoom-in':         { label: 'Zoom in',         defaultOn: true },
    'reading-mode':    { label: 'Reader',          defaultOn: true },
    'history':         { label: 'History',         defaultOn: true },
    'downloads':       { label: 'Downloads',       defaultOn: true },
    'command-palette': { label: 'Command palette', defaultOn: true },
    'ai':              { label: 'AI panel',        defaultOn: true },
    'extensions':      { label: 'Extensions',      defaultOn: true },
    'dev':             { label: 'Developer tools', defaultOn: false,
                         hint: 'Also in the ☰ menu' }
  };

  // Named palettes, plus whatever the user picks. Each is a single hue; the
  // rest of the tokens are derived.
  const PALETTES = {
    green:  { name: 'Signal green', hex: '#2bd473' },
    purple: { name: 'Violet',       hex: '#a78bfa' },
    blue:   { name: 'Azure',        hex: '#5b9dff' },
    amber:  { name: 'Amber',        hex: '#f5b544' },
    rose:   { name: 'Rose',         hex: '#f4708f' },
    teal:   { name: 'Teal',         hex: '#31c8c0' },
    slate:  { name: 'Graphite',     hex: '#9aa4b2' }
  };

  const FONTS = {
    system:   { name: 'System',       stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, 'Helvetica Neue', sans-serif" },
    inter:    { name: 'Inter',        stack: "Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif" },
    rounded:  { name: 'Rounded',      stack: "'SF Pro Rounded', ui-rounded, -apple-system, system-ui, sans-serif" },
    serif:    { name: 'Serif',        stack: "'New York', Georgia, 'Iowan Old Style', serif" },
    mono:     { name: 'Monospace',    stack: "'SF Mono', ui-monospace, 'Cascadia Code', 'Fira Code', monospace" }
  };

  const SIZES = { small: 0.94, normal: 1, large: 1.08, larger: 1.16 };

  const prefs = () => window.mindSettings?.appearance || {};

  // ── Colour maths ───────────────────────────────────────────────────────────
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));

  function toRgb(hex) {
    const h = String(hex).replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  const mix = (c, target, amount) => ({
    r: clamp(c.r + (target - c.r) * amount),
    g: clamp(c.g + (target - c.g) * amount),
    b: clamp(c.b + (target - c.b) * amount)
  });

  const css = (c) => `rgb(${c.r}, ${c.g}, ${c.b})`;
  const rgba = (c, a) => `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;

  /** Perceived brightness, for deciding whether text on this colour is legible. */
  const luminance = (c) => (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;

  /**
   * Derive the five accent tokens from one hue.
   *
   * The two that matter are `ink` and `on-accent`. `ink` is the accent used for
   * text: on a dark UI a mid-tone reads fine, but in light mode the same colour
   * on white is unreadable, so it is darkened there. `on-accent` is what sits
   * ON a filled accent button, and flips to dark text when the accent is light
   * — otherwise a yellow button gets white text on it.
   */
  function applyAccent(hex) {
    const base = toRgb(hex);
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    const root = document.documentElement.style;

    root.setProperty('--accent', css(base));
    root.setProperty('--accent-hover', css(mix(base, 255, 0.22)));
    root.setProperty('--accent-ink', css(light ? mix(base, 0, 0.35) : base));
    root.setProperty('--accent-dim', rgba(base, light ? 0.12 : 0.15));
    root.setProperty('--accent-glow', rgba(base, light ? 0.2 : 0.4));
    root.setProperty('--accent-contrast', luminance(base) > 0.62 ? '#0d1117' : '#ffffff');
  }

  function applyFont(fontKey, sizeKey) {
    const font = FONTS[fontKey] || FONTS.system;
    const scale = SIZES[sizeKey] ?? 1;
    const root = document.documentElement.style;
    root.setProperty('--font-body', font.stack);
    // A scale rather than a pixel size: every size in the design system is
    // relative, so one multiplier moves the whole UI together instead of
    // leaving the labels large and the paddings unchanged.
    root.setProperty('--ui-scale', String(scale));
  }

  function applyToolbar(visible) {
    for (const [id, meta] of Object.entries(ITEMS)) {
      const on = visible?.[id] ?? meta.defaultOn;
      document.querySelectorAll(`[data-tb="${id}"]`).forEach((el) => {
        el.classList.toggle('tb-hidden', !on);
      });
    }
  }

  /** Re-read every appearance preference and apply it. */
  function apply() {
    const p = prefs();
    applyAccent(p.accent || PALETTES.green.hex);
    applyFont(p.font || 'system', p.uiSize || 'normal');
    applyToolbar(p.toolbar);
  }

  function init() {
    apply();
    // Light/dark changes what a readable "ink" is, so the accent is recomputed
    // rather than left as whatever suited the previous theme.
    EventBus.on('theme-changed', () => applyAccent(prefs().accent || PALETTES.green.hex));
    EventBus.on('appearance-changed', apply);
  }

  return { init, apply, applyAccent, ITEMS, PALETTES, FONTS, SIZES };
})();
