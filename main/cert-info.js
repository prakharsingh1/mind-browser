// =============================================================================
// Local Mind Browser — Certificate details
// =============================================================================
// "Is this connection actually secure, and who says so?" A padlock alone does
// not answer that: it says the certificate verified, not who issued it or when
// it expires. Every other browser lets you click through to the details, and a
// browser that leads on privacy should be the last one to hide them.
//
// Electron has no "give me the certificate for this page" call. What it does
// have is setCertificateVerifyProc, which is handed every certificate as it is
// verified. Recording what passes through there gives the details without
// changing any verification behaviour: the proc returns -3, meaning "use
// Chromium's own result", so this observes and decides nothing.

const { ipcMain } = require('electron');

// hostname -> the last certificate seen for it. Bounded, because a long
// browsing session touches a lot of hosts and this is only a convenience.
const seen = new Map();
const MAX_HOSTS = 400;

function remember(hostname, certificate, errorCode) {
  if (!hostname || !certificate) return;
  if (seen.size >= MAX_HOSTS) {
    // Oldest insertion first — Map preserves order, so this is enough.
    const oldest = seen.keys().next().value;
    seen.delete(oldest);
  }
  seen.set(hostname, {
    subject: certificate.subjectName || certificate.subject?.commonName || hostname,
    issuer: certificate.issuerName || certificate.issuer?.commonName || 'Unknown issuer',
    validFrom: certificate.validStart ? certificate.validStart * 1000 : null,
    validTo: certificate.validExpiry ? certificate.validExpiry * 1000 : null,
    fingerprint: certificate.fingerprint || '',
    // 0 means Chromium was happy with it.
    ok: errorCode === 0
  });
}

function install(ses) {
  try {
    ses.setCertificateVerifyProc((request, callback) => {
      remember(request.hostname, request.certificate, request.errorCode);
      // -3: defer to Chromium's own verification. This must never become a
      // callback(0), which would accept every certificate ever presented.
      callback(-3);
    });
  } catch {
    // Some sessions refuse a second proc. Losing the details is acceptable;
    // losing verification would not be, which is why this never falls back to
    // installing a permissive one.
  }
}

function registerCertHandlers() {
  ipcMain.handle('cert:for', (_e, hostname) => {
    const info = seen.get(String(hostname || '').replace(/^www\./, ''))
      || seen.get(String(hostname || ''))
      || null;
    return info;
  });
}

module.exports = { install, registerCertHandlers };
