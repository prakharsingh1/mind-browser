// =============================================================================
// Local Mind Browser — Updates
// =============================================================================
// Someone who downloaded a .dmg has no other way to learn that a new version
// exists. Without this, every user is frozen on whatever build they happened to
// install, including through a security fix — which for a browser is the part
// that matters.
//
// The shape is the one people already understand from Chrome: check quietly in
// the background, download in the background, and only then say anything —
// "restart to finish". Nobody is interrupted to be told a download is starting,
// and nobody is ever forced to restart.
//
// It also, incidentally, answers "how many people are using this": each client
// asks the update feed for a file every few hours, so the feed's request logs
// are an active-user count. That is worth knowing, because it means the browser
// does NOT need a separate telemetry channel to answer the question — and a
// privacy browser that shipped analytics to count its users would be paying for
// the number with the thing it sells.

const { app, dialog, BrowserWindow, ipcMain, shell } = require('electron');
const crashGuard = require('./crash-guard');

// Four hours. Long enough not to be chatter, short enough that a security fix
// reaches people the same day.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 25 * 1000;   // let the window finish opening first

let updater = null;
let state = { status: 'idle', version: null, notes: null, error: null };
let timer = null;

const notify = (patch) => {
  state = { ...state, ...patch };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:state', state);
  }
};

/**
 * Is there somewhere to check?
 *
 * The answer comes from app-update.yml, the feed descriptor electron-builder
 * stamps into Resources at package time, because that is the file
 * electron-updater itself reads.
 *
 * It deliberately does NOT consult package.json's `build.publish`. That looks
 * like the obvious source and cannot work: electron-builder strips the whole
 * `build` block out of the package.json it packs into the asar, so inside a
 * shipped app that lookup is always undefined — the check could never pass, in
 * exactly the builds it was meant to describe.
 */
function isConfigured() {
  try {
    const fs = require('fs');
    const path = require('path');
    const feed = path.join(process.resourcesPath || '', 'app-update.yml');
    if (!fs.existsSync(feed)) return false;

    // Small hand-rolled read rather than a YAML dependency: this file is a
    // handful of flat "key: value" lines written by our own build.
    const text = fs.readFileSync(feed, 'utf8');
    const field = (name) => {
      const m = text.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
    };
    const owner = field('owner');
    return Boolean(owner) && !owner.startsWith('CHANGE-ME');
  } catch {
    return false;
  }
}

/**
 * Turn electron-updater's error into something worth showing a person.
 *
 * The default is a wall of text with a full artifact URL and an HttpError code
 * in it. The two cases that actually happen in the wild are "no release has
 * been published yet" (a 404 on the feed file, which is the normal state of a
 * repo before its first release) and "the network is not reachable" — neither
 * of which is a fault the reader can act on, and neither of which should look
 * like a stack trace.
 */
function humanError(err) {
  const raw = String(err?.message || err || '');
  if (/latest-mac\.yml|latest\.yml/i.test(raw) && /404|Cannot find/i.test(raw)) {
    return 'No releases have been published yet.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ENETDOWN|ETIMEDOUT|ECONNREFUSED|net::/i.test(raw)) {
    return 'Could not reach the update server.';
  }
  if (/rate limit/i.test(raw)) return 'GitHub rate-limited the update check. It will try again later.';
  // Anything genuinely unexpected keeps its text, trimmed to one line.
  return raw.split('\n')[0].slice(0, 160) || 'Update check failed.';
}

function install() {
  // An unpackaged run has nothing to update, and electron-updater throws rather
  // than no-oping if asked.
  if (!app.isPackaged) {
    state.status = 'dev';
    registerIpc();
    return;
  }

  // electron-builder only writes app-update.yml once a real publish target is
  // configured. Until then every check throws ENOENT — and because the throw
  // happens inside electron-updater's own promise chain it surfaces as an
  // unhandled rejection every few hours. Better to notice that up front and
  // say so plainly than to log the same failure forever.
  if (!isConfigured()) {
    state.status = 'unconfigured';
    registerIpc();
    return;
  }

  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (err) {
    crashGuard.record('updater unavailable', err?.message || String(err));
    registerIpc();
    return;
  }

  // Any rejection electron-updater does not hand to its own error event.
  updater.on?.('before-quit-for-update', () => {});

  // Download without asking, prompt before restarting. The download is the part
  // that costs the user nothing; the restart is the part that costs them their
  // tabs, so that is the part they get to decide.
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.logger = null;

  updater.on('checking-for-update', () => notify({ status: 'checking', error: null }));
  updater.on('update-not-available', () => notify({ status: 'current' }));
  updater.on('update-available', (info) => notify({ status: 'downloading', version: info?.version || null }));
  updater.on('download-progress', (p) => notify({ status: 'downloading', percent: Math.round(p?.percent || 0) }));

  updater.on('update-downloaded', (info) => {
    notify({ status: 'ready', version: info?.version || null, notes: info?.releaseNotes || null });
    offerRestart(info?.version);
  });

  updater.on('error', (err) => {
    // A failed update check is not worth a dialog: the user did not ask for it,
    // and there is nothing they can do. It goes in the log and the About page.
    crashGuard.record('update check failed', err?.message || String(err));
    notify({ status: 'error', error: humanError(err) });
  });

  timer = setInterval(check, CHECK_INTERVAL_MS);
  setTimeout(check, FIRST_CHECK_DELAY_MS);
  registerIpc();
}

function check() {
  if (!updater) return;
  try { updater.checkForUpdates(); }
  catch (err) { crashGuard.record('update check threw', err?.message || String(err)); }
}

async function offerRestart(version) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (!win) return;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Later', 'Restart now'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
      message: `Mind Browser ${version || ''} is ready to install.`.replace(/\s+/g, ' '),
      detail: 'It will be applied the next time you quit, or you can restart now. '
            + 'Your open tabs will be restored either way.'
    });
    if (response === 1) {
      // isSilent=true, isForceRunAfter=true — no installer UI, relaunch after.
      updater.quitAndInstall(true, true);
    }
  } catch { /* the dialog failing must not break the app */ }
}

function registerIpc() {
  ipcMain.handle('update:state', () => state);
  ipcMain.handle('update:check', () => {
    if (!updater) return state;
    check();
    return state;
  });
  ipcMain.handle('update:install', () => {
    try { updater?.quitAndInstall(true, true); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  // A manual escape hatch for anyone whose auto-update is blocked — by a
  // corporate proxy, or by having moved the app somewhere it cannot write.
  ipcMain.handle('update:open-releases', () => {
    let url = 'https://github.com';
    try {
      const { publish } = require('../package.json').build;
      const gh = (Array.isArray(publish) ? publish : [publish]).find((x) => x?.provider === 'github');
      if (gh?.owner && gh?.repo) url = `https://github.com/${gh.owner}/${gh.repo}/releases/latest`;
    } catch { /* fall back to the bare host */ }
    shell.openExternal(url).catch(() => {});
    return { ok: true, url };
  });
}

module.exports = { install, check };
