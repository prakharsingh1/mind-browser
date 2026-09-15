// =============================================================================
// Mind Browser — Main Process Entry Point
// =============================================================================
// Creates the main BrowserWindow, sets up the branded macOS application menu,
// initializes all backend services, and registers IPC handlers.

const { app, BrowserWindow, Menu, ipcMain, globalShortcut, session, clipboard, screen, dialog, shell } = require('electron');

// First, before any other module gets a chance to throw during load.
const crashGuard = require('./crash-guard');
crashGuard.install();

// Every request this browser makes should look like a browser, not like an
// Electron app. The privacy layer already rewrites the User-Agent header when
// masking is switched on; this sets the floor, so the runtime is never named
// even with masking off — and so sites that sniff for a known engine (streaming
// players especially) do not take an unknown-browser fallback path.
app.userAgentFallback = require('./privacy-enforce').GENERIC_UA;
const path = require('path');
const { registerIpcHandlers } = require('./ipc-handlers');
const { initStorage, getSettings, saveSettings } = require('./storage');
const { initContentBlocker } = require('./content-blocker');
const { initMemory } = require('./memory');
const { initScheduler, cleanup: cleanupScheduler } = require('./scheduler');
const { initExtensions, registerExtensionIpc } = require('./extensions');
const { registerNewsHandlers } = require('./news');
const { registerFinanceHandlers } = require('./finance');
const { initDownloads } = require('./downloads');
const { registerNtpHandlers } = require('./ntp');
const { registerProxyHandlers } = require('./proxy');
const { initChromeKeys } = require('./chrome-keys');
const { effectiveFlags } = require('./privacy');
const { initPrivacyEnforcement, applyStartupSwitches } = require('./privacy-enforce');
const { buildMaskScript } = require('./privacy-mask');

// ── Brand Constants ──
const APP_NAME = 'Mind Browser';

// Keep a global reference to prevent garbage collection
let mainWindow = null;

