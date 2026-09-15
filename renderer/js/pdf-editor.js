// =============================================================================
// Local Mind Browser — PDF Editor
// =============================================================================
// Chromium's built-in viewer renders PDFs beautifully but cannot create
// annotations — Edge's Draw/Highlight/Note toolbar is Microsoft's own addition
// on top of the same engine. So this is a second, opt-in mode: PDF.js renders
// the pages, an overlay collects marks, and pdf-lib writes them into a real PDF
// that any other reader can open.
//
// Decisions worth stating up front:
//
//   • Marks live in PDF USER SPACE, obtained through the viewport's own
//     transform. Zoom, a Retina panel and a page carrying /Rotate 90 all change
//     the pixel geometry; the document's own coordinates do not. Doing the
//     arithmetic by hand worked until the first rotated scan, which is exactly
//     the kind of file people annotate.
//
//   • Pages render lazily. Rendering all of them up front is fine for a
//     four-page memo and unusable for a 600-page report.
//
//   • "Save" overwrites only a local file the user opened themselves; anything
//     downloaded, and every "Save a copy", goes through a dialog.

import * as pdfjsLib from '../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '../vendor/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Sticky notes and text are laid out to the same measurements on screen, in the
// exported image and in the saved PDF, so all three agree.
const NOTE_MAX_W = 210;      // PDF points
const NOTE_PAD = 5;
const LINE_GAP = 2;

const state = {
  src: null,
  localPath: null,        // set only when the document came from disk
  name: 'document.pdf',
  baseName: 'document',
  bytes: null,            // pristine original, kept for pdf-lib
  doc: null,              // pdf.js document
  pageCache: new Map(),   // n -> pdf.js page

  scale: 1.25,
  fit: null,              // 'width' | 'page' | null
  tool: 'select',
  color: '#ffd23f',
  size: 2.2,

  pages: [],              // per-page DOM + viewport
  marks: [],
  undo: [],
  redo: [],

  rotate: {},             // pageNum -> extra degrees the user asked for
  baseRotate: {},         // pageNum -> the page's own /Rotate
  dropped: new Set(),     // pages to remove on save
  fieldValues: {},        // form field name -> value

  text: new Map(),        // n -> { str, items: [{ s, e, x, y, w, h }] }
  find: { q: '', hits: [], i: -1 },

  signature: null,        // dataURL
  current: 1,
  dirty: false
};

// ── Status line ──────────────────────────────────────────────────────────────
function say(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = kind;
}
const busy = (on, msg = 'Working…') => {
  $('busy').textContent = msg;
  $('busy').classList.toggle('open', on);
};

// ── Load ─────────────────────────────────────────────────────────────────────
async function load() {
  const params = new URLSearchParams(location.search);
  const src = params.get('src');
  if (!src) { say('No document specified.', 'error'); return; }
  state.src = src;

  // Only a document the user opened off their own disk can be saved in place.
  if (src.startsWith('file://')) {
    try { state.localPath = decodeURIComponent(new URL(src).pathname); } catch { /* keep null */ }
  }

  say('Opening…');
  let res;
  try {
    res = await window.localMind.pdfLoad(src);
  } catch (err) {
    say(`Could not open it (${err.message}).`, 'error');
    return;
  }
  if (!res?.ok) { say(res?.error || 'Could not open it.', 'error'); return; }

  state.name = res.name || 'document.pdf';
  state.baseName = state.name.replace(/\s*\(edited\)\.pdf$/i, '').replace(/\.pdf$/i, '');
  state.bytes = new Uint8Array(res.bytes);

  try {
    // pdf.js takes ownership of the buffer it is given and detaches it, which
    // would leave pdf-lib with an empty array at save time. Hand it a copy.
    state.doc = await pdfjsLib.getDocument({ data: state.bytes.slice() }).promise;
  } catch (err) {
    say(`That file could not be read as a PDF (${err.message}).`, 'error');
    return;
  }

  $('pageTotal').textContent = `/ ${state.doc.numPages}`;
  $('save').disabled = false;

  await rebuild();
  say(`${state.doc.numPages} page${state.doc.numPages === 1 ? '' : 's'}. Pick a tool to mark it up.`);

  // Background work — the document is usable before either finishes.
  extractAllText();
  buildThumbs();
}

const getPage = async (n) => {
  if (!state.pageCache.has(n)) state.pageCache.set(n, await state.doc.getPage(n));
  return state.pageCache.get(n);
};

const rotationOf = (page, n) => (page.rotate + (state.rotate[n] || 0) + 360) % 360;

// ── Layout ───────────────────────────────────────────────────────────────────
// Wrappers are created at the right size immediately so the scrollbar is honest
// from the first frame; the expensive part happens when a page nears the view.
let io = null;

async function rebuild() {
  const host = $('pages');
  const keepPage = state.current;

  if (io) io.disconnect();
  host.innerHTML = '';
  state.pages = [];

  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  if (state.fit) await applyFit();

  for (let n = 1; n <= state.doc.numPages; n++) {
    const page = await getPage(n);
    state.baseRotate[n] = page.rotate;
    const viewport = page.getViewport({ scale: state.scale, rotation: rotationOf(page, n) });

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = String(n);
    wrap.style.width = `${Math.floor(viewport.width)}px`;
    wrap.style.height = `${Math.floor(viewport.height)}px`;
    // The text layer positions every span against these, and pdf.js reads them
    // straight out of the cascade.
    wrap.style.setProperty('--scale-factor', String(state.scale));
    wrap.style.setProperty('--total-scale-factor', String(state.scale));
    wrap.classList.toggle('dropped', state.dropped.has(n));

    const canvas = document.createElement('canvas');
    canvas.className = 'page';
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';

    const ink = document.createElement('canvas');
    ink.className = 'ink';
    ink.width = canvas.width;
    ink.height = canvas.height;
    ink.style.width = canvas.style.width;
    ink.style.height = canvas.style.height;

    const forms = document.createElement('div');
    forms.className = 'forms';

    wrap.append(canvas, textDiv, ink, forms);
    host.appendChild(wrap);

    const entry = { num: n, page, viewport, wrap, canvas, textDiv, ink, forms, dpr, painted: false };
    state.pages.push(entry);
    attachTools(entry);
  }

  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const entry = state.pages[Number(e.target.dataset.page) - 1];
      if (entry) renderPage(entry);
    }
  }, { root: $('scroll'), rootMargin: '900px 0px' });
  state.pages.forEach((p) => io.observe(p.wrap));

  updateZoomLabel();
  goToPage(keepPage, false);
}

