// =============================================================================
// Local Mind Browser — Split View
// =============================================================================
// Side-by-side browser view: two webviews displayed in split layout.

const SplitView = (() => {
  let isActive = false;
  let splitTabId = null;

  function init() {
    EventBus.on('toggle-split-view', toggle);
  }

  function toggle() {
    isActive = !isActive;
    const container = document.getElementById('webview-container');
    if (!container) return;

    if (isActive) {
      container.classList.add('split-view');

      // Create a second tab in split view
      const tabs = TabManager.getAllTabs();
      if (tabs.length >= 2) {
        // Show the second tab alongside the first
        const activeTab = TabManager.getActiveTab();
        const otherTab = tabs.find(t => t.id !== activeTab?.id);
        if (otherTab?.webview) {
          splitTabId = otherTab.id;
          otherTab.webview.style.display = 'flex';
          otherTab.webview.classList.add('split-right');
        }
      } else {
        // Create a new tab in the right split
        const newTab = TabManager.createTab('', false);
        splitTabId = newTab.id;
      }
    } else {
      container.classList.remove('split-view');

      // Hide split tab
      if (splitTabId) {
        const tabs = TabManager.getAllTabs();
        const splitTab = tabs.find(t => t.id === splitTabId);
        if (splitTab?.webview) {
          splitTab.webview.style.display = 'none';
          splitTab.webview.classList.remove('split-right');
        }
        splitTabId = null;
      }
    }
  }

  return { init, toggle };
})();