// =============================================================================
// Single Instance Lock
// =============================================================================
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// =============================================================================
// macOS Application Menu (branded as "Mind Browser")
// =============================================================================
function buildAppMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // ── App Menu (macOS only — shows "Mind Browser" in the menu bar) ──
    ...(isMac ? [{
      label: APP_NAME,
      submenu: [
        { label: `About ${APP_NAME}`, role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('open-settings');
          }
        },
        { type: 'separator' },
        { label: `Hide ${APP_NAME}`, role: 'hide' },
        { label: 'Hide Others', role: 'hideOthers' },
        { label: 'Show All', role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${APP_NAME}`, role: 'quit' }
      ]
    }] : []),

    // ── File ──
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-new-tab');
          }
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-close-tab');
          }
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-reopen-tab');
          }
        },
        { type: 'separator' },
        {
          label: 'Downloads',
          accelerator: 'CmdOrCtrl+Shift+J',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-downloads');
          }
        },
        { type: 'separator' },
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            createWindow();
          }
        },
        { type: 'separator' },
        isMac ? { label: 'Close Window', role: 'close' } : { label: 'Exit', role: 'quit' }
      ]
    },

    // ── Edit ──
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', role: 'undo' },
        { label: 'Redo', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { label: 'Select All', role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find…',
          accelerator: 'CmdOrCtrl+F',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-find');
          }
        }
      ]
    },

    // ── View ──
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-toggle-sidebar');
          }
        },
        {
          label: 'Toggle AI Panel',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-toggle-ai');
          }
        },
        {
          label: 'Reading Mode',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-reading-mode');
          }
        },
        {
          label: 'Split View',
          accelerator: 'CmdOrCtrl+\\',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-split-view');
          }
        },
        {
          label: 'Focus Mode',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => mainWindow?.webContents.send('menu-focus-mode')
        },
        { type: 'separator' },
        {
          label: 'Onion Mode (Tor)',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => mainWindow?.webContents.send('menu-onion-mode')
        },
        {
          label: 'History',
          accelerator: 'CmdOrCtrl+Y',
          click: () => mainWindow?.webContents.send('menu-history')
        },
        { type: 'separator' },
        {
          label: 'Edit PDF',
          click: () => mainWindow?.webContents.send('menu-edit-pdf')
        },
        {
          label: 'Print…',
          accelerator: 'CmdOrCtrl+P',
          click: () => mainWindow?.webContents.send('menu-print')
        },
        { type: 'separator' },
        {
          label: 'Task Manager',
          accelerator: 'Shift+Escape',
          click: () => mainWindow?.webContents.send('menu-task-manager')
        },
        { type: 'separator' },
        {
          label: 'Capture Full Page…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow?.webContents.send('menu-capture-full')
        },
        {
          label: 'Capture Visible Area…',
          click: () => mainWindow?.webContents.send('menu-capture-visible')
        },
        {
          label: 'Copy Full Page Screenshot',
          click: () => mainWindow?.webContents.send('menu-capture-copy')
        },
        {
          label: 'Copy Page URL',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => mainWindow?.webContents.send('menu-copy-url')
        },
        { type: 'separator' },
        {
          label: 'Command Palette',
          accelerator: 'CmdOrCtrl+K',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-command-palette');
          }
        },
        { type: 'separator' },
        // These must act on the active PAGE (webview), not the browser chrome —
        // a chrome reload would tear down every open tab.
        {
          label: 'Reload Page',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.send('menu-reload-page')
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => mainWindow?.webContents.send('menu-force-reload')
        },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => mainWindow?.webContents.send('menu-zoom-reset') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => mainWindow?.webContents.send('menu-zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => mainWindow?.webContents.send('menu-zoom-out') },
        { type: 'separator' },
        { label: 'Toggle Full Screen', role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Developer Tools', role: 'toggleDevTools', accelerator: 'Alt+CmdOrCtrl+I' }
      ]
    },

    // ── AI ──
    {
      label: 'AI',
      submenu: [
        {
          label: 'Ask AI…',
          accelerator: 'CmdOrCtrl+J',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-ask-ai');
          }
        },
        {
          label: 'Summarize Page',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-summarize');
          }
        },
        { type: 'separator' },
        {
          label: 'Agent Mode',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-agent-mode');
          }
        },
        {
          label: 'Research Mode',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-research-mode');
          }
        },
        {
          label: 'Compare Tabs',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-compare');
          }
        }
      ]
    },

    // ── Window ──
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', role: 'minimize' },
        { label: 'Zoom', role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { label: 'Bring All to Front', role: 'front' }
        ] : []),
        { type: 'separator' },
        {
          label: 'Next Tab',
          accelerator: 'CmdOrCtrl+Shift+]',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-next-tab');
          }
        },
        {
          label: 'Previous Tab',
          accelerator: 'CmdOrCtrl+Shift+[',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-prev-tab');
          }
        }
      ]
    },

    // ── Help ──
    {
      label: 'Help',
      submenu: [
        {
          label: `${APP_NAME} Help`,
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-help');
          }
        },
        { type: 'separator' },
        {
          label: 'Keyboard Shortcuts',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('open-settings-shortcuts');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// =============================================================================
// Window Creation
// =============================================================================
function createWindow() {
  const isMac = process.platform === 'darwin';

  // The frameless chrome is drawn by the renderer on every platform, but the
  // window controls are not ours to draw:
  //   • macOS — hiddenInset floats the traffic lights over the top-left, and the
  //     renderer reserves 78px there for them.
  //   • Windows/Linux — titleBarOverlay paints the native caption buttons over
  //     the top-right, so the renderer reserves space on that side instead.
  // Getting this wrong on Windows leaves a window with no way to close it.
  const chrome = isMac
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } }
    : {
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#080c09', symbolColor: '#e6f0eb', height: 44 },
        icon: path.join(__dirname, '..', 'build', 'icon.png')
      };

  // Fill the display the app opens on. A fixed 1440x900 left a small window
  // stranded in the corner of anything larger, which is most screens now.
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: screenW,
    height: screenH,
    minWidth: 1024,
    minHeight: 600,
    title: APP_NAME,
    ...chrome,
    backgroundColor: '#080c09',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox stays OFF, and this is a measured trade rather than an
      // oversight. A sandboxed preload may only require Electron's own
      // subset — it cannot load a third-party module, and this preload needs
      // `electron-chrome-extensions/browser-action` to inject the custom
      // element that draws extension toolbar icons. Turning the sandbox on was
      // tried: the window runs, and every extension icon disappears from the
      // toolbar.
      //
      // What the sandbox would protect is already covered another way: this
      // renderer runs no web content. Pages live in <webview> guests with their
      // own preload, contextIsolation is on, nodeIntegration is off, and the
      // chrome document now carries a CSP with no 'unsafe-inline' for script,
      // so there is no path for page content to run code in here.
      sandbox: false,
      spellcheck: true
    }
  });

  // Load the renderer
  // The query is a cache-buster, and it is load-bearing.
  //
  // Rebuilding the app rewrites app.asar and every file inside it moves to a new
  // offset. Something downstream kept offsets from the PREVIOUS archive and
  // applied them to the new one, so the renderer's main document was read
  // starting too early — index.html arrived with the tail of main/storage.js and
  // package.json glued to the front of it, which is exactly the three files that
  // sit next to each other in the archive. A URL that changes every launch
  // cannot be answered from any cache keyed on that URL.
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: { b: String(Date.now()) }
  });

  // The browser chrome itself must never navigate. Dropping a link onto it, or
  // a script reaching the top frame, would otherwise replace the whole
  // interface — every tab, the sidebar and the AI panel — with a web page, and
  // that page would inherit a window holding the privileged preload bridge.
  const chromePath = path.join(__dirname, '..', 'renderer', 'index.html');
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Our own page is reloaded with a changing cache-buster query, so the
    // comparison is on the path, not the whole URL.
    let samePage = false;
    try { samePage = decodeURIComponent(new URL(url).pathname) === chromePath; } catch { /* not a URL */ }
    if (samePage) return;
    event.preventDefault();
    crashGuard.record('blocked chrome navigation', String(url).slice(0, 300));
    routeRequestedUrl(url);          // open it as a tab instead, if it is safe to
  });

  // Same reasoning for a popup opened from the chrome itself.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    routeRequestedUrl(url);
    return { action: 'deny' };
  });

  // Show window once ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// =============================================================================
// App Lifecycle
// =============================================================================

// Set app name for macOS dock & menu bar
app.setName(APP_NAME);

// Chromium reads these once, at launch — after `ready` they are ignored. Hence
// reading settings from disk here rather than through initStorage() below.
try {
  const fsBoot = require('fs');
  const pathBoot = require('path');
  const file = pathBoot.join(app.getPath('userData'), 'local-mind-data', 'settings.json');
  const saved = JSON.parse(fsBoot.readFileSync(file, 'utf8'));
  applyStartupSwitches(effectiveFlags(saved.privacy || {}));
  applyPerformanceSwitches(saved.performance || {});
} catch { /* first run, or unreadable — defaults apply */ }

/**
 * The two settings that genuinely bound how much memory the browser can take.
 * Both are read by Chromium once at launch, which is why they live here and why
 * the settings page tells you a restart is needed.
 */
function applyPerformanceSwitches(perf) {
  // A cap on renderer processes is the single biggest lever on total memory.
  // Chromium's default is sized for a desktop with RAM to spare; past the cap
  // it reuses existing processes instead of spawning more. Tabs still work —
  // they just share, which is exactly the trade people want when they say a
  // browser eats too much RAM.
  const limits = { balanced: 0, strict: 6, minimal: 3 };
  const limit = limits[perf.processLimit] ?? 0;
  if (limit > 0) app.commandLine.appendSwitch('renderer-process-limit', String(limit));

  // GPU rasterisation buys smooth scrolling at the cost of a GPU process and
  // its buffers. On a machine that is swapping, turning it off is a real win.
  if (perf.hardwareAcceleration === false) {
    app.disableHardwareAcceleration();
  }
}

app.whenReady().then(async () => {
  // ── Widevine ──────────────────────────────────────────────────────────────
  // Streaming services (Disney+/Hotstar, Netflix, Prime) will not hand over
  // video without a Content Decryption Module. Stock Electron ships the key
  // system NAMES but no component updater to fetch an actual CDM, so EME is
  // advertised and then fails — which is why a player silently falls back to a
  // lower-quality, unprotected stream instead of playing properly.
  //
  // This build uses castlabs' Electron, which carries Chromium's Widevine
  // component installer. The CDM downloads on first run and is cached, so this
  // await is slow once and instant afterwards. Guarded, because `components`
  // does not exist on stock Electron and the browser must still start there.
  try {
    const { components } = require('electron');
    if (components?.whenReady) {
      await components.whenReady();
      crashGuard.record('widevine', `components ready: ${JSON.stringify(components.status?.() || {})}`);
    }
  } catch (err) {
    // A missing or undownloadable CDM costs protected playback, not the browser.
    crashGuard.record('widevine unavailable', err?.message || String(err));
  }

  // initStorage is synchronous inside (mkdir + default files) — no await needed
  initStorage();

  // Register ALL IPC handlers before the renderer starts loading, so no
  // renderer invoke() can race a not-yet-registered handler.
  registerIpcHandlers(ipcMain, () => mainWindow);
  registerExtensionIpc(ipcMain);
  registerNewsHandlers(ipcMain);
  registerFinanceHandlers(ipcMain);
  initDownloads(ipcMain, () => mainWindow);
  registerNtpHandlers(ipcMain);
  require('./pdf').registerPdfHandlers();
  require('./permissions').registerPermissionIpc();

  // Must run before the window opens: it reads the marker left by the previous
  // run and then claims it for this one.
  require('./session-guard').install();
  require('./cert-errors').install();
  require('./capture').registerCaptureHandlers();
  require('./task-manager').registerTaskManagerHandlers();
  require('./site-info').registerSiteInfoHandlers();
  require('./cert-info').registerCertHandlers();
  // Observes certificates as they verify; changes no verification behaviour.
  require('./cert-info').install(session.defaultSession);
  require('./updater').install();
  ipcMain.handle('session:was-unclean', () => require('./session-guard').wasUnclean());

  // A permission request has to reach a human. The main process asks the
  // window, the window shows the prompt, and the answer comes back here. If no
  // window can answer — none open, or it never replies — the request is denied
  // rather than left hanging.
  // A permission request has to reach a human. A native dialog rather than an
  // HTML one in the renderer: the request arrives on the main process, and
  // bouncing it through the window means a round trip that has to survive the
  // renderer being busy, reloading, or gone. dialog.showMessageBox has none of
  // that exposure, and it is the same thing the OS shows for its own prompts.
  require('./privacy-enforce').setPermissionAsker(async ({ origin, label }) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (!win) return 'deny';

    let site = origin;
    try {
      const u = new URL(origin);
      site = u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : origin;
    } catch { if (origin === 'file://') site = 'A local file'; }

    try {
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Block', 'Allow'],
        // Block is both the default and the cancel action, so dismissing the
        // dialog any way at all refuses rather than grants.
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: `${site} wants to ${label}.`,
        detail: 'You can change this later in Settings.'
      });
      return response === 1 ? 'allow' : 'deny';
    } catch {
      return 'deny';
    }
  });
  require('./devtools').registerDevHandlers();
  require('./reader').registerReaderHandlers();
  require('./pdf').watchForPdfResponses(session.defaultSession, () => mainWindow);
  registerProxyHandlers(ipcMain);
  // Raw key forwarding for chrome-level shortcuts that pages would otherwise eat
  initChromeKeys(() => mainWindow);

  // ── Privacy ───────────────────────────────────────────────────────────────
  // Read fresh on every use so a settings change applies to the next request
  // rather than needing a restart.
  const currentFlags = () => {
    try { return effectiveFlags(getSettings().privacy || {}); } catch { return {}; }
  };
  initPrivacyEnforcement(currentFlags);

  // Encrypted DNS, applied now and again whenever the user changes provider.
  const { applyDnsSettings } = require('./privacy-enforce');
  applyDnsSettings(getSettings().privacy || {});
  ipcMain.handle('privacy:dns-providers', () => require('./privacy').DNS_PROVIDERS);
  ipcMain.handle('privacy:dns-set', (_e, id) => {
    const settings = getSettings();
    settings.privacy = settings.privacy || {};
    settings.privacy.dnsProvider = id;
    saveSettings(settings);
    return applyDnsSettings(settings.privacy);
  });
  const blocker = require('./content-blocker');
  blocker.setPrivacyGate(() => !!currentFlags().blockTrackers);
  blocker.setRequestPrefilter((details) => require('./privacy-enforce').httpsUpgrade(details.url));

  // The settings page renders itself from this, so the levels and the switches
  // it shows are always exactly the ones being enforced.
  // The renderer reports its own uncaught errors here. A broken script in the
  // UI does not kill the app, so these used to fail completely silently —
  // the interface simply stopped responding with nothing written down.
  ipcMain.on('app:renderer-error', (_e, info) => {
    try {
      crashGuard.record('renderer error', typeof info === 'string' ? info : JSON.stringify(info));
    } catch { /* logging must never itself throw */ }
  });

  ipcMain.handle('app:crash-log-path', () => crashGuard.crashLogPath());

  ipcMain.handle('privacy:schema', () => {
    const { LEVELS, CONTROLS, DNS_PROVIDERS } = require('./privacy');
    return { levels: LEVELS, controls: CONTROLS, dnsProviders: DNS_PROVIDERS };
  });

  // Answers the webview preload, which asks before the page's scripts run.
  ipcMain.on('privacy:mask-script', (event) => {
    try {
      // The frame's own URL, not the tab's: an iframe gets its own origin and
      // therefore its own seeds, exactly as a separate site would.
      const { originOf } = require('./privacy-seed');
      const { hostFromUrl, flagsForSite } = require('./privacy');
      const url = event.senderFrame?.url || event.sender?.getURL?.() || '';
      const privacy = getSettings().privacy || {};
      // An excepted site gets the same script minus the page masks, so the
      // rest of its protections stay in force.
      const flags = flagsForSite(privacy, hostFromUrl(url));
      event.returnValue = buildMaskScript(flags, originOf(url));
    } catch { event.returnValue = ''; }
  });

  // ── Onion Mode ────────────────────────────────────────────────────────────
  const onion = require('./onion');
  const tor = require('./tor');
  // Restore the saved bridge choice: someone on a censored network needs it to
  // survive a restart, or Onion Mode silently stops working for them.
  try {
    const pv = getSettings().privacy || {};
    if (pv.torCustomBridges) tor.setCustomBridges(pv.torCustomBridges);
    if (pv.torBridgeMode) tor.setBridgeMode(pv.torBridgeMode);
  } catch { /* defaults are fine */ }
  const pathMod = require('path');

  ipcMain.handle('onion:open', async (event) => {
    // Progress is pushed to whoever asked, so the main window can show it while
    // Tor bootstraps rather than freezing on an unexplained pause.
    const sender = event.sender;
    const res = await onion.openOnionWindow((s) => {
      if (!sender.isDestroyed()) sender.send('onion:status', s);
    });
    return res;
  });

  ipcMain.handle('onion:status', () => tor.status());
  ipcMain.handle('onion:level', () => onion.levelInfo());
  ipcMain.handle('onion:set-level', (_e, l) => onion.setLevel(l));
  // Answers the page preload, which must know the level before page scripts run.
  crashGuard.safeOn(ipcMain, 'onion:level-sync',
    (event) => { event.returnValue = onion.getLevel(); },
    'safer');   // fallback keeps a blocked renderer moving, at the safer default
  // A file URL, not a raw path. The webview's preload attribute is parsed as a
  // URL, so any space in the install path — "…/python things/…" here — makes it
  // invalid, and the preload then fails SILENTLY: the page loads fine with none
  // of the fingerprinting defences applied.
  ipcMain.handle('onion:page-preload', () =>
    require('url').pathToFileURL(pathMod.join(__dirname, 'preload-onion-page.js')).toString());
  ipcMain.handle('onion:available', () => !!tor.findTorBinary());
  ipcMain.handle('onion:close', () => { onion.closeOnionWindow(); return { ok: true }; });
  ipcMain.handle('onion:bridges', () => ({
    mode: tor.getBridgeMode(),
    modes: tor.availableBridgeModes(),
    custom: tor.getCustomBridges()
  }));
  ipcMain.handle('onion:set-bridges', (_e, { mode, custom }) => {
    if (typeof custom === 'string') tor.setCustomBridges(custom);
    if (mode) tor.setBridgeMode(mode);
    const settings = getSettings();
    settings.privacy = settings.privacy || {};
    settings.privacy.torBridgeMode = tor.getBridgeMode();
    settings.privacy.torCustomBridges = tor.getCustomBridges();
    saveSettings(settings);
    return { mode: tor.getBridgeMode(), modes: tor.availableBridgeModes(), custom: tor.getCustomBridges() };
  });

  // "New identity": tor picks fresh circuits after a restart, and restarting is
  // the only way to force it without an open control port.
  ipcMain.handle('onion:new-identity', () => onion.newIdentity());
  ipcMain.handle('onion:new-circuit', async () => {
    tor.stop();
    try { await tor.start(); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // Push status to the onion window itself as it bootstraps.
  tor.onStatus((s) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('onion:status', s);
    }
  });

  // Per-site masking exception, read and written by the Shields popover.
  ipcMain.handle('privacy:site-state', (_e, host) => {
    const { maskingStateFor } = require('./privacy');
    return maskingStateFor(getSettings().privacy || {}, host);
  });

  ipcMain.handle('privacy:site-set', (_e, { host, masked }) => {
    const { normalizeHost, maskingStateFor } = require('./privacy');
    const h = normalizeHost(host);
    if (!h) return null;
    const settings = getSettings();
    settings.privacy = settings.privacy || {};
    const ex = { ...(settings.privacy.siteExceptions || {}) };
    if (masked) delete ex[h]; else ex[h] = true;
    settings.privacy.siteExceptions = ex;
    saveSettings(settings);
    return maskingStateFor(settings.privacy, h);
  });

  // Chrome extensions + Web Store. Must run BEFORE the window loads so the
  // extension-API preload is registered on the session in time.
  initExtensions();

  // Create the main window as early as possible — everything below can
  // finish while the renderer is already painting.
  createWindow();

  buildAppMenu();
  initMemory();
  initScheduler();
  initContentBlocker(session.defaultSession);

  // macOS: recreate window when dock icon clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Route popup/target=_blank links from webviews into a new tab in the renderer.
// (The old `new-window` DOM event no longer exists in modern Electron.)
/**
 * Schemes a web page is allowed to hand us for a new tab.
 *
 * A page calls window.open with whatever it likes. Forwarding that string
 * unchecked meant a hostile page could open `file:///…` and get a local file
 * rendered in a real tab, or hand over a `javascript:` URL. Everything outside
 * this list is refused; mailto: and tel: are passed to the OS instead, which is
 * what the user expects from them.
 */
const TAB_SCHEMES = new Set(['http:', 'https:', 'about:']);
const OS_SCHEMES = new Set(['mailto:', 'tel:', 'sms:', 'facetime:']);

function routeRequestedUrl(url) {
  let scheme;
  try { scheme = new URL(url).protocol.toLowerCase(); } catch { return; }

  if (TAB_SCHEMES.has(scheme)) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('open-url', url);
    return;
  }
  if (OS_SCHEMES.has(scheme)) {
    // shell.openExternal on anything else would be a way for a page to launch
    // arbitrary registered handlers, so the list stays short and explicit.
    shell.openExternal(url).catch(() => {});
    return;
  }
  crashGuard.record('blocked window.open', `scheme=${scheme} url=${String(url).slice(0, 200)}`);
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      routeRequestedUrl(url);
      return { action: 'deny' };
    });

    // Full right-click context menu for web pages (Chrome/Edge-style)
    contents.on('context-menu', (_e, params) => {
      showWebviewContextMenu(contents, params);
    });
  }
});

