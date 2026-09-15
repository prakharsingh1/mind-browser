// =============================================================================
// Local Mind Browser — Agent Tools
// =============================================================================
// Every tool returns real data to the agent loop. Nothing here is fire-and-
// forget: if a tool says it read a page, the page text is in the return value.
//
// Two classes of tool:
//   • main-process tools (search, fetch, finance, news) — fast, no UI needed
//   • renderer tools (open_page, click, type, tabs) — go through the bridge and
//     wait for the webview's actual result
//
// Results are truncated to keep the model's context tight; each tool documents
// its own limit so the model knows it may need to narrow a query.

const https = require('https');
const { callRenderer } = require('./bridge');
const { fetchArticleContent, fetchXml, parseGoogleItems } = require('../news');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function request(url, { method = 'GET', body = null, timeout = 15000, redirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('invalid URL')); }
    const headers = { 'User-Agent': UA, Accept: '*/*' };
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(request(next, { method: 'GET', timeout, redirects: redirects - 1 }));
        }
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const stripTags = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + `\n…[truncated, ${s.length} chars total]` : s || '');

// ── Tool implementations ─────────────────────────────────────────────────────

async function webSearch({ query, count = 6 }) {
  if (!query) throw new Error('query is required');
  const res = await request('https://html.duckduckgo.com/html/', {
    method: 'POST',
    body: 'q=' + encodeURIComponent(query)
  });
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  let s;
  while ((s = snipRe.exec(res.body))) snippets.push(stripTags(s[1]));
  let m, i = 0;
  while ((m = re.exec(res.body)) && out.length < Math.min(count, 10)) {
    let href = m[1];
    // DuckDuckGo wraps results in a redirect — unwrap to the real URL.
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    out.push({ title: stripTags(m[2]), url: href, snippet: clip(snippets[i] || '', 220) });
    i++;
  }
  if (!out.length) return { results: [], note: 'No results — try a simpler or more specific query.' };
  return { results: out };
}

async function fetchUrl({ url, max_chars = 6000 }) {
  if (!url) throw new Error('url is required');
  // Reuse the news extractor: it resolves Google redirects and strips chrome.
  try {
    const art = await fetchArticleContent(url);
    if (art && art.text && art.text.length > 200) {
      return { url: art.realUrl || url, text: clip(art.text, max_chars) };
    }
  } catch { /* fall through to a plain fetch */ }
  const res = await request(url);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(res.body) || [])[1];
  return { url, title: title ? stripTags(title) : undefined, text: clip(stripTags(res.body), max_chars) };
}

async function getStock({ symbol }) {
  if (!symbol) throw new Error('symbol is required');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;

  let res = await request(url);
  // Yahoo throttles bursts; one short backoff usually clears it.
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await request(url);
  }
  if (res.status === 429) {
    throw new Error('market data is rate-limited right now — wait a moment, or use web_search for the figure instead');
  }
  if (res.status !== 200) throw new Error(`market data returned HTTP ${res.status}`);

  let j;
  try { j = JSON.parse(res.body); } catch { throw new Error('market data returned an unreadable response'); }
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`no market data for "${symbol}" — check the ticker (try RELIANCE.NS, AAPL, BTC-USD)`);
  const m = r.meta || {};
  const closes = (r.indicators?.quote?.[0]?.close || []).filter((v) => v != null);
  const price = m.regularMarketPrice ?? closes[closes.length - 1];
  const prev = m.chartPreviousClose ?? closes[0];
  return {
    symbol: m.symbol || symbol,
    name: m.shortName || m.longName,
    currency: m.currency,
    price,
    previousClose: prev,
    changePct: prev ? +(((price - prev) / prev) * 100).toFixed(2) : null,
    dayHigh: m.regularMarketDayHigh,
    dayLow: m.regularMarketDayLow,
    fiftyTwoWeekHigh: m.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: m.fiftyTwoWeekLow,
    exchange: m.fullExchangeName
  };
}

