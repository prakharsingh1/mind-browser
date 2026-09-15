// =============================================================================
// Local Mind Browser — Arc and Zen Importers
// =============================================================================
// The people most likely to try this browser are the ones whose browser just
// died. Arc is on life support and Zen is where a lot of them went, yet nothing
// imports from either — so switching means abandoning your pinned tabs, which
// is the one thing nobody will do.
//
// Neither stores bookmarks in the Chromium JSON format, so each needs its own
// reader. Both are pure JS: no native SQLite dependency, no extra binaries.

const fs = require('fs');
const path = require('path');
const os = require('os');

const homedir = () => os.homedir();

// ── Arc ──────────────────────────────────────────────────────────────────────
// Arc keeps the whole sidebar in one JSON file. Its shape is unusual: `items`
// and `spaces` are FLAT arrays that alternate id-string, object, id-string,
// object… so the objects have to be filtered out rather than indexed by
// position. Pinned tabs are a tree linked by `childrenIds`, and each space
// points at its own pinned root through `containerIDs`, which is itself a flat
// alternating list of the form ["unpinned", <id>, "pinned", <id>].

const ARC_SIDEBAR = () =>
  path.join(homedir(), 'Library', 'Application Support', 'Arc', 'StorableSidebar.json');

/** The id of a space's pinned container, or null. */
function arcPinnedRoot(space) {
  const ids = space?.containerIDs || [];
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === 'pinned' && i + 1 < ids.length) return ids[i + 1];
  }
  return null;
}

function importArc() {
  const file = ARC_SIDEBAR();
  if (!fs.existsSync(file)) return { tree: [], reason: 'Arc is not installed, or it has no saved sidebar.' };

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const containers = data?.sidebar?.containers || [];
  // The first container is global state; the one carrying items is the one we
  // want, and its index is not guaranteed.
  const box = containers.find((c) => c && Array.isArray(c.items) && Array.isArray(c.spaces));
  if (!box) return { tree: [], reason: 'That Arc file has no spaces in it.' };

  const items = new Map();
  for (const entry of box.items) {
    if (entry && typeof entry === 'object' && entry.id) items.set(entry.id, entry);
  }
  const spaces = box.spaces.filter((s) => s && typeof s === 'object' && s.containerIDs);

  // Depth guard: childrenIds is data we did not write, and a cycle would hang
  // the import.
  const walk = (id, seen = new Set(), depth = 0) => {
    if (!id || depth > 24 || seen.has(id)) return null;
    seen.add(id);
    const node = items.get(id);
    if (!node) return null;

    const tab = node.data?.tab;
    const url = tab?.savedURL || tab?.activeTabURL;
    const title = node.title || tab?.savedTitle || '';
    if (url) return { type: 'link', title: title || url, url };

    const children = (node.childrenIds || [])
      .map((k) => walk(k, seen, depth + 1))
      .filter(Boolean);
    return children.length ? { type: 'folder', title: title || 'Folder', children } : null;
  };

  const tree = [];
  for (const space of spaces) {
    const root = arcPinnedRoot(space);
    if (!root) continue;
    const branch = walk(root);
    if (!branch) continue;
    // A space becomes a top-level folder named after itself, so the shape the
    // user built in Arc survives the move.
    tree.push({
      type: 'folder',
      title: space.title || 'Space',
      children: branch.type === 'folder' ? branch.children : [branch]
    });
  }
  return { tree, reason: tree.length ? '' : 'Arc had no pinned tabs to import.' };
}

// ── Zen ──────────────────────────────────────────────────────────────────────
// Zen is Firefox underneath, so bookmarks live in places.sqlite — which would
// mean a native SQLite dependency. Firefox also writes a nightly backup of the
// whole bookmark tree as JSON, compressed with "mozlz4", and that is plain
// LZ4 block format behind an 8-byte magic and a 4-byte length. Decoding it is
// ~40 lines and costs no dependencies at all.

const ZEN_PROFILES = () =>
  path.join(homedir(), 'Library', 'Application Support', 'zen', 'Profiles');

/** LZ4 block decompression. Enough for mozlz4; not a general LZ4 frame reader. */
function lz4Decompress(input, expectedSize) {
  const out = Buffer.alloc(expectedSize);
  let i = 0, o = 0;

  while (i < input.length) {
    const token = input[i++];

    // Literals
    let literalLen = token >> 4;
    if (literalLen === 15) {
      let b;
      do { b = input[i++]; literalLen += b; } while (b === 255);
    }
    input.copy(out, o, i, i + literalLen);
    i += literalLen;
    o += literalLen;
    if (i >= input.length) break;             // last block is literals only

    // Match
    const offset = input[i++] | (input[i++] << 8);
    if (!offset) throw new Error('corrupt lz4 stream');
    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let b;
      do { b = input[i++]; matchLen += b; } while (b === 255);
    }
    matchLen += 4;
    // Byte-by-byte on purpose: matches may overlap the region being written,
    // which is how LZ4 encodes runs, and copy() would read the wrong bytes.
    let from = o - offset;
    for (let n = 0; n < matchLen; n++) out[o++] = out[from++];
  }
  return out.subarray(0, o);
}

function readMozLz4(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).toString('latin1') !== 'mozLz40\0') {
    throw new Error('not a mozlz4 file');
  }
  const size = buf.readUInt32LE(8);
  return lz4Decompress(buf.subarray(12), size).toString('utf8');
}

/** Newest bookmark backup across every Zen profile. */
function newestZenBackup() {
  const root = ZEN_PROFILES();
  if (!fs.existsSync(root)) return null;

  let best = null;
  for (const profile of fs.readdirSync(root)) {
    const dir = path.join(root, profile, 'bookmarkbackups');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonlz4')) continue;
      const full = path.join(dir, name);
      try {
        const mtime = fs.statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { full, mtime };
      } catch { /* unreadable, skip */ }
    }
  }
  return best?.full || null;
}

function importZen() {
  const backup = newestZenBackup();
  if (!backup) {
    return {
      tree: [],
      reason: 'Zen is not installed, or it has not written a bookmark backup yet. Opening Zen once creates one.'
    };
  }

  let root;
  try {
    root = JSON.parse(readMozLz4(backup));
  } catch (err) {
    return { tree: [], reason: `Could not read the Zen backup (${err.message}).` };
  }

  // Firefox nodes: containers have `children`, links carry `uri`. Separators
  // and queries (place: URLs) are neither, and are dropped.
  const convert = (node, depth = 0) => {
    if (!node || depth > 24) return null;
    if (node.uri) {
      if (!/^(https?|ftp):/i.test(node.uri)) return null;
      return { type: 'link', title: node.title || node.uri, url: node.uri };
    }
    const children = (node.children || []).map((c) => convert(c, depth + 1)).filter(Boolean);
    return children.length ? { type: 'folder', title: node.title || 'Folder', children } : null;
  };

  const tree = (root.children || []).map((c) => convert(c)).filter(Boolean);
  return { tree, reason: tree.length ? '' : 'Zen had no bookmarks to import.' };
}

/** Flatten a tree into the legacy flat list callers still expect. */
function flatten(tree, out = []) {
  for (const node of tree) {
    if (node.type === 'link') out.push({ title: node.title, url: node.url });
    else if (node.children) flatten(node.children, out);
  }
  return out;
}

module.exports = { importArc, importZen, flatten, lz4Decompress, readMozLz4 };
