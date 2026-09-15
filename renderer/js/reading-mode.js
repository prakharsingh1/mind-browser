// =============================================================================
// Local Mind Browser — Reader
// =============================================================================
// The old reading mode restyled the live page: it set typography on <body> and
// hid anything whose class name contained "banner" or "popup". That guesses,
// and on a real site it guesses wrong — leaving navigation in place, dropping
// content that happened to match, and inheriting the site's own layout CSS.
//
// This extracts the article instead, with the same library Firefox Reader View
// uses, and renders it into a surface of our own. What you get is the text,
// nothing else, and controls over how it is set — plus the two things people
// actually read books in a browser for: being read aloud, and a focus line.
//
// The reader lives inside a shadow root in the page. That is deliberate: a
// normal overlay inherits the site's stylesheet, and news sites in particular
// have CSS aggressive enough to wreck it. A shadow root is the only way to get
// a clean surface without navigating away and losing the URL.

const ReadingMode = (() => {
  const PREFS_KEY = 'mind-reader-prefs';
  let isActive = false;
  let readerSource = null;              // Readability, fetched once

  const defaults = {
    theme: 'sepia',                     // light | sepia | dark | night
    font: 'serif',                      // serif | sans | mono
    size: 19,
    width: 720,
    lineHeight: 1.75,
    lineFocus: false
  };

  function loadPrefs() {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
    catch { return { ...defaults }; }
  }
  const savePrefs = (p) => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* full */ }
  };

  function init() {
    EventBus.on('toggle-reading-mode', toggle);
    document.getElementById('btn-reading-mode')?.addEventListener('click', toggle);
    // Leaving the page leaves the reader with it.
    EventBus.on('tab-activated', () => { if (isActive) setActive(false); });
  }

  async function ensureSource() {
    if (readerSource) return readerSource;
    const res = await window.localMind.readerScript();
    if (!res?.ok) throw new Error(res?.error || 'the reader could not be loaded');
    readerSource = res.source;
    return readerSource;
  }

  async function toggle() {
    const tab = TabManager.getActiveTab();
    if (!tab?.webview) return Sidebar.showToast?.('Open a page first.');

    if (isActive) {
      try { await tab.webview.executeJavaScript('window.__mindReader && window.__mindReader.close()'); }
      catch { /* the page navigated away already */ }
      setActive(false);
      return;
    }

    try {
      const source = await ensureSource();
      const prefs = loadPrefs();
      // The reader runs inside the page and cannot reach the Speech module, so
      // the chosen voice travels with the prefs it is handed.
      Object.assign(prefs, { voice: Speech?.prefs?.() || {} });
      const result = await tab.webview.executeJavaScript(
        `${source}\n;(${readerBootstrap.toString()})(${JSON.stringify(prefs)});`
      );

      if (!result?.ok) {
        Sidebar.showToast?.(result?.error || "There isn't an article on this page to read.");
        return;
      }
      setActive(true);
      Sidebar.showToast?.(`Reader — about ${result.minutes} min`);
      watchForClose(tab);
    } catch (err) {
      Sidebar.showToast?.(`Reader could not open (${err.message}).`);
    }
  }

  /**
   * The reader can also be dismissed from inside the page (its own close button
   * or Escape), so the toolbar state has to follow the page rather than assume.
   */
  function watchForClose(tab) {
    const timer = setInterval(async () => {
      if (!isActive) return clearInterval(timer);
      try {
        const state = await tab.webview.executeJavaScript(
          'window.__mindReader ? window.__mindReader.state() : null');
        if (!state) { setActive(false); clearInterval(timer); return; }
        if (state.prefs) savePrefs(state.prefs);
      } catch {
        setActive(false);
        clearInterval(timer);
      }
    }, 1000);
  }

  function setActive(next) {
    isActive = next;
    document.body.classList.toggle('reading-mode', isActive);
    document.getElementById('btn-reading-mode')?.classList.toggle('active', isActive);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Everything below runs INSIDE the page, stringified and injected. It cannot
  // close over anything here, which is why prefs are passed in as an argument.
  // ───────────────────────────────────────────────────────────────────────────
  function readerBootstrap(prefs) {
    if (window.__mindReader) { window.__mindReader.close(); }

    let article;
    try {
      // Readability consumes the document it is given, so it gets a clone.
      article = new Readability(document.cloneNode(true), { charThreshold: 300 }).parse();
    } catch (err) {
      return { ok: false, error: 'This page could not be parsed as an article.' };
    }
    if (!article || !article.content || article.length < 400) {
      return { ok: false, error: "There isn't an article on this page to read." };
    }

    const words = (article.textContent || '').trim().split(/\s+/).length;
    const minutes = Math.max(1, Math.round(words / 220));

    const host = document.createElement('div');
    host.id = '__mind_reader_host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(host);

    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';

    const THEMES = {
      light: { bg: '#ffffff', fg: '#1a1a1a', dim: '#6a6a6a', rule: '#e3e3e3', link: '#0b62c4', sel: '#cfe6ff' },
      sepia: { bg: '#f4ecd8', fg: '#3b3226', dim: '#7d7060', rule: '#e0d4bb', link: '#8a5a1b', sel: '#e6d3a8' },
      dark:  { bg: '#1d1f21', fg: '#dfe1e3', dim: '#9aa0a6', rule: '#33363a', link: '#7ab8ff', sel: '#31465e' },
      night: { bg: '#000000', fg: '#b9bcc0', dim: '#7b7f85', rule: '#22252a', link: '#6aa9ee', sel: '#25303d' }
    };
    const FONTS = {
      serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
      sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      mono: 'ui-monospace, SFMono-Regular, Menlo, monospace'
    };

    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .wrap {
          position: fixed; inset: 0; overflow-y: auto;
          font-family: var(--rf);
          background: var(--bg); color: var(--fg);
          transition: background 0.2s, color 0.2s;
        }
        ::selection { background: var(--sel); }

        .bar {
          position: sticky; top: 0; z-index: 5;
          display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
          padding: 9px 16px;
          background: var(--bg); border-bottom: 1px solid var(--rule);
        }
        .bar button, .bar select {
          height: 30px; padding: 0 10px;
          background: transparent; color: var(--dim);
          border: 1px solid var(--rule); border-radius: 8px;
          font: 500 12.5px var(--ui); cursor: pointer;
        }
        .bar button:hover { color: var(--fg); border-color: var(--dim); }
        .bar button.on { color: var(--bg); background: var(--fg); border-color: var(--fg); }
        .bar .spacer { flex: 1; }
        .swatches { display: flex; gap: 5px; }
        .sw { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--rule); cursor: pointer; padding: 0; }
        .sw.on { border-color: var(--fg); }

        .progress { position: sticky; top: 0; height: 2px; background: var(--rule); z-index: 6; }
        .progress i { display: block; height: 100%; width: 0; background: var(--link); }

        article {
          max-width: var(--w); margin: 0 auto; padding: 44px 26px 140px;
          font-size: var(--fs); line-height: var(--lh);
        }
        h1.title { font-size: 1.9em; line-height: 1.2; margin: 0 0 10px; }
        .meta { color: var(--dim); font: 400 0.78em var(--ui); margin-bottom: 30px; }
        article :is(h2,h3,h4) { line-height: 1.3; margin: 1.7em 0 0.5em; }
        article p { margin: 0 0 1.1em; }
        article a { color: var(--link); }
        article img, article video { max-width: 100%; height: auto; border-radius: 8px; }
        article figure { margin: 1.4em 0; }
        article figcaption { color: var(--dim); font: 400 0.8em var(--ui); margin-top: 6px; }
        article blockquote {
          margin: 1.3em 0; padding: 2px 0 2px 18px;
          border-left: 3px solid var(--rule); color: var(--dim);
        }
        article pre {
          overflow-x: auto; padding: 14px; border-radius: 8px;
          background: rgba(127,127,127,0.12); font: 0.82em ui-monospace, Menlo, monospace;
        }
        article table { border-collapse: collapse; width: 100%; }
        article :is(th,td) { border: 1px solid var(--rule); padding: 7px 10px; text-align: left; }

        /* Read-aloud: the paragraph being spoken. */
        .speaking { background: var(--sel); border-radius: 4px; }

        /* Line focus dims everything but a band around the pointer. */
        .focusbar { position: fixed; left: 0; right: 0; background: rgba(0,0,0,0.55); pointer-events: none; z-index: 4; display: none; }
        .wrap.focus .focusbar { display: block; }
      </style>

      <div class="wrap" id="wrap">
        <div class="progress"><i id="bar"></i></div>
        <div class="bar">
          <button id="aloud">▶ Read aloud</button>
          <button id="focus">Line focus</button>
          <span class="spacer"></span>
          <div class="swatches" id="themes"></div>
          <select id="font">
            <option value="serif">Serif</option>
            <option value="sans">Sans</option>
            <option value="mono">Mono</option>
          </select>
          <button id="smaller">A−</button>
          <button id="bigger">A+</button>
          <button id="narrower">◧</button>
          <button id="wider">◨</button>
          <button id="looser">↕</button>
          <button id="close">Close</button>
        </div>
        <article id="art">
          <h1 class="title"></h1>
          <div class="meta"></div>
          <div id="body"></div>
        </article>
        <div class="focusbar" id="fb-top"></div>
        <div class="focusbar" id="fb-bot"></div>
      </div>`;

    const $ = (id) => root.getElementById(id);
    $('art').querySelector('.title').textContent = article.title || document.title;
    $('art').querySelector('.meta').textContent =
      [article.siteName, article.byline, `${minutes} min read`].filter(Boolean).join(' · ');
    // Readability returns sanitised HTML built from the page's own DOM.
    $('body').innerHTML = article.content;

    const wrap = $('wrap');

    function paint() {
      const t = THEMES[prefs.theme] || THEMES.sepia;
      wrap.style.setProperty('--bg', t.bg);
      wrap.style.setProperty('--fg', t.fg);
      wrap.style.setProperty('--dim', t.dim);
      wrap.style.setProperty('--rule', t.rule);
      wrap.style.setProperty('--link', t.link);
      wrap.style.setProperty('--sel', t.sel);
      wrap.style.setProperty('--rf', FONTS[prefs.font] || FONTS.serif);
      wrap.style.setProperty('--ui', FONTS.sans);
      wrap.style.setProperty('--fs', prefs.size + 'px');
      wrap.style.setProperty('--w', prefs.width + 'px');
      wrap.style.setProperty('--lh', String(prefs.lineHeight));
      wrap.classList.toggle('focus', prefs.lineFocus);
      $('focus').classList.toggle('on', prefs.lineFocus);
      $('font').value = prefs.font;
      for (const b of root.querySelectorAll('.sw')) b.classList.toggle('on', b.dataset.theme === prefs.theme);
    }

    const themes = $('themes');
    for (const name of Object.keys(THEMES)) {
      const b = document.createElement('button');
      b.className = 'sw';
      b.dataset.theme = name;
      b.title = name;
      b.style.background = THEMES[name].bg;
      b.addEventListener('click', () => { prefs.theme = name; paint(); });
      themes.appendChild(b);
    }

    $('font').addEventListener('change', (e) => { prefs.font = e.target.value; paint(); });
    $('bigger').addEventListener('click', () => { prefs.size = Math.min(34, prefs.size + 1); paint(); });
    $('smaller').addEventListener('click', () => { prefs.size = Math.max(13, prefs.size - 1); paint(); });
    $('wider').addEventListener('click', () => { prefs.width = Math.min(1100, prefs.width + 60); paint(); });
    $('narrower').addEventListener('click', () => { prefs.width = Math.max(480, prefs.width - 60); paint(); });
    $('looser').addEventListener('click', () => {
      // Cycles rather than growing forever — three sensible settings.
      prefs.lineHeight = prefs.lineHeight >= 2.1 ? 1.5 : Math.round((prefs.lineHeight + 0.25) * 100) / 100;
      paint();
    });

    // ── Progress ─────────────────────────────────────────────────────────────
    wrap.addEventListener('scroll', () => {
      const max = wrap.scrollHeight - wrap.clientHeight;
      $('bar').style.width = max > 0 ? `${(wrap.scrollTop / max) * 100}%` : '0';
      if (prefs.lineFocus) placeFocus(lastY);
    });

    // ── Line focus ───────────────────────────────────────────────────────────
    let lastY = window.innerHeight / 2;
    const BAND = 90;
    function placeFocus(y) {
      lastY = y;
      $('fb-top').style.cssText += `;top:0;height:${Math.max(0, y - BAND / 2)}px;`;
      $('fb-bot').style.cssText += `;top:${y + BAND / 2}px;bottom:0;height:auto;`;
    }
    wrap.addEventListener('pointermove', (e) => { if (prefs.lineFocus) placeFocus(e.clientY); });
    $('focus').addEventListener('click', () => {
      prefs.lineFocus = !prefs.lineFocus;
      paint();
      if (prefs.lineFocus) placeFocus(lastY);
    });

    // ── Read aloud ───────────────────────────────────────────────────────────
    // Paragraph at a time, with the current one highlighted and scrolled into
    // view. Word-level highlighting is what Edge does, but it needs the text
    // re-split on every boundary event; paragraph level is honest, stable, and
    // enough to keep your place.
    const blocks = [...$('body').querySelectorAll('p, li, h2, h3, blockquote')]
      .filter((el) => (el.textContent || '').trim().length > 1);
    let speaking = false;
    let at = 0;

    function speakFrom(i) {
      if (i >= blocks.length) return stopAloud();
      at = i;
      for (const b of blocks) b.classList.remove('speaking');
      const el = blocks[i];
      el.classList.add('speaking');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });

      const u = new SpeechSynthesisUtterance(el.textContent.trim());
      const want = prefs.voice || {};
      if (want.voiceURI) {
        const v = speechSynthesis.getVoices().find((x) => x.voiceURI === want.voiceURI);
        if (v) u.voice = v;
      }
      u.rate = want.rate || 1;
      u.pitch = want.pitch || 1;
      u.onend = () => { if (speaking) speakFrom(i + 1); };
      u.onerror = () => stopAloud();
      speechSynthesis.speak(u);
    }
    function stopAloud() {
      speaking = false;
      try { speechSynthesis.cancel(); } catch { /* ignore */ }
      for (const b of blocks) b.classList.remove('speaking');
      $('aloud').textContent = '▶ Read aloud';
      $('aloud').classList.remove('on');
    }
    $('aloud').addEventListener('click', () => {
      if (speaking) return stopAloud();
      if (!blocks.length) return;
      speaking = true;
      $('aloud').textContent = '■ Stop';
      $('aloud').classList.add('on');
      speakFrom(at >= blocks.length ? 0 : at);
    });
    // Click any paragraph while reading aloud to jump there.
    $('body').addEventListener('click', (e) => {
      if (!speaking) return;
      const el = e.target.closest('p, li, h2, h3, blockquote');
      const i = blocks.indexOf(el);
      if (i < 0) return;
      speechSynthesis.cancel();
      speakFrom(i);
    });

    // ── Teardown ─────────────────────────────────────────────────────────────
    function close() {
      stopAloud();
      document.documentElement.style.overflow = prevOverflow;
      host.remove();
      document.removeEventListener('keydown', onKey, true);
      delete window.__mindReader;
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    document.addEventListener('keydown', onKey, true);
    $('close').addEventListener('click', close);

    paint();
    wrap.focus?.();

    window.__mindReader = { close, state: () => ({ prefs }) };
    return { ok: true, minutes, title: article.title };
  }

  return { init, toggle };
})();
