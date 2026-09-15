// =============================================================================
// Local Mind Browser — AI Side Panel Controller
// =============================================================================
// Manages the right AI panel: chat, page mode, agent mode, research, compare.

const AiPanel = (() => {
  let isVisible = true;
  let currentModel = '';
  let messages = [];
  let isStreaming = false;
  let currentResponse = '';
  let currentChatId = null;    // Persisted chat id (assigned on first save)
  let pendingAttachment = null; // { name, content } from the attach button
  let recognition = null;      // SpeechRecognition instance while listening

  function init() {
    // Close panel button
    document.getElementById('close-ai-panel')?.addEventListener('click', toggle);

    // Toggle from top bar
    document.getElementById('btn-ai-toggle')?.addEventListener('click', toggle);

    // Send button
    // The markup uses id="send-btn"; binding only to "ai-send-btn" meant the
    // send button was never wired (optional chaining hid the mismatch). Bind
    // whichever exists so a future rename can't silently break it again.
    ['send-btn', 'ai-send-btn'].forEach((id) => {
      document.getElementById(id)?.addEventListener('click', sendMessage);
    });

    // Input: Enter to send, Shift+Enter for newline
    const input = document.getElementById('ai-input');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      // Auto-resize textarea
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      });
    }

    // Attach file button
    const attachInput = document.createElement('input');
    attachInput.type = 'file';
    attachInput.accept = '.txt,.md,.markdown,.json,.csv,.log,.js,.ts,.py,.html,.css,.xml,.yaml,.yml';
    attachInput.style.display = 'none';
    document.body.appendChild(attachInput);
    attachInput.addEventListener('change', () => {
      const file = attachInput.files[0];
      attachInput.value = '';
      if (file) attachFile(file);
    });
    document.querySelector('.ai-attach-btn')?.addEventListener('click', () => attachInput.click());

    // New chat
    document.getElementById('ai-new-chat')?.addEventListener('click', () => {
      newChat();
      AgentMonitor.clear();
    });

    // Past conversations
    document.getElementById('ai-history-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHistory();
    });

    // Agent-mode toggle
    document.getElementById('ai-agent-toggle')?.addEventListener('click', toggleMode);

    // Voice input button
    document.getElementById('voice-btn')?.addEventListener('click', toggleVoiceInput);

    // Model selector
    const modelSelect = document.getElementById('model-select');
    if (modelSelect) {
      modelSelect.addEventListener('change', (e) => {
        if (e.target.value === '__advanced__') {
          e.target.value = currentModel || 'gemini-2.5-pro';
          try { Settings.open('models'); } catch {}
          return;
        }
        currentModel = e.target.value;
        const s = window.mindSettings;
        if (s) { s.models = s.models || {}; s.models.chatModel = currentModel;
                 window.localMind?.saveSettings?.(s); }
      });
    }

    // Listen for chat tokens from main process
    if (window.localMind) {
      window.localMind.onChatToken((token) => {
        currentResponse += token;
        updateStreamingMessage(currentResponse);
      });

      window.localMind.onChatDone((result) => {
        isStreaming = false;
        finishStreamingMessage(result);
      });

      window.localMind.onChatError((error) => {
        isStreaming = false;
        appendMessage('assistant', `Error: ${error}`, 'error');
        hideTypingIndicator();
      });

      // Load models
      loadModels();

      // Live memory count
      refreshMemoryIndicator();
    }

    // Listen for @commands from address bar
    EventBus.on('ai-command', handleAiCommand);

    // Hover-to-reveal rail
    initPeek();
    applyHoverMode();
    EventBus.on('tab-activated', () => refreshSuggestions());
    setTimeout(refreshSuggestions, 1500);
  }

  // ── File Attachment ──

  const MAX_ATTACHMENT_BYTES = 200 * 1024;

  function attachFile(file) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      window.localMind?.showNotification?.('File too large', 'Attachments are limited to 200 KB of text.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingAttachment = { name: file.name, content: String(reader.result) };
      renderAttachmentChip();
    };
    reader.onerror = () => {
      window.localMind?.showNotification?.('Attach failed', `Could not read ${file.name}.`);
    };
    reader.readAsText(file);
  }

  function renderAttachmentChip() {
    document.getElementById('attachment-chip')?.remove();
    if (!pendingAttachment) return;

    const inputArea = document.querySelector('.ai-input-area');
    if (!inputArea) return;

    const chip = document.createElement('div');
    chip.id = 'attachment-chip';
    chip.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:6px 10px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:var(--radius-md);font-size:12px;color:var(--text-secondary);';
    chip.innerHTML = `
      <span>📎</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(pendingAttachment.name)}</span>
      <button id="attachment-remove" style="background:none;border:none;color:var(--text-tertiary);cursor:pointer;font-size:14px;line-height:1;">×</button>
    `;
    chip.querySelector('#attachment-remove').addEventListener('click', () => {
      pendingAttachment = null;
      chip.remove();
    });
    inputArea.insertBefore(chip, inputArea.firstChild);
  }

  // ── Voice Input ──

  function toggleVoiceInput() {
    const btn = document.getElementById('voice-btn');

    // Already listening → stop
    if (recognition) {
      recognition.stop();
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      window.localMind?.showNotification?.('Voice input unavailable', 'Speech recognition is not supported on this system.');
      return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;

    const input = document.getElementById('ai-input');
    const baseText = input ? input.value : '';

    recognition.onresult = (e) => {
      const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
      if (input) input.value = (baseText ? baseText + ' ' : '') + transcript;
    };
    recognition.onerror = (e) => {
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        window.localMind?.showNotification?.('Voice input failed', 'Speech recognition is not available (it requires network speech services).');
      }
    };
    recognition.onend = () => {
      recognition = null;
      btn?.classList.remove('listening');
    };

    try {
      recognition.start();
      btn?.classList.add('listening');
    } catch {
      recognition = null;
      btn?.classList.remove('listening');
    }
  }

  // ── Memory Indicator ──

  async function refreshMemoryIndicator() {
    if (!window.localMind?.getMemoryStats) return;
    try {
      const stats = await window.localMind.getMemoryStats();
      const el = document.getElementById('memory-indicator-text');
      if (el && stats) {
        el.textContent = `Memory active · ${stats.total ?? 0} item${stats.total === 1 ? '' : 's'} stored`;
      }
    } catch { /* backend unavailable */ }
  }

  // Hover-to-reveal on the AI panel mirrors the sidebar: when enabled, closing
  // the panel leaves a thin rail on the right edge that expands on hover, rather
  // than hiding it entirely. Controlled by appearance.aiPanelHover (default on).
  const hoverModeOn = () => window.mindSettings?.appearance?.aiPanelHover !== false;

  function toggle() {
    const body = document.body;
    const panel = document.getElementById('ai-panel');

    // Decide from the DOM, not from a cached flag: `isVisible` could drift out
    // of sync with the classes (peek, rail, hidden), and when it did the click
    // produced no visible change at all — the button looked dead.
    const showing = !body.classList.contains('ai-panel-hidden')
                 && !body.classList.contains('ai-panel-rail');

    // Always start from a clean slate so no leftover state can win.
    body.classList.remove('ai-panel-hidden', 'ai-panel-rail');
    panel?.classList.remove('peek');

    if (showing) {
      // Closing: park it on the hover rail if enabled, else hide outright.
      body.classList.add(hoverModeOn() ? 'ai-panel-rail' : 'ai-panel-hidden');
      isVisible = false;
    } else {
      isVisible = true;               // opening: pinned open
    }

    document.getElementById('btn-ai-toggle')?.classList.toggle('active', isVisible);
  }

  // Reconcile the panel with the current setting (called on load and whenever
  // the toggle in Settings flips).
  function applyHoverMode() {
    const body = document.body;
    const panel = document.getElementById('ai-panel');
    if (hoverModeOn()) {
      // A hidden panel becomes a hoverable rail instead of vanishing.
      if (body.classList.contains('ai-panel-hidden')) {
        body.classList.remove('ai-panel-hidden');
        body.classList.add('ai-panel-rail');
        isVisible = false;
      }
    } else {
      // Turning hover off: a railed panel folds away completely.
      panel?.classList.remove('peek');
      if (body.classList.contains('ai-panel-rail')) {
        body.classList.remove('ai-panel-rail');
        body.classList.add('ai-panel-hidden');
        isVisible = false;
      }
    }
    const btn = document.getElementById('btn-ai-toggle');
    if (btn) btn.classList.toggle('active', isVisible);
  }

  // Auto-hidden mode: the panel takes no space at all (no rail). Pushing the
  // cursor into the thin hot zone at the right screen edge slides the full,
  // opaque panel in; leaving it slides it back out.
  function initPeek() {
    const panel = document.getElementById('ai-panel');
    const zone = document.getElementById('ai-hotzone');
    if (!panel) return;
    let closeTimer = null;

    const railed = () => document.body.classList.contains('ai-panel-rail');
    const open = () => {
      if (!railed()) return;
      clearTimeout(closeTimer);
      panel.classList.add('peek');
    };
    const close = () => {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => panel.classList.remove('peek'), 140);
    };

    zone?.addEventListener('mouseenter', open);
    // Staying inside the panel keeps it open; leaving it closes.
    panel.addEventListener('mouseenter', () => { open(); refreshSuggestions(); });
    panel.addEventListener('mousemove', open);
    panel.addEventListener('mouseleave', close);
    window.addEventListener('blur', () => panel.classList.remove('peek'));

    // Belt-and-braces: some pointer paths (fast flicks, webview boundaries)
    // don't fire mouseenter on the zone, so watch the coordinate directly.
    document.addEventListener('mousemove', (e) => {
      if (!railed()) return;
      if (e.clientX >= window.innerWidth - 3) open();
    });
  }



  // ── Agent mode ─────────────────────────────────────────────────────────────
  // Chat answers from the model's own knowledge; Agent actually goes and does
  // the work with tools (search, read pages, quotes, clicking) before answering.
  let agentMode = false;

  function setMode(mode) {
    agentMode = mode === 'agent';
    const btn = document.getElementById('ai-agent-toggle');
    btn?.classList.toggle('active', agentMode);
    const input = document.getElementById('ai-input');
    if (input) {
      input.placeholder = agentMode
        ? 'Give the agent a task — it will browse and research…'
        : 'Ask Mind Browser anything...';
    }
    if (agentMode && !isVisible) toggle();
  }

  const toggleMode = () => setMode(agentMode ? 'chat' : 'agent');

  async function runAgentTask(task) {
    isStreaming = true;
    AgentMonitor.clear();
    AgentMonitor.begin(task);

    const model = resolveModel();
    // Carry the conversation into the run — without it, follow-ups like
    // "write them in a doc" or "do again" have no idea what they refer to.
    let ctx = {
      history: messages.slice(-10).map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))
    };
    try {
      const tab = TabManager.getActiveTab?.();
      if (tab?.url && tab.webview) {
        ctx.url = tab.url;
        ctx.pageContent = await tab.webview.executeJavaScript(
          '(document.body ? document.body.innerText : "").slice(0, 4000)', true
        ).catch(() => '');
      }
    } catch { /* no page context available */ }

    let res;
    try {
      res = await window.localMind.runAgent(task, model, ctx);
    } catch (err) {
      res = { success: false, error: err?.message || 'agent failed' };
    }

    isStreaming = false;
    AgentMonitor.finish(res?.success);

    const answer = res?.success
      ? (res.answer || 'Task complete.')
      : `**Agent stopped:** ${res?.error || 'unknown error'}`;
    // appendMessage already pushes onto `messages` — pushing again stored every
    // agent answer twice, so each follow-up shipped the whole reply to the model
    // a second time and burned context for nothing.
    appendMessage('assistant', answer);
    persistChat();
  }

  /**
   * The model to actually call. `currentModel` is only set when the user
   * *changes* the dropdown, so falling back to a hardcoded local model sent
   * requests to Ollama on localhost — which, when it isn't running, surfaces
   * as a bare "fetch failed". Read the selector's current value instead.
   */
  function resolveModel() {
    const sel = document.getElementById('model-select');
    return currentModel || sel?.value || 'gemini-2.5-flash';
  }


  // ── Context awareness ──────────────────────────────────────────────────────
  // When the panel is revealed, look at what the user is actually doing and
  // offer actions for THIS page, instead of a generic empty state.
  let lastCtxUrl = '';

  async function refreshSuggestions() {
    const empty = document.querySelector('.ai-empty-state');
    if (!empty || messages.length) return;
    const tab = TabManager.getActiveTab?.();
    const url = tab?.url || '';
    if (!url || url === lastCtxUrl) return;
    lastCtxUrl = url;

    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    const title = tab?.title || host;
    const video = /youtube\.com|vimeo|netflix|twitch/.test(url);

    const ideas = video
      ? ['Summarise this video', 'Key takeaways with timestamps', 'Find related sources on this topic']
      : ['Summarise this page', 'Explain the key points simply', 'Find what other sources say about this'];

    let box = document.getElementById('ai-suggestions');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ai-suggestions';
      empty.appendChild(box);
    }
    box.innerHTML = `<div class="ai-sug-ctx">Looking at <b>${escapeHtml(title).slice(0, 60)}</b></div>`;
    ideas.forEach((t) => {
      const chip = document.createElement('button');
      chip.className = 'ai-sug';
      chip.textContent = t;
      chip.addEventListener('click', () => {
        const input = document.getElementById('ai-input');
        if (input) { input.value = t; sendMessage(); }
      });
      box.appendChild(chip);
    });
  }

  async function sendMessage() {
    const input = document.getElementById('ai-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text || isStreaming) return;

    // Clear input
    input.value = '';
    input.style.height = 'auto';

    // Everything runs through the agent. It decides for itself whether a task
    // needs tools (search/read/browse) or can just be answered — so the user
    // never has to pick a mode, and it can't invent facts it should look up.
    document.querySelector('.ai-empty-state')?.style.setProperty('display', 'none');
    appendMessage('user', text);        // this already records it in `messages`
    await runAgentTask(text);
    return;

    // Hide empty state
    const emptyState = document.querySelector('.ai-empty-state');
    if (emptyState) emptyState.style.display = 'none';

    // Fold in any attached file
    let content = text;
    if (pendingAttachment) {
      content += `\n\n[Attached file: ${pendingAttachment.name}]\n\`\`\`\n${pendingAttachment.content}\n\`\`\``;
      appendMessage('user', `${text}\n📎 ${pendingAttachment.name}`);
      messages[messages.length - 1].content = content; // API gets the full file
      pendingAttachment = null;
      document.getElementById('attachment-chip')?.remove();
    } else {
      appendMessage('user', text);
    }

    // Build messages array for the API
    const systemPrompt = await getSystemPrompt();
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    // Start streaming
    isStreaming = true;
    currentResponse = '';
    showTypingIndicator();

    const model = resolveModel();

    if (window.localMind) {
      await window.localMind.chat(apiMessages, model, {});
    }
  }

  async function getSystemPrompt() {
    let basePrompt = 'You are Mind Browser Agent, a highly capable autonomous assistant built into an intelligent web browser. ' +
           'You have the ability to read web pages, browse multiple tabs, search the local file system (for things like resumes, images, and documents), and deploy sub-agents for complex tasks. ' +
           'Analyze the user\'s request and automatically determine the best approach. ' +
           'If the user asks you to apply for a job, find their resume on their laptop. If they want to research, open tabs and read. ' +
           'Always render substantial outputs (code, reports, resumes) inside beautiful Artifact markdown blocks (use ```...```).';

    try {
      const activeTab = window.TabManager ? TabManager.getActiveTab() : null;
      if (activeTab && activeTab.webview) {
        const pageText = await activeTab.webview.executeJavaScript('document.body.innerText');
        const pageTitle = await activeTab.webview.executeJavaScript('document.title');
        const truncatedText = pageText ? pageText.slice(0, 15000) : '';
        basePrompt += `\n\n--- CURRENT PAGE CONTEXT ---\nURL: ${activeTab.url}\nTitle: ${pageTitle}\nContent:\n${truncatedText}\n----------------------------`;
      }
    } catch (err) {
      console.warn("Failed to extract page context for AI:", err);
    }

    return basePrompt;
  }

  function appendMessage(role, content, type = 'text') {
    messages.push({ role, content, type, timestamp: new Date().toISOString() });
    renderMessage(role, content, type, messages.length - 1);
  }

  function renderMessage(role, content, type, index = messages.length - 1) {
    const container = document.getElementById('chat-container');
    if (!container) return;

    const msgEl = document.createElement('div');
    msgEl.className = `chat-message ${role} animate-fadeSlideUp`;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (role === 'assistant') {
      bubble.innerHTML = renderMarkdown(content);
    } else {
      bubble.textContent = content;
    }

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = formatRelativeDate(new Date().toISOString());

    msgEl.appendChild(bubble);
    msgEl.appendChild(meta);
    if (role === 'assistant') msgEl.appendChild(answerActions(content, index));
    container.appendChild(msgEl);

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  /**
   * Copy / retry under an assistant reply. Answers are the thing people
   * actually want out of the panel, and until now there was no way to get one
   * out of it short of selecting the text by hand.
   */
  function answerActions(content, index) {
    const bar = document.createElement('div');
    bar.className = 'answer-actions';

    const copy = document.createElement('button');
    copy.className = 'answer-action';
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.title = 'Copy this answer as markdown';
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(content).then(() => {
        copy.textContent = 'Copied';
        copy.classList.add('ok');
        setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('ok'); }, 1600);
      });
    });
    bar.appendChild(copy);

    // Read the answer aloud. Same engine and same voice setting as the reader,
    // so the browser has one voice rather than two.
    if (Speech?.available?.()) {
      const listen = document.createElement('button');
      listen.className = 'answer-action';
      listen.type = 'button';
      listen.textContent = 'Listen';
      listen.title = 'Read this answer aloud';
      listen.addEventListener('click', () => {
        if (Speech.isSpeaking()) {
          Speech.stop();
          return;
        }
        Speech.speak(content, {
          onStateChange: (on) => {
            listen.textContent = on ? 'Stop' : 'Listen';
            listen.classList.toggle('ok', on);
          }
        });
      });
      bar.appendChild(listen);
    }

    // Retry re-runs the question that produced THIS answer. Searching back from
    // the reply's own index matters when a saved chat is reloaded: every bubble
    // renders at once, so "the most recent user message" would be the newest
    // question in the whole conversation for all of them.
    const asked = messages.slice(0, index).reverse().find((m) => m.role === 'user')?.content;
    if (asked) {
      const retry = document.createElement('button');
      retry.className = 'answer-action';
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.title = 'Run that question again';
      retry.addEventListener('click', () => {
        if (isStreaming) return;
        runAgentTask(String(asked));
      });
      bar.appendChild(retry);
    }

    return bar;
  }

  function showTypingIndicator() {
    const container = document.getElementById('chat-container');
    if (!container) return;

    // Remove any existing indicator
    hideTypingIndicator();

    const indicator = document.createElement('div');
    indicator.id = 'typing-indicator';
    indicator.className = 'chat-message assistant animate-fadeSlideUp';
    indicator.innerHTML = `
      <div class="message-bubble">
        <div class="typing-indicator">
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
        </div>
      </div>
    `;
    container.appendChild(indicator);
    container.scrollTop = container.scrollHeight;
  }

  function hideTypingIndicator() {
    document.getElementById('typing-indicator')?.remove();
  }

  function updateStreamingMessage(content) {
    hideTypingIndicator();

    let streamEl = document.getElementById('streaming-message');
    if (!streamEl) {
      streamEl = document.createElement('div');
      streamEl.id = 'streaming-message';
      streamEl.className = 'chat-message assistant animate-fadeSlideUp';
      streamEl.innerHTML = '<div class="message-bubble"></div>';
      document.getElementById('chat-container')?.appendChild(streamEl);
    }

    const bubble = streamEl.querySelector('.message-bubble');
    if (bubble) {
      bubble.innerHTML = renderMarkdown(content);
    }

    // Scroll to bottom
    const container = document.getElementById('chat-container');
    if (container) container.scrollTop = container.scrollHeight;
  }

  function finishStreamingMessage(result) {
    hideTypingIndicator();
    const streamEl = document.getElementById('streaming-message');
    if (streamEl) {
      streamEl.id = '';
      // Add meta
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      meta.textContent = 'Just now';
      streamEl.appendChild(meta);
    }

    if (result?.content) {
      messages.push({
        role: 'assistant',
        content: result.content,
        type: 'text',
        timestamp: new Date().toISOString()
      });
    }

    persistChat();
  }

  // Save the current conversation so it shows up in Recent Conversations
  async function persistChat() {
    if (!window.localMind?.saveChat || messages.length === 0) return;
    const firstUserMsg = messages.find(m => m.role === 'user');
    const chat = {
      id: currentChatId || undefined,
      title: truncate(firstUserMsg?.content || 'Untitled Chat', 60),
      date: new Date().toISOString(),
      model: currentModel,
      messages
    };
    try {
      const result = await window.localMind.saveChat(chat);
      if (result?.id) currentChatId = result.id;
      EventBus.emit('chat-saved');
    } catch { /* backend unavailable */ }
  }

  /** Restore a previously saved conversation into the panel. */
  function loadChat(chat) {
    if (!chat) return;
    currentChatId = chat.id || null;
    messages = chat.messages || [];

    // Show panel if hidden
    if (!isVisible) toggle();

    // Re-render all messages
    const container = document.getElementById('chat-container');
    if (container) {
      container.querySelectorAll('.chat-message, #agent-monitor').forEach(el => el.remove());
    }
    AgentMonitor.clear();          // a restored chat shouldn't inherit old runs
    const emptyState = document.querySelector('.ai-empty-state');
    if (emptyState) emptyState.style.display = messages.length ? 'none' : '';
    messages.forEach((m, n) => renderMessage(m.role, m.content, m.type || 'text', n));
  }

  // ── Past conversations ──────────────────────────────────────────────────────
  // A popover hung off the header button. Chats already persist via
  // getChatHistory/getChat; before this the only way back into one was the new
  // tab page, which meant leaving whatever you were reading.
  let historyEl = null;

  function closeHistory() {
    historyEl?.remove();
    historyEl = null;
    document.removeEventListener('click', onDocClickHistory);
    document.removeEventListener('keydown', onKeyHistory);
  }

  function onDocClickHistory(e) {
    if (historyEl && !historyEl.contains(e.target)) closeHistory();
  }
  function onKeyHistory(e) { if (e.key === 'Escape') closeHistory(); }

  function relDate(d) {
    const t = new Date(d).getTime();
    if (!t) return '';
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return days < 7 ? `${days}d ago` : new Date(t).toLocaleDateString();
  }

  async function toggleHistory() {
    if (historyEl) return closeHistory();

    const btn = document.getElementById('ai-history-btn');
    if (!btn) return;

    historyEl = document.createElement('div');
    historyEl.className = 'ai-history';
    historyEl.innerHTML = '<div class="ai-history-head">Past conversations</div><div class="ai-history-list"></div>';
    btn.parentElement.appendChild(historyEl);

    const list = historyEl.querySelector('.ai-history-list');
    let chats = [];
    try { chats = (await window.localMind?.getChatHistory?.()) || []; } catch { chats = []; }

    if (!chats.length) {
      list.innerHTML = '<div class="ai-history-empty">Nothing here yet. Conversations you have show up in this list.</div>';
    } else {
      chats.slice(0, 40).forEach((chat) => {
        const row = document.createElement('div');
        row.className = 'ai-history-row';
        const title = document.createElement('span');
        title.className = 'ai-history-title';
        title.textContent = chat.title || 'Untitled';
        const when = document.createElement('span');
        when.className = 'ai-history-date';
        when.textContent = relDate(chat.date);
        const del = document.createElement('button');
        del.className = 'ai-history-del';
        del.title = 'Delete conversation';
        del.textContent = '×';

        row.append(title, when, del);
        row.addEventListener('click', async () => {
          try {
            const full = await window.localMind?.getChat?.(chat.id);
            if (full) loadChat(full);
          } catch { /* leave the panel as it is */ }
          closeHistory();
        });
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          try { await window.localMind?.deleteChat?.(chat.id); } catch { /* ignore */ }
          row.remove();
          if (!list.children.length) {
            list.innerHTML = '<div class="ai-history-empty">Nothing here yet. Conversations you have show up in this list.</div>';
          }
        });
        list.appendChild(row);
      });
    }

    // defer so the click that opened it doesn't immediately close it
    setTimeout(() => {
      document.addEventListener('click', onDocClickHistory);
      document.addEventListener('keydown', onKeyHistory);
    }, 0);
  }

  /** Start a fresh conversation (new chat id). */
  function newChat() {
    currentChatId = null;
    messages = [];
    const container = document.getElementById('chat-container');
    if (container) {
      container.querySelectorAll('.chat-message, #agent-monitor').forEach(el => el.remove());
    }
    AgentMonitor.clear();          // and the agent run cards
    const emptyState = document.querySelector('.ai-empty-state');
    if (emptyState) emptyState.style.display = '';
  }

  function handleAiCommand(cmd) {
    // Show AI panel if hidden
    if (!isVisible) toggle();

    const input = document.getElementById('ai-input');
    if (input && cmd.query) {
      input.value = cmd.query;
      sendMessage();
    }
  }


  // Curated flagship models — the full catalogue lives in Settings → Models.
  // Showing every model from every provider made this unusable; these are the
  // three worth defaulting to per provider.
  const CURATED = {
    Gemini: [
      ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
      ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
      ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite']
    ],
    Groq: [
      ['groq:llama-3.3-70b-versatile', 'Llama 3.3 70B'],
      ['groq:llama-3.1-8b-instant', 'Llama 3.1 8B Instant'],
      ['groq:openai/gpt-oss-120b', 'GPT-OSS 120B']
    ],
    OpenRouter: [
      ['openrouter:anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5'],
      ['openrouter:openai/gpt-4o', 'GPT-4o'],
      ['openrouter:deepseek/deepseek-chat', 'DeepSeek Chat']
    ]
  };

  // Models served by the user's own endpoint. Fetched rather than hardcoded,
  // because only they know what their gateway or local runtime is serving.
  let customModels = [];
  async function refreshCustomModels() {
    try {
      const all = await window.localMind.getModels();
      customModels = all?.custom || [];
      renderCuratedModels();
    } catch { /* leave the curated list as it is */ }
  }

  /** Render the short list, plus a route into the full catalogue. */
  function renderCuratedModels() {
    const sel = document.getElementById('model-select');
    if (!sel) return;
    const favs = window.mindSettings?.models?.favorites || [];
    const keep = sel.value;
    sel.innerHTML = '';

    if (favs.length) {
      const g = document.createElement('optgroup');
      g.label = 'Favourites';
      favs.forEach((id) => g.appendChild(new Option(id.split(':').pop(), id)));
      sel.appendChild(g);
    }

    if (customModels.length) {
      const g = document.createElement('optgroup');
      g.label = 'Custom / local';
      customModels.forEach((id) => g.appendChild(new Option(id.replace(/^custom:/, ''), id)));
      sel.appendChild(g);
    }

    Object.entries(CURATED).forEach(([provider, models]) => {
      const g = document.createElement('optgroup');
      g.label = provider;
      models.forEach(([id, label]) => g.appendChild(new Option(label, id)));
      sel.appendChild(g);
    });

    sel.appendChild(new Option('Advanced models…', '__advanced__'));
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  EventBus.on('models-changed', () => refreshCustomModels());

  async function loadModels() {
    renderCuratedModels();
    refreshCustomModels();
    if (true) return;   // full catalogue now lives in Settings → Models
    try {
      const models = await window.localMind.getModels();
      const select = document.getElementById('model-select');
      if (!select) return;

      select.innerHTML = '';

      // Ollama models
      if (models.ollama && models.ollama.length > 0) {
        const group = document.createElement('optgroup');
        group.label = 'Ollama (Local)';
        models.ollama.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          group.appendChild(opt);
        });
        select.appendChild(group);
        if (!currentModel) currentModel = models.ollama[0];
      }

      // Cloud providers
      const cloudProviders = [
        { key: 'openai', label: 'OpenAI' },
        { key: 'anthropic', label: 'Anthropic' },
        { key: 'gemini', label: 'Gemini' },
        { key: 'groq', label: 'Groq' },
        { key: 'openrouter', label: 'OpenRouter' }
      ];

      for (const p of cloudProviders) {
        if (models[p.key] && models[p.key].length > 0) {
          const group = document.createElement('optgroup');
          group.label = p.label;
          models[p.key].forEach(m => {
            const opt = document.createElement('option');
            opt.value = (p.key === 'groq' || p.key === 'openrouter') ? `${p.key}:${m}` : m;
            opt.textContent = m;
            group.appendChild(opt);
          });
          select.appendChild(group);
        }
      }

      // Set current value
      if (currentModel) select.value = currentModel;
    } catch (err) {
      console.error('Failed to load models:', err);
    }
  }

  return { init, toggle, sendMessage, loadChat, newChat, refreshMemoryIndicator, applyHoverMode, setMode, toggleMode };
})();
