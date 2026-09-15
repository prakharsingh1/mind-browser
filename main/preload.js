// =============================================================================
// Local Mind Browser — Renderer Preload Script
// =============================================================================
// Exposes a secure API to the renderer process via contextBridge.
// All communication with the main process goes through ipcRenderer.invoke().

const { contextBridge, ipcRenderer } = require('electron');

// Injects the <browser-action-list> custom element + window.browserAction
// bridge so extension toolbar icons/popups render in the renderer.
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');
injectBrowserAction();

contextBridge.exposeInMainWorld('localMind', {
  // Which OS we're on — the renderer reserves space for the native window
  // controls on the correct side (traffic lights left, caption buttons right).
  platform: process.platform,

  // ─── Chat & AI ─────────────────────────────────────────────────────────
  chat: (messages, model, options) =>
    ipcRenderer.invoke('chat', messages, model, options),
  stopChat: () =>
    ipcRenderer.invoke('stop-chat'),
  onChatToken: (callback) => {
    ipcRenderer.on('chat-token', (_event, token) => callback(token));
  },
  onChatDone: (callback) => {
    ipcRenderer.on('chat-done', (_event, data) => callback(data));
  },
  onChatError: (callback) => {
    ipcRenderer.on('chat-error', (_event, err) => callback(err));
  },

  // ─── Models ────────────────────────────────────────────────────────────
  getModels: () =>
    ipcRenderer.invoke('get-models'),
  checkOllama: () =>
    ipcRenderer.invoke('check-ollama'),

  // ─── Settings & Storage ────────────────────────────────────────────────
  getSettings: () =>
    ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) =>
    ipcRenderer.invoke('save-settings', settings),
  getApiKey: (provider) =>
    ipcRenderer.invoke('get-api-key', provider),
  saveApiKey: (provider, key) =>
    ipcRenderer.invoke('save-api-key', provider, key),

  // ─── Chat History ──────────────────────────────────────────────────────
  getChatHistory: () =>
    ipcRenderer.invoke('get-chat-history'),
  saveChat: (chat) =>
    ipcRenderer.invoke('save-chat', chat),
  getChat: (id) =>
    ipcRenderer.invoke('get-chat', id),
  deleteChat: (id) =>
    ipcRenderer.invoke('delete-chat', id),

  // ─── Memory ────────────────────────────────────────────────────────────
  getMemories: (query) =>
    ipcRenderer.invoke('get-memories', query),
  saveMemory: (memory) =>
    ipcRenderer.invoke('save-memory', memory),
  deleteMemory: (id) =>
    ipcRenderer.invoke('delete-memory', id),
  clearMemories: () =>
    ipcRenderer.invoke('clear-memories'),
  getMemoryStats: () =>
    ipcRenderer.invoke('get-memory-stats'),
  getMemoryContext: (query) =>
    ipcRenderer.invoke('get-memory-context', query),

  // ─── Agent ─────────────────────────────────────────────────────────────
  // Agent bridge: main asks the renderer to drive a webview, renderer replies
  onAgentCall: (callback) => {
    ipcRenderer.on('agent:call', (_event, payload) => callback(payload));
  },
  onChromeKey: (callback) => {
    ipcRenderer.on('chrome-key', (_event, data) => callback(data));
  },
  // ─── PDF editor ────────────────────────────────────────────────────────
  pdfLoad: (src) => ipcRenderer.invoke('pdf:load', src),
  pdfSave: (payload) => ipcRenderer.invoke('pdf:save', payload),
  pdfReveal: (p) => ipcRenderer.invoke('pdf:reveal', p),
  // Conversion output: one file, or a folder of page images.
  fileSaveAs: (payload) => ipcRenderer.invoke('file:saveAs', payload),
  fileSaveMany: (payload) => ipcRenderer.invoke('file:saveMany', payload),

  // ─── Developer tools ───────────────────────────────────────────────────
  devCommand: (payload) => ipcRenderer.invoke('dev:command', payload),
  devState: (id) => ipcRenderer.invoke('dev:state', id),
  devCatalog: () => ipcRenderer.invoke('dev:devices'),

  // ─── Reader ────────────────────────────────────────────────────────────
  readerScript: () => ipcRenderer.invoke('reader:script'),

  testCustomEndpoint: () => ipcRenderer.invoke('test-custom-endpoint'),

  // ── Site permissions ──────────────────────────────────────────────────
  // The prompt itself is a native dialog raised by the main process; the
  // renderer only reads and revokes what was decided.
  sessionWasUnclean: () => ipcRenderer.invoke('session:was-unclean'),

  // ── Screenshots ───────────────────────────────────────────────────────
  // ── Updates ───────────────────────────────────────────────────────────
  updateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openReleases: () => ipcRenderer.invoke('update:open-releases'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, st) => cb(st)),

  siteInfo: (url) => ipcRenderer.invoke('site:info', { url }),
  clearSiteData: (origin) => ipcRenderer.invoke('site:clear', { origin }),
  certFor: (hostname) => ipcRenderer.invoke('cert:for', hostname),

  listTasks: () => ipcRenderer.invoke('tasks:list'),
  closeTask: (contentsId) => ipcRenderer.invoke('tasks:close', contentsId),
  onCloseTabByContentsId: (cb) => ipcRenderer.on('close-tab-by-contents-id', (_e, id) => cb(id)),

  capturePage: (id, mode) => ipcRenderer.invoke('capture:page', { id, mode }),
  captureCopy: (id, mode) => ipcRenderer.invoke('capture:copy', { id, mode }),
  listPermissions: () => ipcRenderer.invoke('permissions:list'),
  revokePermission: (origin, permission) => ipcRenderer.invoke('permissions:revoke', origin, permission),
  revokeAllPermissions: () => ipcRenderer.invoke('permissions:revoke-all'),

  reportError: (info) => ipcRenderer.send('app:renderer-error', info),
  crashLogPath: () => ipcRenderer.invoke('app:crash-log-path'),

  agentResult: (payload) => ipcRenderer.send('agent:result', payload),
  // Stop the bridge's deadline while a confirmation is waiting on a human.
  agentHoldTimeout: (id) => ipcRenderer.send('agent:timeout-hold', { id }),
  agentReleaseTimeout: (id) => ipcRenderer.send('agent:timeout-release', { id }),

  runAgent: (task, model, options) =>
    ipcRenderer.invoke('run-agent', task, model, options),
  stopAgent: () =>
    ipcRenderer.invoke('stop-agent'),
  onAgentProgress: (callback) => {
    ipcRenderer.on('agent-progress', (_event, data) => callback(data));
  },
  onAgentNavigate: (callback) => {
    ipcRenderer.on('agent-navigate', (_event, data) => callback(data));
  },
  onAgentNavigateNewTab: (callback) => {
    ipcRenderer.on('agent-navigate-new-tab', (_event, data) => callback(data));
  },
  onAgentAction: (callback) => {
    ipcRenderer.on('agent-action', (_event, data) => callback(data));
  },

  // ─── Content Blocker ───────────────────────────────────────────────────
  getBlockerStats: () =>
    ipcRenderer.invoke('get-blocker-stats'),
  proxyGet: () => ipcRenderer.invoke('proxy:get'),
  proxySet: (cfg) => ipcRenderer.invoke('proxy:set', cfg),
  proxyCheck: () => ipcRenderer.invoke('proxy:check'),
  // ─── Onion Mode ────────────────────────────────────────────────────────
  onionOpen: () => ipcRenderer.invoke('onion:open'),
  onionAvailable: () => ipcRenderer.invoke('onion:available'),
  onionClose: () => ipcRenderer.invoke('onion:close'),
  onionBridges: () => ipcRenderer.invoke('onion:bridges'),
  onionSetBridges: (mode, custom) => ipcRenderer.invoke('onion:set-bridges', { mode, custom }),
  onionLevel: () => ipcRenderer.invoke('onion:level'),
  onionSetLevel: (l) => ipcRenderer.invoke('onion:set-level', l),
  onOnionStatus: (cb) => {
    const fn = (_e, s) => cb(s);
    ipcRenderer.on('onion:status', fn);
    return () => ipcRenderer.removeListener('onion:status', fn);
  },

  privacyDnsProviders: () => ipcRenderer.invoke('privacy:dns-providers'),
  privacyDnsSet: (id) => ipcRenderer.invoke('privacy:dns-set', id),
  privacySiteState: (host) => ipcRenderer.invoke('privacy:site-state', host),
  privacySiteSet: (host, masked) => ipcRenderer.invoke('privacy:site-set', { host, masked }),
  shieldGet: (host) => ipcRenderer.invoke('shield:get', host),
  shieldSet: (host, mode) => ipcRenderer.invoke('shield:set', { host, mode }),
  toggleBlocker: (enabled) =>
    ipcRenderer.invoke('toggle-blocker', enabled),

  // ─── Scheduler ─────────────────────────────────────────────────────────
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  createTask: (t) => ipcRenderer.invoke('create-task', t),
  deleteTask: (id) => ipcRenderer.invoke('delete-task', id),
  
  // Widgets
  captureTab: (webContentsId) => ipcRenderer.invoke('capture-tab', webContentsId),
  getWidgetWeather: (city) => ipcRenderer.invoke('get-widget-weather', city),
  getWidgetNews: (topic) => ipcRenderer.invoke('get-widget-news', topic),

  // ─── New Tab widgets ───────────────────────────────────────────────────
  ntpWeather: (city) => ipcRenderer.invoke('ntp:weather', city),
  ntpWallpapers: () => ipcRenderer.invoke('ntp:wallpapers'),
  ntpNews: (topic) => ipcRenderer.invoke('ntp:news', topic),
  ntpFavicon: (url) => ipcRenderer.invoke('ntp:favicon', url),
  ntpCacheWallpaper: (url) => ipcRenderer.invoke('ntp:cache-wallpaper', url),
  ntpDisplayName: () => ipcRenderer.invoke('ntp:display-name'),
  pauseTask: (id) =>
    ipcRenderer.invoke('pause-task', id),
  resumeTask: (id) =>
    ipcRenderer.invoke('resume-task', id),

  // ─── System ────────────────────────────────────────────────────────────
  getAppVersion: () =>
    ipcRenderer.invoke('get-app-version'),
  getSystemInfo: () =>
    ipcRenderer.invoke('get-system-info'),
  getTabMetrics: (webContentsIds) =>
    ipcRenderer.invoke('get-tab-metrics', webContentsIds),
  freeMemory: () =>
    ipcRenderer.invoke('free-memory'),
  relaunchApp: () =>
    ipcRenderer.invoke('app:relaunch'),
  showNotification: (title, body) =>
    ipcRenderer.invoke('show-notification', title, body),

  // ─── Browser Data Import ────────────────────────────────────────────────
  importBrowserData: (browser) =>
    ipcRenderer.invoke('import-browser-data', browser),

  // ─── Omnibox ───────────────────────────────────────────────────────────
  omniboxSuggest: (q, engine) =>
    ipcRenderer.invoke('omnibox:suggest', { q, engine }),
  readClipboardText: () =>
    ipcRenderer.invoke('read-clipboard-text'),
  writeClipboardText: (text) =>
    ipcRenderer.invoke('write-clipboard-text', text),
  privacySchema: () => ipcRenderer.invoke('privacy:schema'),

  // ─── Downloads ─────────────────────────────────────────────────────────
  downloadsList: () => ipcRenderer.invoke('downloads:list'),
  downloadCancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
  downloadPause: (id) => ipcRenderer.invoke('downloads:pause', id),
  downloadResume: (id) => ipcRenderer.invoke('downloads:resume', id),
  downloadOpen: (id) => ipcRenderer.invoke('downloads:open', id),
  downloadShow: (id) => ipcRenderer.invoke('downloads:show', id),
  downloadsClear: () => ipcRenderer.invoke('downloads:clear'),
  downloadsOpenFolder: () => ipcRenderer.invoke('downloads:open-folder'),
  onDownloadEvent: (callback) => {
    ipcRenderer.on('download-event', (_event, data) => callback(data));
  },

  // ─── Bookmarks ─────────────────────────────────────────────────────────
  getBookmarks: () =>
    ipcRenderer.invoke('get-bookmarks'),
  saveBookmarks: (items) =>
    ipcRenderer.invoke('save-bookmarks', items),

  // ─── News Hub ──────────────────────────────────────────────────────────
  newsSection: (section, city, withImages) =>
    ipcRenderer.invoke('news:section', { section, city, withImages }),
  newsTrending: () =>
    ipcRenderer.invoke('news:trending'),
  newsXTrends: () =>
    ipcRenderer.invoke('news:xtrends'),
  newsArticle: (url) =>
    ipcRenderer.invoke('news:article', { url }),
  newsStory: (payload) =>
    ipcRenderer.invoke('news:story', payload),
  newsPodcasts: (payload) =>
    ipcRenderer.invoke('news:podcasts', payload),
  newsImage: (payload) =>
    ipcRenderer.invoke('news:image', payload),
  newsPredictions: () =>
    ipcRenderer.invoke('news:predictions'),

  // ─── Finance Hub ───────────────────────────────────────────────────────
  finQuotes: (symbols) =>
    ipcRenderer.invoke('fin:quotes', symbols),
  finChart: (symbol, range) =>
    ipcRenderer.invoke('fin:chart', { symbol, range }),
  finSearch: (q) =>
    ipcRenderer.invoke('fin:search', q),
  finTrending: () =>
    ipcRenderer.invoke('fin:trending'),
  finNews: (payload) =>
    ipcRenderer.invoke('fin:news', payload),
  finNewsImages: (urls) =>
    ipcRenderer.invoke('fin:news-images', urls),
  finIndustry: (industry) =>
    ipcRenderer.invoke('fin:industry', { industry }),
  finProfile: (symbol) =>
    ipcRenderer.invoke('fin:profile', { symbol }),
  finFundamentals: (symbol, freq) =>
    ipcRenderer.invoke('fin:fundamentals', { symbol, freq }),

  // ─── Native Application Menu ───────────────────────────────────────────
  // The main process sends these when the user picks a menu-bar item.
  onMenuAction: (callback) => {
    const channels = [
      'open-settings', 'open-settings-shortcuts',
      'menu-new-tab', 'menu-close-tab', 'menu-find',
      'menu-toggle-sidebar', 'menu-toggle-ai', 'menu-reading-mode',
      'menu-split-view', 'menu-command-palette',
      'menu-focus-mode', 'menu-copy-url', 'menu-onion-mode', 'menu-history', 'menu-print', 'menu-edit-pdf',
      'menu-capture-full', 'menu-capture-visible', 'menu-capture-copy', 'menu-task-manager',
      'menu-ask-ai', 'menu-summarize', 'menu-agent-mode',
      'menu-research-mode', 'menu-compare',
      'menu-next-tab', 'menu-prev-tab', 'menu-help',
      'menu-reload-page', 'menu-force-reload',
      'menu-zoom-in', 'menu-zoom-out', 'menu-zoom-reset',
      'menu-reopen-tab', 'menu-downloads'
    ];
    channels.forEach(ch => ipcRenderer.on(ch, () => callback(ch)));
  },

  // Events that carry data, which onMenuAction cannot: it fans one callback out
  // over channel names and drops the arguments.
  onAppEvent: (channel, handler) => {
    const allowed = ['pdf-detected', 'dev-open-tab', 'menu-dev-panel'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_event, payload) => handler(payload));
  },

  // Popup / target=_blank links from webviews, routed via the main process
  onOpenUrl: (callback) => {
    ipcRenderer.on('open-url', (_event, url) => callback(url));
  },

  // ─── Chrome Extensions ─────────────────────────────────────────────────
  extSelectTab: (webContentsId) =>
    ipcRenderer.send('ext:select-tab', webContentsId),
  extTabCreated: (requestId, webContentsId) =>
    ipcRenderer.send('ext:tab-created', { requestId, webContentsId }),
  onExtCreateTab: (callback) =>
    ipcRenderer.on('ext:create-tab', (_e, details) => callback(details)),
  onExtActivateTab: (callback) =>
    ipcRenderer.on('ext:activate-tab', (_e, webContentsId) => callback(webContentsId)),
  onExtCloseTab: (callback) =>
    ipcRenderer.on('ext:close-tab', (_e, webContentsId) => callback(webContentsId)),
  listExtensions: () =>
    ipcRenderer.invoke('ext:list'),
  removeExtension: (id) =>
    ipcRenderer.invoke('ext:remove', id),

  // ─── Cleanup ───────────────────────────────────────────────────────────
  removeAllListeners: (channel) =>
    ipcRenderer.removeAllListeners(channel)
});
