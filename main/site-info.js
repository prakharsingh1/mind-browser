// =============================================================================
// Local Mind Browser — Site information
// =============================================================================
// What Chrome shows when you click the padlock, and for the same reason: the
// padlock is a claim, and the user should be able to check it. Who issued the
// certificate, when it expires, what this site has stored on the machine, and
// what it has been allowed to do.
//
// Everything here is read-only except the two clear actions, and both of those
// are scoped to a single origin — "clear site data" that quietly signed you out
// of everything else would be worse than not offering it.

const { ipcMain, session } = require('electron');

/** Cookies for a host, counting the parent domain's too (.example.com). */
async function cookieCount(ses, hostname) {
  if (!hostname) return 0;
  try {
    const bare = hostname.replace(/^www\./, '');
    const all = await ses.cookies.get({});
    return all.filter((c) => {
      const d = (c.domain || '').replace(/^\./, '');
      return d === hostname || d === bare || hostname.endsWith(`.${d}`);
    }).length;
  } catch {
    return 0;
  }
}

function registerSiteInfoHandlers() {
  ipcMain.handle('site:info', async (_e, { url }) => {
    try {
      const u = new URL(url);
      const ses = session.defaultSession;

      return {
        ok: true,
        origin: u.origin,
        hostname: u.hostname,
        scheme: u.protocol.replace(':', ''),
        // A local file and an extension page are not "insecure" in the way an
        // http:// site is, and saying so would be misleading.
        secure: u.protocol === 'https:',
        local: u.protocol === 'file:' || u.hostname === 'localhost'
             || u.hostname === '127.0.0.1' || u.hostname === '::1',
        cookies: await cookieCount(ses, u.hostname)
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Cookies plus everything else this origin has put on the machine.
  ipcMain.handle('site:clear', async (_e, { origin }) => {
    try {
      const ses = session.defaultSession;
      await ses.clearStorageData({
        origin,
        storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage']
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerSiteInfoHandlers };
