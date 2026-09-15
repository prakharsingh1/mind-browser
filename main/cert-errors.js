// =============================================================================
// Local Mind Browser — Certificate errors
// =============================================================================
// Electron's default for a bad certificate is to reject it silently: the page
// fails with a bare network error and the user is told nothing about why. That
// is the worst of both worlds — it looks like the site is broken rather than
// like the connection is untrustworthy, so people retry, switch networks, and
// eventually work around the very warning that was protecting them.
//
// This says what is wrong, in words, and requires an explicit decision.
//
// Exceptions last for the session only. A permanently stored "I trust this
// broken certificate" is how a one-off airport captive portal turns into a
// standing hole months later, so the answer is deliberately forgotten on quit.

const { app, dialog, BrowserWindow } = require('electron');

const allowed = new Set();      // "host\0fingerprint" — session lifetime only
const asking = new Map();       // host -> Promise, so one page cannot stack dialogs

// Chromium's error strings are precise but not readable. These are the cases
// people actually hit, in language that says what to do about it.
const EXPLANATIONS = {
  'net::ERR_CERT_DATE_INVALID':
    'Its security certificate has expired, or your Mac\'s clock is wrong. Check the date and time first.',
  'net::ERR_CERT_AUTHORITY_INVALID':
    'Its security certificate was not issued by an authority your Mac trusts. This is what an intercepted connection looks like.',
  'net::ERR_CERT_COMMON_NAME_INVALID':
    'Its security certificate was issued for a different address, so it may not belong to this site.',
  'net::ERR_CERT_REVOKED':
    'Its security certificate has been revoked. It should not be trusted.',
  'net::ERR_CERT_WEAK_SIGNATURE_ALGORITHM':
    'Its security certificate uses an algorithm that is no longer considered safe.',
  'net::ERR_CERT_SYMANTEC_LEGACY':
    'Its security certificate comes from an authority that is no longer trusted.'
};

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return url; } };

function install() {
  app.on('certificate-error', async (event, webContents, url, error, certificate, callback) => {
    // Always ours to answer — never fall through to Chromium's silent reject.
    event.preventDefault();

    const host = hostOf(url);
    const key = `${host}\0${certificate?.fingerprint || ''}`;

    if (allowed.has(key)) return callback(true);

    // A page with twenty subresources on a bad host must ask once, not twenty
    // times. Everything after the first request waits on the same answer.
    if (!asking.has(host)) {
      asking.set(host, ask(host, error, certificate).finally(() => asking.delete(host)));
    }

    let proceed = false;
    try { proceed = await asking.get(host); } catch { proceed = false; }

    if (proceed) allowed.add(key);
    callback(proceed);
  });
}

async function ask(host, error, certificate) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined;

  const why = EXPLANATIONS[error]
    || 'Its security certificate could not be verified, so there is no way to confirm you are talking to the real site.';

  const issued = certificate?.issuerName ? `\nIssued by: ${certificate.issuerName}` : '';
  const valid = certificate?.validExpiry
    ? `\nExpires: ${new Date(certificate.validExpiry * 1000).toLocaleDateString()}`
    : '';

  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Back to safety', 'Continue anyway'],
      // Safety is both the default and the cancel action, so dismissing the
      // dialog any way at all refuses.
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: `Your connection to ${host} is not private.`,
      detail: `${why}\n\nAnyone on this network could be reading or changing what `
            + `you send. Only continue if you know exactly why this site's `
            + `certificate is wrong.${issued}${valid}\n\n(${error})`
    });
    return response === 1;
  } catch {
    return false;
  }
}

module.exports = { install };
