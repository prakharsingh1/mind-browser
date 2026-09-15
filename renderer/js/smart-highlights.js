// =============================================================================
// Local Mind Browser — Smart Highlights
// =============================================================================
// Highlights text on pages with AI-powered annotations and explanations.

const SmartHighlights = (() => {
  let highlights = [];

  function init() {
    // Listen for text selection events from webview
    EventBus.on('webview:text-selected', handleTextSelection);
  }

  function handleTextSelection(data) {
    const { tabId, data: selData } = data;
    if (!selData || !selData.text || selData.text.length < 10) return;

    // Not inside our own PDF editor. Selecting text there IS the highlight
    // gesture, so a popup offering to summarise it both covers the page and
    // fights the tool the user just picked.
    const url = TabManager.getActiveTab()?.url || '';
    if (/\/pdf-editor\.html/.test(url)) return;

    showHighlightPopup(selData);
  }

  function showHighlightPopup(selData) {
    // Remove existing popup
    removePopup();

    const popup = document.createElement('div');
    popup.id = 'highlight-popup';
    popup.className = 'highlight-popup animate-fadeSlideUp';
    popup.innerHTML = `
      <div class="highlight-popup-inner">
        <button class="hl-btn" data-action="explain" title="Explain">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 9a3 3 0 115.12 2.13c-.57.57-.87 1.17-.87 1.87v1M12 17h.01"/></svg>
          Explain
        </button>
        <button class="hl-btn" data-action="summarize" title="Summarize">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>
          Summarize
        </button>
        <button class="hl-btn" data-action="rewrite" title="Rewrite">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Rewrite
        </button>
        <button class="hl-btn" data-action="translate" title="Translate">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/></svg>
          Translate
        </button>
        <button class="hl-btn" data-action="save" title="Save to Memory">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
          Save
        </button>
      </div>
    `;

    // Add event listeners
    popup.querySelectorAll('.hl-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        handleHighlightAction(action, selData.text);
        removePopup();
      });
    });

    document.body.appendChild(popup);

    // Position relative to the browser viewport
    const viewportRect = document.getElementById('browser-viewport')?.getBoundingClientRect();
    if (viewportRect && selData.rect) {
      popup.style.top = `${Math.min(viewportRect.top + selData.rect.y - 50, window.innerHeight - 60)}px`;
      popup.style.left = `${viewportRect.left + selData.rect.x}px`;
    }

    // Auto-close after 8 seconds
    setTimeout(removePopup, 8000);
  }

  function removePopup() {
    document.getElementById('highlight-popup')?.remove();
  }

  function handleHighlightAction(action, text) {
    if (action === 'save') {
      // Save to memory
      if (window.localMind) {
        window.localMind.saveMemory({
          type: 'note',
          content: text,
          source: 'highlight',
          url: TabManager.getActiveTab()?.url || ''
        }).then(() => AiPanel.refreshMemoryIndicator());
      }
      return;
    }

    // Route to AI panel
    const prompts = {
      explain: `Explain this in simple terms: "${text}"`,
      summarize: `Summarize this concisely: "${text}"`,
      rewrite: `Rewrite this more clearly: "${text}"`,
      translate: `Translate this to English: "${text}"`
    };

    const input = document.getElementById('ai-input');
    if (input) {
      input.value = prompts[action] || text;
      AiPanel.sendMessage();
    }
  }

  return { init };
})();