// Open a URL in the current window as a new tab (routes through the renderer)
function openUrlInNewTab(url) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('open-url', url);
}

// Open a URL in a brand-new browser window (IPC handlers are already registered
// globally and resolve the current window lazily)
function openUrlInNewWindow(url) {
  const win = createWindow();
  win.webContents.once('did-finish-load', () => win.webContents.send('open-url', url));
}

function buildSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function showWebviewContextMenu(contents, params) {
  const template = [];
  const sep = () => template.push({ type: 'separator' });
  const has = (v) => typeof v === 'string' && v.length > 0;

  const linkURL = params.linkURL;
  const isImage = params.mediaType === 'image' && has(params.srcURL);
  const selection = (params.selectionText || '').trim();

  // ── Editable fields: standard edit actions ──
  if (params.isEditable) {
    template.push(
      { label: 'Undo', enabled: params.editFlags.canUndo, click: () => contents.undo() },
      { label: 'Redo', enabled: params.editFlags.canRedo, click: () => contents.redo() },
      { type: 'separator' },
      { label: 'Cut', enabled: params.editFlags.canCut, click: () => contents.cut() },
      { label: 'Copy', enabled: params.editFlags.canCopy, click: () => contents.copy() },
      { label: 'Paste', enabled: params.editFlags.canPaste, click: () => contents.paste() },
      { label: 'Select All', click: () => contents.selectAll() }
    );
    if (selection) {
      sep();
      template.push({ label: `Search Google for “${truncateLabel(selection)}”`, click: () => openUrlInNewTab(buildSearchUrl(selection)) });
    }
  } else {
    // ── Link actions ──
    if (has(linkURL)) {
      template.push(
        { label: 'Open Link in New Tab', click: () => openUrlInNewTab(linkURL) },
        { label: 'Open Link in New Window', click: () => openUrlInNewWindow(linkURL) },
        { type: 'separator' },
        { label: 'Copy Link', click: () => clipboard.writeText(linkURL) },
        { label: 'Save Link As…', click: () => contents.downloadURL(linkURL) }
      );
      sep();
    }

    // ── Image actions ──
    if (isImage) {
      template.push(
        { label: 'Open Image in New Tab', click: () => openUrlInNewTab(params.srcURL) },
        { label: 'Save Image As…', click: () => contents.downloadURL(params.srcURL) },
        { label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) }
      );
      sep();
    }

    // ── Selected text actions ──
    if (selection) {
      template.push(
        { label: 'Copy', click: () => contents.copy() },
        { label: `Search Google for “${truncateLabel(selection)}”`, click: () => openUrlInNewTab(buildSearchUrl(selection)) }
      );
      sep();
    }

    // ── Navigation (only useful on the page itself) ──
    if (!has(linkURL) && !isImage && !selection) {
      template.push(
        { label: 'Back', enabled: contents.navigationHistory ? contents.navigationHistory.canGoBack() : contents.canGoBack(), click: () => contents.goBack() },
        { label: 'Forward', enabled: contents.navigationHistory ? contents.navigationHistory.canGoForward() : contents.canGoForward(), click: () => contents.goForward() },
        { label: 'Reload', click: () => contents.reload() },
        { type: 'separator' },
        { label: 'Save Page As…', click: () => contents.downloadURL(contents.getURL()) },
        { label: 'Print…', click: () => contents.print() },
        { label: 'View Page Source', click: () => openUrlInNewTab(`view-source:${contents.getURL()}`) },
        { type: 'separator' }
      );
    }
  }

  // ── Always available ──
  template.push({ label: 'Inspect', click: () => contents.inspectElement(params.x, params.y) });

  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: mainWindow });
}

function truncateLabel(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Clean up on quit
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  cleanupScheduler();
});

let isQuitting = false;
app.on('before-quit', (e) => {
  // Read via the storage module (in-memory cached) — the old code read a
  // hand-built path that didn't match storage's actual directory, so the
  // "warn before quit" setting never applied.
  let warnBeforeQuit = true;
  try {
    const settings = require('./storage').getSettings();
    if (settings?.appearance?.warnBeforeQuit === false) warnBeforeQuit = false;
  } catch (err) {}

  if (warnBeforeQuit && !isQuitting && mainWindow) {
    e.preventDefault();
    const { dialog } = require('electron');
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Cancel', 'Quit'],
      defaultId: 1,
      cancelId: 0,
      title: 'Confirm Quit',
      message: 'Are you sure you want to quit Mind Browser?',
      detail: 'Pressing ⌘Q will close all tabs and windows.'
    });
    if (choice === 1) {
      isQuitting = true;
      app.quit();
    }
  }
});
