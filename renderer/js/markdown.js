// =============================================================================
// Local Mind Browser — Markdown Renderer
// =============================================================================
// Converts markdown to HTML for chat messages.
//
// This is a real block parser, not a pile of regexes run over the whole string.
// The old version applied every rule to the entire document at once, so a table
// row and a bullet list three paragraphs apart still got glued into one element,
// every newline became a <br> (including inside code), and any stray asterisk in
// prose turned into italics. Scanning line by line and closing each block as it
// ends is the only way the output survives real model answers.

function renderMarkdown(text) {
  if (!text) return '';

  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code / artifact ────────────────────────────────────────────
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || '';
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;                                        // consume the closing fence
      out.push(richArtifact(lang, body.join('\n')));
      continue;
    }

    if (!line.trim()) { i++; continue; }

    // ── Horizontal rule ───────────────────────────────────────────────────
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // ── Heading ───────────────────────────────────────────────────────────
    const head = /^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (head) {
      const level = Math.min(head[1].length, 3);
      out.push(`<h${level}>${inline(head[2])}</h${level}>`);
      i++;
      continue;
    }

    // ── Table ─────────────────────────────────────────────────────────────
    // Requires a header row AND a |---|---| divider right beneath it, which is
    // what stops a lone "| maybe |" in prose from becoming a one-cell table.
    if (isRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const header = cells(line);
      const align = cells(lines[i + 1]).map(alignOf);
      i += 2;
      const body = [];
      while (i < lines.length && isRow(lines[i])) body.push(cells(lines[i++]));
      out.push(table(header, align, body));
      continue;
    }

    // ── Blockquote ────────────────────────────────────────────────────────
    if (/^\s{0,3}>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        quote.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      }
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }

    // ── Lists ─────────────────────────────────────────────────────────────
    if (bulletOf(line) || numberOf(line)) {
      const ordered = !bulletOf(line);
      const items = [];
      while (i < lines.length) {
        const item = ordered ? numberOf(lines[i]) : bulletOf(lines[i]);
        if (!item) {
          // An indented wrapped line belongs to the item above it.
          if (items.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i])) {
            items[items.length - 1] += ' ' + lines[i].trim();
            i++;
            continue;
          }
          break;
        }
        items.push(item);
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }

    // ── Paragraph ─────────────────────────────────────────────────────────
    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
    if (!para.length) {
      // A line that looked like a block but didn't qualify (most often a lone
      // "| a | b |" with no divider under it). Render it as text rather than
      // dropping it — silently losing a line of the answer is the worst option.
      out.push(`<p>${inline(line)}</p>`);
      i++;
      continue;
    }
    const lone = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(para.join(' ').trim());
    out.push(lone ? figure(lone[2], lone[1]) : `<p>${inline(para.join('\n'))}</p>`);
  }

  return `<div class="md-content">${out.join('')}</div>`;
}