async function renderPage(entry) {
  if (entry.painted) return;
  entry.painted = true;                       // claim it before the first await
  try {
    await entry.page.render({
      canvasContext: entry.canvas.getContext('2d'),
      viewport: entry.viewport,
      transform: entry.dpr === 1 ? null : [entry.dpr, 0, 0, entry.dpr, 0, 0]
    }).promise;

    // A real text layer buys selection, copy, find, and — because it is in the
    // DOM — the AI panel being able to read the document.
    entry.textDiv.innerHTML = '';
    pdfjsLib.setLayerDimensions(entry.textDiv, entry.viewport);
    await new pdfjsLib.TextLayer({
      textContentSource: entry.page.streamTextContent(),
      container: entry.textDiv,
      viewport: entry.viewport
    }).render();

    await buildFormFields(entry);
    paintPage(entry);
  } catch (err) {
    entry.painted = false;
    console.error('page render failed', entry.num, err);
  }
}

// ── Form fields ──────────────────────────────────────────────────────────────
// Real inputs positioned over the widget rectangles. Filling a form in place is
// most of what people mean by "edit a PDF", and it is the one thing the built-in
// viewer already does that a replacement must not lose.
async function buildFormFields(entry) {
  let anns = [];
  try { anns = await entry.page.getAnnotations({ intent: 'display' }); } catch { return; }
  entry.forms.innerHTML = '';

  for (const a of anns) {
    if (a.subtype !== 'Widget' || a.hidden) continue;
    const name = a.fieldName;
    if (!name) continue;

    const [x0, y0, x1, y1] = a.rect;
    const [vx0, vy0] = entry.viewport.convertToViewportPoint(x0, y0);
    const [vx1, vy1] = entry.viewport.convertToViewportPoint(x1, y1);
    const left = Math.min(vx0, vx1), top = Math.min(vy0, vy1);
    const w = Math.abs(vx1 - vx0), h = Math.abs(vy1 - vy0);

    const stored = state.fieldValues[name];
    let el;

    if (a.fieldType === 'Btn' && !a.pushButton) {
      el = document.createElement('input');
      el.type = 'checkbox';
      el.checked = stored !== undefined ? !!stored : (a.fieldValue && a.fieldValue !== 'Off');
      el.addEventListener('change', () => setField(name, el.checked));
    } else if (a.fieldType === 'Ch') {
      el = document.createElement('select');
      for (const opt of a.options || []) {
        const o = document.createElement('option');
        o.value = opt.exportValue ?? opt.displayValue;
        o.textContent = opt.displayValue;
        el.appendChild(o);
      }
      el.value = stored ?? a.fieldValue ?? '';
      el.addEventListener('change', () => setField(name, el.value));
    } else if (a.fieldType === 'Tx') {
      el = document.createElement('input');
      el.type = 'text';
      el.value = stored ?? (a.fieldValue || '');
      el.addEventListener('input', () => setField(name, el.value));
    } else {
      continue;                                // push buttons and signatures
    }

    if (a.readOnly) el.disabled = true;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    if (el.type === 'checkbox') {
      el.style.width = `${Math.min(w, h)}px`;
      el.style.height = `${Math.min(w, h)}px`;
    } else {
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.fontSize = `${clamp(h * 0.62, 8, 20)}px`;
    }
    entry.forms.appendChild(el);
  }
}

function setField(name, value) {
  state.fieldValues[name] = value;
  state.dirty = true;
  say('Form field updated.');
}

// ── Coordinates ──────────────────────────────────────────────────────────────
// The viewport owns the whole transform — scale, the y-axis flip and any page
// rotation. Going through it is the only way marks land correctly on a rotated
// page, which hand-rolled arithmetic silently got wrong.
function toPdf(entry, clientX, clientY) {
  const r = entry.wrap.getBoundingClientRect();
  const [x, y] = entry.viewport.convertToPdfPoint(clientX - r.left, clientY - r.top);
  return { x, y };
}
const toView = (viewport, p) => viewport.convertToViewportPoint(p.x, p.y);

// ── Marks ────────────────────────────────────────────────────────────────────
let markSeq = 0;
const newId = () => `m${++markSeq}`;

function pushUndo() {
  state.undo.push(JSON.stringify(state.marks));
  if (state.undo.length > 80) state.undo.shift();
  state.redo.length = 0;
  state.dirty = true;
  refreshHistoryButtons();
}
function refreshHistoryButtons() {
  $('t-undo').disabled = !state.undo.length;
  $('t-redo').disabled = !state.redo.length;
}

function addMark(m) {
  pushUndo();
  m.id = newId();
  state.marks.push(m);
  paintAll();
}

// ── Painting ─────────────────────────────────────────────────────────────────
function paintAll() { state.pages.forEach((e) => e.painted && paintPage(e)); }

function paintPage(entry) {
  const ctx = entry.ink.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, entry.ink.width, entry.ink.height);
  paintMarksOn(ctx, entry.viewport, entry.num, entry.dpr);
  paintFindOn(ctx, entry.viewport, entry.num, entry.dpr);
}

/**
 * Draw every mark for one page.
 *
 * Shared by the screen, the image export and the thumbnail, so what you see is
 * what lands in a PNG — one code path, no chance of them drifting apart.
 */