async function getNews({ query, topic = '', count = 8 }) {
  const suffix = 'hl=en-IN&gl=IN&ceid=IN:en';
  const url = query
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${suffix}`
    : topic
      ? `https://news.google.com/rss/headlines/section/topic/${encodeURIComponent(topic.toUpperCase())}?${suffix}`
      : `https://news.google.com/rss?${suffix}`;
  const xml = await fetchXml(url);
  if (!xml) return { articles: [], note: 'news feed unavailable' };
  const items = parseGoogleItems(xml, Math.min(count, 12));
  return {
    articles: items.map((a) => ({
      title: a.title, url: a.url, source: a.source, publishedAt: a.publishedAt
    }))
  };
}

// ── Renderer-backed tools ────────────────────────────────────────────────────
const rendererTool = (action, timeout) => async (args) => {
  const res = await callRenderer(action, args, timeout);
  if (!res.ok) throw new Error(res.error || 'renderer action failed');
  return res.data;
};

// ── Registry ─────────────────────────────────────────────────────────────────
// `schema` is rendered into the system prompt so the model knows the contract.
// `parallel: true` marks a tool that runs entirely in the main process, so a
// batch of them can be executed concurrently. Tools that drive the browser are
// deliberately left unmarked: they share one webview and would race each other.
const TOOLS = {
  web_search: {
    parallel: true,
    schema: '{"query": string, "count"?: number}',
    describe: 'Search the web. Returns [{title, url, snippet}]. Use to find sources before reading them.',
    run: webSearch,
    label: (a) => `Searching "${a.query}"`,
    icon: ''
  },
  fetch_url: {
    parallel: true,
    schema: '{"url": string, "max_chars"?: number}',
    describe: 'Download a URL and return its readable text. Fast — prefer this over open_page for research.',
    run: fetchUrl,
    label: (a) => `Reading ${hostOf(a.url)}`,
    icon: ''
  },
  get_stock: {
    parallel: true,
    schema: '{"symbol": string}',
    describe: 'Live quote: price, % change, day range, 52-week range. NSE tickers end in .NS (e.g. RELIANCE.NS).',
    run: getStock,
    label: (a) => `Quote ${a.symbol}`,
    icon: ''
  },
  get_news: {
    parallel: true,
    schema: '{"query"?: string, "topic"?: string, "count"?: number}',
    describe: 'Recent news headlines with links. topic ∈ BUSINESS|TECHNOLOGY|WORLD|SPORTS|SCIENCE|HEALTH.',
    run: getNews,
    label: (a) => `News: ${a.query || a.topic || 'top stories'}`,
    icon: ''
  },
  open_page: {
    schema: '{"url": string, "new_tab"?: boolean}',
    describe: 'Open a URL in the browser and return the visible page text. Use when the user should SEE it, or when a page needs JS to render.',
    run: rendererTool('open_page', 45000),
    label: (a) => `Opening ${hostOf(a.url)}`,
    icon: ''
  },
  read_page: {
    schema: '{}',
    describe: 'Return the text of the page currently open in the active tab.',
    run: rendererTool('read_page', 20000),
    label: () => 'Reading current page',
    icon: ''
  },
  page_links: {
    schema: '{"filter"?: string}',
    describe: 'List links on the current page as [{text, url}], optionally filtered by substring.',
    run: rendererTool('page_links', 20000),
    label: () => 'Scanning page links',
    icon: ''
  },
  click: {
    schema: '{"text": string}',
    describe: 'Click the first link/button whose visible text contains `text`. Returns the resulting page text.',
    run: rendererTool('click', 30000),
    label: (a) => `Clicking "${a.text}"`,
    icon: ''
  },
  type_text: {
    schema: '{"text": string, "selector"?: string, "submit"?: boolean}',
    describe: 'Type into an input (defaults to the main search/text field). Set submit:true to press Enter.',
    run: rendererTool('type_text', 30000),
    label: (a) => `Typing "${clip(a.text, 40)}"`,
    icon: ''
  },
  list_tabs: {
    schema: '{}',
    describe: 'List open tabs as [{id, title, url, active}].',
    run: rendererTool('list_tabs', 10000),
    label: () => 'Listing tabs',
    icon: ''
  },
  save_note: {
    schema: '{"title": string, "body": string}',
    describe: 'Save a note into the browser\'s Notes app. Use to persist findings the user asked you to keep.',
    run: rendererTool('save_note', 10000),
    label: (a) => `Saving note "${clip(a.title, 40)}"`,
    icon: ''
  },

  // ── Real browser control ──
  new_tab: {
    schema: '{"url"?: string, "background"?: boolean}',
    describe: 'Open a new tab. Use background:true to load research tabs without leaving the current page.',
    run: rendererTool('new_tab', 45000),
    label: (a) => `New tab${a.url ? ' → ' + hostOf(a.url) : ''}`,
    icon: ''
  },
  switch_tab: {
    schema: '{"id": string}',
    describe: 'Focus a tab by id (from list_tabs) and return its page text.',
    run: rendererTool('switch_tab', 20000),
    label: () => 'Switching tab',
    icon: ''
  },
  close_tab: {
    schema: '{"id": string}',
    describe: 'Close a tab by id. Tidy up research tabs when finished.',
    run: rendererTool('close_tab', 10000),
    label: () => 'Closing tab',
    icon: ''
  },
  press_key: {
    schema: '{"key": string, "modifiers"?: string[]}',
    describe: 'Press a key in the page: Enter, Tab, Escape, ArrowDown, Backspace… modifiers ∈ ["Meta","Control","Shift","Alt"]. Use for shortcuts and form submission.',
    run: rendererTool('press_key', 20000),
    label: (a) => `Pressing ${[...(a.modifiers || []), a.key].join('+')}`,
    icon: ''
  },
  type_into_editor: {
    schema: '{"text": string}',
    describe: 'Type into a rich-text editor (Google Docs, Notion, contenteditable). Types as REAL keystrokes so editors register it — plain type_text does not work in these apps.',
    run: rendererTool('type_into_editor', 120000),
    label: (a) => `Writing ${String(a.text || '').length} chars`,
    icon: ''
  },
  scroll_page: {
    schema: '{"direction"?: "down"|"up"|"bottom"|"top", "amount"?: number}',
    describe: 'Scroll the page and return the newly visible text. Use when content loads lazily.',
    run: rendererTool('scroll_page', 20000),
    label: (a) => `Scrolling ${a.direction || 'down'}`,
    icon: ''
  },
  wait_for: {
    schema: '{"text"?: string, "seconds"?: number}',
    describe: 'Wait for text to appear on the page (or just wait N seconds). Use after actions that load slowly.',
    run: rendererTool('wait_for', 60000),
    label: (a) => (a.text ? `Waiting for "${clip(a.text, 30)}"` : `Waiting ${a.seconds || 3}s`),
    icon: ''
  },

  // ── Structured data ──
  extract_table: {
    schema: '{"match"?: string, "max_rows"?: number}',
    describe: 'Pull real tables off the current page as rows of cells. USE THIS for rankings, prices, league tables — far more accurate than reading prose, and it preserves order and every row.',
    run: rendererTool('extract_table', 25000),
    label: () => 'Extracting table',
    icon: ''
  },
  calculate: {
    parallel: true,
    schema: '{"expression": string}',
    describe: 'Evaluate arithmetic exactly (e.g. "214.63-157.5", "1234*0.18"). Use instead of doing sums in your head.',
    run: calculate,
    label: (a) => `Calculating ${clip(a.expression, 40)}`,
    icon: ''
  },
  remember: {
    schema: '{"fact": string}',
    describe: 'Save something durable about the user (a preference, a holding, a recurring need) so future sessions know it.',
    run: remember,
    label: (a) => `Remembering "${clip(a.fact, 40)}"`,
    icon: ''
  },
  bookmark_page: {
    schema: '{"url"?: string, "title"?: string}',
    describe: 'Bookmark a page (defaults to the current tab) so the user can find it later.',
    run: rendererTool('bookmark_page', 10000),
    label: () => 'Bookmarking',
    icon: ''
  },

  // ── Parallel research (the "multi-agent" step) ──
  onion_search: {
    parallel: true,
    schema: '{"query": string, "count"?: number, "index"?: "duckduckgo"|"ahmia"}',
    describe: 'Search .onion services over Tor. Returns [{title, url, snippet}]. Use for material that is not on the clearnet — censored reporting, mirrors of blocked sites, onion-only services. ahmia indexes onion sites only; duckduckgo covers both. Starts Tor if it is not already running, which takes a few seconds.',
    run: (a) => require('../onion-research').onionSearch(a),
    label: (a) => `Searching Tor for "${a.query}"`,
    icon: ''
  },
  onion_fetch: {
    parallel: true,
    schema: '{"url": string, "max_chars"?: number}',
    describe: 'Read a page over Tor and return its text. Works for .onion addresses and for clearnet pages you want fetched without revealing your IP. Onion services are slow — allow time.',
    run: (a) => require('../onion-research').onionFetch(a),
    label: (a) => `Reading ${hostOf(a.url)} over Tor`,
    icon: ''
  },
  research: {
    parallel: true,
    schema: '{"queries": string[], "per_query"?: number}',
    describe: 'Run several web searches AT ONCE and fetch the top result of each. Much faster than searching one at a time — use it whenever you need to gather facts on 2+ subjects (e.g. several companies).',
    run: research,
    label: (a) => `Researching ${(a.queries || []).length} topics in parallel`,
    icon: ''
  }
};

