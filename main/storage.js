// =============================================================================
// Local Mind Browser — Storage Engine
// =============================================================================
// Handles persistent storage: settings, encrypted API keys, chat history,
// bookmarks, and browsing history. Uses Electron's safeStorage for encryption.

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

let storageDir = '';

// =============================================================================
// Initialization
// =============================================================================
async function initStorage() {
  storageDir = path.join(app.getPath('userData'), 'local-mind-data');

  // Create directories
  const dirs = ['history', 'workflows', 'downloads'];
  for (const dir of dirs) {
    const dirPath = path.join(storageDir, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  // Create default settings if not exists
  const settingsPath = path.join(storageDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    const defaults = {
      general: {
        searchEngine: 'duckduckgo',
        maxAgentSteps: 50,
        contextWindow: 8192,
        startupPage: 'newtab'
      },
      models: {
        plannerModel: '',
        navigatorModel: '',
        chatModel: ''
      },
      providers: {},
      appearance: {
        theme: 'device',
        accentColor: 'green',
        fontSizePreset: 'medium',
        density: 'comfortable',
        showAnimations: true,
        glassmorphism: true,
        showTabIcons: true,
        showHomeButton: true,
        showBookmarksBar: false,
        showBookmarksOnNtp: true,
        alwaysShowFullUrls: false,
        autoPip: false,
        showMemoryUsage: false,
        pageZoom: 100,
        tabHighlightsLinks: true,
        warnBeforeQuit: true,
        allowSplitViewDrag: true
      },
      privacy: {
        adBlockerEnabled: true,
        defaultPageVisibility: 'visible',
        sensitiveDomainsHidden: true
      },
      performance: {
        tabSleepEnabled: true,
        tabSleepMinutes: 15,
        neverSleep: [],
        processLimit: 'balanced',
        hardwareAcceleration: true
      },
      firewall: {
        enabled: false,
        allowList: [],
        denyList: []
      },
      profile: {
        name: '',
        email: '',
        preferences: ''
      },
      autofill: {
        profiles: []
      },
      widgets: {
        news: { topic: 'world' },
        weather: { city: 'Pune' },
        clock: { timezone: 'Asia/Kolkata', appearance: 'analog' }
      },
      pageVisibility: {}
    };
    fs.writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
  }

  // Create empty API keys file if not exists
  const keysPath = path.join(storageDir, 'api-keys.json');
  if (!fs.existsSync(keysPath)) {
    fs.writeFileSync(keysPath, '{}', 'utf-8');
  }

  // Create empty bookmarks file if not exists
  const bookmarksPath = path.join(storageDir, 'bookmarks.json');
  if (!fs.existsSync(bookmarksPath)) {
    fs.writeFileSync(bookmarksPath, JSON.stringify({ folders: [], items: [] }, null, 2), 'utf-8');
  }
}

// =============================================================================
// Settings
// =============================================================================
// Settings are read on every renderer boot and by several main-process
// consumers — cache in memory and only touch disk on first read and on save.
let settingsCache = null;

function getSettings() {
  if (settingsCache) return settingsCache;
  try {
    const settingsPath = path.join(storageDir, 'settings.json');
    const data = fs.readFileSync(settingsPath, 'utf-8');
    settingsCache = JSON.parse(data);
    return settingsCache;
  } catch (err) {
    console.error('Failed to read settings:', err.message);
    // Returning {} means the next save writes defaults straight over whatever
    // is there, destroying a file that might have been recoverable by hand.
    // Move it aside first so the user still has it.
    try {
      const settingsPath = path.join(storageDir, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        fs.renameSync(settingsPath, `${settingsPath}.corrupt-${Date.now()}`);
      }
    } catch { /* best effort */ }
    return {};
  }
}

/**
 * Write a file so a crash cannot leave it half-written.
 *
 * writeFileSync truncates the target first, so a power cut, a kill, or a full
 * disk in the middle of it leaves an empty or partial file — and for
 * settings.json that is every preference the user has ever set. Writing to a
 * sibling and renaming is atomic on POSIX: the file is either the old contents
 * or the new one, never a mixture.
 */
function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

function saveSettings(settings) {
  try {
    settingsCache = settings;
    const settingsPath = path.join(storageDir, 'settings.json');
    writeAtomic(settingsPath, JSON.stringify(settings, null, 2));
    return { success: true };
  } catch (err) {
    console.error('Failed to save settings:', err.message);
    return { success: false, error: err.message };
  }
}

// =============================================================================
// API Keys (Encrypted with safeStorage)
// =============================================================================
function getApiKey(provider) {
  try {
    const keysPath = path.join(storageDir, 'api-keys.json');
    let data = {};
    if (fs.existsSync(keysPath)) {
      data = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    }
    const encrypted = data[provider];
    if (!encrypted) return '';

    if (safeStorage.isEncryptionAvailable()) {
      const buffer = Buffer.from(encrypted, 'base64');
      return safeStorage.decryptString(buffer);
    }
    // Fallback: stored as plain text (when encryption unavailable)
    return encrypted;
  } catch (err) {
    console.error(`Failed to get API key for ${provider}:`, err.message);
    return '';
  }
}

function saveApiKey(provider, key) {
  try {
    const keysPath = path.join(storageDir, 'api-keys.json');
    let data = {};
    if (fs.existsSync(keysPath)) {
      data = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    }

    if (key === '') {
      // Remove key
      delete data[provider];
    } else if (safeStorage.isEncryptionAvailable()) {
      // Encrypt and store as base64
      const encrypted = safeStorage.encryptString(key);
      data[provider] = encrypted.toString('base64');
    } else {
      // Fallback: store as plain text
      data[provider] = key;
    }

    fs.writeFileSync(keysPath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    console.error(`Failed to save API key for ${provider}:`, err.message);
    return { success: false, error: err.message };
  }
}

// =============================================================================
// Chat History
// =============================================================================
function getChatHistory() {
  try {
    const historyDir = path.join(storageDir, 'history');
    const files = fs.readdirSync(historyDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filePath = path.join(historyDir, f);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return {
          id: data.id || path.basename(f, '.json'),
          title: data.title || 'Untitled Chat',
          date: data.date || fs.statSync(filePath).mtime.toISOString(),
          model: data.model || 'unknown',
          messageCount: (data.messages || []).length
        };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    return files;
  } catch (err) {
    console.error('Failed to get chat history:', err.message);
    return [];
  }
}

/** How many past conversations to keep. Older ones are deleted on save. */
const MAX_CHATS = 3;

/**
 * Keep only the newest MAX_CHATS conversations.
 * Runs after every save, so the folder can't grow without bound.
 */
function pruneChats() {
  try {
    const historyDir = path.join(storageDir, 'history');
    const files = fs.readdirSync(historyDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const fp = path.join(historyDir, f);
        let date;
        // prefer the chat's own timestamp; fall back to the file's mtime
        try { date = new Date(JSON.parse(fs.readFileSync(fp, 'utf-8')).date); } catch { date = null; }
        if (!date || isNaN(date)) date = fs.statSync(fp).mtime;
        return { fp, date };
      })
      .sort((a, b) => b.date - a.date);

    files.slice(MAX_CHATS).forEach(({ fp }) => {
      try { fs.unlinkSync(fp); } catch { /* already gone */ }
    });
  } catch (err) {
    console.warn('Could not prune chat history:', err.message);
  }
}

function saveChat(chat) {
  try {
    if (!chat.id) chat.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    if (!chat.date) chat.date = new Date().toISOString();

    const filePath = path.join(storageDir, 'history', `${chat.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(chat, null, 2), 'utf-8');
    pruneChats();
    return { success: true, id: chat.id };
  } catch (err) {
    console.error('Failed to save chat:', err.message);
    return { success: false, error: err.message };
  }
}

function deleteChat(id) {
  try {
    const filePath = path.join(storageDir, 'history', `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return { success: true };
  } catch (err) {
    console.error('Failed to delete chat:', err.message);
    return { success: false, error: err.message };
  }
}

function getFullChat(id) {
  try {
    const filePath = path.join(storageDir, 'history', `${id}.json`);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return null;
  }
}

// =============================================================================
// Bookmarks
// =============================================================================
// Bookmarks are stored as a tree: nodes are either
//   { type: 'folder', title, children: [...] } or { type: 'link', title, url }
function getBookmarks() {
  try {
    const bookmarksPath = path.join(storageDir, 'bookmarks.json');
    const data = JSON.parse(fs.readFileSync(bookmarksPath, 'utf-8'));
    if (Array.isArray(data.tree)) return data.tree;
    // Migrate the old flat { items: [{title,url}] } format into link nodes
    if (Array.isArray(data.items)) {
      return data.items.map(b => ({ type: 'link', title: b.title || b.url, url: b.url }));
    }
    return [];
  } catch (err) {
    return [];
  }
}

function saveBookmarks(tree) {
  try {
    const bookmarksPath = path.join(storageDir, 'bookmarks.json');
    fs.writeFileSync(bookmarksPath, JSON.stringify({ tree: tree || [] }, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    console.error('Failed to save bookmarks:', err.message);
    return { success: false, error: err.message };
  }
}

// =============================================================================
// Exports
// =============================================================================
module.exports = {
  initStorage,
  getSettings,
  saveSettings,
  getApiKey,
  saveApiKey,
  getChatHistory,
  saveChat,
  deleteChat,
  getFullChat,
  getBookmarks,
  saveBookmarks
};
