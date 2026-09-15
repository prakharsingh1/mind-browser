#!/usr/bin/env node
// =============================================================================
// Fetch the Tor Expert Bundle for bundling with Mind Browser
// =============================================================================
// Onion Mode needs a real `tor` binary. This downloads the official Tor Expert
// Bundle from the Tor Project archive, checks it against the SHA256 published
// alongside it, and unpacks it into resources/tor/<platform>-<arch>/.
//
// The checksum is not optional. A Tor binary is the single worst thing in this
// app to get from an unverified source: a swapped binary would look like it
// works while sending every request somewhere of the attacker's choosing.
//
//   node scripts/fetch-tor.js                 newest known version, this arch
//   node scripts/fetch-tor.js 15.0.20         a specific version
//   node scripts/fetch-tor.js 15.0.20 all     every desktop platform
//
// The bundles are also GPG-signed (.asc). Verifying that signature needs the
// Tor Project's key, which is a manual trust decision, so this does not attempt
// it — see README-tor.md.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ARCHIVE = 'https://archive.torproject.org/tor-package-archive/torbrowser';
const DEFAULT_VERSION = '15.0.20';

// electron-builder's platform-arch naming, mapped to the archive's.
const TARGETS = {
  'darwin-arm64': 'macos-aarch64',
  'darwin-x64': 'macos-x86_64',
  'win32-x64': 'windows-x86_64',
  'linux-x64': 'linux-x86_64'
};

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mind-browser-build' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Parse "…  <sha256>  <filename>" lines into a lookup. */
function parseSums(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+(.+?)\s*$/.exec(line.trim());
    if (m) map.set(path.basename(m[2]), m[1]);
  }
  return map;
}

async function fetchOne(version, key, sums) {
  const archiveArch = TARGETS[key];
  const name = `tor-expert-bundle-${archiveArch}-${version}.tar.gz`;
  const dest = path.join(__dirname, '..', 'resources', 'tor', key);

  const expected = sums.get(name);
  if (!expected) throw new Error(`${name} is not listed in the checksum file — wrong version?`);

  process.stdout.write(`  ${key.padEnd(13)} downloading ${name} … `);
  const blob = await get(`${ARCHIVE}/${version}/${name}`);

  const actual = crypto.createHash('sha256').update(blob).digest('hex');
  if (actual !== expected) {
    throw new Error(`CHECKSUM MISMATCH for ${name}\n  expected ${expected}\n  got      ${actual}`);
  }
  process.stdout.write('verified … ');

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tmp = path.join(dest, name);
  fs.writeFileSync(tmp, blob);
  // The bundle is a plain tar.gz; system tar avoids adding a dependency.
  execFileSync('tar', ['-xzf', tmp, '-C', dest]);
  fs.unlinkSync(tmp);

  // The binary lives at tor/tor (plus its own libs) inside the bundle.
  // Keyed off the TARGET, not the host: fetching the Windows bundle from a Mac
  // looked for `tor` and failed on a directory that had unpacked correctly.
  const bin = path.join(dest, 'tor', key.startsWith('win32') ? 'tor.exe' : 'tor');
  if (!fs.existsSync(bin)) throw new Error(`extracted, but no tor binary at ${bin}`);
  fs.chmodSync(bin, 0o755);

  // The Tor Project ships this binary unsigned. macOS on Apple Silicon refuses
  // to run ANY unsigned executable — it is SIGKILLed the instant it starts,
  // which looks like a mysterious crash rather than a signing problem. An
  // ad-hoc signature is enough to satisfy the loader.
  //
  // Only on the host's own platform: signing a Windows or Linux binary from a
  // Mac is neither possible nor meaningful.
  if (process.platform === 'darwin' && key.startsWith('darwin')) {
    // The pluggable transports are separate executables and need signing too,
    // or bridge mode dies the same way the main binary did.
    const ptDir = path.join(dest, 'tor', 'pluggable_transports');
    const pts = fs.existsSync(ptDir)
      ? fs.readdirSync(ptDir)
          .filter((f) => !/\.(json|md|txt)$/i.test(f))
          .map((f) => path.join(ptDir, f))
      : [];
    const toSign = [
      path.join(dest, 'tor', 'libevent-2.1.7.dylib'),
      ...pts,
      bin
    ].filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    for (const f of toSign) {
      try {
        execFileSync('codesign', ['--force', '--sign', '-', f], { stdio: 'ignore' });
      } catch {
        console.warn(`\n  warning: could not sign ${path.basename(f)}; Onion Mode may fail to start.`);
      }
    }
    process.stdout.write('signed … ');
  }

  console.log(`extracted (${(blob.length / 1048576).toFixed(1)} MB)`);
}

(async () => {
  const version = process.argv[2] || DEFAULT_VERSION;
  const all = process.argv[3] === 'all';
  const here = `${process.platform}-${process.arch}`;

  const keys = all ? Object.keys(TARGETS) : [here];
  if (!all && !TARGETS[here]) {
    console.error(`No Tor Expert Bundle mapping for ${here}.`);
    process.exit(1);
  }

  console.log(`Tor Expert Bundle ${version}`);
  console.log('  fetching published checksums …');
  const sums = parseSums((await get(`${ARCHIVE}/${version}/sha256sums-unsigned-build.txt`)).toString('utf8'));

  for (const key of keys) await fetchOne(version, key, sums);

  console.log('\nDone. resources/tor/<platform>-<arch>/tor/tor is now in place.');
  console.log('Onion Mode will use it automatically; without it, it falls back to a system Tor.');
})().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