/**
 * Fan out several searches and read the best hit for each concurrently.
 * This is what makes "compare N things" tasks fast instead of serial.
 */

/** Arithmetic without letting the model guess. Digits and operators only. */
async function calculate({ expression }) {
  const expr = String(expression || '').trim();
  if (!expr) throw new Error('expression is required');
  if (!/^[0-9+\-*/(). %eE]+$/.test(expr)) {
    throw new Error('only numbers and + - * / ( ) . % are allowed');
  }
  let value;
  try { value = Function(`"use strict";return (${expr.replace(/%/g, '/100')})`)(); }
  catch { throw new Error('could not evaluate that expression'); }
  if (typeof value !== 'number' || !isFinite(value)) throw new Error('result is not a finite number');
  return { expression: expr, result: value };
}

/** Persist a durable fact about the user. */
async function remember({ fact }) {
  const text = String(fact || '').trim();
  if (!text) throw new Error('fact is required');
  const memory = require('../memory');
  memory.addMemory({ content: text, type: 'agent', date: new Date().toISOString() });
  return { remembered: text };
}

async function research({ queries = [], per_query = 1 }) {
  const list = (Array.isArray(queries) ? queries : [queries]).filter(Boolean).slice(0, 6);
  if (!list.length) throw new Error('queries must be a non-empty array of search strings');

  const findings = await Promise.all(list.map(async (q) => {
    try {
      const { results } = await webSearch({ query: q, count: Math.max(2, per_query + 1) });
      if (!results?.length) return { query: q, error: 'no results' };
      const picks = results.slice(0, Math.max(1, Math.min(per_query, 2)));
      const pages = await Promise.all(picks.map(async (r) => {
        try {
          const page = await fetchUrl({ url: r.url, max_chars: 2500 });
          return { title: r.title, url: r.url, text: page.text };
        } catch (e) {
          return { title: r.title, url: r.url, error: e.message };
        }
      }));
      return { query: q, sources: pages };
    } catch (e) {
      return { query: q, error: e.message };
    }
  }));
  return { findings };
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url || ''; }
}

/** Tool catalogue rendered into the system prompt. */
function toolCatalogue() {
  return Object.entries(TOOLS)
    .map(([name, t]) => `- ${name} ${t.schema}\n    ${t.describe}`)
    .join('\n');
}

async function runTool(name, args = {}) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}`);
  return tool.run(args || {});
}

const toolMeta = (name, args) => {
  const t = TOOLS[name];
  if (!t) return { icon: '⚡', label: name };
  let label;
  try { label = t.label(args || {}); } catch { label = name; }
  return { icon: t.icon, label };
};

module.exports = { TOOLS, toolCatalogue, runTool, toolMeta, clip };