function paintMarksOn(ctx, viewport, pageNum, k) {
  const unit = viewport.scale * k;                  // PDF points -> device px
  const dev = (p) => { const [x, y] = toView(viewport, p); return [x * k, y * k]; };

  for (const m of state.marks) {
    if (m.page !== pageNum) continue;
    ctx.save();
    ctx.strokeStyle = m.color;
    ctx.fillStyle = m.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (m.type === 'quads') {
      ctx.globalAlpha = 0.38;
      for (const r of m.rects) {
        const [ax, ay] = dev({ x: r.x0, y: r.y0 });
        const [bx, by] = dev({ x: r.x1, y: r.y1 });
        ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      }
    } else if (m.type === 'ink' || m.type === 'highlight') {
      ctx.globalAlpha = m.type === 'highlight' ? 0.38 : 1;
      ctx.lineWidth = (m.type === 'highlight' ? 14 : m.size) * unit;
      ctx.beginPath();
      m.points.forEach((p, i) => {
        const [x, y] = dev(p);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    } else if (m.type === 'rect') {
      const [ax, ay] = dev(m.a);
      const [bx, by] = dev(m.b);
      ctx.lineWidth = m.size * unit;
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    } else if (m.type === 'image' && imageCache.has(m.id)) {
      const [ax, ay] = dev(m.a);
      const [bx, by] = dev(m.b);
      ctx.drawImage(imageCache.get(m.id),
        Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    } else if (m.type === 'note' || m.type === 'text') {
      paintTextMark(ctx, viewport, m, k, unit, dev);
    }
    ctx.restore();
  }
}

function paintTextMark(ctx, viewport, m, k, unit, dev) {
  const size = m.size || 10;
  const lines = wrapToWidth(m.text, size, NOTE_MAX_W - NOTE_PAD * 2);
  const lineH = size + LINE_GAP;
  const boxH = m.type === 'note' ? lines.length * lineH + NOTE_PAD * 2 : lines.length * lineH;
  const boxW = m.type === 'note'
    ? Math.min(NOTE_MAX_W, Math.max(50, measureMax(lines, size) + NOTE_PAD * 2))
    : measureMax(lines, size);

  // Remembered so the eraser can hit-test exactly what was drawn.
  m._box = { w: boxW, h: boxH };

  const [ax, ay] = dev(m.at);
  ctx.save();
  ctx.translate(ax, ay);
  // Text has to stay upright for the reader, so it turns with the page.
  ctx.rotate((viewport.rotation % 360) * Math.PI / 180);

  if (m.type === 'note') {
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = m.color;
    ctx.fillRect(0, 0, boxW * unit, boxH * unit);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#2a2205';
  } else {
    ctx.fillStyle = m.color;
  }

  ctx.font = `${size * unit}px Helvetica, Arial, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  const padX = m.type === 'note' ? NOTE_PAD : 0;
  lines.forEach((line, i) => {
    ctx.fillText(line, padX * unit, (padX + size + i * lineH) * unit);
  });
  ctx.restore();
}

// Helvetica's metrics are close enough to the canvas default that measuring
// once here keeps screen and saved file in step.
let measureCtx = null;
function measureText(s, size) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${size}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(s).width;
}
const measureMax = (lines, size) => Math.max(0, ...lines.map((l) => measureText(l, size)));

function wrapToWidth(text, size, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measureText(next, size) > maxW) { out.push(line); line = word; }
      else line = next;
    }
    out.push(line);
  }
  return out.slice(0, 40);
}

// ── Tools ────────────────────────────────────────────────────────────────────
const imageCache = new Map();      // mark id -> HTMLImageElement

function attachTools(entry) {
  let active = null;

  const start = (e) => {
    if (state.tool === 'select' || state.tool === 'highlight') return;
    if (state.dropped.has(entry.num)) return say('That page is marked for removal.');

    if (state.tool === 'erase') { eraseAt(entry, e); return; }
    if (state.tool === 'note' || state.tool === 'text') {
      // Without this the default focus change that follows pointerdown blurs
      // the box the moment it appears, committing it empty.
      e.preventDefault();
      openTextBox(entry, e);
      return;
    }
    if (state.tool === 'sign' && !state.signature) { openSignaturePad(); return; }

    e.preventDefault();
    entry.ink.setPointerCapture?.(e.pointerId);
    const at = toPdf(entry, e.clientX, e.clientY);

    if (state.tool === 'rect' || state.tool === 'sign') {
      active = { page: entry.num, type: state.tool === 'sign' ? 'image' : 'rect', color: state.color, size: state.size, a: at, b: at };
      if (state.tool === 'sign') active.dataUrl = state.signature;
    } else {
      active = { page: entry.num, type: 'ink', color: state.color, size: state.size, points: [at] };
    }
  };

  const move = (e) => {
    if (!active) return;
    const at = toPdf(entry, e.clientX, e.clientY);
    if (active.points) active.points.push(at); else active.b = at;
    paintPage(entry);
    previewOn(entry, active);
  };

  const end = () => {
    if (!active) return;
    const done = active;
    active = null;

    // A click with no drag is not a mark; discard rather than leave a dot.
    const tiny = done.points
      ? done.points.length < 2
      : Math.abs(done.b.x - done.a.x) < 3 && Math.abs(done.b.y - done.a.y) < 3;
    if (tiny) { paintPage(entry); return; }

    if (done.type === 'image') {
      addMark(done);                       // assigns the id the cache is keyed on
      const img = new Image();
      img.onload = () => { imageCache.set(done.id, img); paintPage(entry); };
      img.src = done.dataUrl;
      say('Signature placed.');
      return;
    }
    addMark(done);
    say('Marked. Save when you are done.');
  };

  entry.ink.addEventListener('pointerdown', start);
  entry.ink.addEventListener('pointermove', move);
  entry.ink.addEventListener('pointerup', end);
  entry.ink.addEventListener('pointercancel', end);

  // Highlighting rides on a real text selection, the way Edge and Acrobat do
  // it, so a highlight follows the line rather than the shake of your hand.
  entry.textDiv.addEventListener('mouseup', () => {
    if (state.tool !== 'highlight') return;
    setTimeout(() => highlightSelection(entry), 0);
  });
}

function previewOn(entry, m) {
  const ctx = entry.ink.getContext('2d');
  const saved = state.marks;
  state.marks = [m];
  paintMarksOn(ctx, entry.viewport, entry.num, entry.dpr);
  state.marks = saved;
}

function highlightSelection(entry) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!entry.textDiv.contains(range.commonAncestorContainer)) return;

  const wrapRect = entry.wrap.getBoundingClientRect();
  const rects = [];
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const [x0, y0] = entry.viewport.convertToPdfPoint(r.left - wrapRect.left, r.top - wrapRect.top);
    const [x1, y1] = entry.viewport.convertToPdfPoint(r.right - wrapRect.left, r.bottom - wrapRect.top);
    rects.push({ x0, y0, x1, y1 });
  }
  if (!rects.length) return;

  addMark({ page: entry.num, type: 'quads', color: state.color, rects });
  sel.removeAllRanges();
  say(`Highlighted ${rects.length} line${rects.length === 1 ? '' : 's'}.`);
}

// ── Erase ────────────────────────────────────────────────────────────────────
function eraseAt(entry, e) {
  const p = toPdf(entry, e.clientX, e.clientY);
  const tol = 6 / state.scale;

  for (let i = state.marks.length - 1; i >= 0; i--) {
    const m = state.marks[i];
    if (m.page !== entry.num) continue;
    if (hits(m, p, tol)) {
      pushUndo();
      state.marks.splice(i, 1);
      paintAll();
      say('Mark removed.');
      return;
    }
  }
  say('Nothing to erase there.');
}

function hits(m, p, tol) {
  const inBox = (x0, y0, x1, y1) =>
    p.x >= Math.min(x0, x1) - tol && p.x <= Math.max(x0, x1) + tol &&
    p.y >= Math.min(y0, y1) - tol && p.y <= Math.max(y0, y1) + tol;

  if (m.type === 'quads') return m.rects.some((r) => inBox(r.x0, r.y0, r.x1, r.y1));
  if (m.type === 'rect' || m.type === 'image') return inBox(m.a.x, m.a.y, m.b.x, m.b.y);
  if (m.type === 'note' || m.type === 'text') {
    const b = m._box || { w: 80, h: 20 };
    return inBox(m.at.x, m.at.y, m.at.x + b.w, m.at.y - b.h);
  }
  if (m.points) {
    const r = (m.type === 'highlight' ? 14 : m.size) / 2 + tol;
    return m.points.some((q, i) => {
      if (!i) return Math.hypot(q.x - p.x, q.y - p.y) <= r;
      return distToSeg(p, m.points[i - 1], q) <= r;
    });
  }
  return false;
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ── Note / text entry ────────────────────────────────────────────────────────
function openTextBox(entry, e) {
  const at = toPdf(entry, e.clientX, e.clientY);
  const r = entry.wrap.getBoundingClientRect();
  const isNote = state.tool === 'note';

  const box = document.createElement('textarea');
  box.className = 'note-edit';
  box.style.left = `${e.clientX - r.left}px`;
  box.style.top = `${e.clientY - r.top}px`;
  box.style.width = `${NOTE_MAX_W * state.scale}px`;
  box.placeholder = isNote ? 'Type a note…' : 'Type text…';
  if (isNote) {
    box.style.background = state.color;
  } else {
    box.style.background = 'rgba(255,255,255,0.94)';
    box.style.color = state.color;
  }
  entry.wrap.appendChild(box);

  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const text = box.value.trim();
    box.remove();
    if (!keep || !text) return;
    addMark({
      page: entry.num,
      type: isNote ? 'note' : 'text',
      color: state.color,
      at,
      text,
      size: isNote ? 10 : clamp(state.size * 4.5, 9, 34)
    });
    say(isNote ? 'Note added.' : 'Text added.');
  };

  // Focus on the next frame and only listen for blur once it has landed, so
  // nothing left over from the opening click closes it.
  requestAnimationFrame(() => {
    box.focus();
    box.addEventListener('blur', () => finish(true));
  });
  box.addEventListener('keydown', (ev) => {
    ev.stopPropagation();                       // keep ⌘Z and Esc out of the doc
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); }
  });
}

// ── Signature ────────────────────────────────────────────────────────────────
function openSignaturePad() {
  const pad = $('sigPad');
  const ctx = pad.getContext('2d');
  ctx.clearRect(0, 0, pad.width, pad.height);
  ctx.lineWidth = 4.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#12131a';
  let drawing = false, any = false;

  const at = (e) => {
    const r = pad.getBoundingClientRect();
    return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)];
  };
  pad.onpointerdown = (e) => { drawing = true; any = true; pad.setPointerCapture(e.pointerId); const [x, y] = at(e); ctx.beginPath(); ctx.moveTo(x, y); };
  pad.onpointermove = (e) => { if (!drawing) return; const [x, y] = at(e); ctx.lineTo(x, y); ctx.stroke(); };
  pad.onpointerup = () => { drawing = false; };

  $('sigClear').onclick = () => { ctx.clearRect(0, 0, pad.width, pad.height); any = false; };
  $('sigCancel').onclick = () => $('sigScrim').classList.remove('open');
  $('sigUse').onclick = () => {
    if (!any) return say('Draw a signature first.');
    state.signature = trimTransparent(pad);
    $('sigScrim').classList.remove('open');
    setTool('sign');
    say('Signature ready — drag on the page to place it.');
  };

  $('sigScrim').classList.add('open');
}

/** Crop the blank margin so the stamp is the signature, not the whole pad. */
function trimTransparent(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 <= x0 || y1 <= y0) return canvas.toDataURL('image/png');
  const pad = 8;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0; out.height = y1 - y0;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

// ── Text extraction, search ──────────────────────────────────────────────────
async function extractAllText() {
  const parts = [];
  for (let n = 1; n <= state.doc.numPages; n++) {
    try {
      const page = await getPage(n);
      const content = await page.getTextContent();
      let str = '';
      const items = [];
      for (const it of content.items) {
        if (typeof it.str !== 'string') continue;
        const t = it.transform;
        const s = str.length;
        str += it.str;
        items.push({
          s, e: str.length,
          x: t[4], y: t[5],
          w: it.width || 0,
          h: it.height || Math.abs(t[3]) || 10
        });
        if (it.hasEOL) str += '\n';
      }
      state.text.set(n, { str, items });
      parts.push(str);
    } catch { state.text.set(n, { str: '', items: [] }); }
  }
  // Put the whole document in the DOM so find-in-page and the AI panel see all
  // of it, not just the handful of pages currently rendered.
  $('alltext').textContent = parts.join('\n\n');
}

function runFind(q) {
  state.find.q = q;
  state.find.hits = [];
  state.find.i = -1;
  if (q.trim().length) {
    const needle = q.toLowerCase();
    for (let n = 1; n <= state.doc.numPages; n++) {
      const t = state.text.get(n);
      if (!t?.str) continue;
      const hay = t.str.toLowerCase();
      let from = 0, at;
      while ((at = hay.indexOf(needle, from)) !== -1) {
        state.find.hits.push({ page: n, start: at, end: at + needle.length });
        from = at + needle.length;
        if (state.find.hits.length > 2000) break;
      }
    }
  }
  $('findCount').textContent = state.find.hits.length
    ? `1 of ${state.find.hits.length}`
    : (q.trim() ? 'No matches' : '');
  if (state.find.hits.length) stepFind(0); else paintAll();
}

function stepFind(delta) {
  const { hits } = state.find;
  if (!hits.length) return;
  state.find.i = (state.find.i + delta + hits.length) % hits.length;
  const hit = hits[state.find.i];
  $('findCount').textContent = `${state.find.i + 1} of ${hits.length}`;
  goToPage(hit.page, true);
  paintAll();
}

/** Rectangles, in PDF space, covering one match. */
function rectsForHit(hit) {
  const t = state.text.get(hit.page);
  if (!t) return [];
  const out = [];
  for (const it of t.items) {
    if (it.e <= hit.start || it.s >= hit.end) continue;
    const len = it.e - it.s;
    if (!len) continue;
    const a = Math.max(0, hit.start - it.s) / len;
    const b = Math.min(len, hit.end - it.s) / len;
    out.push({ x0: it.x + it.w * a, y0: it.y, x1: it.x + it.w * b, y1: it.y + it.h });
  }
  return out;
}

function paintFindOn(ctx, viewport, pageNum, k) {
  if (!state.find.hits.length) return;
  const dev = (x, y) => { const [vx, vy] = viewport.convertToViewportPoint(x, y); return [vx * k, vy * k]; };

  state.find.hits.forEach((hit, idx) => {
    if (hit.page !== pageNum) return;
    ctx.save();
    ctx.globalAlpha = idx === state.find.i ? 0.55 : 0.3;
    ctx.fillStyle = idx === state.find.i ? '#ff9500' : '#ffe066';
    for (const r of rectsForHit(hit)) {
      const [ax, ay] = dev(r.x0, r.y0);
      const [bx, by] = dev(r.x1, r.y1);
      ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    }
    ctx.restore();
  });
}

// ── Thumbnails ───────────────────────────────────────────────────────────────
async function buildThumbs() {
  const host = $('thumbs');
  host.innerHTML = '';
  for (let n = 1; n <= state.doc.numPages; n++) {
    const cell = document.createElement('div');
    cell.className = 'thumb';
    cell.dataset.page = String(n);
    const c = document.createElement('canvas');
    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = String(n);
    cell.append(c, label);
    cell.addEventListener('click', () => goToPage(n, true));
    host.appendChild(cell);
  }
  // Draw them one at a time so the sidebar fills in without blocking input.
  for (let n = 1; n <= state.doc.numPages; n++) {
    await drawThumb(n);
    await new Promise((r) => setTimeout(r, 0));
  }
  markCurrentThumb();
}

async function drawThumb(n) {
  const cell = $('thumbs').querySelector(`.thumb[data-page="${n}"]`);
  if (!cell) return;
  const c = cell.querySelector('canvas');
  const page = await getPage(n);
  const vp = page.getViewport({ scale: 1, rotation: rotationOf(page, n) });
  const scale = 140 / vp.width;
  const viewport = page.getViewport({ scale, rotation: rotationOf(page, n) });
  c.width = Math.floor(viewport.width);
  c.height = Math.floor(viewport.height);
  try {
    await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;
    paintMarksOn(c.getContext('2d'), viewport, n, 1);
  } catch { /* a thumbnail is not worth surfacing an error for */ }
  cell.classList.toggle('dropped', state.dropped.has(n));
}

function markCurrentThumb() {
  $('thumbs').querySelectorAll('.thumb').forEach((t) => {
    const on = Number(t.dataset.page) === state.current;
    t.classList.toggle('current', on);
    if (on) t.scrollIntoView({ block: 'nearest' });
  });
}

// ── Navigation and zoom ──────────────────────────────────────────────────────
function goToPage(n, scroll) {
  n = clamp(n, 1, state.doc.numPages);
  state.current = n;
  $('pageNum').value = String(n);
  markCurrentThumb();
  if (scroll) {
    const entry = state.pages[n - 1];
    if (entry) {
      renderPage(entry);
      entry.wrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }
}

$('scroll').addEventListener('scroll', () => {
  // Whichever page covers the middle of the viewport is the one you are on.
  const mid = $('scroll').getBoundingClientRect().top + $('scroll').clientHeight / 2;
  for (const e of state.pages) {
    const r = e.wrap.getBoundingClientRect();
    if (r.top <= mid && r.bottom >= mid) {
      if (state.current !== e.num) { state.current = e.num; $('pageNum').value = String(e.num); markCurrentThumb(); }
      break;
    }
  }
}, { passive: true });

async function applyFit() {
  const page = await getPage(state.current);
  const vp = page.getViewport({ scale: 1, rotation: rotationOf(page, state.current) });
  const avail = $('scroll').clientWidth - 48;
  const availH = $('scroll').clientHeight - 48;
  state.scale = state.fit === 'width'
    ? clamp(avail / vp.width, 0.2, 6)
    : clamp(Math.min(avail / vp.width, availH / vp.height), 0.2, 6);
}

function updateZoomLabel() {
  const pick = $('zoomPick');
  if (state.fit) { pick.value = `fit-${state.fit}`; return; }
  const v = String(state.scale);
  pick.value = [...pick.options].some((o) => o.value === v) ? v : '';
}

async function setZoom(value) {
  if (value === 'fit-width' || value === 'fit-page') state.fit = value.slice(4);
  else { state.fit = null; state.scale = Number(value); }
  await rebuild();
}

const stepZoom = async (factor) => {
  state.fit = null;
  state.scale = clamp(state.scale * factor, 0.2, 6);
  await rebuild();
};

// ── Page operations ──────────────────────────────────────────────────────────
async function pageAction(act) {
  const n = state.current;
  if (act === 'rot-left' || act === 'rot-right') {
    state.rotate[n] = ((state.rotate[n] || 0) + (act === 'rot-left' ? -90 : 90) + 360) % 360;
    state.dirty = true;
    await rebuild();
    drawThumb(n);
    say(`Page ${n} rotated.`);
  } else if (act === 'rot-all-right') {
    for (let i = 1; i <= state.doc.numPages; i++) state.rotate[i] = ((state.rotate[i] || 0) + 90) % 360;
    state.dirty = true;
    await rebuild();
    buildThumbs();
    say('Every page rotated.');
  } else if (act === 'drop') {
    if (state.dropped.size + 1 >= state.doc.numPages) return say('A PDF needs at least one page.', 'error');
    state.dropped.add(n);
    state.dirty = true;
    state.pages[n - 1]?.wrap.classList.add('dropped');
    drawThumb(n);
    say(`Page ${n} will be removed when you save.`);
  } else if (act === 'restore') {
    state.dropped.delete(n);
    state.pages[n - 1]?.wrap.classList.remove('dropped');
    drawThumb(n);
    say(`Page ${n} kept.`);
  } else if (act === 'restore-all') {
    const had = state.dropped.size;
    state.dropped.clear();
    state.pages.forEach((e) => e.wrap.classList.remove('dropped'));
    buildThumbs();
    say(had ? 'All pages restored.' : 'No pages were removed.');
  }
}

// ── Export ───────────────────────────────────────────────────────────────────
const keptPages = () =>
  Array.from({ length: state.doc.numPages }, (_, i) => i + 1).filter((n) => !state.dropped.has(n));

/** Render one page, marks included, to a canvas at the requested scale. */
async function pageToCanvas(n, scale) {
  const page = await getPage(n);
  const viewport = page.getViewport({ scale, rotation: rotationOf(page, n) });
  const c = document.createElement('canvas');
  c.width = Math.floor(viewport.width);
  c.height = Math.floor(viewport.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  paintMarksOn(ctx, viewport, n, 1);
  return c;
}

const canvasBytes = (canvas, mime, quality) => new Promise((resolve, reject) => {
  canvas.toBlob(async (b) => {
    if (!b) return reject(new Error('the page could not be encoded as an image'));
    resolve(new Uint8Array(await b.arrayBuffer()));
  }, mime, quality);
});

async function exportImages(format) {
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const pages = keptPages();
  busy(true, `Rendering ${pages.length} page${pages.length === 1 ? '' : 's'}…`);
  try {
    const files = [];
    const pad = String(pages.length).length;
    for (const n of pages) {
      const c = await pageToCanvas(n, 2);       // ~144 dpi, a sensible default
      files.push({
        name: `${state.baseName} - page ${String(n).padStart(pad, '0')}.${format}`,
        bytes: Array.from(await canvasBytes(c, mime, 0.92))
      });
    }
    const res = await window.localMind.fileSaveMany({ files, folderName: `${state.baseName} pages` });
    if (res?.ok) say(`Exported ${res.count} images to ${res.path}`, 'ok');
    else if (res?.cancelled) say('Export cancelled.');
    else say(res?.error || 'Could not export.', 'error');
  } catch (err) {
    say(`Export failed (${err.message}).`, 'error');
  } finally { busy(false); }
}

async function exportOneImage() {
  busy(true, 'Rendering page…');
  try {
    const c = await pageToCanvas(state.current, 2);
    const bytes = Array.from(await canvasBytes(c, 'image/png'));
    const res = await window.localMind.fileSaveAs({
      bytes, name: `${state.baseName} - page ${state.current}.png`, extension: 'png', label: 'PNG image'
    });
    if (res?.ok) say(`Saved ${res.path}`, 'ok');
    else if (res?.cancelled) say('Export cancelled.');
    else say(res?.error || 'Could not export.', 'error');
  } catch (err) {
    say(`Export failed (${err.message}).`, 'error');
  } finally { busy(false); }
}

async function exportPptx() {
  if (!window.PptxGenJS) return say('The PowerPoint exporter did not load.', 'error');
  const pages = keptPages();
  busy(true, 'Building the deck…');
  try {
    const first = await getPage(pages[0]);
    const fvp = first.getViewport({ scale: 1, rotation: rotationOf(first, pages[0]) });
    const W = fvp.width / 72, H = fvp.height / 72;      // points -> inches

    const pptx = new window.PptxGenJS();
    pptx.defineLayout({ name: 'PDFPAGE', width: W, height: H });
    pptx.layout = 'PDFPAGE';
    pptx.title = state.baseName;

    for (const n of pages) {
      const c = await pageToCanvas(n, 2);
      const slide = pptx.addSlide();
      // Pages of a different size are fitted and centred rather than stretched.
      const ar = c.width / c.height;
      let w = W, h = W / ar;
      if (h > H) { h = H; w = H * ar; }
      slide.addImage({ data: c.toDataURL('image/png'), x: (W - w) / 2, y: (H - h) / 2, w, h });
    }

    const blob = await pptx.write({ outputType: 'blob' });
    const res = await window.localMind.fileSaveAs({
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      name: `${state.baseName}.pptx`, extension: 'pptx', label: 'PowerPoint'
    });
    if (res?.ok) say(`Saved ${res.path}`, 'ok');
    else if (res?.cancelled) say('Export cancelled.');
    else say(res?.error || 'Could not export.', 'error');
  } catch (err) {
    say(`PowerPoint export failed (${err.message}).`, 'error');
  } finally { busy(false); }
}

async function exportDocx() {
  const lib = window.docx;
  if (!lib) return say('The Word exporter did not load.', 'error');
  busy(true, 'Building the document…');
  try {
    const { Document, Packer, Paragraph, TextRun, PageBreak } = lib;
    const children = [];
    const pages = keptPages();

    pages.forEach((n, idx) => {
      const t = state.text.get(n);
      const body = (t?.str || '').split('\n');
      for (const line of body) {
        children.push(new Paragraph({ children: [new TextRun(line)] }));
      }
      // Notes and text marks are part of the document now, so they come along.
      const notes = state.marks.filter((m) => m.page === n && (m.type === 'note' || m.type === 'text'));
      if (notes.length) {
        children.push(new Paragraph({ children: [new TextRun({ text: 'Annotations', bold: true })] }));
        for (const m of notes) children.push(new Paragraph({ children: [new TextRun(`• ${m.text}`)] }));
      }
      if (idx < pages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
    });

    const doc = new Document({ sections: [{ children }] });
    const blob = await Packer.toBlob(doc);
    const res = await window.localMind.fileSaveAs({
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      name: `${state.baseName}.docx`, extension: 'docx', label: 'Word document'
    });
    if (res?.ok) say(`Saved ${res.path}`, 'ok');
    else if (res?.cancelled) say('Export cancelled.');
    else say(res?.error || 'Could not export.', 'error');
  } catch (err) {
    say(`Word export failed (${err.message}).`, 'error');
  } finally { busy(false); }
}

async function exportText() {
  const pages = keptPages();
  const out = pages.map((n) => state.text.get(n)?.str || '').join('\n\n');
  const res = await window.localMind.fileSaveAs({
    bytes: Array.from(new TextEncoder().encode(out)),
    name: `${state.baseName}.txt`, extension: 'txt', label: 'Plain text'
  });
  if (res?.ok) say(`Saved ${res.path}`, 'ok');
  else if (res?.cancelled) say('Export cancelled.');
  else say(res?.error || 'Could not export.', 'error');
}

// ── Save ─────────────────────────────────────────────────────────────────────
// Helvetica can only encode WinAnsi. A pasted em-dash or an emoji would
// otherwise throw part-way through the save and lose every mark, so translate
// the characters people actually type and drop the rest.
function winAnsi(text) {
  return String(text)
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/\t/g, '    ')
    // Anything left that Helvetica cannot draw becomes a visible placeholder;
    // silently deleting it would hide the fact that something was lost.
    .replace(/[^\x20-\x7E¡-ÿ\n]/g, '?');
}

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return {
    r: parseInt(v.slice(0, 2), 16) / 255,
    g: parseInt(v.slice(2, 4), 16) / 255,
    b: parseInt(v.slice(4, 6), 16) / 255
  };
};

async function save(mode) {
  if (!state.bytes) return;
  const overwrite = mode === 'overwrite' ? state.localPath : null;
  if (mode === 'overwrite' && !overwrite) {
    say('This document was not opened from a file — saving a copy instead.');
  }

  $('save').disabled = true;
  busy(true, 'Saving…');

  try {
    const { PDFDocument, rgb, degrees, StandardFonts } = PDFLib;
    // Plenty of ordinary documents carry owner-password encryption that only
    // encodes permissions. pdf-lib refuses those by default, which would make
    // the editor fail on files the viewer opened happily.
    const doc = await PDFDocument.load(state.bytes, { ignoreEncryption: true });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();

    // ── Form values ───────────────────────────────────────────────────────
    if (Object.keys(state.fieldValues).length) {
      try {
        const form = doc.getForm();
        for (const field of form.getFields()) {
          const name = field.getName();
          if (!(name in state.fieldValues)) continue;
          const v = state.fieldValues[name];
          const kind = field.constructor.name;
          if (kind === 'PDFTextField') field.setText(String(v ?? ''));
          else if (kind === 'PDFCheckBox') v ? field.check() : field.uncheck();
          else if (kind === 'PDFDropdown' || kind === 'PDFOptionList') field.select(String(v));
          else if (kind === 'PDFRadioGroup') field.select(String(v));
        }
      } catch (err) {
        say(`Form values could not all be written (${err.message}).`, 'error');
      }
    }

    // ── Marks ─────────────────────────────────────────────────────────────
    for (const m of state.marks) {
      const page = pages[m.page - 1];
      if (!page || state.dropped.has(m.page)) continue;
      const c = hexToRgb(m.color);
      const colour = rgb(c.r, c.g, c.b);

      if (m.type === 'quads') {
        for (const r of m.rects) {
          page.drawRectangle({
            x: Math.min(r.x0, r.x1), y: Math.min(r.y0, r.y1),
            width: Math.abs(r.x1 - r.x0), height: Math.abs(r.y1 - r.y0),
            color: colour, opacity: 0.38
          });
        }
      } else if (m.type === 'rect') {
        page.drawRectangle({
          x: Math.min(m.a.x, m.b.x), y: Math.min(m.a.y, m.b.y),
          width: Math.abs(m.b.x - m.a.x), height: Math.abs(m.b.y - m.a.y),
          borderColor: colour, borderWidth: m.size, opacity: 0
        });
      } else if (m.type === 'image') {
        const png = await doc.embedPng(m.dataUrl);
        page.drawImage(png, {
          x: Math.min(m.a.x, m.b.x), y: Math.min(m.a.y, m.b.y),
          width: Math.abs(m.b.x - m.a.x), height: Math.abs(m.b.y - m.a.y)
        });
      } else if (m.type === 'note' || m.type === 'text') {
        const size = m.size || 10;
        const lines = wrapToWidth(winAnsi(m.text), size, NOTE_MAX_W - NOTE_PAD * 2);
        const lineH = size + LINE_GAP;
        // Geometry needs no correction (convertToPdfPoint already undid the
        // rotation), but glyphs run along the user-space x-axis, so they have
        // to be turned back through everything the viewer will apply.
        const rot = ((state.baseRotate[m.page] || 0) + (state.rotate[m.page] || 0)) % 360;
        if (m.type === 'note') {
          const boxW = Math.min(NOTE_MAX_W,
            Math.max(50, Math.max(0, ...lines.map((l) => font.widthOfTextAtSize(l, size))) + NOTE_PAD * 2));
          const boxH = lines.length * lineH + NOTE_PAD * 2;
          page.drawRectangle({
            x: m.at.x, y: m.at.y - boxH, width: boxW, height: boxH,
            color: colour, opacity: 0.92, rotate: degrees(-rot)
          });
        }
        lines.forEach((line, i) => {
          page.drawText(line, {
            x: m.at.x + (m.type === 'note' ? NOTE_PAD : 0),
            y: m.at.y - (m.type === 'note' ? NOTE_PAD : 0) - size - i * lineH,
            size, font,
            color: m.type === 'note' ? rgb(0.16, 0.13, 0.02) : colour,
            rotate: degrees(-rot)
          });
        });
      } else if (m.points?.length) {
        const thickness = m.type === 'highlight' ? 14 : m.size;
        const opacity = m.type === 'highlight' ? 0.38 : 1;
        // A polyline as a series of segments: pdf-lib has no freehand path API,
        // and this reproduces the stroke exactly.
        for (let i = 1; i < m.points.length; i++) {
          page.drawLine({
            start: m.points[i - 1], end: m.points[i],
            thickness, color: colour, opacity, lineCap: 1
          });
        }
      }
    }

    // ── Rotation ──────────────────────────────────────────────────────────
    for (const [n, delta] of Object.entries(state.rotate)) {
      const page = pages[Number(n) - 1];
      if (!page || !delta) continue;
      page.setRotation(degrees((page.getRotation().angle + Number(delta)) % 360));
    }

    // ── Removed pages, highest index first so the rest keep their numbers ──
    const drop = [...state.dropped].sort((a, b) => b - a);
    for (const n of drop) doc.removePage(n - 1);

    if (mode === 'flatten') {
      try { doc.getForm().flatten(); } catch { /* nothing to flatten */ }
    }

    const out = await doc.save();
    const res = await window.localMind.pdfSave({
      bytes: Array.from(out),
      name: overwrite ? state.name : `${state.baseName} (edited).pdf`,
      overwrite
    });

    if (res?.ok) {
      state.dirty = false;
      say(`Saved to ${res.path}`, 'ok');
    } else if (res?.cancelled) {
      say('Save cancelled.');
    } else {
      say(res?.error || 'Could not save.', 'error');
    }
  } catch (err) {
    say(`Could not save (${err.message}).`, 'error');
  } finally {
    $('save').disabled = false;
    busy(false);
  }
}

// ── Toolbar wiring ───────────────────────────────────────────────────────────
const TOOLS = [
  ['t-select', 'select'], ['t-highlight', 'highlight'], ['t-draw', 'ink'],
  ['t-note', 'note'], ['t-text', 'text'], ['t-rect', 'rect'],
  ['t-sign', 'sign'], ['t-erase', 'erase']
];

function setTool(tool) {
  state.tool = tool;
  document.body.classList.toggle('armed', tool !== 'select' && tool !== 'highlight');
  document.body.classList.toggle('tool-highlight', tool === 'highlight');
  document.body.classList.toggle('tool-erase', tool === 'erase');
  for (const [id, name] of TOOLS) $(id).classList.toggle('active', name === tool);

  if (tool === 'highlight') say('Drag across text to highlight it.');
  else if (tool === 'erase') say('Click a mark to remove it.');
  else if (tool === 'sign' && !state.signature) openSignaturePad();
}

for (const [id, name] of TOOLS) {
  $(id).addEventListener('click', () => setTool(name));
}

$('t-sidebar').addEventListener('click', () => {
  document.body.classList.toggle('with-sidebar');
  if (state.fit) rebuild();
});

document.querySelectorAll('.swatch').forEach((b) => {
  b.addEventListener('click', () => {
    state.color = b.dataset.color;
    document.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
  });
});

$('sizePick').addEventListener('change', (e) => { state.size = Number(e.target.value); });

$('t-undo').addEventListener('click', () => {
  if (!state.undo.length) return say('Nothing to undo.');
  state.redo.push(JSON.stringify(state.marks));
  state.marks = JSON.parse(state.undo.pop());
  state.dirty = true;
  refreshHistoryButtons();
  paintAll();
  say('Undone.');
});

$('t-redo').addEventListener('click', () => {
  if (!state.redo.length) return say('Nothing to redo.');
  state.undo.push(JSON.stringify(state.marks));
  state.marks = JSON.parse(state.redo.pop());
  state.dirty = true;
  refreshHistoryButtons();
  paintAll();
  say('Redone.');
});

$('t-prev').addEventListener('click', () => goToPage(state.current - 1, true));
$('t-next').addEventListener('click', () => goToPage(state.current + 1, true));
$('pageNum').addEventListener('change', (e) => {
  const n = parseInt(e.target.value, 10);
  if (Number.isFinite(n)) goToPage(n, true); else e.target.value = String(state.current);
});

$('t-zoom-in').addEventListener('click', () => stepZoom(1.2));
$('t-zoom-out').addEventListener('click', () => stepZoom(1 / 1.2));
$('zoomPick').addEventListener('change', (e) => setZoom(e.target.value));

// ── Menus ────────────────────────────────────────────────────────────────────
/**
 * Put a menu under its button, kept inside the window.
 *
 * It prefers to line up with the button's right edge, which is where the eye
 * expects it. When there is not enough room to the left — a wrapped toolbar
 * puts Save near x=0 — it slides right rather than off the screen, and it
 * flips above the button rather than below if it would fall off the bottom.
 */
function placeMenu(btn, menu) {
  const r = btn.getBoundingClientRect();
  // Measure while hidden from view but laid out, or the size reads as zero.
  menu.style.visibility = 'hidden';
  menu.classList.add('open');
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const gap = 6, edge = 8;

  let left = r.right - mw;
  left = Math.max(edge, Math.min(left, window.innerWidth - mw - edge));

  let top = r.bottom + gap;
  if (top + mh > window.innerHeight - edge) top = Math.max(edge, r.top - mh - gap);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = '';
}

function wireMenu(buttonId, menuId, handler) {
  const btn = $(buttonId), menu = $(menuId);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = menu.classList.contains('open');
    closeMenus();
    if (!wasOpen) placeMenu(btn, menu);
  });
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    closeMenus();
    handler(act);
  });
}
const closeMenus = () => document.querySelectorAll('.menu').forEach((m) => m.classList.remove('open'));
document.addEventListener('click', closeMenus);
// A fixed menu does not travel with its button, so anything that moves the
// button has to dismiss it rather than leave it stranded.
window.addEventListener('resize', closeMenus);
$('scroll').addEventListener('scroll', closeMenus, { passive: true });

wireMenu('t-pages', 'menu-pages', pageAction);
wireMenu('t-export', 'menu-export', (act) => {
  if (act === 'png') exportImages('png');
  else if (act === 'jpg') exportImages('jpg');
  else if (act === 'png-one') exportOneImage();
  else if (act === 'pptx') exportPptx();
  else if (act === 'docx') exportDocx();
  else if (act === 'txt') exportText();
});
wireMenu('save', 'menu-save', (act) => save(act));

// ── Find ─────────────────────────────────────────────────────────────────────
let findTimer = null;
const openFind = () => {
  $('findbar').classList.add('open');
  $('findInput').focus();
  $('findInput').select();
};
const closeFind = () => {
  $('findbar').classList.remove('open');
  state.find = { q: '', hits: [], i: -1 };
  $('findCount').textContent = '';
  paintAll();
};

$('t-find').addEventListener('click', () => ($('findbar').classList.contains('open') ? closeFind() : openFind()));
$('findClose').addEventListener('click', closeFind);
$('findNext').addEventListener('click', () => stepFind(1));
$('findPrev').addEventListener('click', () => stepFind(-1));
$('findInput').addEventListener('input', (e) => {
  clearTimeout(findTimer);
  const q = e.target.value;
  findTimer = setTimeout(() => runFind(q), 160);
});
$('findInput').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});

// ── Keyboard ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;

  if (e.key === 'Escape') { closeMenus(); setTool('select'); return; }
  if (meta && e.key === 'f') { e.preventDefault(); openFind(); return; }
  if (meta && e.key === '\\') { e.preventDefault(); $('t-sidebar').click(); return; }
  if (meta && e.key === 'z') {
    e.preventDefault();
    (e.shiftKey ? $('t-redo') : $('t-undo')).click();
    return;
  }
  if (meta && e.key === 's') { e.preventDefault(); save(e.shiftKey ? 'copy' : 'overwrite'); return; }
  if (meta && (e.key === '=' || e.key === '+')) { e.preventDefault(); stepZoom(1.2); return; }
  if (meta && e.key === '-') { e.preventDefault(); stepZoom(1 / 1.2); return; }
  if (meta && e.key === '0') { e.preventDefault(); setZoom('1'); return; }
  if (meta && e.key === '[') { e.preventDefault(); pageAction('rot-left'); return; }
  if (meta && e.key === ']') { e.preventDefault(); pageAction('rot-right'); return; }

  if (!meta && (e.key === 'PageDown' || e.key === 'ArrowRight')) {
    if (document.activeElement?.tagName === 'INPUT') return;
    goToPage(state.current + 1, true);
  }
  if (!meta && (e.key === 'PageUp' || e.key === 'ArrowLeft')) {
    if (document.activeElement?.tagName === 'INPUT') return;
    goToPage(state.current - 1, true);
  }
});

// Losing unsaved marks silently would be the worst failure this page has.
window.addEventListener('beforeunload', (e) => {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

// Fit modes are relative to the window, so they have to follow it.
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!state.fit) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => rebuild(), 180);
});

setTool('select');
refreshHistoryButtons();
document.querySelector('.swatch')?.classList.add('on');
load();
