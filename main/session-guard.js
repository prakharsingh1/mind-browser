// =============================================================================
// Local Mind Browser — Unclean shutdown detection
// =============================================================================
// Restoring the last session on request is not the same as recovering from a
// crash, and the browser only did the first. If it went down unexpectedly —
// a kill, a power loss, an OOM — it came back to an empty new tab and the
// user's twenty open tabs were simply gone, because "restore last session" was
// an opt-in startup preference rather than a response to losing them.
//
// The mechanism is deliberately dumb, because it has to work in exactly the
// situations where nothing else does: a marker file is written when the app
// starts and deleted on the way out. If it is still there at the next launch,
// the previous run never reached its exit path.
//
// It is written with the pid and a timestamp so a stale marker from a machine
// that was reset, or from a second copy of the app, can be recognised rather
// than blindly believed.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let markerPath = null;
let uncleanExit = false;

const file = () => {
  if (markerPath) return markerPath;
  try { markerPath = path.join(app.getPath('userData'), 'running.marker'); }
  catch { markerPath = null; }
  return markerPath;
};

/**
 * Read (and then claim) the marker. Call once, early, before the marker for
 * THIS run is written.
 */
function checkPreviousRun() {
  const f = file();
  if (!f) return false;
  try {
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      // A marker whose process is still alive belongs to another running copy
      // of the app, not to a crash of ours.
      let stillRunning = false;
      try { process.kill(raw.pid, 0); stillRunning = raw.pid !== process.pid; }
      catch { stillRunning = false; }
      uncleanExit = !stillRunning;
    }
  } catch {
    // An unreadable marker means something went wrong last time too.
    uncleanExit = true;
  }

  try {
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
  } catch { /* if we cannot write it, we simply will not detect next time */ }

  return uncleanExit;
}

/** Remove the marker. Anything that reaches here counts as a clean exit. */
function markCleanExit() {
  const f = file();
  if (!f) return;
  try { fs.unlinkSync(f); } catch { /* already gone */ }
}

function install() {
  checkPreviousRun();
  // before-quit covers ⌘Q and app.quit(); will-quit covers the rest. Both are
  // cheap and idempotent, so registering both is the safest option.
  app.on('before-quit', markCleanExit);
  app.on('will-quit', markCleanExit);
}

const wasUnclean = () => uncleanExit;

module.exports = { install, wasUnclean, markCleanExit };
