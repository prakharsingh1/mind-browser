// =============================================================================
// Local Mind Browser — Settings Controller
// =============================================================================
// Full-page settings view with all options wired to the backend.

const Settings = (() => {
  let currentSection = 'general';
  let settings = {};
  let perfInterval = null;   // live-refresh timer for the Performance section
  let clockPreviewInterval = null;  // live-tick timer for the clock Cover Flow

  let privacySchema = null;

  function init() {
    // Close button
    document.getElementById('settings-close')?.addEventListener('click', close);

    // Nav items
    document.querySelectorAll('.settings-nav-item').forEach(item => {
      item.addEventListener('click', () => {
        setSection(item.dataset.section);
      });
    });
  }

  /**
   * One delegated click handler for every control in Settings.
   *
   * These were inline onclick attributes. They worked, but they are exactly
   * what forces `script-src 'unsafe-inline'` into the Content-Security-Policy —
   * and a policy with that in it cannot stop injected script from running in
   * the window that holds the privileged bridge. Routing them through
   * data-act/data-arg is what lets the policy be tightened.
   */
  function wireDelegatedActions() {
    const root = document.getElementById('settings-overlay');
    if (!root || root.dataset.delegated === 'on') return;
    root.dataset.delegated = 'on';

    // Range inputs report through 'input', not 'click'.
    root.addEventListener('input', (e) => {
      const el = e.target.closest('[data-act-input]');
      if (!el || !root.contains(el)) return;
      if (el.dataset.actInput === 'setPrivacyLevel') setPrivacyLevel(el.value);
    });

    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el || !root.contains(el)) return;
      const { act, arg, then } = el.dataset;

      switch (act) {
        case 'toggleSetting':
          toggleSetting(arg, el);
          // A couple of toggles have to nudge something else once flipped.
          if (then === 'aiPanelHover' && typeof AiPanel !== 'undefined') AiPanel.applyHoverMode();
          break;
        case 'saveKey':              saveKey(arg); break;
        case 'togglePrivacyControl': togglePrivacyControl(arg, el); break;
        case 'toggleOnion':          toggleOnion(el); break;
        case 'resetPrivacyOverrides': resetPrivacyOverrides(); break;
        default: break;
      }
    });
  }

  async function open(section) {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) overlay.classList.remove('hidden');
    wireDelegatedActions();

    // The footer version is visible from every section, so it is filled on
    // open rather than only when About happens to be viewed.
    window.localMind?.getAppVersion?.().then((v) => {
      const foot = document.getElementById('settings-version');
      if (foot && v) foot.textContent = `Mind Browser v${v}`;
    }).catch(() => {});

    // Load current settings
    if (window.localMind) {
      settings = await window.localMind.getSettings();
      window.mindSettings = settings;
      // Fetched here, while we can still await, so the section renderers below
      // stay synchronous.
      if (!privacySchema) {
        try { privacySchema = await window.localMind.privacySchema(); } catch { /* fall back to a basic page */ }
      }
    }

    if (section) {
      setSection(section);
    } else {
      renderSection(currentSection);
    }
  }

  function close() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) overlay.classList.add('hidden');
    stopPerfRefresh();
    stopClockPreview();
    // Ensure the New Tab clock shows the latest theme when settings closes
    if (typeof NewTabPage !== 'undefined') NewTabPage.refreshClock();
  }

  function setSection(section) {
    currentSection = section;
    document.querySelectorAll('.settings-nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.section === section);
    });
    renderSection(section);
  }

  function renderSection(section) {
    const content = document.getElementById('settings-content');
    if (!content) return;

    const renderers = {
      general: renderGeneral,
      models: renderModels,
      memory: renderMemory,
      privacy: renderPrivacy,
      widgets: renderWidgets,
      news: renderNews,
      finance: renderFinance,
      performance: renderPerformance,
      appearance: renderAppearance,
      wallpaper: renderWallpaper,
      shortcuts: renderShortcuts,
      about: renderAbout
    };

    stopPerfRefresh();
    stopClockPreview();
    const renderer = renderers[section] || renderers.general;
    content.innerHTML = renderer();

    // Bind events after rendering
    bindSectionEvents(section);
  }

  function renderGeneral() {
    const g = settings.general || {};
    return `
      <h2 class="settings-section-title">General</h2>
      <p class="settings-section-desc">Configure basic browser behavior and defaults.</p>
      
      <div class="settings-group">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <label class="settings-label" style="margin-bottom: 0;">Autofill Profiles</label>
          <button id="btn-add-profile" class="btn btn-secondary" style="font-size: 11px; padding: 4px 8px;">+ Add Profile</button>
        </div>
        <div id="autofill-profiles-container">
          <!-- Populated by JS -->
        </div>
        <div class="settings-row-desc" style="margin-top: 8px;">Saved to automatically fill web forms securely.</div>
      </div>

      <div class="settings-divider"></div>

      <div class="settings-group">
        <label class="settings-label">Default Search Engine</label>
        <select class="settings-input settings-select" id="setting-search-engine">
          <option value="duckduckgo" ${g.searchEngine === 'duckduckgo' ? 'selected' : ''}>DuckDuckGo</option>
          <option value="google" ${g.searchEngine === 'google' ? 'selected' : ''}>Google</option>
          <option value="bing" ${g.searchEngine === 'bing' ? 'selected' : ''}>Bing</option>
        </select>
      </div>

      <div class="settings-group">
        <label class="settings-label">Max Agent Steps</label>
        <input type="number" class="settings-input" id="setting-max-steps" value="${g.maxAgentSteps || 50}" min="10" max="200">
      </div>

      <div class="settings-group">
        <label class="settings-label">Context Window Size</label>
        <select class="settings-input settings-select" id="setting-context-window">
          <option value="4096" ${g.contextWindow == 4096 ? 'selected' : ''}>4,096 tokens</option>
          <option value="8192" ${g.contextWindow == 8192 ? 'selected' : ''}>8,192 tokens</option>
          <option value="16384" ${g.contextWindow == 16384 ? 'selected' : ''}>16,384 tokens</option>
          <option value="32768" ${g.contextWindow == 32768 ? 'selected' : ''}>32,768 tokens</option>
        </select>
      </div>

      <div class="settings-divider"></div>

      <div class="settings-row">
        <div>
          <div class="settings-row-label">Startup Page</div>
          <div class="settings-row-desc">What to show when the browser starts</div>
        </div>
        <select class="settings-input settings-select" id="setting-startup" style="width:200px">
          <option value="newtab" ${g.startupPage === 'newtab' ? 'selected' : ''}>New Tab Page</option>
          <option value="last" ${g.startupPage === 'last' ? 'selected' : ''}>Last Open Tabs</option>
        </select>
      </div>

      <div class="settings-divider"></div>

      <h3 class="settings-section-title" style="font-size:16px;margin-top:8px;">Import Data</h3>
      <p class="settings-section-desc">Transfer bookmarks from your default browser.</p>

      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;">
        <button class="settings-btn secondary" id="import-chrome" style="display:flex;align-items:center;gap:8px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="21.17" y1="8" x2="12" y2="8"/><line x1="3.95" y1="6.06" x2="8.54" y2="14"/><line x1="10.88" y1="21.94" x2="15.46" y2="14"/></svg>
          Import from Chrome
        </button>
        <button class="settings-btn secondary" id="import-safari" style="display:flex;align-items:center;gap:8px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><circle cx="12" cy="12" r="10"/><line x1="14.31" y1="8" x2="20.05" y2="17.94"/><line x1="9.69" y1="8" x2="21.17" y2="8"/><line x1="7.38" y1="12" x2="13.12" y2="2.06"/><line x1="9.69" y1="16" x2="3.95" y2="6.06"/><line x1="14.31" y1="16" x2="2.83" y2="16"/><line x1="16.62" y1="12" x2="10.88" y2="21.94"/></svg>
          Import from Safari
        </button>
        <button class="settings-btn secondary" id="import-edge" style="display:flex;align-items:center;gap:8px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><circle cx="12" cy="12" r="10"/><path d="M7 15c1.5 1.5 4 2 6.5 1 2-.8 3-2.5 3-4 0-2.5-2.2-4-4.5-4C9 4 7 6.2 7 9c0 3.5 2.5 6 6 6.5"/></svg>
          Import from Edge
        </button>
        <button class="settings-btn secondary" id="import-arc" style="display:flex;align-items:center;gap:8px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M4 19c3.5-9 6.5-13 8-13s4.5 4 8 13"/><circle cx="16.5" cy="15" r="3.2"/></svg>
          Import from Arc
        </button>
        <button class="settings-btn secondary" id="import-zen" style="display:flex;align-items:center;gap:8px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><circle cx="12" cy="12" r="9"/><path d="M8.5 9h7l-7 6h7"/></svg>
          Import from Zen
        </button>
      </div>
      <div id="import-status" style="margin-top:12px;font-size:13px;color:var(--text-secondary);"></div>
    `;
  }

  function renderModels() {
    return `
      <h2 class="settings-section-title">AI Models</h2>
      <p class="settings-section-desc">The panel shows a curated shortlist. Every supported model lives here.</p>

      <div class="settings-group">
        <label class="settings-label">Cost strategy</label>
        <select class="settings-input" id="mdl-strategy" style="width:280px">
          <option value="savings">Maximum Savings — free APIs whenever possible</option>
          <option value="balanced">Balanced — free first, escalate when needed</option>
          <option value="performance">Maximum Performance — strongest model</option>
        </select>
        <div class="settings-row-desc" id="mdl-usage" style="margin-top:8px"></div>
      </div>

      <div class="settings-group">
        <label class="settings-label">Pin a model (overrides routing — leave blank to auto-route)</label>
        <input type="text" class="settings-input" id="mdl-default" style="width:280px"
               value="${escapeHtml(settings.models?.pinnedModel || '')}" placeholder="auto">
      </div>

      <div class="settings-group">
        <label class="settings-label">Browse all models</label>
        <input type="text" class="settings-input" id="mdl-search" placeholder="Search models…" style="width:280px">
        <div id="mdl-list" class="mdl-list">Loading models…</div>
      </div>
      <div class="settings-divider"></div>
    ` + renderKeysSection();
  }

  /** Full catalogue: search, favourite, set as default. */
  async function bindModelsSection() {
    const list = document.getElementById('mdl-list');
    const search = document.getElementById('mdl-search');
    const def = document.getElementById('mdl-default');
    if (!list) return;

    const strat = document.getElementById('mdl-strategy');
    if (strat) {
      strat.value = settings.models?.strategy || 'balanced';
      strat.addEventListener('change', () => {
        settings.models = settings.models || {};
        settings.models.strategy = strat.value;
        window.localMind?.saveSettings?.(settings);
      });
    }
    const usage = settings.usage || {};
    const el = document.getElementById('mdl-usage');
    if (el) {
      el.textContent = `Today: about $${(usage.savedUsd || 0).toFixed(3)} saved, $${(usage.spentUsd || 0).toFixed(4)} spent (estimates).`;
    }

    def?.addEventListener('change', () => {
      settings.models = settings.models || {};
      settings.models.pinnedModel = def.value.trim();
      window.localMind?.saveSettings?.(settings);
      try { AiPanel.reloadModels?.(); } catch {}
    });

    let all = [];
    try {
      const byProvider = await window.localMind.getModels();
      Object.entries(byProvider || {}).forEach(([provider, models]) => {
        (models || []).forEach((m) => {
          const id = typeof m === 'string' ? m : (m.id || m.name);
          if (id) all.push({ provider, id });
        });
      });
    } catch { /* offline or no keys */ }

    if (!all.length) {
      list.innerHTML = '<div class="mdl-empty">No models available — add an API key below, then reopen this page.</div>';
      return;
    }

    const draw = () => {
      const q = (search?.value || '').toLowerCase();
      const favs = settings.models?.favorites || [];
      const rows = all.filter((m) => !q || m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q));
      list.innerHTML = rows.slice(0, 200).map((m) => `
        <div class="mdl-row">
          <button class="mdl-fav ${favs.includes(m.id) ? 'on' : ''}" data-fav="${escapeHtml(m.id)}" title="Favourite">★</button>
          <span class="mdl-id">${escapeHtml(m.id)}</span>
          <span class="mdl-prov">${escapeHtml(m.provider)}</span>
          <button class="mdl-use" data-use="${escapeHtml(m.id)}">Use</button>
        </div>`).join('') || '<div class="mdl-empty">No matches.</div>';

      list.querySelectorAll('[data-fav]').forEach((b) => b.addEventListener('click', () => {
        settings.models = settings.models || {};
        const f = settings.models.favorites || [];
        const id = b.dataset.fav;
        settings.models.favorites = f.includes(id) ? f.filter((x) => x !== id) : [...f, id];
        window.localMind?.saveSettings?.(settings);
        draw();
      }));
      list.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => {
        if (def) def.value = b.dataset.use;
        settings.models = settings.models || {};
        settings.models.pinnedModel = b.dataset.use;
        window.localMind?.saveSettings?.(settings);
      }));
    };

    search?.addEventListener('input', draw);
    draw();
  }

  function renderKeysSection() {
    return `
      <h2 class="settings-section-title">Models & API Keys</h2>
      <p class="settings-section-desc">Configure LLM providers and manage API keys.</p>

      <div class="settings-group">
        <label class="settings-label">Ollama Status</label>
        <div id="ollama-status" class="settings-row-desc">Checking...</div>
      </div>

      <div class="settings-divider"></div>

      <div class="settings-group">
        <label class="settings-label">OpenAI API Key</label>
        <input type="password" class="settings-input" id="key-openai" placeholder="sk-...">
        <button class="settings-btn secondary" style="margin-top:8px" data-act="saveKey" data-arg="openai">Save Key</button>
      </div>

      <div class="settings-group">
        <label class="settings-label">Anthropic API Key</label>
        <input type="password" class="settings-input" id="key-anthropic" placeholder="sk-ant-...">
        <button class="settings-btn secondary" style="margin-top:8px" data-act="saveKey" data-arg="anthropic">Save Key</button>
      </div>

      <div class="settings-group">
        <label class="settings-label">Gemini API Key</label>
        <input type="password" class="settings-input" id="key-gemini" placeholder="AIza...">
        <button class="settings-btn secondary" style="margin-top:8px" data-act="saveKey" data-arg="gemini">Save Key</button>
      </div>

      <div class="settings-group">
        <label class="settings-label">Groq API Key</label>
        <input type="password" class="settings-input" id="key-groq" placeholder="gsk_...">
        <button class="settings-btn secondary" style="margin-top:8px" data-act="saveKey" data-arg="groq">Save Key</button>
      </div>

      <div class="settings-group">
        <label class="settings-label">OpenRouter API Key</label>
        <input type="password" class="settings-input" id="key-openrouter" placeholder="sk-or-v1-...">
        <button class="settings-btn secondary" style="margin-top:8px" data-act="saveKey" data-arg="openrouter">Save Key</button>
      </div>

      <div class="settings-divider"></div>

      <h2 class="settings-section-title">Custom or local model</h2>
      <p class="settings-section-desc">
        Point the browser at any endpoint that speaks the OpenAI chat API — a model
        running on this machine (LM Studio, llama.cpp, vLLM, Jan, LocalAI), a gateway
        of your own, or another provider that uses the same protocol (DeepSeek,
        Mistral, Together, Fireworks, xAI). Nothing leaves your machine when the
        endpoint is local.
      </p>

      <div class="settings-group">
        <label class="settings-label">Endpoint</label>
        <input type="text" class="settings-input" id="custom-api-base"
               placeholder="http://localhost:1234/v1" spellcheck="false" autocomplete="off">
        <div class="settings-row-desc" style="margin-top:6px">
          The base URL. <code>/v1</code> is added if you leave it off.
        </div>
      </div>

      <div class="settings-group">
        <label class="settings-label">API key <span style="opacity:0.6">— leave empty for a local model</span></label>
        <input type="password" class="settings-input" id="key-custom" placeholder="Optional">
        <button class="settings-btn secondary" style="margin-top:8px" data-act="saveKey" data-arg="custom">Save Key</button>
      </div>

      <div class="settings-group">
        <label class="settings-label">Model names <span style="opacity:0.6">— only if the endpoint has no /models list</span></label>
        <input type="text" class="settings-input" id="custom-models"
               placeholder="llama-3.3-70b, qwen2.5-coder" spellcheck="false" autocomplete="off">
      </div>

      <button class="settings-btn secondary" id="custom-test">Test connection</button>
      <div id="custom-test-result" style="margin-top:8px;font-size:12.5px"></div>

      <div class="settings-divider"></div>

      <h2 class="settings-section-title">Read aloud</h2>
      <p class="settings-section-desc">
        Used by the reader and by the Listen button on an AI answer. Voices come from
        macOS — add more in System Settings → Accessibility → Spoken Content.
      </p>

      <div class="settings-group">
        <label class="settings-label">Voice</label>
        <select class="settings-input" id="speech-voice"></select>
      </div>

      <div class="settings-group">
        <label class="settings-label">Speed <span id="speech-rate-val" style="opacity:0.6"></span></label>
        <input type="range" id="speech-rate" min="0.5" max="2" step="0.05" style="width:100%">
      </div>

      <div class="settings-group">
        <label class="settings-label">Pitch <span id="speech-pitch-val" style="opacity:0.6"></span></label>
        <input type="range" id="speech-pitch" min="0.5" max="1.6" step="0.05" style="width:100%">
      </div>

      <button class="settings-btn secondary" id="speech-test">Hear a sample</button>
    `;
  }

  function renderMemory() {
    return `
      <h2 class="settings-section-title">Memory</h2>
      <p class="settings-section-desc">Manage what the AI remembers about your browsing.</p>
      <div class="settings-row">
        <div><div class="settings-row-label">Memories stored</div><div class="settings-row-desc">Total items in AI memory</div></div>
        <span id="memory-count" style="color:var(--accent);font-weight:600">0</span>
      </div>
      <div class="settings-divider"></div>
      <button class="settings-btn danger" id="clear-memories">Clear All Memories</button>
    `;
  }

  function renderVpnBlock() {
    return `
      <div class="settings-divider"></div>
      <h3 class="settings-section-title" style="font-size:16px;">VPN / Proxy</h3>
      <p class="settings-section-desc">Route all browsing through your own VPN or proxy — SOCKS5 or HTTP. Applies to every tab, including private windows.</p>

      <div class="settings-row">
        <div>
          <div class="settings-row-label">Route traffic through proxy</div>
          <div class="settings-row-desc" id="vpn-status">Off</div>
        </div>
        <div class="settings-toggle" id="vpn-toggle"></div>
      </div>

      <div class="settings-group">
        <label class="settings-label">Type</label>
        <select class="settings-input" id="vpn-type" style="width:180px">
          <option value="socks5">SOCKS5</option>
          <option value="http">HTTP</option>
        </select>
      </div>
      <div class="settings-group">
        <label class="settings-label">Server</label>
        <input type="text" class="settings-input" id="vpn-host" placeholder="127.0.0.1" style="width:220px">
      </div>
      <div class="settings-group">
        <label class="settings-label">Port</label>
        <input type="text" class="settings-input" id="vpn-port" placeholder="1080" style="width:120px">
      </div>
      <div class="settings-group">
        <label class="settings-label">Username (optional)</label>
        <input type="text" class="settings-input" id="vpn-user" style="width:220px">
      </div>
      <div class="settings-group">
        <label class="settings-label">Password (optional)</label>
        <input type="password" class="settings-input" id="vpn-pass" style="width:220px">
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="settings-btn" id="vpn-save">Save &amp; apply</button>
        <button class="settings-btn secondary" id="vpn-test">Check my IP</button>
        <span class="settings-row-desc" id="vpn-ip"></span>
      </div>`;
  }

  async function bindVpnEvents() {
    if (!document.getElementById('vpn-toggle')) return;
    const $ = (id) => document.getElementById(id);
    let cfg = { enabled: false, type: 'socks5' };
    try { cfg = (await window.localMind.proxyGet())?.config || cfg; } catch {}

    $('vpn-type').value = cfg.type || 'socks5';
    $('vpn-host').value = cfg.host || '';
    $('vpn-port').value = cfg.port || '';
    $('vpn-user').value = cfg.username || '';
    $('vpn-pass').value = cfg.password || '';
    $('vpn-toggle').classList.toggle('active', !!cfg.enabled);
    $('vpn-status').textContent = cfg.enabled ? `On — ${cfg.type} ${cfg.host}:${cfg.port}` : 'Off';

    const collect = () => ({
      enabled: $('vpn-toggle').classList.contains('active'),
      type: $('vpn-type').value,
      host: $('vpn-host').value.trim(),
      port: $('vpn-port').value.trim(),
      username: $('vpn-user').value.trim(),
      password: $('vpn-pass').value
    });

    const applyNow = async () => {
      const next = collect();
      const res = await window.localMind.proxySet(next);
      $('vpn-status').textContent = res?.ok
        ? (next.enabled ? `On — ${next.type} ${next.host}:${next.port}` : 'Off')
        : `Error: ${res?.error || 'could not apply'}`;
      if (!res?.ok) $('vpn-toggle').classList.remove('active');
    };

    $('vpn-toggle').addEventListener('click', function () {
      this.classList.toggle('active');
      applyNow();
    });
    $('vpn-save').addEventListener('click', applyNow);
    $('vpn-test').addEventListener('click', async () => {
      $('vpn-ip').textContent = 'Checking…';
      const r = await window.localMind.proxyCheck();
      $('vpn-ip').textContent = r?.ok ? `Exit IP: ${r.ip}` : `Failed: ${r?.error || 'no response'}`;
    });
  }

  /** Which switches are actually in force: the level's preset, plus overrides. */
  function effectivePrivacy() {
    const p = settings.privacy || {};
    const levels = privacySchema?.levels || [];
    const level = levels.find((l) => l.id === (p.level ?? 2)) || levels[1];
    const keys = (privacySchema?.controls || []).flatMap((g) => g.items.map((i) => i.key));
    const out = {};
    for (const k of keys) out[k] = !!level?.flags.includes(k);
    for (const [k, v] of Object.entries(p.overrides || {})) if (k in out) out[k] = !!v;
    return { flags: out, level, levels, custom: keys.some((k) => out[k] !== !!level?.flags.includes(k)) };
  }

  function renderPrivacyLevels() {
    if (!privacySchema) return '';
    const { flags, level, levels, custom } = effectivePrivacy();
    const onCount = Object.values(flags).filter(Boolean).length;

    const ticks = levels.map((l) => `<span class="plevel-tick${l.id === level.id ? ' on' : ''}">${escapeHtml(l.name)}</span>`).join('');

    const groups = (privacySchema.controls || []).map((g) => `
      <div class="pgroup">
        <div class="pgroup-title">${escapeHtml(g.group)}</div>
        ${g.items.map((it) => `
          <div class="settings-row">
            <div>
              <div class="settings-row-label">${escapeHtml(it.label)}</div>
              <div class="settings-row-desc">${escapeHtml(it.desc)}</div>
            </div>
            <div class="settings-toggle ${flags[it.key] ? 'active' : ''}"
                 data-act="togglePrivacyControl" data-arg="${it.key}"></div>
          </div>`).join('')}
      </div>`).join('');

    return `
      <div class="plevel-card">
        <div class="plevel-head">
          <div>
            <div class="plevel-name">${escapeHtml(level.name)}${custom ? ' <span class="plevel-custom">Custom</span>' : ''}</div>
            <div class="plevel-tagline">${escapeHtml(level.tagline)}</div>
          </div>
          <div class="plevel-count">${onCount} of ${Object.keys(flags).length} protections on</div>
        </div>
        <input type="range" min="1" max="${levels.length}" step="1" value="${level.id}"
               class="plevel-slider" id="privacy-level-slider"
               data-act-input="setPrivacyLevel">
        <div class="plevel-ticks">${ticks}</div>
        <div class="plevel-detail">${escapeHtml(level.detail)}</div>
        ${custom ? `<button class="plevel-reset" data-act="resetPrivacyOverrides">Reset to ${escapeHtml(level.name)}</button>` : ''}
      </div>

      <div class="plevel-note">
        This protects what <em>sites</em> can learn about you. It does not hide your
        IP address or your traffic from your network — that needs a VPN or Tor.
      </div>

      <div class="settings-divider"></div>

      <div class="settings-group">
        <div class="settings-row">
          <div>
            <div class="settings-row-label">Onion Mode <span class="onion-pill">Tor</span></div>
            <div class="settings-row-desc">
              Opens a separate window where everything goes through the Tor network. Your IP
              address is hidden, .onion sites work, and the window shares nothing with your
              normal browsing — it is wiped when you close it.
            </div>
          </div>
          <div class="settings-toggle" id="toggle-onion" data-act="toggleOnion"></div>
        </div>
        <div id="onion-status" class="settings-row-desc" style="margin-top:8px"></div>

        <div style="margin-top:14px">
          <label class="settings-label">Security level</label>
          <select class="settings-input settings-select" id="setting-onion-level">
            <option value="standard">Standard — everything works</option>
            <option value="safer">Safer — blocks the risky parts (recommended)</option>
            <option value="safest">Safest — JavaScript off, most sites break</option>
          </select>
          <div class="settings-row-desc" id="onion-level-desc" style="margin-top:8px"></div>
        </div>

        <div style="margin-top:14px">
          <label class="settings-label">If Tor is blocked on your network</label>
          <select class="settings-input settings-select" id="setting-onion-bridge">
            <option value="direct">Connect directly (normal)</option>
            <option value="obfs4">Use a bridge — obfs4</option>
            <option value="snowflake">Use a bridge — Snowflake</option>
            <option value="meek">Use a bridge — meek</option>
            <option value="custom">Use bridges I was given</option>
          </select>
          <div class="settings-row-desc" style="margin-top:8px">
            Some countries and networks block Tor outright. Bridges are unlisted entry
            points that disguise the traffic. Only use one if a direct connection fails —
            they are slower.
          </div>
          <textarea class="settings-input" id="setting-onion-custom-bridges" rows="3"
            style="margin-top:10px;display:none;font-family:ui-monospace,SFMono-Regular,monospace;font-size:11.5px"
            placeholder="Paste bridge lines here, one per line"></textarea>
          <div class="settings-row-desc" id="onion-bridge-hint" style="margin-top:8px;display:none">
            Get your own from <b>bridges.torproject.org</b>, or email <b>bridges@torproject.org</b>.
            The built-in bridges are public and are the first thing a censor blocks, so a
            personally issued one often works when they do not.
          </div>
        </div>

        <div class="onion-caveat">
          <b>Read this before relying on it</b>
          This hides your IP address and reaches .onion services, which is enough for privacy
          from your internet provider and for reading things your network blocks. It is not
          Tor Browser. Tor Browser makes every user look identical; this is still Mind Browser,
          so a determined site could pick you out by how your browser is configured even without
          knowing where you are. <b style="display:inline">If being identified would put you in danger, use Tor Browser.</b>
        </div>
      </div>

      <div class="settings-divider"></div>
      <div class="settings-group">
        <label class="settings-label">Encrypted DNS</label>
        <select class="settings-input settings-select" id="setting-dns-provider">
          ${(privacySchema.dnsProviders || []).map((d) => `
            <option value="${escapeHtml(d.id)}"${d.id === (settings.privacy?.dnsProvider || 'system') ? ' selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
        </select>
        <div class="settings-row-desc" id="dns-provider-desc" style="margin-top:8px"></div>
      </div>

      <div class="settings-divider"></div>
      <details class="padvanced">
        <summary>Every protection, individually</summary>
        <p class="settings-section-desc" style="margin-top:10px">
          Changing any switch keeps your level but marks it Custom. Nothing here is hidden from you.
        </p>
        ${groups}
      </details>
      <div class="settings-divider"></div>
    `;
  }

  function renderPrivacy() {
    const p = settings.privacy || {};
    return `
      <h2 class="settings-section-title">Privacy & Security</h2>
      <p class="settings-section-desc">Choose how much you want to give away. Slide right for more protection and more broken sites.</p>

      ${renderPrivacyLevels()}

      <h3 class="settings-subhead">AI access</h3>
      <div class="settings-row">
        <div><div class="settings-row-label">Default Page Visibility</div><div class="settings-row-desc">Whether AI can read page content by default</div></div>
        <select class="settings-input settings-select" id="setting-visibility" style="width:180px">
          <option value="visible" ${p.defaultPageVisibility === 'visible' ? 'selected' : ''}>Visible (AI can read)</option>
          <option value="ask" ${p.defaultPageVisibility === 'ask' ? 'selected' : ''}>Ask First</option>
          <option value="hidden" ${p.defaultPageVisibility === 'hidden' ? 'selected' : ''}>Hidden</option>
        </select>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-row">
        <div><div class="settings-row-label">Auto-hide Sensitive Sites</div><div class="settings-row-desc">Hide AI from banking, healthcare, and financial sites</div></div>
        <div class="settings-toggle ${p.sensitiveDomainsHidden ? 'active' : ''}" id="toggle-sensitive" data-act="toggleSetting" data-arg="privacy.sensitiveDomainsHidden"></div>
      </div>
    ` + renderVpnBlock();
  }

  function renderWidgets() {
    const w = settings.widgets || { news: { topic: 'world' }, weather: { city: 'Pune' }, clock: { timezone: 'Asia/Kolkata', appearance: 'analog' } };
    return `
      <h2 class="settings-section-title">Widgets Dashboard</h2>
      <p class="settings-section-desc">Customize the widgets on your New Tab Page.</p>

      <div class="settings-group">
        <label class="settings-label">News Topic</label>
        <select class="settings-input settings-select" id="setting-widget-news">
          <option value="general" ${w.news?.topic === 'general' ? 'selected' : ''}>World News</option>
          <option value="technology" ${w.news?.topic === 'technology' ? 'selected' : ''}>Technology</option>
          <option value="business" ${w.news?.topic === 'business' ? 'selected' : ''}>Business</option>
          <option value="sports" ${w.news?.topic === 'sports' ? 'selected' : ''}>Sports</option>
          <option value="entertainment" ${w.news?.topic === 'entertainment' ? 'selected' : ''}>Entertainment</option>
        </select>
      </div>

      <div class="settings-group">
        <label class="settings-label">Weather City</label>
        <input type="text" class="settings-input" id="setting-widget-weather" value="${w.weather?.city || 'Pune'}" placeholder="e.g. New York, London, Tokyo">
      </div>

      <div class="settings-group">
        <label class="settings-label">Clock Timezone</label>
        <input type="text" class="settings-input" id="setting-widget-timezone" value="${w.clock?.timezone || 'Asia/Kolkata'}" placeholder="e.g. America/New_York, Europe/London">
      </div>

      <div class="settings-group">
        <label class="settings-label">Clock Theme</label>
        <div class="cf-wrap" id="clock-coverflow">
          <button class="cf-arrow cf-prev" aria-label="Previous">‹</button>
          <div class="cf-stage"><div class="cf-track"></div></div>
          <button class="cf-arrow cf-next" aria-label="Next">›</button>
          <div class="cf-name"></div>
          <div class="cf-dots"></div>
        </div>
      </div>
    `;
  }

  function renderNews() {
    if (!settings.news) settings.news = {};
    const n = settings.news;
    const city = n.city || settings.widgets?.weather?.city || 'Pune';

    return `
      <h2 class="settings-section-title">News</h2>
      <p class="settings-section-desc">Configure the News page (sidebar → News).</p>

      <div class="settings-group">
        <label class="settings-label">AI Briefing Model</label>
        <p class="settings-row-desc" style="margin-bottom:8px;">Model used to write the daily briefing at the top of the News page. Pick "Off" to disable AI features.</p>
        <select class="settings-input settings-select" id="setting-news-model" style="width:280px">
          <option value="">Off</option>
          ${n.model ? `<option value="${escapeHtml(n.model)}" selected>${escapeHtml(n.model)}</option>` : ''}
        </select>
        <div id="news-model-status" class="settings-row-desc" style="margin-top:6px;">Loading available models…</div>
      </div>

      <div class="settings-row">
        <div>
          <div class="settings-row-label">AI daily briefing</div>
          <div class="settings-row-desc">Summarize the day's top stories with the model above</div>
        </div>
        <div class="settings-toggle ${n.briefing !== false ? 'active' : ''}" id="toggle-news-briefing" data-act="toggleSetting" data-arg="news.briefing"></div>
      </div>

      <div class="settings-group">
        <label class="settings-label">Local news city</label>
        <input type="text" class="settings-input" id="setting-news-city" value="${escapeHtml(city)}" placeholder="e.g. Pune, Mumbai, Delhi" style="width:280px">
      </div>
    `;
  }

  // Populate the news model dropdown from all configured providers
  async function loadNewsModels() {
    const select = document.getElementById('setting-news-model');
    const status = document.getElementById('news-model-status');
    if (!select || !window.localMind?.getModels) return;
    try {
      const models = await window.localMind.getModels();
      const current = settings.news?.model || '';
      select.innerHTML = '<option value="">Off</option>';
      let count = 0;
      const labels = { ollama: 'Ollama (Local)', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', groq: 'Groq' };
      Object.entries(models || {}).forEach(([provider, list]) => {
        if (!Array.isArray(list) || !list.length) return;
        const group = document.createElement('optgroup');
        group.label = labels[provider] || provider;
        list.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          if (m === current) opt.selected = true;
          group.appendChild(opt);
          count++;
        });
        select.appendChild(group);
      });
      if (status) status.textContent = count ? `${count} model(s) available.` : 'No models found — start Ollama or add an API key in AI Models.';
    } catch {
      if (status) status.textContent = 'Could not load models.';
    }
  }

  const FIN_INDUSTRIES = ['Technology', 'AI', 'Semiconductors', 'Banking', 'FMCG', 'Pharma', 'Energy', 'Automobile', 'EV', 'Defense', 'Retail', 'Real Estate', 'Telecom', 'Renewable Energy'];

  function renderFinance() {
    if (!settings.finance) settings.finance = {};
    const sel = new Set(settings.finance.industries || []);
    return `
      <h2 class="settings-section-title">Finance</h2>
      <p class="settings-section-desc">Configure the Finance page (sidebar → Finance). Watchlist and portfolio are managed on the page itself.</p>

      <div class="settings-group">
        <label class="settings-label">Industries you follow</label>
        <p class="settings-row-desc" style="margin-bottom:10px;">News for these industries is prioritized in the Finance feed.</p>
        <div id="fin-industry-chips" style="display:flex;flex-wrap:wrap;gap:8px;">
          ${FIN_INDUSTRIES.map(ind => `
            <button data-ind="${ind}" style="
              padding:6px 14px;border-radius:999px;font-size:12px;font-family:inherit;cursor:pointer;
              border:1px solid ${sel.has(ind) ? 'var(--accent)' : 'var(--border-color)'};
              background:${sel.has(ind) ? 'var(--accent-dim, rgba(43,212,115,0.15))' : 'var(--bg-secondary)'};
              color:${sel.has(ind) ? 'var(--accent)' : 'var(--text-secondary)'};
            ">${ind}</button>`).join('')}
        </div>
      </div>
    `;
  }

  function renderPerformance() {
    if (!settings.performance) settings.performance = {};
    const p = settings.performance;
    if (p.tabSleepEnabled === undefined) p.tabSleepEnabled = true;
    const mins = p.tabSleepMinutes || 15;
    const limit = p.processLimit || 'balanced';
    const hwAccel = p.hardwareAcceleration !== false;

    return `
      <h2 class="settings-section-title">Performance</h2>
      <p class="settings-section-desc">Keep the browser lean — sleep inactive tabs and monitor what each tab is costing you.</p>

      <div class="settings-row">
        <div>
          <div class="settings-row-label">Memory Saver</div>
          <div class="settings-row-desc">Put inactive background tabs to sleep to free their memory. They reload instantly when you switch back.</div>
        </div>
        <div class="settings-toggle ${p.tabSleepEnabled ? 'active' : ''}" id="toggle-tabsleep" data-act="toggleSetting" data-arg="performance.tabSleepEnabled"></div>
      </div>

      <div class="settings-row">
        <div>
          <div class="settings-row-label">Sleep tabs after</div>
          <div class="settings-row-desc">How long a background tab stays awake before sleeping</div>
        </div>
        <select class="settings-input settings-select" id="setting-sleep-minutes" style="width:160px">
          <option value="5" ${mins == 5 ? 'selected' : ''}>5 minutes</option>
          <option value="15" ${mins == 15 ? 'selected' : ''}>15 minutes</option>
          <option value="30" ${mins == 30 ? 'selected' : ''}>30 minutes</option>
          <option value="60" ${mins == 60 ? 'selected' : ''}>1 hour</option>
        </select>
      </div>

      <div class="settings-row">
        <div>
          <div class="settings-row-label">Never sleep these sites</div>
          <div class="settings-row-desc">Sleeping discards the page, so anything half-typed is lost on reload. One host per line — an entry also covers its subdomains.</div>
        </div>
      </div>
      <textarea class="settings-input" id="setting-never-sleep" rows="3" spellcheck="false"
        placeholder="mail.google.com&#10;figma.com"
        style="width:100%;font-family:var(--font-mono,monospace);font-size:12px;">${escapeHtml((p.neverSleep || []).join('\n'))}</textarea>

      <div class="settings-divider"></div>

      <h3 class="settings-section-title" style="font-size:16px;margin-bottom:2px;">Memory limits</h3>
      <p class="settings-section-desc">Chromium reads both of these once, at launch.</p>

      <div class="settings-row">
        <div>
          <div class="settings-row-label">Process limit</div>
          <div class="settings-row-desc">How many renderer processes tabs may spread across. Fewer processes means less memory and slightly more contention when several heavy tabs are busy at once — this is the main dial behind "eats less RAM than Chrome".</div>
        </div>
        <select class="settings-input settings-select" id="setting-process-limit" style="width:200px">
          <option value="balanced" ${limit === 'balanced' ? 'selected' : ''}>Balanced — no limit</option>
          <option value="strict" ${limit === 'strict' ? 'selected' : ''}>Strict — up to 6</option>
          <option value="minimal" ${limit === 'minimal' ? 'selected' : ''}>Minimal — up to 3</option>
        </select>
      </div>

      <div class="settings-row">
        <div>
          <div class="settings-row-label">Hardware acceleration</div>
          <div class="settings-row-desc">Uses the GPU for rendering. Smoother, but costs a GPU process and its buffers — turn it off on a machine that is short on memory.</div>
        </div>
        <div class="settings-toggle ${hwAccel ? 'active' : ''}" id="toggle-hwaccel" data-act="toggleSetting" data-arg="performance.hardwareAcceleration"></div>
      </div>

      <div id="perf-restart-note" class="settings-row-desc" style="display:none;padding:10px 12px;background:var(--bg-tertiary);border-radius:var(--radius-md);margin-top:4px;">
        These take effect after a restart.
        <button class="settings-btn secondary" id="perf-restart-btn" style="margin-left:10px;">Restart now</button>
      </div>

      <div class="settings-divider"></div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:10px;flex-wrap:wrap;">
        <div>
          <h3 class="settings-section-title" style="font-size:16px;margin-bottom:2px;">Tab Resource Monitor</h3>
          <div class="settings-row-desc" id="perf-total">Measuring…</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="settings-btn secondary" id="free-memory-btn">Free Memory Now</button>
          <button class="settings-btn secondary" id="sleep-now-btn">Sleep Inactive Tabs</button>
        </div>
      </div>

      <div id="perf-table"></div>
    `;
  }

  // ── Wallpaper ──────────────────────────────────────────────────────────────
  // Curated gradients ship with the app (instant, offline, no download); Bing's
  // daily 4K photos are fetched on demand and cached by the main process.
  const GRADIENTS = [
    { id: 'g-aurora',   name: 'Aurora',    css: 'linear-gradient(150deg,#0f2027 0%,#203a43 45%,#2c5364 100%)' },
    { id: 'g-dusk',     name: 'Dusk',      css: 'linear-gradient(150deg,#2b1055 0%,#7597de 100%)' },
    { id: 'g-ember',    name: 'Ember',     css: 'linear-gradient(150deg,#42275a 0%,#734b6d 100%)' },
    { id: 'g-forest',   name: 'Forest',    css: 'linear-gradient(150deg,#0b2027 0%,#2c5f2d 100%)' },
    { id: 'g-slate',    name: 'Slate',     css: 'linear-gradient(150deg,#1e1e24 0%,#3b3b47 100%)' },
    { id: 'g-sand',     name: 'Sand',      css: 'linear-gradient(150deg,#3e2f24 0%,#8a6f52 100%)' },
    { id: 'g-abyss',    name: 'Abyss',     css: 'linear-gradient(150deg,#000428 0%,#004e92 100%)' },
    { id: 'g-mono',     name: 'Minimal',   css: 'linear-gradient(150deg,#101012 0%,#1c1c20 100%)' }
  ];

  function wallpaperCfg() {
    try { return NewTabPage.getWallpaper() || {}; } catch { return {}; }
  }

  function renderWallpaper() {
    const w = wallpaperCfg();
    const swatch = (g) => `
      <button class="wp-tile ${w.id === g.id ? 'active' : ''}" data-grad="${g.id}"
              style="background:${g.css}" title="${g.name}">
        <span>${g.name}</span>
      </button>`;

    return `
      <h2 class="settings-section-title">Wallpaper</h2>
      <p class="settings-section-desc">Set the backdrop for the New Tab page. Your choice is remembered.</p>

      <div class="settings-group">
        <label class="settings-label">Built-in</label>
        <div class="wp-grid">
          <button class="wp-tile ${!w.url ? 'active' : ''}" data-grad="none"
                  style="background:var(--bg-tertiary)"><span>None</span></button>
          ${GRADIENTS.map(swatch).join('')}
        </div>
      </div>

      <div class="settings-group">
        <label class="settings-label">Photo of the day · Bing</label>
        <div class="wp-grid" id="wp-bing"><div class="wp-loading">Loading photos…</div></div>
      </div>

      <div class="settings-row">
        <div>
          <div class="settings-row-label">Daily rotation</div>
          <div class="settings-row-desc">Pick a fresh Bing photo each day</div>
        </div>
        <div class="settings-toggle ${w.daily ? 'active' : ''}" id="wp-daily"></div>
      </div>

      <div class="settings-group">
        <label class="settings-label">Custom image</label>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="settings-btn" id="wp-upload">Choose file…</button>
          ${w.custom ? '<button class="settings-btn" id="wp-clear-custom">Remove</button>' : ''}
        </div>
        <input type="file" id="wp-file" accept="image/*" style="display:none">
      </div>

      <div class="settings-group">
        <label class="settings-label">Fit</label>
        <select class="settings-input" id="wp-fit" style="width:200px">
          <option value="fill" ${(w.fit || 'fill') === 'fill' ? 'selected' : ''}>Fill</option>
          <option value="fit" ${w.fit === 'fit' ? 'selected' : ''}>Fit</option>
          <option value="stretch" ${w.fit === 'stretch' ? 'selected' : ''}>Stretch</option>
          <option value="center" ${w.fit === 'center' ? 'selected' : ''}>Center</option>
        </select>
      </div>

      <div class="settings-group">
        <label class="settings-label">Dim <span class="wp-val" id="wp-dim-val">${Math.round((w.dim ?? 0.45) * 100)}%</span></label>
        <input type="range" class="wp-range" id="wp-dim" min="0" max="90" value="${Math.round((w.dim ?? 0.45) * 100)}">
      </div>

      <div class="settings-group">
        <label class="settings-label">Blur <span class="wp-val" id="wp-blur-val">${w.blur ?? 0}px</span></label>
        <input type="range" class="wp-range" id="wp-blur" min="0" max="24" value="${w.blur ?? 0}">
      </div>
    `;
  }

  function bindWallpaperEvents() {
    const set = (patch) => NewTabPage.setWallpaper(patch);

    // Built-in gradients
    document.querySelectorAll('#settings-content .wp-tile[data-grad]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.grad;
        if (id === 'none') set({ url: '', id: '', daily: false });
        else {
          const g = GRADIENTS.find(x => x.id === id);
          // Gradients are painted as a CSS image, so they need no download.
          set({ url: '', gradient: g.css, id: g.id, daily: false });
        }
        renderSection('wallpaper');
      });
    });

    // Bing photos
    const bing = document.getElementById('wp-bing');
    if (bing && window.localMind?.ntpWallpapers) {
      window.localMind.ntpWallpapers().then((res) => {
        if (!res?.ok || !res.data?.length) {
          bing.innerHTML = '<div class="wp-loading">Photos unavailable offline</div>';
          return;
        }
        const cur = wallpaperCfg();
        bing.innerHTML = res.data.map((p) => `
          <button class="wp-tile ${cur.id === p.id ? 'active' : ''}" data-bing="${p.id}"
                  data-url="${p.url}" style="background-image:url('${p.thumb}')"
                  title="${escapeHtml(p.copyright || p.title)}">
            <span>${escapeHtml(p.title)}</span>
          </button>`).join('');
        bing.querySelectorAll('[data-bing]').forEach((b) => {
          b.addEventListener('click', () => {
            set({ url: b.dataset.url, gradient: '', id: b.dataset.bing, daily: false });
            renderSection('wallpaper');
          });
        });
      }).catch(() => {
        bing.innerHTML = '<div class="wp-loading">Photos unavailable</div>';
      });
    }

    document.getElementById('wp-daily')?.addEventListener('click', function () {
      const on = !this.classList.contains('active');
      this.classList.toggle('active', on);
      set({ daily: on });
      if (on) applyDailyWallpaper();
    });

    // Custom upload — stored as a data URL so it survives restarts.
    const file = document.getElementById('wp-file');
    document.getElementById('wp-upload')?.addEventListener('click', () => file?.click());
    file?.addEventListener('change', () => {
      const f = file.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        set({ url: reader.result, gradient: '', id: 'custom', custom: true, daily: false });
        renderSection('wallpaper');
      };
      reader.readAsDataURL(f);
    });
    document.getElementById('wp-clear-custom')?.addEventListener('click', () => {
      set({ url: '', gradient: '', id: '', custom: false });
      renderSection('wallpaper');
    });

    document.getElementById('wp-fit')?.addEventListener('change', function () {
      set({ fit: this.value });
    });

    const dim = document.getElementById('wp-dim');
    dim?.addEventListener('input', function () {
      document.getElementById('wp-dim-val').textContent = `${this.value}%`;
      set({ dim: Number(this.value) / 100 });
    });

    const blur = document.getElementById('wp-blur');
    blur?.addEventListener('input', function () {
      document.getElementById('wp-blur-val').textContent = `${this.value}px`;
      set({ blur: Number(this.value) });
    });
  }

  /** Rotate to today's Bing photo (once per day) when daily rotation is on. */
  async function applyDailyWallpaper() {
    const cfg = wallpaperCfg();
    if (!cfg.daily || !window.localMind?.ntpWallpapers) return;
    const today = new Date().toDateString();
    if (cfg.dailyOn === today) return;
    try {
      const res = await window.localMind.ntpWallpapers();
      if (res?.ok && res.data?.length) {
        const pick = res.data[0];
        NewTabPage.setWallpaper({ url: pick.url, gradient: '', id: pick.id, dailyOn: today });
      }
    } catch { /* offline — keep the current wallpaper */ }
  }

  function renderAppearance() {
    const a = settings.appearance || {};
    return `
      <h2 class="settings-section-title">Appearance</h2>
      <p class="settings-section-desc">Customize the browser's look and feel.</p>

      <div class="settings-group">
        <label class="settings-label">Accent colour</label>
        <div class="ap-swatches" id="ap-swatches"></div>
        <div class="settings-row-desc" style="margin-top:8px">
          Or pick your own:
          <input type="color" id="ap-accent-custom" value="${a.accent || '#2bd473'}"
                 style="vertical-align:middle;width:36px;height:24px;border:0;background:none;cursor:pointer">
        </div>
      </div>

      <div class="settings-group">
        <label class="settings-label">Font</label>
        <select class="settings-input" id="ap-font" style="width:200px"></select>
      </div>

      <div class="settings-group">
        <label class="settings-label">Interface size</label>
        <select class="settings-input" id="ap-size" style="width:200px"></select>
      </div>

      <div class="settings-divider"></div>

      <h2 class="settings-section-title">Toolbar</h2>
      <p class="settings-section-desc">
        Choose which controls appear in the top bar. Everything here is also in the
        ☰ menu, so turning one off does not take the feature away.
      </p>
      <div id="ap-toolbar"></div>

      <div class="settings-divider"></div>

      <div class="settings-group">
        <label class="settings-label">Theme</label>
        <select class="settings-input" id="setting-theme" style="width:200px">
          <option value="device" ${a.theme === 'device' || !a.theme ? 'selected' : ''}>Device · Default</option>
          <option value="dark" ${a.theme === 'dark' ? 'selected' : ''}>Dark</option>
          <option value="light" ${a.theme === 'light' ? 'selected' : ''}>Light</option>
        </select>
      </div>

      <div class="settings-group">
        <label class="settings-label">Sidebar Behaviour</label>
        <select class="settings-input" id="setting-sidebar-mode" style="width:280px">
          <option value="docked" ${!a.sidebarMode || a.sidebarMode === 'docked' ? 'selected' : ''}>Always visible</option>
          <option value="icons" ${a.sidebarMode === 'icons' ? 'selected' : ''}>Collapse to icons, expand on hover</option>
          <option value="autohide" ${a.sidebarMode === 'autohide' ? 'selected' : ''}>Auto-hide · slides in from the edge</option>
        </select>
        <div class="settings-row-desc" style="margin-top:6px">
          Auto-hide takes the sidebar out of the layout so it floats over the page,
          the same way the AI panel does. It is the smoothest of the three, because
          nothing behind it has to be re-laid-out when it opens.
        </div>
      </div>

      <div class="settings-group">
        <label class="settings-label">Tab Bar Position</label>
        <select class="settings-input" id="setting-tab-layout" style="width:200px">
          <option value="top" ${a.tabLayout !== 'left' ? 'selected' : ''}>Top (default)</option>
          <option value="left" ${a.tabLayout === 'left' ? 'selected' : ''}>Left sidebar · Arc-style</option>
        </select>
      </div>

      <div class="settings-row">
        <div>
          <div class="settings-row-label">Reveal AI panel on hover</div>
          <div class="settings-row-desc">Collapse the AI Assistant to a rail that expands when you hover the right edge</div>
        </div>
        <div class="settings-toggle ${a.aiPanelHover !== false ? 'active' : ''}" id="toggle-ai-hover" data-act="toggleSetting" data-arg="appearance.aiPanelHover" data-then="aiPanelHover"></div>
      </div>

      <div class="settings-row">
        <div><div class="settings-row-label">Show home button</div></div>
        <div class="settings-toggle ${a.showHomeButton !== false ? 'active' : ''}" id="toggle-home-btn" data-act="toggleSetting" data-arg="appearance.showHomeButton"></div>
      </div>

      <div class="settings-row">
        <div><div class="settings-row-label">Show bookmarks bar</div></div>
        <div class="settings-toggle ${a.showBookmarksBar !== false ? 'active' : ''}" id="toggle-bookmarks-bar" data-act="toggleSetting" data-arg="appearance.showBookmarksBar"></div>
      </div>

      <div class="settings-row">
        <div><div class="settings-row-label">Show bookmarks bar on new tab page</div></div>
        <div class="settings-toggle ${a.showBookmarksOnNtp !== false ? 'active' : ''}" id="toggle-bookmarks-ntp" data-act="toggleSetting" data-arg="appearance.showBookmarksOnNtp"></div>
      </div>

      <div class="settings-row">
        <div><div class="settings-row-label">Always Show Full URLs</div></div>
        <div class="settings-toggle ${a.alwaysShowFullUrls ? 'active' : ''}" id="toggle-full-urls" data-act="toggleSetting" data-arg="appearance.alwaysShowFullUrls"></div>
      </div>

      <div class="settings-row">
        <div><div class="settings-row-label">Automatic picture-in-picture</div><div class="settings-row-desc">Sites can enter picture-in-picture automatically</div></div>
        <div class="settings-toggle ${a.autoPip ? 'active' : ''}" id="toggle-auto-pip" data-act="toggleSetting" data-arg="appearance.autoPip"></div>
      </div>

      <div class="settings-row">
        <div><div class="settings-row-label">Show memory usage on tab hover preview card</div></div>
        <div class="settings-toggle ${a.showMemoryUsage ? 'active' : ''}" id="toggle-memory-usage" data-act="toggleSetting" data-arg="appearance.showMemoryUsage"></div>
      </div>

      <div class="settings-group">
        <label class="settings-label">Font size</label>
        <select class="settings-input" id="setting-fontsize-preset" style="width:200px">
          <option value="small" ${a.fontSizePreset === 'small' ? 'selected' : ''}>Small</option>
          <option value="medium" ${a.fontSizePreset === 'medium' || !a.fontSizePreset ? 'selected' : ''}>Medium (Recommended)</option>
          <option value="large" ${a.fontSizePreset === 'large' ? 'selected' : ''}>Large</option>
        </select>
        <button class="settings-btn" style="margin-left:12px;">Customize fonts</button>
      </div>

      <div class="settings-group">
        <label class="settings-label">Page zoom</label>
        <select class="settings-input" id="setting-page-zoom" style="width:200px">
          <option value="80" ${a.pageZoom === 80 ? 'selected' : ''}>80%</option>
          <option value="90" ${a.pageZoom === 90 ? 'selected' : ''}>90%</option>
          <option value="100" ${a.pageZoom === 100 || !a.pageZoom ? 'selected' : ''}>100%</option>
          <option value="110" ${a.pageZoom === 110 ? 'selected' : ''}>110%</option>
          <option value="125" ${a.pageZoom === 125 ? 'selected' : ''}>125%</option>
          <option value="150" ${a.pageZoom === 150 ? 'selected' : ''}>150%</option>
        </select>
      </div>

      <div class="settings-row">
        <div><div class="settings-row-label">Pressing Tab on a webpage highlights links, as well as form fields</div></div>
        <div class="settings-toggle ${a.tabHighlightsLinks !== false ? 'active' : ''}" id="toggle-tab-links" data-act="toggleSetting" data-arg="appearance.tabHighlightsLinks"></div>
      </div>

      <div class="settings-row">
        <div><div class="settings-row-label">Show warning before quitting with ⌘Q</div></div>
        <div class="settings-toggle ${a.warnBeforeQuit !== false ? 'active' : ''}" id="toggle-warn-quit" data-act="toggleSetting" data-arg="appearance.warnBeforeQuit"></div>
      </div>

      <div class="settings-row">
        <div><div class="settings-row-label">Allow split view drag-and-drop on left or right edge of window</div></div>
        <div class="settings-toggle ${a.allowSplitViewDrag !== false ? 'active' : ''}" id="toggle-split-drag" data-act="toggleSetting" data-arg="appearance.allowSplitViewDrag"></div>
      </div>
    `;
  }

  function renderShortcuts() {
    const shortcuts = [
      ['⌘T', 'New Tab'], ['⌘W', 'Close Tab'], ['⌘L', 'Focus Address Bar'],
      ['⌘K', 'Command Palette'], ['⌘B', 'Toggle Sidebar'], ['⌘⇧L', 'Toggle AI Panel'],
      ['⌘⇧R', 'Reading Mode'], ['⌘\\', 'Split View'], ['⌘,', 'Settings'],
      ['⌘R', 'Reload Page'], ['⌘⇧]', 'Next Tab'], ['⌘⇧[', 'Previous Tab'],
      ['⌘D', 'Pin Page to Sidebar'], ['⌘⇧N', 'Incognito Tab'], ['⌘F', 'Find in Page'],
      ['⌘Y', 'History'], ['⌘+ / ⌘−', 'Zoom In / Out'], ['⌘0', 'Reset Zoom']
    ];

    return `
      <h2 class="settings-section-title">Keyboard Shortcuts</h2>
      <p class="settings-section-desc">Quick reference for all keyboard shortcuts.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${shortcuts.map(([key, desc]) => `
          <div class="settings-row" style="padding:8px 12px;background:var(--bg-tertiary);border-radius:var(--radius-sm)">
            <span style="color:var(--text-primary);font-size:13px">${desc}</span>
            <span class="cp-item-shortcut">${key}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderAbout() {
    return `
      <h2 class="settings-section-title">About</h2>
      <p class="settings-section-desc">Build details, and whether the optional pieces actually loaded.</p>

      <div class="about-hero">
        <img class="about-mark" src="assets/icon.png" alt="" width="52" height="52">
        <div class="about-id">
          <div class="about-name">Mind Browser</div>
          <div class="about-line" id="about-version">Version …</div>
          <div class="about-update" id="about-update">Checking for updates…</div>
        </div>
        <button class="settings-btn secondary" id="about-update-btn">Check for updates</button>
      </div>

      <div class="settings-divider"></div>

      <div class="about-grid">
        <section>
          <h3 class="about-h">Build</h3>
          <dl class="about-dl" id="about-build"></dl>
        </section>
        <section>
          <h3 class="about-h">Capabilities</h3>
          <dl class="about-dl" id="about-caps"></dl>
        </section>
      </div>

      <div class="settings-divider"></div>

      <div class="about-actions">
        <button class="settings-btn secondary" id="about-copy">Copy build info</button>
        <button class="settings-btn secondary" id="about-crashlog">Show crash log</button>
      </div>
    `;
  }

  /** Fill the About panel from the main process. */
  async function loadAboutInfo() {
    const info = await window.localMind?.getSystemInfo?.().catch(() => null);
    if (!info) return;

    const ver = document.getElementById('about-version');
    if (ver) {
      const chip = info.arch === 'arm64' ? 'Apple Silicon'
        : info.translated ? 'Intel build under Rosetta' : 'Intel';
      ver.textContent = `Version ${info.version} · ${chip}`;
    }

    const row = (k, v, tone) =>
      `<dt>${escapeHtml(k)}</dt><dd${tone ? ` class="${tone}"` : ''}>${escapeHtml(String(v))}</dd>`;

    const build = document.getElementById('about-build');
    if (build) {
      build.innerHTML = [
        row('Chromium', info.chromium),
        row('Electron', info.electron),
        row('Node', info.node),
        row('Architecture', info.arch),
        row('Kernel', info.osVersion)
      ].join('');
    }

    const caps = document.getElementById('about-caps');
    if (caps) {
      const wv = info.widevine
        ? { text: `Ready · ${info.widevine.version}`, tone: 'ok' }
        : { text: 'Not available', tone: 'warn' };
      caps.innerHTML = [
        row('Protected video (DRM)', wv.text, wv.tone),
        row('Extensions', info.extensions === 1 ? '1 loaded' : `${info.extensions} loaded`),
        '<dt>Local models</dt><dd id="about-ollama-status">Checking…</dd>'
      ].join('');
    }

    document.getElementById('about-copy')?.addEventListener('click', async (e) => {
      // A bug report is far more useful with this pasted into it than without.
      const text = [
        `Mind Browser ${info.version}`,
        `Chromium ${info.chromium} · Electron ${info.electron} · Node ${info.node}`,
        `${info.platform} ${info.arch}${info.translated ? ' (Rosetta)' : ''} · kernel ${info.osVersion}`,
        `Widevine: ${info.widevine ? info.widevine.version : 'unavailable'}`,
        `Extensions: ${info.extensions}`
      ].join('\n');
      await window.localMind?.writeClipboardText?.(text);
      e.target.textContent = 'Copied';
      setTimeout(() => { e.target.textContent = 'Copy build info'; }, 1600);
    });

    document.getElementById('about-crashlog')?.addEventListener('click', async () => {
      const path = await window.localMind?.crashLogPath?.().catch(() => null);
      if (path) window.localMind?.pdfReveal?.(path);
    });
  }

  function bindSectionEvents(section) {
    if (section === 'wallpaper') bindWallpaperEvents();
    if (section === 'privacy') bindVpnEvents();
    if (section === 'models') bindModelsSection();
    if (section === 'general') {
      window.renderAutofillProfiles = () => {
        const container = document.getElementById('autofill-profiles-container');
        if (!container) return;
        
        const profiles = settings.autofill?.profiles || [];
        
        if (profiles.length === 0) {
          container.innerHTML = '<div style="color: var(--text-tertiary); font-size: 12px; padding: 12px 0;">No profiles saved yet.</div>';
          return;
        }

        container.innerHTML = profiles.map(p => `
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; background: var(--bg-secondary); padding: 8px 12px; border-radius: 6px; border: 1px solid ${p.isDefault ? 'var(--accent-color)' : 'var(--border-color)'}">
            <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
              <div style="display: flex; gap: 8px;">
                <input type="text" class="settings-input profile-name" data-id="${p.id}" value="${escapeHtml(p.name)}" placeholder="Name" style="padding: 4px 8px; font-size: 12px;">
                <input type="email" class="settings-input profile-email" data-id="${p.id}" value="${escapeHtml(p.email)}" placeholder="Email" style="padding: 4px 8px; font-size: 12px;">
              </div>
              <div style="display: flex; gap: 8px; align-items: center;">
                <input type="text" class="settings-input profile-label" data-id="${p.id}" value="${escapeHtml(p.label || '')}" placeholder="Label (e.g. Work)" style="padding: 2px 6px; font-size: 11px; width: 100px; background: transparent; border: none; border-bottom: 1px dashed var(--border-color); border-radius: 0;">
                <label style="font-size: 11px; display: flex; align-items: center; gap: 4px; color: var(--text-secondary); cursor: pointer;">
                  <input type="radio" name="default_profile" value="${p.id}" ${p.isDefault ? 'checked' : ''} class="profile-default-radio"> Default
                </label>
              </div>
            </div>
            <button class="btn-delete-profile" data-id="${p.id}" style="background: none; border: none; color: var(--text-tertiary); cursor: pointer; padding: 4px;" title="Delete Profile">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
          </div>
        `).join('');

        // Bind events
        container.querySelectorAll('.profile-name, .profile-email, .profile-label').forEach(input => {
          input.addEventListener('change', (e) => {
            const id = e.target.getAttribute('data-id');
            const profile = settings.autofill.profiles.find(p => p.id === id);
            if (profile) {
              if (e.target.classList.contains('profile-name')) profile.name = e.target.value;
              if (e.target.classList.contains('profile-email')) profile.email = e.target.value;
              if (e.target.classList.contains('profile-label')) profile.label = e.target.value;
              saveInputSetting('autofill.profiles', settings.autofill.profiles);
            }
          });
        });

        container.querySelectorAll('.profile-default-radio').forEach(radio => {
          radio.addEventListener('change', (e) => {
            const id = e.target.value;
            settings.autofill.profiles.forEach(p => p.isDefault = (p.id === id));
            saveInputSetting('autofill.profiles', settings.autofill.profiles);
            window.renderAutofillProfiles();
          });
        });

        container.querySelectorAll('.btn-delete-profile').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            settings.autofill.profiles = settings.autofill.profiles.filter(p => p.id !== id);
            
            // Ensure there's a default if profiles exist
            if (settings.autofill.profiles.length > 0 && !settings.autofill.profiles.some(p => p.isDefault)) {
              settings.autofill.profiles[0].isDefault = true;
            }
            
            saveInputSetting('autofill.profiles', settings.autofill.profiles);
            window.renderAutofillProfiles();
          });
        });
      };
      
      window.renderAutofillProfiles();
      
      document.getElementById('btn-add-profile')?.addEventListener('click', () => {
        if (!settings.autofill) settings.autofill = { profiles: [] };
        if (!settings.autofill.profiles) settings.autofill.profiles = [];
        
        settings.autofill.profiles.push({
          id: Date.now().toString(),
          label: 'New Profile',
          name: '',
          email: '',
          isDefault: settings.autofill.profiles.length === 0
        });
        saveInputSetting('autofill.profiles', settings.autofill.profiles);
        window.renderAutofillProfiles();
      });

      document.getElementById('setting-search-engine')?.addEventListener('change', (e) => saveInputSetting('general.searchEngine', e.target.value));
      document.getElementById('setting-max-steps')?.addEventListener('change', (e) => saveInputSetting('general.maxAgentSteps', parseInt(e.target.value, 10)));
      document.getElementById('setting-context-window')?.addEventListener('change', (e) => saveInputSetting('general.contextWindow', parseInt(e.target.value, 10)));
      document.getElementById('setting-startup')?.addEventListener('change', (e) => saveInputSetting('general.startupPage', e.target.value));

      // Import buttons
      document.getElementById('import-chrome')?.addEventListener('click', () => importBrowserData('chrome'));
      document.getElementById('import-safari')?.addEventListener('click', () => importBrowserData('safari'));
      document.getElementById('import-edge')?.addEventListener('click', () => importBrowserData('edge'));
      document.getElementById('import-arc')?.addEventListener('click', () => importBrowserData('arc'));
      document.getElementById('import-zen')?.addEventListener('click', () => importBrowserData('zen'));
    }
    if (section === 'privacy') {
      document.getElementById('setting-visibility')?.addEventListener('change', (e) => saveInputSetting('privacy.defaultPageVisibility', e.target.value));

      // ── Onion Mode ────────────────────────────────────────────────────────
      refreshOnionSection();

      // Bridges
      const br = document.getElementById('setting-onion-bridge');
      const brText = document.getElementById('setting-onion-custom-bridges');
      const brHint = document.getElementById('onion-bridge-hint');
      const paintBridges = (info) => {
        if (!info) return;
        if (br && info.mode) br.value = info.mode;
        if (brText && typeof info.custom === 'string') brText.value = info.custom;
        const custom = br?.value === 'custom';
        if (brText) brText.style.display = custom ? '' : 'none';
        if (brHint) brHint.style.display = br?.value === 'direct' ? 'none' : '';
      };
      window.localMind?.onionBridges?.().then(paintBridges).catch(() => {});
      br?.addEventListener('change', async () => {
        paintBridges({ mode: br.value });
        try { paintBridges(await window.localMind?.onionSetBridges?.(br.value, brText?.value)); } catch {}
      });
      brText?.addEventListener('change', async () => {
        try { paintBridges(await window.localMind?.onionSetBridges?.(br?.value, brText.value)); } catch {}
      });

      const lvl = document.getElementById('setting-onion-level');
      lvl?.addEventListener('change', async (e) => {
        try {
          const info = await window.localMind?.onionSetLevel?.(e.target.value);
          paintOnionLevel(info);
        } catch {}
      });

      // Progress while Tor bootstraps, so the toggle does not look stuck.
      window.localMind?.onOnionStatus?.((st) => {
        const el = document.getElementById('onion-status');
        if (!el) return;
        if (st.state === 'ready') el.textContent = 'Connected to Tor.';
        else if (st.state === 'failed') el.textContent = st.error || 'Tor failed to start.';
        else el.textContent = st.progress ? `Connecting to Tor… ${st.progress}%` : 'Starting Tor…';
        const t = document.getElementById('toggle-onion');
        if (t) t.classList.toggle('active', st.state === 'ready');
      });

      const dns = document.getElementById('setting-dns-provider');
      const dnsDesc = () => {
        const list = privacySchema?.dnsProviders || [];
        const chosen = list.find((d) => d.id === dns?.value);
        const el = document.getElementById('dns-provider-desc');
        if (el) el.textContent = chosen?.detail || '';
      };
      dnsDesc();
      dns?.addEventListener('change', async (e) => {
        // Applied by the main process, which owns the resolver; mirrored into
        // settings there too, so this does not double-write.
        try { await window.localMind?.privacyDnsSet?.(e.target.value); } catch {}
        settings.privacy = settings.privacy || {};
        settings.privacy.dnsProvider = e.target.value;
        window.mindSettings = settings;
        dnsDesc();
      });
    }
    if (section === 'memory') {
      loadMemoryStats();
      document.getElementById('clear-memories')?.addEventListener('click', async () => {
        if (confirm('Are you sure you want to clear all memories? This cannot be undone.')) {
          if (window.localMind && window.localMind.clearMemories) {
            await window.localMind.clearMemories();
          }
          if (window.localMind && window.localMind.showNotification) {
            window.localMind.showNotification('Memories Cleared', 'All stored memories have been deleted.');
          }
          const memoryCount = document.getElementById('memory-count');
          if (memoryCount) memoryCount.textContent = '0';
        }
      });
    }
    if (section === 'models') {
      checkOllamaStatus();
      loadApiKeys();
      wireCustomEndpoint();
      wireSpeech();
    }
    if (section === 'about') {
      // Order matters: loadAboutInfo builds the row that holds the Ollama
      // status, so asking for the status first would write into nothing.
      loadAboutInfo().then(() => checkOllamaStatus('about-ollama-status'));
      wireUpdates();
    }
    if (section === 'widgets') {
      document.getElementById('setting-widget-news')?.addEventListener('change', (e) => saveInputSetting('widgets.news.topic', e.target.value));
      document.getElementById('setting-widget-weather')?.addEventListener('change', (e) => saveInputSetting('widgets.weather.city', e.target.value));
      document.getElementById('setting-widget-timezone')?.addEventListener('change', (e) => saveInputSetting('widgets.clock.timezone', e.target.value));
      initClockCoverFlow();
    }
    if (section === 'news') {
      loadNewsModels();
      document.getElementById('setting-news-model')?.addEventListener('change', (e) => saveInputSetting('news.model', e.target.value));
      document.getElementById('setting-news-city')?.addEventListener('change', (e) => saveInputSetting('news.city', e.target.value.trim()));
    }
    if (section === 'finance') {
      document.getElementById('fin-industry-chips')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-ind]');
        if (!btn) return;
        if (!settings.finance) settings.finance = {};
        const list = new Set(settings.finance.industries || []);
        list.has(btn.dataset.ind) ? list.delete(btn.dataset.ind) : list.add(btn.dataset.ind);
        saveInputSetting('finance.industries', [...list]);
        renderSection('finance');
      });
    }
    if (section === 'performance') {
      document.getElementById('setting-sleep-minutes')?.addEventListener('change', (e) => saveInputSetting('performance.tabSleepMinutes', parseInt(e.target.value, 10)));

      // One host per line, blanks dropped — the stored shape is an array.
      document.getElementById('setting-never-sleep')?.addEventListener('change', (e) => {
        const list = e.target.value.split('\n').map(x => x.trim()).filter(Boolean);
        saveInputSetting('performance.neverSleep', list);
      });

      const showRestartNote = () => {
        const note = document.getElementById('perf-restart-note');
        if (note) note.style.display = 'block';
      };
      document.getElementById('setting-process-limit')?.addEventListener('change', (e) => {
        saveInputSetting('performance.processLimit', e.target.value);
        showRestartNote();
      });
      document.getElementById('toggle-hwaccel')?.addEventListener('click', showRestartNote);
      document.getElementById('perf-restart-btn')?.addEventListener('click', () => {
        window.localMind?.relaunchApp?.();
      });

      document.getElementById('free-memory-btn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const slept = TabManager.sleepInactiveTabs(true);
        let freed = 0;
        try { freed = (await window.localMind?.freeMemory?.())?.freedMB || 0; } catch {}
        btn.disabled = false;
        const parts = [];
        if (slept) parts.push(`${slept} tab${slept === 1 ? '' : 's'} slept`);
        if (freed) parts.push(`${freed} MB released`);
        window.localMind?.showNotification?.('Memory Saver',
          parts.length ? parts.join(', ') + '.' : 'Nothing left to free.');
        refreshPerfTable();
      });

      document.getElementById('sleep-now-btn')?.addEventListener('click', () => {
        const slept = TabManager.sleepInactiveTabs(true);
        if (window.localMind?.showNotification) {
          window.localMind.showNotification('Memory Saver', slept > 0 ? `Put ${slept} tab${slept === 1 ? '' : 's'} to sleep.` : 'No background tabs to sleep.');
        }
        refreshPerfTable();
      });

      // One listener for every row button, so rebuilding the table every two
      // seconds does not pile up handlers on elements that are about to be
      // replaced anyway.
      document.getElementById('perf-table')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-tab-id]');
        if (!btn) return;
        const id = btn.dataset.tabId;
        if (btn.dataset.act === 'sleep') TabManager.sleepTab(id);
        else if (btn.dataset.act === 'close') TabManager.closeTab(id);
        refreshPerfTable();
      });

      refreshPerfTable();
      perfInterval = setInterval(refreshPerfTable, 2000);
    }
    if (section === 'appearance') {
      wireAppearanceExtras();
      document.getElementById('setting-theme')?.addEventListener('change', (e) => saveInputSetting('appearance.theme', e.target.value));
      document.getElementById('setting-tab-layout')?.addEventListener('change', (e) => saveInputSetting('appearance.tabLayout', e.target.value));
      document.getElementById('setting-sidebar-mode')?.addEventListener('change', (e) => {
        saveInputSetting('appearance.sidebarMode', e.target.value);
        // Apply immediately: a layout preference you have to restart for is a
        // preference nobody trusts.
        Sidebar.applySidebarMode(e.target.value);
      });
      document.getElementById('setting-fontsize-preset')?.addEventListener('change', (e) => saveInputSetting('appearance.fontSizePreset', e.target.value));
      document.getElementById('setting-page-zoom')?.addEventListener('change', (e) => saveInputSetting('appearance.pageZoom', parseInt(e.target.value, 10)));
    }
  }

  /** Reflect whether Tor is installed and whether Onion Mode is open. */
  async function refreshOnionSection() {
    const status = document.getElementById('onion-status');
    const toggle = document.getElementById('toggle-onion');
    if (!status) return;

    let available = false;
    try { available = await window.localMind?.onionAvailable?.(); } catch {}

    if (!available) {
      // A missing binary is a setup step with a specific fix, not a failure.
      status.textContent = 'Tor is not installed yet. Run "npm run fetch-tor" once to download it.';
      toggle?.classList.add('disabled');
    } else {
      status.textContent = 'Ready. Turning this on opens the Onion window.';
      toggle?.classList.remove('disabled');
    }

    try { paintOnionLevel(await window.localMind?.onionLevel?.()); } catch {}
  }

  function paintOnionLevel(info) {
    if (!info?.level) return;
    const sel = document.getElementById('setting-onion-level');
    if (sel && sel.value !== info.level) sel.value = info.level;
    const desc = document.getElementById('onion-level-desc');
    const meta = info.levels?.[info.level];
    if (desc && meta) desc.textContent = meta.detail;
  }

  /**
   * The toggle opens the Onion window rather than flipping a stored preference:
   * Onion Mode is a place you go, not a mode the whole browser enters. Routing
   * ordinary browsing through Tor would be slow and would leak the identity you
   * are already signed in as everywhere.
   */
  async function toggleOnion(el) {
    if (el?.classList.contains('disabled')) return;
    const status = document.getElementById('onion-status');

    if (el?.classList.contains('active')) {
      try { await window.localMind?.onionClose?.(); } catch {}
      el.classList.remove('active');
      if (status) status.textContent = 'Onion Mode closed. Its data has been wiped.';
      return;
    }

    if (status) status.textContent = 'Starting Tor…';
    try {
      const res = await window.localMind?.onionOpen?.();
      if (res?.ok) {
        el?.classList.add('active');
      } else if (status) {
        status.textContent = res?.error || 'Onion Mode could not start.';
      }
    } catch (err) {
      if (status) status.textContent = err?.message || 'Onion Mode could not start.';
    }
  }

  function saveInputSetting(path, value) {
    const keys = path.split('.');
    let obj = settings;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    window.mindSettings = settings;
    if (window.localMind) {
      window.localMind.saveSettings(settings);
    }
    if (window.applyAppearanceSettings) window.applyAppearanceSettings(settings);
  }

  function stopPerfRefresh() {
    if (perfInterval) {
      clearInterval(perfInterval);
      perfInterval = null;
    }
  }

  function stopClockPreview() {
    if (clockPreviewInterval) {
      clearInterval(clockPreviewInterval);
      clockPreviewInterval = null;
    }
  }

  // iPod-style Cover Flow theme picker for the New Tab clock.
  function initClockCoverFlow() {
    const wrap = document.getElementById('clock-coverflow');
    if (!wrap || typeof ClockThemes === 'undefined') return;

    const track = wrap.querySelector('.cf-track');
    const nameEl = wrap.querySelector('.cf-name');
    const dotsEl = wrap.querySelector('.cf-dots');
    const themes = ClockThemes.THEMES;

    const current = settings.widgets?.clock?.theme
      || (settings.widgets?.clock?.appearance === 'digital' ? 'digital' : 'minimal');
    let selected = Math.max(0, themes.findIndex(t => t.id === current));

    // Build one card (with a live preview clock) per theme
    track.innerHTML = '';
    dotsEl.innerHTML = '';
    themes.forEach((theme, i) => {
      const card = document.createElement('div');
      card.className = 'cf-card';
      card.dataset.index = i;
      const preview = document.createElement('div');
      preview.className = 'cf-preview';
      card.appendChild(preview);
      ClockThemes.mount(preview, theme.id, 0.82);
      card.addEventListener('click', () => select(i));
      track.appendChild(card);

      const dot = document.createElement('button');
      dot.className = 'cf-dot';
      dot.addEventListener('click', () => select(i));
      dotsEl.appendChild(dot);
    });

    const cards = [...track.querySelectorAll('.cf-card')];
    const dots = [...dotsEl.querySelectorAll('.cf-dot')];

    function layout() {
      cards.forEach((card, i) => {
        const off = i - selected;
        const abs = Math.abs(off);
        let x, rot, scale, z, op;
        if (off === 0) {
          x = 0; rot = 0; scale = 1; z = 100; op = 1;
        } else {
          const dir = off > 0 ? 1 : -1;
          x = dir * (96 + (abs - 1) * 58);
          rot = dir * -48;
          scale = 0.74;
          z = 50 - abs;
          op = abs > 2 ? 0 : 0.9;
        }
        card.style.transform = `translateX(-50%) translateX(${x}px) rotateY(${rot}deg) scale(${scale})`;
        card.style.zIndex = z;
        card.style.opacity = op;
        card.style.pointerEvents = abs > 2 ? 'none' : 'auto';
        card.classList.toggle('active', off === 0);
      });
      dots.forEach((d, i) => d.classList.toggle('active', i === selected));
      nameEl.textContent = themes[selected].name;
    }

    function select(i) {
      selected = Math.max(0, Math.min(themes.length - 1, i));
      layout();
      saveInputSetting('widgets.clock.theme', themes[selected].id);
      // Refresh the live New Tab clock directly (and via the bus as a backup)
      if (typeof NewTabPage !== 'undefined') NewTabPage.refreshClock();
      EventBus.emit('clock-theme-changed');
    }

    wrap.querySelector('.cf-prev').onclick = () => select(selected - 1);
    wrap.querySelector('.cf-next').onclick = () => select(selected + 1);
    wrap.onwheel = (e) => {
      e.preventDefault();
      select(selected + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1));
    };

    layout();

    // Tick every live preview clock together
    stopClockPreview();
    const previews = [...track.querySelectorAll('.cf-preview')];
    const tickAll = () => { const now = new Date(); previews.forEach(p => ClockThemes.tick(p, now)); };
    tickAll();
    clockPreviewInterval = setInterval(tickAll, 1000);
  }

  async function refreshPerfTable() {
    const table = document.getElementById('perf-table');
    if (!table) { stopPerfRefresh(); return; }

    const tabs = TabManager.getAllTabs();
    const activeTab = TabManager.getActiveTab();

    // Collect each live tab's webContents id
    const rows = tabs.map(t => {
      let wcId = null;
      try { wcId = t.webview?.getWebContentsId?.() ?? null; } catch {}
      return { tab: t, wcId };
    });

    // Ask the main process for per-process metrics
    let metrics = { tabs: {}, total: null };
    if (window.localMind?.getTabMetrics) {
      try {
        metrics = await window.localMind.getTabMetrics(rows.map(r => r.wcId).filter(id => id !== null));
      } catch {}
    }

    const totalEl = document.getElementById('perf-total');
    if (totalEl) {
      const t = metrics.total;
      totalEl.textContent = t
        ? `${t.memoryMB} MB total · ${t.tabsMB} MB in tabs · ${t.overheadMB} MB browser itself · ${t.processCount} processes · CPU ${t.cpu}%`
        : 'Metrics available when running the desktop app';
    }

    const barColor = (mb) => mb > 500 ? 'var(--error)' : mb > 200 ? 'var(--warning)' : 'var(--accent)';
    const maxMB = Math.max(100, ...rows.map(r => metrics.tabs[r.wcId]?.memoryMB || 0));

    // Heaviest first — the point of the list is finding what to close.
    rows.sort((a, b) => (metrics.tabs[b.wcId]?.memoryMB || -1) - (metrics.tabs[a.wcId]?.memoryMB || -1));

    const perf = window.mindSettings?.performance || {};

    table.innerHTML = rows.map(({ tab, wcId }) => {
      const m = wcId !== null ? metrics.tabs[wcId] : null;
      const isActive = tab.id === activeTab?.id;
      const exempt = TabManager.isSleepExempt?.(tab.url, perf);
      const state = tab.sleeping ? '💤 Sleeping' : isActive ? 'Active' : 'Background';
      const stateColor = tab.sleeping ? 'var(--text-tertiary)' : isActive ? 'var(--accent)' : 'var(--text-secondary)';
      const memText = tab.sleeping ? '0 MB' : m ? `${m.memoryMB} MB` : '—';
      const cpuText = tab.sleeping ? '' : m ? `CPU ${m.cpu}%` : '';
      const barWidth = tab.sleeping || !m ? 0 : Math.round((m.memoryMB / maxMB) * 100);

      // Say so when a figure is one tab's share of a process it does not own.
      const note = [];
      if (m?.sharedWith) note.push(`share of a process held with ${m.sharedWith} other tab${m.sharedWith === 1 ? '' : 's'} (${m.processMB} MB total)`);
      if (exempt) note.push('never sleeps');

      const canSleep = !tab.sleeping && !isActive && !exempt;

      return `
        <div style="padding:10px 12px;margin-bottom:6px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:var(--radius-md);">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="flex:1;font-size:13px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(truncate(tab.title || tab.url || 'New Tab', 40))}</span>
            <span style="font-size:11px;color:${stateColor};flex-shrink:0;">${state}</span>
            <span style="font-size:12px;color:var(--text-secondary);min-width:64px;text-align:right;flex-shrink:0;">${memText}</span>
            <span style="font-size:11px;color:var(--text-tertiary);min-width:64px;text-align:right;flex-shrink:0;">${cpuText}</span>
            <button class="settings-btn secondary" data-tab-id="${escapeHtml(String(tab.id))}" data-act="sleep"
              style="font-size:11px;padding:3px 8px;flex-shrink:0;" ${canSleep ? '' : 'disabled'}>Sleep</button>
            <button class="settings-btn secondary" data-tab-id="${escapeHtml(String(tab.id))}" data-act="close"
              style="font-size:11px;padding:3px 8px;flex-shrink:0;">Close</button>
          </div>
          ${note.length ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:6px;">${escapeHtml(note.join(' · '))}</div>` : ''}
          <div style="height:3px;background:var(--bg-secondary);border-radius:2px;margin-top:8px;overflow:hidden;">
            <div style="height:100%;width:${barWidth}%;background:${m ? barColor(m.memoryMB) : 'transparent'};border-radius:2px;transition:width 0.4s ease;"></div>
          </div>
        </div>
      `;
    }).join('') || '<div class="settings-row-desc">No open tabs.</div>';
  }

  async function loadMemoryStats() {
    if (!window.localMind || !window.localMind.getMemoryStats) return;
    const stats = await window.localMind.getMemoryStats();
    const el = document.getElementById('memory-count');
    if (el && stats) el.textContent = stats.total ?? 0;
  }

  async function checkOllamaStatus(targetId = 'ollama-status') {
    if (!window.localMind) return;
    const result = await window.localMind.checkOllama();
    const el = document.getElementById(targetId);
    if (el) {
      el.innerHTML = result.connected
        ? `<span style="color:var(--success)">Connected (${result.models.length} models)</span>`
        : `<span style="color:var(--error)">Not connected — Is Ollama running?</span>`;
    }
  }

  async function loadApiKeys() {
    if (!window.localMind) return;
    const providers = ['openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'custom'];
    for (const p of providers) {
      const key = await window.localMind.getApiKey(p);
      const input = document.getElementById(`key-${p}`);
      if (input && key) {
        input.value = '•'.repeat(Math.min(key.length, 20));
        input.dataset.hasKey = 'true';
      }
    }
  }

  /**
   * The custom endpoint's URL and manual model list are settings, not keys, so
   * they save on edit rather than behind a button — there is nothing secret to
   * mask and no reason to make people press Save twice.
   */
  function wireCustomEndpoint() {
    const base = document.getElementById('custom-api-base');
    const models = document.getElementById('custom-models');
    const test = document.getElementById('custom-test');
    const out = document.getElementById('custom-test-result');
    if (!base) return;

    base.value = settings.customApiBase || '';
    models.value = settings.customModels || '';

    base.addEventListener('change', () => {
      settings.customApiBase = base.value.trim();
      window.localMind?.saveSettings?.(settings);
    });
    models.addEventListener('change', () => {
      settings.customModels = models.value.trim();
      window.localMind?.saveSettings?.(settings);
    });

    test?.addEventListener('click', async () => {
      out.textContent = 'Checking…';
      out.style.color = 'var(--text-secondary)';
      // Save first: the user has probably just typed the URL and not blurred.
      settings.customApiBase = base.value.trim();
      settings.customModels = models.value.trim();
      await window.localMind?.saveSettings?.(settings);

      const res = await window.localMind.testCustomEndpoint();
      if (res?.ok) {
        out.style.color = 'var(--success)';
        out.textContent = `Reachable — ${res.count} model${res.count === 1 ? '' : 's'} at ${res.base}`;
        // Bring the new models into the picker straight away.
        EventBus.emit('models-changed');
      } else {
        out.style.color = 'var(--error)';
        out.textContent = res?.error || 'Could not reach that endpoint.';
      }
    });
  }

  /** Voice picker for read-aloud, shared by the reader and the AI panel. */
  /**
   * Accent, font, size and toolbar. Everything applies live — a colour picker
   * you have to press Save on is a colour picker you cannot actually judge.
   */
  /** Update status on the About page, plus a manual check. */
  function wireUpdates() {
    // Read the real version rather than a hardcoded one. It was pinned at
    // "1.0.0" while the app was on 2.4.0 — harmless until updates go live, at
    // which point the number people report is the number that matters.
    window.localMind?.getAppVersion?.()
      .then((v) => {
        if (!v) return;
        // Only the footer here. The About line itself is written by
        // loadAboutInfo, which also knows the architecture — setting it here
        // as well raced it and won, dropping the "Apple Silicon" half.
        const foot = document.getElementById('settings-version');
        if (foot) foot.textContent = `Mind Browser v${v}`;
      })
      .catch(() => {});

    const out = document.getElementById('about-update');
    const btn = document.getElementById('about-update-btn');
    if (!out || !window.localMind?.updateState) return;

    const paint = (st) => {
      if (!st) return;
      const map = {
        dev: 'Updates are disabled in a development build.',
        unconfigured: 'No update channel is set up yet for this build.',
        idle: 'Ready to check.',
        checking: 'Checking for updates…',
        current: 'You are on the latest version.',
        downloading: st.percent != null
          ? `Downloading ${st.version || 'update'}… ${st.percent}%`
          : `Downloading ${st.version || 'update'}…`,
        ready: `Version ${st.version} is ready — restart to finish.`,
        error: st.error || 'Could not check for updates.'
      };
      out.textContent = map[st.status] || '';
      out.style.color = st.status === 'ready' ? 'var(--accent)'
        : st.status === 'error' ? 'var(--error)' : 'var(--text-tertiary)';
      btn.textContent = st.status === 'ready' ? 'Restart now' : 'Check for updates';
      btn.onclick = st.status === 'ready'
        ? () => window.localMind.installUpdate()
        : () => window.localMind.checkForUpdate().then(paint);
    };

    window.localMind.updateState().then(paint);
    window.localMind.onUpdateState?.(paint);
  }

  function wireAppearanceExtras() {
    if (typeof Appearance === 'undefined') return;
    const a = settings.appearance || (settings.appearance = {});
    const save = () => {
      window.localMind?.saveSettings?.(settings);
      window.mindSettings = settings;
      EventBus.emit('appearance-changed');
    };

    // ── Accent swatches ──────────────────────────────────────────────────────
    const host = document.getElementById('ap-swatches');
    const custom = document.getElementById('ap-accent-custom');
    if (host) {
      host.innerHTML = '';
      for (const [key, pal] of Object.entries(Appearance.PALETTES)) {
        const b = document.createElement('button');
        b.className = 'ap-swatch';
        b.type = 'button';
        b.style.background = pal.hex;
        b.title = pal.name;
        b.classList.toggle('on', (a.accent || '#2bd473').toLowerCase() === pal.hex.toLowerCase());
        b.addEventListener('click', () => {
          a.accent = pal.hex;
          if (custom) custom.value = pal.hex;
          host.querySelectorAll('.ap-swatch').forEach((x) => x.classList.toggle('on', x === b));
          Appearance.applyAccent(pal.hex);
          save();
        });
        host.appendChild(b);
      }
    }
    custom?.addEventListener('input', () => {
      a.accent = custom.value;
      host?.querySelectorAll('.ap-swatch').forEach((x) => x.classList.remove('on'));
      Appearance.applyAccent(custom.value);
    });
    // Persist on release rather than on every pixel of the picker's drag.
    custom?.addEventListener('change', save);

    // ── Font and size ────────────────────────────────────────────────────────
    const font = document.getElementById('ap-font');
    if (font) {
      font.innerHTML = '';
      for (const [key, f] of Object.entries(Appearance.FONTS)) {
        font.appendChild(new Option(f.name, key));
      }
      font.value = a.font || 'system';
      font.addEventListener('change', () => { a.font = font.value; save(); });
    }

    const size = document.getElementById('ap-size');
    if (size) {
      size.innerHTML = '';
      for (const key of Object.keys(Appearance.SIZES)) {
        size.appendChild(new Option(key.charAt(0).toUpperCase() + key.slice(1), key));
      }
      size.value = a.uiSize || 'normal';
      size.addEventListener('change', () => { a.uiSize = size.value; save(); });
    }

    // ── Toolbar items ────────────────────────────────────────────────────────
    const bar = document.getElementById('ap-toolbar');
    if (bar) {
      bar.innerHTML = '';
      a.toolbar = a.toolbar || {};
      for (const [id, meta] of Object.entries(Appearance.ITEMS)) {
        const on = a.toolbar[id] ?? meta.defaultOn;
        const row = document.createElement('div');
        row.className = 'settings-row';
        row.innerHTML = `
          <div>
            <div class="settings-row-label"></div>
            <div class="settings-row-desc"></div>
          </div>
          <div class="settings-toggle${on ? ' active' : ''}"></div>`;
        row.querySelector('.settings-row-label').textContent = meta.label;
        row.querySelector('.settings-row-desc').textContent = meta.hint || '';
        const toggle = row.querySelector('.settings-toggle');
        toggle.addEventListener('click', () => {
          const next = !toggle.classList.contains('active');
          toggle.classList.toggle('active', next);
          a.toolbar[id] = next;
          save();
        });
        bar.appendChild(row);
      }
    }
  }

  function wireSpeech() {
    const sel = document.getElementById('speech-voice');
    if (!sel || typeof Speech === 'undefined') return;

    const rate = document.getElementById('speech-rate');
    const pitch = document.getElementById('speech-pitch');
    const rateVal = document.getElementById('speech-rate-val');
    const pitchVal = document.getElementById('speech-pitch-val');

    function fill() {
      const p = Speech.prefs();
      const voices = Speech.list();
      sel.innerHTML = '';
      sel.appendChild(new Option('System default', ''));
      for (const v of voices) {
        sel.appendChild(new Option(`${v.name} — ${v.lang}`, v.voiceURI));
      }
      sel.value = p.voiceURI || '';
      rate.value = String(p.rate ?? 1);
      pitch.value = String(p.pitch ?? 1);
      rateVal.textContent = `${Number(rate.value).toFixed(2)}×`;
      pitchVal.textContent = Number(pitch.value).toFixed(2);
    }
    fill();
    // The voice list arrives asynchronously in Chromium and is usually empty
    // on the first call, so refill once it lands.
    try { speechSynthesis.addEventListener('voiceschanged', fill, { once: true }); } catch {}

    sel.addEventListener('change', () => Speech.setPrefs({ voiceURI: sel.value }));
    rate.addEventListener('input', () => {
      rateVal.textContent = `${Number(rate.value).toFixed(2)}×`;
      Speech.setPrefs({ rate: Number(rate.value) });
    });
    pitch.addEventListener('input', () => {
      pitchVal.textContent = Number(pitch.value).toFixed(2);
      Speech.setPrefs({ pitch: Number(pitch.value) });
    });
    document.getElementById('speech-test')?.addEventListener('click', () => {
      Speech.speak('This is how pages and answers will sound when read aloud.');
    });
  }

  async function saveKey(provider) {
    const input = document.getElementById(`key-${provider}`);
    if (!input || !window.localMind) return;
    const key = input.value.trim();
    if (key && !key.startsWith('•')) {
      await window.localMind.saveApiKey(provider, key);
      input.value = '•'.repeat(Math.min(key.length, 20));
      input.dataset.hasKey = 'true';
    }
  }

  // ── Privacy controls ───────────────────────────────────────────────────────

  function persistPrivacy() {
    window.mindSettings = settings;
    window.localMind?.saveSettings(settings);
  }

  function setPrivacyLevel(value) {
    const level = Number(value);
    settings.privacy = settings.privacy || {};
    settings.privacy.level = level;
    // Moving the slider is a fresh start: keeping old overrides would leave the
    // page claiming a level it is not actually applying.
    settings.privacy.overrides = {};
    persistPrivacy();
    renderSection('privacy');
  }

  function togglePrivacyControl(key, element) {
    const { flags } = effectivePrivacy();
    const next = !flags[key];
    settings.privacy = settings.privacy || {};
    settings.privacy.overrides = { ...(settings.privacy.overrides || {}), [key]: next };
    persistPrivacy();
    element.classList.toggle('active', next);
    // Re-render so the header count and the Custom badge stay truthful.
    renderSection('privacy');
  }

  function resetPrivacyOverrides() {
    settings.privacy = settings.privacy || {};
    settings.privacy.overrides = {};
    persistPrivacy();
    renderSection('privacy');
  }

  function toggleSetting(path, element) {
    const keys = path.split('.');
    let obj = settings;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    const lastKey = keys[keys.length - 1];
    obj[lastKey] = !obj[lastKey];
    element.classList.toggle('active', obj[lastKey]);

    // Save settings
    window.mindSettings = settings;
    if (window.localMind) {
      window.localMind.saveSettings(settings);
    }
    if (window.applyAppearanceSettings) window.applyAppearanceSettings(settings);
  }
  async function importBrowserData(browser) {
    const label = { chrome: 'Chrome', safari: 'Safari', edge: 'Edge', arc: 'Arc', zen: 'Zen' }[browser] || browser;
    const status = document.getElementById('import-status');
    if (status) status.textContent = `Importing from ${label}...`;

    try {
      if (window.localMind && window.localMind.importBrowserData) {
        const result = await window.localMind.importBrowserData(browser);
        if (result && result.bookmarks && result.bookmarks.length > 0) {
          // Persist into our own bookmark store (folders preserved, de-duped)
          await Bookmarks.addMany(result.tree || result.bookmarks.map(b => ({ type: 'link', title: b.title, url: b.url })));
          if (status) status.innerHTML = `<span style="color:var(--success)">Imported ${result.bookmarks.length} bookmarks from ${label}.</span>`;
        } else {
          const why = result?.reason || `No bookmarks found. Is ${label} installed?`;
          if (status) status.innerHTML = `<span style="color:var(--warning)">${escapeHtml(why)}</span>`;
        }
      } else {
        // Fallback: read directly if IPC not available (dev mode)
        if (status) status.innerHTML = `<span style="color:var(--warning)">Import requires the packaged app. Run via npm start.</span>`;
      }
    } catch (err) {
      if (status) status.innerHTML = `<span style="color:var(--error)">Import failed: ${err.message || err}</span>`;
    }
  }

  return { init, open, close, saveKey, toggleSetting, setPrivacyLevel, togglePrivacyControl, resetPrivacyOverrides, toggleOnion };
})();
