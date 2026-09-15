// =============================================================================
// Local Mind Browser: first-run onboarding
// =============================================================================
// Runs once, on first launch: learn the user's name, pick a theme,
// optionally connect a model, then walk the top bar with spotlight coachmarks
// so the unfamiliar buttons get explained in place.
//
// Everything is skippable. Skipping is recorded exactly like finishing, so the
// flow never reappears. A user who dismisses it is not nagged next launch.
//
// The tour points at REAL elements by id. If an element isn't present (a build
// where the feature is hidden, or a future rename), that step is dropped rather
// than pointing the spotlight at empty space.

const Onboarding = (() => {
  let root = null, tour = null;
  let step = 0;                       // index into STEPS
  let tourIdx = 0;
  const picked = { name: '', theme: null, provider: '', key: '' };

  const STEPS = ['name', 'theme', 'model'];

  // ── the guided tour, in the order a new user meets these ──────────────────
  const TOUR = [
    { id: 'sidebar-toggle',      title: 'Sidebar',          key: '⌘B',
      body: 'Your open tabs, pinned sites, and the built-in News, Finance and Notes pages all live here. Collapse it any time.' },
    { id: 'address-bar',         title: 'The address bar',  key: '⌘L',
      body: 'Type a URL, a search, or a question. It searches your own history, bookmarks and open tabs before it ever asks a search engine.' },
    { id: 'btn-adblock',         title: 'Shields',          key: null,
      body: 'Counts the ads and trackers blocked on this page. Click it to allow a site if something looks broken.' },
    { id: 'btn-command-palette', title: 'Command palette',  key: '⌘K',
      body: 'The fastest way around. Every tab, bookmark, setting and action, by typing a few letters.' },
    { id: 'btn-ai-toggle',       title: 'The AI panel',     key: '⌘⇧L',
      body: 'Chat about the page, or switch to Agent mode and it will drive the browser for you, clicking, typing and reading as it goes.' },
    { id: 'btn-reading-mode',    title: 'Reader',           key: '⌘⇧E',
      body: 'Pulls the article out of the page and sets it properly — your choice of theme, font and width. It can also read it aloud to you, and dim everything but the line you are on.' },
    { id: 'btn-volume',          title: 'Volume',           key: null,
      body: 'Appears whenever a tab is making sound. It goes past 100% for videos that are too quiet, so you do not need a volume booster extension.' },
    { id: 'btn-dev',             title: 'Developer tools',  key: '⌥⌘D',
      body: 'Hard reload, device and network emulation, a dark-mode override and a switch to turn JavaScript off. Handy when you are building a site.' },
    { id: 'btn-history',         title: 'History',          key: '⌘Y',
      body: 'Everywhere you have been, grouped by day and searchable. Delete a single page or clear the lot — it is your record, so you get to edit it.' },
    { id: 'btn-downloads',       title: 'Downloads',        key: '⌘⇧J',
      body: 'Everything you download, with pause and resume. A PDF you download can be opened and marked up right here rather than in another app.' },
    { id: 'btn-menu',            title: 'Settings & more',  key: '⌘,',
      body: 'Models, appearance, privacy and extensions. Connect your own API or a model running on this machine under Models, and pick a voice for reading aloud.' }
  ];

  // the preload bridge is exposed as `localMind`
  const api = () => window.localMind;

  // ── template ──────────────────────────────────────────────────────────────
  function render() {
    root = document.createElement('div');
    root.id = 'onboarding';
    root.innerHTML = `
      <div class="ob-aurora" aria-hidden="true"><i></i><i></i></div>
      <div class="ob-card" role="dialog" aria-modal="true" aria-label="Welcome to Mind Browser">
        <button class="ob-skip" id="ob-skip">Skip setup</button>

        <section class="ob-step on" data-step="name">
          <h1 class="ob-hi">What should<br>I call you?</h1>
          <p class="ob-sub">Only used to greet you on the new tab page. It stays on this
            machine. There's no account, and nothing is sent anywhere.</p>
          <input class="ob-input" id="ob-name" type="text" placeholder="Your name"
                 autocomplete="off" spellcheck="false" maxlength="40">
          <p class="ob-hint" id="ob-name-hint"></p>
          <div class="ob-foot">
            <button class="ob-btn primary" data-next>Continue</button>
          </div>
        </section>

        <section class="ob-step" data-step="theme">
          <h1 class="ob-hi">Dark or light?</h1>
          <p class="ob-sub">Pick one. It applies as you hover, so you can see it before you
            commit, and you can change it any time in Settings.</p>
          <div class="ob-choices three">
            <button class="ob-choice" data-theme="dark">
              <div class="ob-swatch sw-dark"><div class="bar"><i></i><i></i><i></i></div><div class="body"><div class="side"></div><div class="main"><i></i><i></i></div></div></div>
              <b>Dark</b><span>Easier at night</span>
            </button>
            <button class="ob-choice" data-theme="light">
              <div class="ob-swatch sw-light"><div class="bar"><i></i><i></i><i></i></div><div class="body"><div class="side"></div><div class="main"><i></i><i></i></div></div></div>
              <b>Light</b><span>Easier in daylight</span>
            </button>
            <button class="ob-choice" data-theme="device">
              <div class="ob-swatch sw-auto"><div class="bar"><i></i><i></i><i></i></div><div class="body"><div class="side"></div><div class="main"><i></i><i></i></div></div></div>
              <b>Match system</b><span>Follows your Mac</span>
            </button>
          </div>
          <div class="ob-foot">
            <button class="ob-btn ghost" data-back>Back</button>
            <button class="ob-btn primary" data-next>Continue</button>
          </div>
        </section>

        <section class="ob-step" data-step="model">
          <h1 class="ob-hi">Give it a brain?</h1>
          <p class="ob-sub">Browsing, News, Finance, Notes and Shields all work without one.
            The AI panel and the agents need a model. You can do this later.</p>
          <div class="ob-choices">
            <button class="ob-choice" data-model="local">
              <b>Run it locally</b>
              <span>Use Ollama on this machine. Free, private, and nothing leaves your Mac.</span>
            </button>
            <button class="ob-choice" data-model="key">
              <b>Use an API key</b>
              <span>Anthropic, OpenAI, Google, Groq or OpenRouter. Faster, costs pennies.</span>
            </button>
          </div>
          <div class="ob-key" id="ob-key">
            <select id="ob-provider">
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI (GPT)</option>
              <option value="gemini">Google (Gemini)</option>
              <option value="groq">Groq (fast inference)</option>
              <option value="openrouter">OpenRouter (everything else)</option>
            </select>
            <input id="ob-apikey" type="password" placeholder="Paste your API key" autocomplete="off" spellcheck="false">
            <p class="note">Stored on this machine only, and sent only to the provider it
              belongs to. You can add or change keys later in Settings.</p>
          </div>
          <div class="ob-foot">
            <button class="ob-btn ghost" data-back>Back</button>
            <button class="ob-btn primary" data-next>Continue</button>
          </div>
        </section>

        <section class="ob-step" data-step="done">
          <h1 class="ob-hi" id="ob-done-title">You're set.</h1>
          <p class="ob-sub">Want a quick tour of the top bar? It takes about thirty seconds and
            explains the buttons you haven't seen before.</p>
          <div class="ob-foot">
            <button class="ob-btn ghost" id="ob-no-tour">No thanks</button>
            <button class="ob-btn primary" id="ob-do-tour">Show me around</button>
          </div>
        </section>

        <div class="ob-dots" id="ob-dots"></div>
      </div>`;
    document.body.appendChild(root);

    tour = document.createElement('div');
    tour.id = 'ob-tour';
    tour.innerHTML = `
      <div class="ob-hole" id="ob-hole"></div>
      <div class="ob-ring" id="ob-ring"></div>
      <div class="ob-ping" id="ob-ping"></div>
      <div class="ob-tip" id="ob-tip">
        <h4><span id="ob-tip-title"></span><kbd id="ob-tip-key"></kbd></h4>
        <p id="ob-tip-body"></p>
        <div class="ob-tip-foot">
          <span class="count" id="ob-tip-count"></span>
          <button class="end" id="ob-tour-end">End tour</button>
          <button class="back" id="ob-tour-back">Back</button>
          <button class="next" id="ob-tour-next">Next</button>
        </div>
      </div>`;
    document.body.appendChild(tour);

    wire();
  }

  // ── step machine ──────────────────────────────────────────────────────────
  const sections = () => [...root.querySelectorAll('.ob-step')];

  function show(i) {
    step = i;
    const names = [...STEPS, 'done'];
    sections().forEach((s) => s.classList.toggle('on', s.dataset.step === names[i]));
    const dots = root.querySelector('#ob-dots');
    dots.innerHTML = names.map((_, n) => `<i class="${n === i ? 'on' : ''}"></i>`).join('');
    if (names[i] === 'name') setTimeout(() => root.querySelector('#ob-name')?.focus(), 300);
    if (names[i] === 'done') {
      const t = root.querySelector('#ob-done-title');
      t.textContent = picked.name ? `You're set, ${picked.name}.` : "You're set.";
    }
  }

  function wire() {
    root.querySelectorAll('[data-next]').forEach((b) => b.addEventListener('click', next));
    root.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => show(Math.max(0, step - 1))));
    root.querySelector('#ob-skip').addEventListener('click', () => finish(true));

    const nameInput = root.querySelector('#ob-name');
    nameInput.addEventListener('input', () => {
      const v = nameInput.value.trim();
      root.querySelector('#ob-name-hint').textContent = v ? `Nice to meet you, ${v}.` : '';
    });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') next(); });

    // theme: preview on hover, commit on click
    const themeBtns = root.querySelectorAll('[data-theme]');
    themeBtns.forEach((b) => {
      b.addEventListener('mouseenter', () => applyTheme(b.dataset.theme));
      b.addEventListener('click', () => {
        picked.theme = b.dataset.theme;
        themeBtns.forEach((x) => x.classList.toggle('sel', x === b));
        applyTheme(b.dataset.theme);
      });
    });
    root.querySelector('[data-step="theme"]').addEventListener('mouseleave', () => {
      applyTheme(picked.theme || currentTheme());
    });

    // model choice
    const modelBtns = root.querySelectorAll('[data-model]');
    modelBtns.forEach((b) => b.addEventListener('click', () => {
      modelBtns.forEach((x) => x.classList.toggle('sel', x === b));
      root.querySelector('#ob-key').classList.toggle('on', b.dataset.model === 'key');
    }));

    root.querySelector('#ob-no-tour').addEventListener('click', () => finish(false));
    root.querySelector('#ob-do-tour').addEventListener('click', () => { finish(false, true); });

    tour.querySelector('#ob-tour-next').addEventListener('click', () => goTour(tourIdx + 1));
    tour.querySelector('#ob-tour-back').addEventListener('click', () => goTour(tourIdx - 1));
    tour.querySelector('#ob-tour-end').addEventListener('click', endTour);

    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', () => { if (tour.classList.contains('on')) position(); });
  }

  function onKey(e) {
    if (root?.classList.contains('open')) {
      if (e.key === 'Escape') finish(true);
      return;
    }
    if (tour?.classList.contains('on')) {
      if (e.key === 'Escape') endTour();
      if (e.key === 'ArrowRight' || e.key === 'Enter') goTour(tourIdx + 1);
      if (e.key === 'ArrowLeft') goTour(tourIdx - 1);
    }
  }

  let lastAdvance = 0;
  function next() {
    // consecutive steps put Continue at the same spot, so a double-click would
    // silently skip one. Ignore a second advance inside the transition window.
    const now = Date.now();
    if (now - lastAdvance < 350) return;
    lastAdvance = now;

    const names = [...STEPS, 'done'];
    if (names[step] === 'name') picked.name = root.querySelector('#ob-name').value.trim();
    if (names[step] === 'model') {
      picked.provider = root.querySelector('#ob-provider').value;
      picked.key = root.querySelector('#ob-apikey').value.trim();
    }
    show(Math.min(names.length - 1, step + 1));
  }

  const currentTheme = () => window.mindSettings?.appearance?.theme || 'device';

  function applyTheme(theme) {
    const isDark = theme === 'dark' ||
      (theme === 'device' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.dataset.theme = isDark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  }

  // ── persistence ───────────────────────────────────────────────────────────
  async function finish(skipped, startTour = false) {
    try {
      const s = (await api()?.getSettings()) || {};
      s.general = s.general || {};
      s.profile = s.profile || {};
      s.appearance = s.appearance || {};

      // Mark it done either way. Dismissing is a decision, not a deferral.
      s.general.onboardedAt = Date.now();
      if (!skipped) {
        if (picked.name) s.profile.name = picked.name;
        if (picked.theme) s.appearance.theme = picked.theme;
      }
      await api()?.saveSettings(s);
      window.mindSettings = s;
      window.applyAppearanceSettings?.(s);

      if (!skipped && picked.key && picked.provider) {
        await api()?.saveApiKey(picked.provider, picked.key);
      }
    } catch (err) {
      console.warn('[onboarding] could not save preferences:', err?.message || err);
    }

    root.classList.add('closing');
    root.classList.remove('open');
    setTimeout(() => {
      root.remove();
      if (startTour) startTourFlow();
    }, 450);
  }

  // ── tour ──────────────────────────────────────────────────────────────────
  let live = [];

  function startTourFlow() {
    // only point at things that actually exist in this build
    live = TOUR.filter((t) => {
      const el = document.getElementById(t.id);
      if (!el) return false;
      // Presence is not enough: the volume control is hidden until a tab makes
      // sound, and spotlighting it would ring an empty corner of the screen.
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!live.length) return;
    tour.classList.add('on');
    goTour(0);
  }

  function goTour(i) {
    if (i < 0) return;
    if (i >= live.length) return endTour();
    tourIdx = i;
    const t = live[i];
    tour.querySelector('#ob-tip-title').textContent = t.title;
    const kbd = tour.querySelector('#ob-tip-key');
    kbd.textContent = t.key || '';
    kbd.style.display = t.key ? '' : 'none';
    tour.querySelector('#ob-tip-body').textContent = t.body;
    tour.querySelector('#ob-tip-count').textContent = `${i + 1} of ${live.length}`;
    tour.querySelector('#ob-tour-back').style.visibility = i === 0 ? 'hidden' : 'visible';
    tour.querySelector('#ob-tour-next').textContent = i === live.length - 1 ? 'Done' : 'Next';
    position();
  }

  function position() {
    const t = live[tourIdx];
    const el = document.getElementById(t.id);
    if (!el) return endTour();
    const r = el.getBoundingClientRect();
    const pad = 6;

    const hole = tour.querySelector('#ob-hole');
    const ring = tour.querySelector('#ob-ring');
    const ping = tour.querySelector('#ob-ping');
    [hole, ring].forEach((n) => {
      n.style.top = `${r.top - pad}px`;
      n.style.left = `${r.left - pad}px`;
      n.style.width = `${r.width + pad * 2}px`;
      n.style.height = `${r.height + pad * 2}px`;
    });
    const size = Math.max(r.width, r.height) + 16;
    ping.style.width = ping.style.height = `${size}px`;
    ping.style.top = `${r.top + r.height / 2 - size / 2}px`;
    ping.style.left = `${r.left + r.width / 2 - size / 2}px`;

    // keep the tooltip on screen: below the target, flipped above if it'd overflow
    const tip = tour.querySelector('#ob-tip');
    const tw = tip.offsetWidth || 320, th = tip.offsetHeight || 150;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(14, Math.min(left, window.innerWidth - tw - 14));
    let top = r.bottom + 16;
    if (top + th > window.innerHeight - 14) top = Math.max(14, r.top - th - 16);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function endTour() {
    tour.classList.remove('on');
  }

  // ── entry point ───────────────────────────────────────────────────────────
  async function init() {
    if (!api()?.getSettings) return;               // no bridge, never guess
    try {
      const s = await api().getSettings();
      if (!s || s.general?.onboardedAt) return;    // unreadable, or already seen
    } catch { return; }                            // don't block the browser
    render();
    show(0);
    requestAnimationFrame(() => root.classList.add('open'));
  }

  /** Manually re-runnable from Settings → Help. */
  function restart() {
    if (!root || !document.body.contains(root)) { render(); }
    show(0);
    root.classList.remove('closing');
    requestAnimationFrame(() => root.classList.add('open'));
  }

  return { init, restart, startTour: () => { if (!tour) render(); startTourFlow(); } };
})();

window.Onboarding = Onboarding;