/** Does this line open a block that a paragraph must not swallow? */
function isBlockStart(line) {
  return /^\s*```/.test(line)
    || /^\s{0,3}#{1,4}\s/.test(line)
    || /^\s{0,3}>\s?/.test(line)
    || /^\s*([-*_])\1{2,}\s*$/.test(line)
    || !!bulletOf(line)
    || !!numberOf(line)
    || isRow(line);
}

const bulletOf = (line) => (/^\s{0,3}[-*+]\s+(.+)$/.exec(line) || [])[1] || null;
const numberOf = (line) => (/^\s{0,3}\d{1,3}[.)]\s+(.+)$/.exec(line) || [])[1] || null;

const isRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isDivider = (line) => /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line);

/** Split a table row, honouring escaped pipes. */
function cells(line) {
  return line.trim().replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());
}

function alignOf(spec) {
  const left = spec.startsWith(':');
  const right = spec.endsWith(':');
  if (left && right) return 'center';
  return right ? 'right' : 'left';
}

function table(header, align, body) {
  const at = (n) => (align[n] && align[n] !== 'left' ? ` style="text-align:${align[n]}"` : '');
  const head = header.map((c, n) => `<th${at(n)}>${inline(c)}</th>`).join('');
  const rows = body
    .map((r) => `<tr>${header.map((_, n) => `<td${at(n)}>${inline(r[n] || '')}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/**
 * Route a fenced block to the best renderer for its language.
 *   ```chart  -> an actual chart
 *   ```html / ```svg -> a live preview with a toggle back to source
 * everything else falls through to the existing code card.
 */
function richArtifact(lang, code) {
  const l = String(lang || '').toLowerCase();
  if (l === 'chart') {
    const svg = chartFrom(code);
    if (svg) return svg;                    // bad spec falls through to the code card
  }
  if (l === 'html' || l === 'svg') return preview(l, code);
  return artifact(lang, code);
}

const CHART_COLORS = ['#2bd473', '#4ecdc4', '#a78bfa', '#f59e0b', '#f472b6', '#60a5fa'];

/**
 * Render a chart from a JSON spec the model emits:
 *   { "type": "bar"|"line", "title"?, "data": [{ "label": "A", "value": 3 }] }
 *
 * Inline SVG on purpose: the panel blocks remote scripts, so a charting library
 * could not load even if one were bundled. Returns '' on anything malformed so
 * the caller can fall back to showing the source.
 */
function chartFrom(src) {
  let spec;
  try { spec = JSON.parse(src); } catch { return ''; }
  const rows = (spec?.data || [])
    .filter((d) => d && d.label !== undefined && Number.isFinite(Number(d.value)))
    .map((d) => ({ label: String(d.label), value: Number(d.value) }));
  if (!rows.length) return '';

  const type = spec.type === 'line' ? 'line' : 'bar';
  const W = 520, H = 240, padL = 44, padR = 12, padT = 16, padB = 46;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const values = rows.map((r) => r.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = (max - min) || 1;
  const y = (v) => padT + plotH - ((v - min) / span) * plotH;

  const fmt = (n) => (Math.abs(n) >= 1000 ? n.toLocaleString() : String(Math.round(n * 100) / 100));

  // Gridlines and axis labels
  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const v = min + (span * g) / 4;
    const yy = y(v);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" class="mdc-grid"/>` +
            `<text x="${padL - 6}" y="${yy + 3.5}" class="mdc-axis" text-anchor="end">${escapeHtml(fmt(v))}</text>`;
  }

  let body = '';
  if (type === 'bar') {
    const step = plotW / rows.length;
    const bw = Math.max(4, Math.min(46, step * 0.62));
    rows.forEach((r, n) => {
      const cx = padL + step * n + step / 2;
      const top = y(Math.max(r.value, 0));
      const base = y(0);
      const h = Math.max(1, Math.abs(base - top));
      const c = CHART_COLORS[n % CHART_COLORS.length];
      body += `<rect x="${cx - bw / 2}" y="${Math.min(top, base)}" width="${bw}" height="${h}" rx="3" fill="${c}"><title>${escapeHtml(r.label)}: ${escapeHtml(fmt(r.value))}</title></rect>`;
    });
  } else {
    const step = rows.length > 1 ? plotW / (rows.length - 1) : 0;
    const pts = rows.map((r, n) => `${padL + step * n},${y(r.value)}`).join(' ');
    body += `<polyline points="${pts}" fill="none" stroke="${CHART_COLORS[0]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    rows.forEach((r, n) => {
      body += `<circle cx="${padL + step * n}" cy="${y(r.value)}" r="3" fill="${CHART_COLORS[0]}"><title>${escapeHtml(r.label)}: ${escapeHtml(fmt(r.value))}</title></circle>`;
    });
  }

  // x labels, thinned so they never collide
  const every = Math.ceil(rows.length / 8);
  const stepX = type === 'bar'
    ? (n) => padL + (plotW / rows.length) * n + (plotW / rows.length) / 2
    : (n) => padL + (rows.length > 1 ? (plotW / (rows.length - 1)) * n : 0);
  let xlabels = '';
  rows.forEach((r, n) => {
    if (n % every) return;
    xlabels += `<text x="${stepX(n)}" y="${H - padB + 16}" class="mdc-axis" text-anchor="middle">${escapeHtml(r.label.slice(0, 12))}</text>`;
  });

  const title = spec.title ? `<div class="mdc-title">${escapeHtml(String(spec.title))}</div>` : '';
  return `<div class="md-chart">${title}<svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">${grid}${body}${xlabels}</svg></div>`;
}

/** HTML/SVG the model wrote, shown rendered with a toggle back to the source. */
function preview(lang, code) {
  const src = code.trim();
  const n = src.split('\n').length;
  // Sandboxed with no allow-scripts: the panel shares an origin with the app,
  // so model-written markup must never get to run script against it.
  const doc = `<!doctype html><meta charset="utf-8"><style>
    :root{color-scheme:dark}
    body{margin:0;padding:10px;font:13px -apple-system,system-ui,sans-serif;color:#e6f0eb;background:transparent}
    img,svg{max-width:100%}</style>${src}`;
  return `<div class="artifact-card">
      <div class="artifact-header">
        <div class="artifact-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
          <span>${escapeHtml(lang.toUpperCase())} PREVIEW</span>
          <span class="artifact-lines">${n} line${n === 1 ? '' : 's'}</span>
        </div>
        <div class="artifact-tools">
          <button class="code-copy-btn" data-md-act="preview" title="Show source">Source</button>
          <button class="code-copy-btn" data-md-act="copy" title="Copy code">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          </button>
        </div>
      </div>
      <iframe class="artifact-preview" sandbox="" srcdoc="${escapeHtml(doc)}" loading="lazy"></iframe>
      <pre class="code-block" data-lang="${escapeHtml(lang)}" style="display:none"><code>${escapeHtml(src)}</code></pre>
    </div>`;
}

/** Flip one artifact card between its rendered preview and its source. */
function togglePreview(btn) {
  const card = btn.closest('.artifact-card');
  const frame = card.querySelector('.artifact-preview');
  const pre = card.querySelector('.code-block');
  const showingSource = frame.style.display === 'none';
  frame.style.display = showingSource ? '' : 'none';
  pre.style.display = showingSource ? 'none' : '';
  btn.textContent = showingSource ? 'Source' : 'Preview';
}

function artifact(lang, code) {
  const title = lang ? lang.toUpperCase() : 'ARTIFACT';
  const n = code.trim().split('\n').length;
  return `<div class="artifact-card">
      <div class="artifact-header">
        <div class="artifact-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
          <span>${escapeHtml(title)}</span>
          <span class="artifact-lines">${n} line${n === 1 ? '' : 's'}</span>
        </div>
        <button class="code-copy-btn" data-md-act="copy" title="Copy code">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
      </div>
      <pre class="code-block" data-lang="${escapeHtml(lang)}"><code>${escapeHtml(code.trim())}</code></pre>
    </div>`;
}

/** A standalone image, with its alt text as a caption. */
function figure(url, alt) {
  if (!safeUrl(url)) return '';
  const caption = alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : '';
  return `<figure class="md-figure"><img src="${escapeHtml(unescapeAmp(url))}" alt="${escapeHtml(alt || '')}" loading="lazy" data-on-error="remove-figure">${caption}</figure>`;
}

/** Only ever emit URLs the panel should be willing to load or open. */
const safeUrl = (url) => /^(https?:|data:image\/)/i.test(String(url).trim());

/** escapeHtml turns & into &amp;, which would break a query string in an href. */
const unescapeAmp = (url) => String(url).replace(/&amp;/g, '&');

/**
 * Inline spans. The text is escaped FIRST and markers are converted after, so
 * nothing the model writes can inject markup. Code spans are lifted out before
 * the emphasis rules run, which is what keeps `a * b` from italicising.
 */
function inline(text) {
  let s = escapeHtml(text);

  const spans = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `@@CODE${spans.push(c) - 1}@@`);

  // Images before links — the syntaxes differ only by the leading "!".
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => (safeUrl(unescapeAmp(url))
    ? `<img class="md-inline-img" src="${unescapeAmp(url)}" alt="${alt}" loading="lazy" data-on-error="remove">`
    : alt));

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => (safeUrl(unescapeAmp(url))
    ? `<a href="${unescapeAmp(url)}" target="_blank" rel="noopener">${label}</a>`
    : label));

  // Bare URLs, so a pasted link is still clickable.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);

  s = s.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^\s*][\s\S]*?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_([^\s_][\s\S]*?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');

  s = s.replace(/@@CODE(\d+)@@/g, (_, n) => `<code class="inline-code">${spans[n]}</code>`);

  // Soft line breaks inside one paragraph.
  return s.replace(/\n/g, '<br>');
}

/** Copy an artifact's code to the clipboard. */
function copyCode(btn) {
  const code = btn.closest('.artifact-card')?.querySelector('code');
  if (!code) return;
  navigator.clipboard.writeText(code.textContent).then(() => {
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
    setTimeout(() => {
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    }, 2000);
  });
}
