// =============================================================================
// Local Mind Browser — IPC Handler Registration
// =============================================================================
// Registers all IPC handlers that bridge the renderer to main process services.

const { app, Notification, net, webContents, session } = require('electron');
const https = require('https');
const storage = require('./storage');
const ollama = require('./ollama');
const providers = require('./providers/index');
const blocker = require('./content-blocker');
const memory = require('./memory');
// ReAct tool-calling loop. Replaces the old plan-then-execute engine, which
// planned blindly up front and whose "read page" step returned no page text.
const agentEngine = require('./agent/loop');
const { initBridge } = require('./agent/bridge');
const scheduler = require('./scheduler');

// Cache of article URL → og:image URL so repeated new-tab loads on the same top
// story don't re-download the (large) article page. Bounded to the last 50.
const ogImageCache = new Map();

/**
 * Register all IPC handlers on the given ipcMain instance.
 * Handlers may only be registered once per app — the current window is
 * resolved through getWindow() so new windows keep working.
 * @param {Electron.IpcMain} ipcMain
 * @param {() => Electron.BrowserWindow} getWindow
 */
function registerIpcHandlers(ipcMain, getWindow) {

  // Send an event to the current main window, if it is still alive
  function sendToWindow(channel, payload) {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }

  // ─── Chat & AI ─────────────────────────────────────────────────────────
  ipcMain.handle('chat', async (_event, messages, model, options = {}) => {
    const apiKey = storage.getApiKey(providers.getProviderForModel(model).providerName);

    return new Promise((resolve) => {
      providers.streamChat(
        messages,
        model,
        apiKey,
        options,
        // onToken — forward each token to the renderer unless this is a quiet
        // background call (e.g. the News page briefing), which only awaits the
        // resolved result and must not touch the AI panel's stream UI.
        (token) => { if (!options.quiet) sendToWindow('chat-token', token); },
        // onDone
        (result) => {
          if (!options.quiet) sendToWindow('chat-done', result);
          resolve(result);
        },
        // onError
        (error) => {
          if (!options.quiet) sendToWindow('chat-error', error);
          resolve({ error });
        }
      );
    });
  });

  ipcMain.handle('stop-chat', () => {
    providers.stopAll();
    return { success: true };
  });

  // ─── Models ────────────────────────────────────────────────────────────
  ipcMain.handle('get-models', async () => {
    return await providers.listAllModels((provider) => storage.getApiKey(provider));
  });

  // Lets Settings say "reachable, 7 models" instead of leaving the user to
  // guess whether their endpoint URL is right.
  ipcMain.handle('test-custom-endpoint', async () => {
    try {
      return await require('./providers/custom').testConnection(storage.getApiKey('custom'));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('check-ollama', async () => {
    return await ollama.checkConnection();
  });

  // ─── Settings ──────────────────────────────────────────────────────────
  ipcMain.handle('get-settings', () => {
    return storage.getSettings();
  });

  ipcMain.handle('save-settings', (_event, settings) => {
    return storage.saveSettings(settings);
  });

  ipcMain.handle('get-bookmarks', () => {
    return storage.getBookmarks();
  });

  ipcMain.handle('save-bookmarks', (_event, items) => {
    return storage.saveBookmarks(items);
  });

  // ─── API Keys ──────────────────────────────────────────────────────────
  ipcMain.handle('get-api-key', (_event, provider) => {
    return storage.getApiKey(provider);
  });

  ipcMain.handle('save-api-key', (_event, provider, key) => {
    return storage.saveApiKey(provider, key);
  });

  // ─── Chat History ──────────────────────────────────────────────────────
  ipcMain.handle('get-chat-history', () => {
    return storage.getChatHistory();
  });

  ipcMain.handle('save-chat', (_event, chat) => {
    return storage.saveChat(chat);
  });

  ipcMain.handle('get-chat', (_event, id) => {
    return storage.getFullChat(id);
  });

  ipcMain.handle('delete-chat', (_event, id) => {
    return storage.deleteChat(id);
  });

  // ─── Memory ────────────────────────────────────────────────────────────
  ipcMain.handle('get-memories', (_event, query) => {
    if (query) return memory.searchMemories(query);
    return memory.getMemories();
  });

  ipcMain.handle('save-memory', (_event, mem) => {
    return memory.addMemory(mem);
  });

  ipcMain.handle('delete-memory', (_event, id) => {
    return memory.deleteMemory(id);
  });

  ipcMain.handle('clear-memories', () => {
    return memory.clearAll();
  });

  ipcMain.handle('get-memory-stats', () => {
    return memory.getStats();
  });

  ipcMain.handle('get-memory-context', (_event, query) => {
    return memory.getMemoryContext(query);
  });

  // ─── Agent ─────────────────────────────────────────────────────────────
  initBridge(ipcMain, getWindow);

  ipcMain.handle('run-agent', async (_event, task, model, options) => {
    return agentEngine.runAgent(
      task, model, options,
      (progress) => sendToWindow('agent-progress', progress),
      getWindow()
    );
  });

  ipcMain.handle('stop-agent', () => {
    agentEngine.stopAgent();
    return { success: true };
  });

  // ─── Content Blocker ───────────────────────────────────────────────────
  ipcMain.handle('get-blocker-stats', () => {
    return blocker.getStats();
  });

  ipcMain.handle('shield:get', (_event, host) => ({
    mode: blocker.getSiteMode(host),
    stats: blocker.getStats()
  }));

  ipcMain.handle('shield:set', (_event, { host, mode }) => blocker.setSiteMode(host, mode));

  ipcMain.handle('toggle-blocker', (_event, enabled) => {
    return blocker.toggle(enabled);
  });

  // ─── Scheduler ─────────────────────────────────────────────────────────
  ipcMain.handle('get-tasks', () => {
    return scheduler.getTasks();
  });

  ipcMain.handle('create-task', (_event, task) => {
    return scheduler.createTask(task);
  });

  ipcMain.handle('delete-task', (_event, id) => {
    return scheduler.deleteTask(id);
  });

  ipcMain.handle('pause-task', (_event, id) => {
    return scheduler.pauseTask(id);
  });

  ipcMain.handle('resume-task', (_event, id) => {
    return scheduler.resumeTask(id);
  });

  // ─── System ────────────────────────────────────────────────────────────
  // Clipboard text for the address-bar context menu (Paste / Paste and Go)
  ipcMain.handle('read-clipboard-text', () => {
    try { return require('electron').clipboard.readText(); } catch { return ''; }
  });

  // Writing goes through here rather than navigator.clipboard: that API refuses
  // when the host document is not focused, which is exactly the case whenever a
  // page has focus — so copying the URL silently did nothing.
  ipcMain.handle('write-clipboard-text', (_e, text) => {
    try { require('electron').clipboard.writeText(String(text ?? '')); return true; }
    catch { return false; }
  });

  // ── Omnibox: search-suggest completions ──
  // Fetched in the main process (no CORS), tight timeout so a slow network
  // can never hold up the dropdown — the renderer renders local results first
  // and merges these in when (if) they arrive.
  ipcMain.handle('omnibox:suggest', (_event, { q, engine }) => {
    return new Promise((resolve) => {
      if (!q || q.length < 2) return resolve([]);
      const urls = {
        google: `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(q)}`,
        duckduckgo: `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`,
        bing: `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`
      };
      const url = urls[engine] || urls.duckduckgo;
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 900 }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // All three engines use OpenSearch-style [query, [suggestions...]]
            resolve(Array.isArray(parsed?.[1]) ? parsed[1].slice(0, 5) : []);
          } catch { resolve([]); }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.on('error', () => resolve([]));
    });
  });

  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  /**
   * Everything the About page reports, gathered in one call.
   *
   * Worth having beyond vanity: when someone files a bug, the first four
   * questions are always which build, which Chromium, which architecture, and
   * whether the optional pieces actually loaded. A static "Version 1.0.0" and a
   * marketing paragraph answered none of them.
   */
  ipcMain.handle('get-system-info', () => {
    const info = {
      version: app.getVersion(),
      chromium: process.versions.chrome,
      electron: process.versions.electron,
      node: process.versions.node,
      v8: process.versions.v8,
      arch: process.arch,
      platform: process.platform,
      osVersion: require('os').release(),
      // Rosetta: an arm64 Mac running the Intel build is a real support case
      // and is invisible from the version number alone.
      translated: (() => {
        try { return process.arch === 'x64' && require('os').cpus()[0]?.model?.includes('Apple'); }
        catch { return false; }
      })(),
      widevine: null,
      extensions: 0
    };

    try {
      const { components } = require('electron');
      const status = components?.status?.() || {};
      const cdm = Object.values(status)[0];
      if (cdm) info.widevine = { status: cdm.status, version: cdm.version };
    } catch { /* stock Electron has no components module */ }

    try {
      const ses = session.defaultSession;
      const list = ses.extensions?.getAllExtensions?.() || [];
      info.extensions = list.length;
    } catch { /* extensions not loaded */ }

    return info;
  });

  // Per-tab resource usage.
  //
  // The subtlety that makes a naive version lie: Chromium puts same-site tabs
  // in ONE renderer process. Reading each tab's process straight off
  // getAppMetrics() therefore reports the whole process against every tab
  // sharing it — five tabs of one site each claiming 400 MB, and a column that
  // sums to far more than the browser actually uses. So the cost of a shared
  // process is split across its tabs, and the row says who it is shared with.
  ipcMain.handle('get-tab-metrics', (_event, webContentsIds = []) => {
    const { webContents } = require('electron');
    const processMetrics = app.getAppMetrics();
    const byPid = new Map(processMetrics.map((m) => [m.pid, m]));

    const pidOf = new Map();        // webContentsId -> pid
    const tabsInPid = new Map();    // pid -> how many open tabs live there
    for (const id of webContentsIds) {
      try {
        const wc = webContents.fromId(id);
        if (!wc || wc.isDestroyed()) continue;
        const pid = wc.getOSProcessId();
        if (!pid) continue;
        pidOf.set(id, pid);
        tabsInPid.set(pid, (tabsInPid.get(pid) || 0) + 1);
      } catch { /* the webview's process is already gone */ }
    }

    const tabs = {};
    for (const [id, pid] of pidOf) {
      const m = byPid.get(pid);
      if (!m) continue;
      const share = tabsInPid.get(pid) || 1;
      const processMB = (m.memory?.workingSetSize || 0) / 1024;
      tabs[id] = {
        memoryMB: Math.round(processMB / share),
        processMB: Math.round(processMB),
        cpu: Math.round(((m.cpu?.percentCPUUsage || 0) / share) * 10) / 10,
        pid,
        sharedWith: share - 1
      };
    }

    // Anything that is not a tab renderer — the browser process itself, the GPU
    // process, network and utility services. Naming it separately is the only
    // way the total adds up on screen.
    const tabPids = new Set(pidOf.values());
    let tabsMB = 0, overheadMB = 0, totalCpu = 0;
    for (const m of processMetrics) {
      const mb = (m.memory?.workingSetSize || 0) / 1024;
      totalCpu += m.cpu?.percentCPUUsage || 0;
      if (tabPids.has(m.pid)) tabsMB += mb; else overheadMB += mb;
    }

    return {
      tabs,
      total: {
        memoryMB: Math.round(tabsMB + overheadMB),
        tabsMB: Math.round(tabsMB),
        overheadMB: Math.round(overheadMB),
        cpu: Math.round(totalCpu * 10) / 10,
        processCount: processMetrics.length
      }
    };
  });

  // Drop what can be dropped right now: the HTTP cache and each session's
  // in-memory code caches. Tab sleeping is the renderer's job; this is the part
  // only the main process can do.
  ipcMain.handle('free-memory', async () => {
    const { session } = require('electron');
    const before = app.getAppMetrics()
      .reduce((sum, m) => sum + (m.memory?.workingSetSize || 0) / 1024, 0);
    try {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearCodeCaches({ urls: [] });
    } catch { /* a session may be mid-teardown; the sweep is best-effort */ }
    const after = app.getAppMetrics()
      .reduce((sum, m) => sum + (m.memory?.workingSetSize || 0) / 1024, 0);
    return { ok: true, freedMB: Math.max(0, Math.round(before - after)) };
  });

  // The process-limit and hardware-acceleration settings only take effect at
  // launch, so the settings page offers to do the relaunch rather than leaving
  // the user to work out that a restart is what they need.
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('show-notification', (_event, title, body) => {
    if (Notification.isSupported()) {
      const notification = new Notification({ title, body });
      notification.show();
    }
    return { success: true };
  });

  // ─── Browser Data Import ──────────────────────────────────────────────
  ipcMain.handle('import-browser-data', async (_event, browser) => {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const homedir = os.homedir();
    const bookmarks = [];   // flat list (kept for backward compatibility)
    const tree = [];        // folder-preserving tree

    try {
      if (browser === 'chrome' || browser === 'edge') {
        // Chrome and Edge both store bookmarks in the same Chromium JSON format
        const chromiumPath = browser === 'edge'
          ? path.join(homedir, 'Library', 'Application Support', 'Microsoft Edge', 'Default', 'Bookmarks')
          : path.join(homedir, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Bookmarks');
        if (fs.existsSync(chromiumPath)) {
          const data = JSON.parse(fs.readFileSync(chromiumPath, 'utf8'));

          // Convert a Chromium node into our tree format, preserving folders
          function convert(node) {
            if (!node) return null;
            if (node.type === 'url') {
              bookmarks.push({ title: node.name || '', url: node.url || '' });
              return { type: 'link', title: node.name || '', url: node.url || '' };
            }
            if (node.type === 'folder') {
              const children = (node.children || []).map(convert).filter(Boolean);
              return { type: 'folder', title: node.name || 'Folder', children };
            }
            return null;
          }

          if (data.roots) {
            // Each root (Bookmarks bar, Other bookmarks…) becomes a top-level folder
            Object.values(data.roots).forEach((root) => {
              if (!root || typeof root !== 'object' || !root.children) return;
              const folder = convert(root);
              if (folder && folder.children && folder.children.length) tree.push(folder);
            });
          }
        }
      } else if (browser === 'arc' || browser === 'zen') {
        // Neither uses the Chromium format: Arc has its own sidebar JSON, Zen
        // is Firefox underneath. See importers.js.
        const { importArc, importZen, flatten } = require('./importers');
        const res = browser === 'arc' ? importArc() : importZen();
        tree.push(...res.tree);
        bookmarks.push(...flatten(res.tree));
        if (!res.tree.length) return { bookmarks: [], tree: [], reason: res.reason };
      } else if (browser === 'safari') {
        // Safari stores bookmarks as a plist — convert to JSON via plutil
        const safariPath = path.join(homedir, 'Library', 'Safari', 'Bookmarks.plist');
        if (fs.existsSync(safariPath)) {
          const { execSync } = require('child_process');
          const tempPath = path.join(app.getPath('temp'), 'safari_bookmarks.json');
          
          try {
            execSync(`plutil -convert json -o "${tempPath}" "${safariPath}"`);
            const data = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
            
            function extractSafari(node) {
              if (!node) return;
              if (node.URLString) {
                bookmarks.push({ 
                  title: (node.URIDictionary && node.URIDictionary.title) || node.URLString, 
                  url: node.URLString 
                });
              }
              if (node.Children) {
                node.Children.forEach(extractSafari);
              }
            }
            
            extractSafari(data);
            // Clean up temp file
            try { fs.unlinkSync(tempPath); } catch {}
          } catch (plistErr) {
            console.error('Safari plist conversion failed:', plistErr.message);
          }
        }
      }
    } catch (err) {
      console.error(`Failed to import from ${browser}:`, err.message);
    }

    // Safari import only produced a flat list — wrap it in a single folder so
    // callers always receive a tree.
    if (!tree.length && bookmarks.length) {
      tree.push({ type: 'folder', title: 'Imported', children: bookmarks.map(b => ({ type: 'link', title: b.title, url: b.url })) });
    }

    return { bookmarks, tree };
  });

  // ─── Tab thumbnail (sidebar hover preview) ─────────────────────────────
  // Small, short-lived JPEGs — just enough for a 232px popover.
  ipcMain.handle('capture-tab', async (_event, webContentsId) => {
    try {
      const wc = webContents.fromId(webContentsId);
      if (!wc || wc.isDestroyed() || wc.isLoading()) return { ok: false };
      const img = await wc.capturePage();
      if (img.isEmpty()) return { ok: false };
      const small = img.resize({ width: 420, quality: 'good' });
      return { ok: true, data: small.toDataURL() };
    } catch {
      return { ok: false };
    }
  });

  // ─── Widgets ───────────────────────────────────────────────────────────
  ipcMain.handle('get-widget-weather', async (_event, city) => {
    return new Promise((resolve) => {
      const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ error: e.message });
          }
        });
      }).on('error', (e) => resolve({ error: e.message }));
    });
  });

  ipcMain.handle('get-widget-news', async (_event, topic) => {
    // Google News RSS — live, keyless, always current. Topic sections map to
    // Google's own category feeds; anything unknown falls back to top stories.
    const topicMap = {
      general: '', world: 'WORLD', nation: 'NATION', business: 'BUSINESS',
      technology: 'TECHNOLOGY', entertainment: 'ENTERTAINMENT',
      sports: 'SPORTS', science: 'SCIENCE', health: 'HEALTH'
    };
    const section = topicMap[topic] || '';
    const suffix = 'hl=en-IN&gl=IN&ceid=IN:en';
    const url = section
      ? `https://news.google.com/rss/headlines/section/topic/${section}?${suffix}`
      : `https://news.google.com/rss?${suffix}`;

    const decode = (s) => s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');

    // Google's topic-section feeds answer with a 302 to a /topics/… URL, so we
    // follow a few redirects (top-stories returns 200 directly).
    const fetchText = (target, redirectsLeft, cb) => {
      https.get(target, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          return fetchText(next, redirectsLeft - 1, cb);
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => cb(null, data));
      }).on('error', (e) => cb(e));
    };

    const matchOg = (html) => {
      const m = /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i.exec(html)
             || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i.exec(html);
      return m ? decode(m[1]) : null;
    };

    // GET with redirect-following and an optional byte cap. `stop(html)` may
    // return true to abort the download early once we have what we need.
    const httpGet = (target, { cap = 0, stop = null } = {}, cb) => {
      let redirects = 6;
      const go = (u) => {
        try {
          https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects-- > 0) {
              res.resume();
              return go(new URL(res.headers.location, u).toString());
            }
            let html = '';
            let ended = false;
            const done = () => { if (!ended) { ended = true; cb(null, html); } };
            res.on('data', (chunk) => {
              html += chunk;
              if ((stop && stop(html)) || (cap && html.length > cap)) { res.destroy(); done(); }
            });
            res.on('end', done);
            res.on('error', (e) => { if (!ended) { ended = true; cb(e); } });
          }).on('error', (e) => cb(e));
        } catch (e) { cb(e); }
      };
      go(target);
    };

    const httpPost = (u, body, cb) => {
      const url = new URL(u);
      const req = https.request({
        hostname: url.hostname, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'Mozilla/5.0' }
      }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => cb(null, d));
      });
      req.on('error', cb);
      req.write(body); req.end();
    };

    // Resolve a Google News link to the *real* article's og:image. Google hides
    // the publisher URL behind a signed batchexecute RPC, so we: fetch the
    // interstitial for its signature/timestamp, decode to the real URL, then read
    // that page's og:image. Any failure yields null (widget falls back to gradient).
    const resolveArticleImage = (googleLink, cb) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; clearTimeout(timer); cb(v); } };
      const timer = setTimeout(() => finish(null), 9000);
      const artIdMatch = /articles\/([^?]+)/.exec(googleLink);
      if (!artIdMatch) return finish(null);
      const artId = artIdMatch[1];

      httpGet(googleLink, { stop: (h) => /data-n-a-sg="/.test(h) && /data-n-a-ts="/.test(h), cap: 800000 }, (e1, page) => {
        if (e1 || !page) return finish(null);
        const sig = (/data-n-a-sg="([^"]+)"/.exec(page) || [])[1];
        const ts = (/data-n-a-ts="([^"]+)"/.exec(page) || [])[1];
        if (!sig || !ts) return finish(null);

        const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], artId, Number(ts), sig]);
        const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));

        httpPost('https://news.google.com/_/DotsSplashUi/data/batchexecute', body, (e2, resp) => {
          if (e2 || !resp) return finish(null);
          const realMatch = /garturlres\\",\\"(https?:\/\/[^\\"]+)/.exec(resp);
          if (!realMatch) return finish(null);
          const realUrl = realMatch[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');

          // Publisher og:image lives in <head> — abort once found or past </head>.
          httpGet(realUrl, { stop: (h) => !!matchOg(h) || /<\/head>/i.test(h), cap: 120000 }, (e3, phtml) => {
            if (e3 || !phtml) return finish(null);
            finish(matchOg(phtml));
          });
        });
      });
    };

    return new Promise((resolve) => {
      fetchText(url, 4, (err, data) => {
        if (err) return resolve({ error: err.message });
        try {
            const pick = (block, tag) => {
              const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block);
              return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
            };
            const articles = [];
            const itemRe = /<item>([\s\S]*?)<\/item>/g;
            let m;
            while ((m = itemRe.exec(data)) !== null && articles.length < 10) {
              const block = m[1];
              let title = decode(pick(block, 'title'));
              const link = pick(block, 'link');
              const source = decode(pick(block, 'source'));
              // Google titles read "Headline - Source"; drop the trailing source
              if (source && title.endsWith(` - ${source}`)) {
                title = title.slice(0, -(source.length + 3));
              }
              if (title && link) {
                articles.push({
                  title,
                  url: link,
                  source,
                  publishedAt: pick(block, 'pubDate') || new Date().toUTCString(),
                  urlToImage: null
                });
              }
            }
            if (!articles.length) return resolve({ error: 'No articles parsed' });
            // Enrich the top article with a background image for the widget,
            // reusing a cached image URL when we've resolved this story before.
            const top = articles[0];
            if (ogImageCache.has(top.url)) {
              top.urlToImage = ogImageCache.get(top.url);
              return resolve({ articles });
            }
            resolveArticleImage(top.url, (img) => {
              if (img) {
                top.urlToImage = img;
                ogImageCache.set(top.url, img);
                if (ogImageCache.size > 50) ogImageCache.delete(ogImageCache.keys().next().value);
              }
              resolve({ articles });
            });
          } catch (e) {
            resolve({ error: e.message });
          }
      });
    });
  });
}

module.exports = { registerIpcHandlers };
