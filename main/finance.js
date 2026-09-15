// =============================================================================
// Local Mind Browser — Finance Hub Service
// =============================================================================
// Backend for the Finance page. Market data comes from Yahoo Finance's public
// (keyless) chart/search/trending endpoints; news reuses the Google News RSS
// infrastructure from news.js with per-industry search feeds.

const https = require('https');
const { parseGoogleItems, fetchXml, fetchArticleImage } = require('./news');

const UA = { 'User-Agent': 'Mozilla/5.0' };

function fetchJson(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: UA }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

// Range → Yahoo chart params
// For each range we fetch MORE history than we display (`fetch`) so moving
// averages / Bollinger bands are already "warmed up" at the left edge of the
// visible window, then only show the trailing `display` bars.
const RANGES = {
  '1D':  { fetch: '5d',  interval: '5m',  display: 78 },
  '1W':  { fetch: '1mo', interval: '30m', display: 65 },
  '1M':  { fetch: '6mo', interval: '1d',  display: 22 },
  '6M':  { fetch: '1y',  interval: '1d',  display: 126 },
  '1Y':  { fetch: '2y',  interval: '1d',  display: 252 },
  // range=max returns a fixed ~227-point downsample at ANY interval, leaving no
  // warm-up room, so 5Y uses an explicit 10y window (~524 weekly bars) instead.
  '5Y':  { fetch: '10y', interval: '1wk', display: 260 },
  // MAX shows all history, so indicators can't be warmed — nothing precedes it.
  'MAX': { fetch: 'max', interval: '1mo', display: Infinity }
};

// Low-level fetch → normalized OHLCV arrays + meta. No warm-up logic.
async function rawChart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const data = await fetchJson(url);
  const res = data?.chart?.result?.[0];
  if (!res) return null;
  const q = res.indicators?.quote?.[0] || {};
  const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
  (res.timestamp || []).forEach((ts, i) => {
    if (q.close?.[i] == null) return;
    out.t.push(ts);
    out.o.push(q.open?.[i] ?? q.close[i]);
    out.h.push(q.high?.[i] ?? q.close[i]);
    out.l.push(q.low?.[i] ?? q.close[i]);
    out.c.push(q.close[i]);
    out.v.push(q.volume?.[i] ?? 0);
  });
  const m = res.meta || {};
  return {
    meta: {
      name: m.shortName || m.longName || symbol,
      currency: m.currency || '',
      price: m.regularMarketPrice,
      prevClose: m.chartPreviousClose ?? m.previousClose
    },
    ...out
  };
}

async function chart(symbol, rangeKey) {
  const r = RANGES[rangeKey] || RANGES['1D'];
  const raw = await rawChart(symbol, r.fetch, r.interval);
  if (!raw) return null;
  // Everything before `start` is warm-up history for the indicators; the chart
  // only paints from `start` onward.
  const start = Number.isFinite(r.display) ? Math.max(0, raw.c.length - r.display) : 0;
  return {
    symbol,
    name: raw.meta.name,
    currency: raw.meta.currency,
    price: raw.meta.price,
    prevClose: raw.meta.prevClose,
    start,
    t: raw.t, o: raw.o, h: raw.h, l: raw.l, c: raw.c, v: raw.v
  };
}

// Lightweight quote (uses the 1D chart call; also returns a sparkline)
const quoteCache = new Map(); // symbol → { at, data }
async function quote(symbol) {
  const hit = quoteCache.get(symbol);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.data;
  const ch = await rawChart(symbol, '1d', '5m');
  if (!ch) return null;
  const price = ch.meta.price ?? ch.c[ch.c.length - 1];
  const prev = ch.meta.prevClose ?? ch.c[0];
  const data = {
    symbol,
    name: ch.meta.name,
    currency: ch.meta.currency,
    price,
    change: price != null && prev != null ? price - prev : null,
    changePct: price != null && prev ? ((price - prev) / prev) * 100 : null,
    spark: ch.c.filter((_, i) => i % Math.max(1, Math.floor(ch.c.length / 40)) === 0)
  };
  quoteCache.set(symbol, { at: Date.now(), data });
  if (quoteCache.size > 200) quoteCache.delete(quoteCache.keys().next().value);
  return data;
}

// ── Yahoo auth (cookie + crumb) ──
// quoteSummary requires a session cookie (from fc.yahoo.com) and a matching
// crumb. Both are cached; getcrumb is aggressively rate-limited per IP, so we
// never retry in a loop — one failure marks the whole fetch degraded and the
// renderer hides those sections.
let yAuth = null; // { cookie, crumb, at }
const YAUTH_TTL = 30 * 60 * 1000;

function yGet(url, cookie, depth = 0) {
  return new Promise((resolve) => {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Accept': '*/*' };
    if (cookie) headers.Cookie = cookie;
    https.get(url, { headers }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && depth < 5) {
        res.resume();
        return resolve(yGet(res.headers.location, cookie, depth + 1));
      }
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d, setCookie: res.headers['set-cookie'] }));
    }).on('error', () => resolve({ status: 0, body: '', setCookie: null }));
  });
}

async function getYahooAuth() {
  if (yAuth && Date.now() - yAuth.at < YAUTH_TTL) return yAuth;
  const c = await yGet('https://fc.yahoo.com/');
  const cookie = (c.setCookie || []).map((s) => s.split(';')[0]).join('; ');
  if (!cookie) return null;
  const cr = await yGet('https://query2.finance.yahoo.com/v1/test/getcrumb', cookie);
  const crumb = (cr.body || '').trim();
  if (cr.status !== 200 || !crumb || crumb.length > 20) return null;
  yAuth = { cookie, crumb, at: Date.now() };
  return yAuth;
}

const fmtOr = (x) => x == null ? null : (x.fmt ?? x.raw ?? null);
const rawOr = (x) => x == null ? null : (x.raw ?? null);

// Company profile: one quoteSummary call, normalized for the renderer.
const profileCache = new Map(); // symbol → { at, data }
async function profile(symbol) {
  const hit = profileCache.get(symbol);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const auth = await getYahooAuth();
  if (!auth) return { ok: false, reason: 'auth' };
  const mods = 'assetProfile,summaryDetail,defaultKeyStatistics,financialData,price,recommendationTrend,majorHoldersBreakdown,institutionOwnership,insiderTransactions,calendarEvents,earningsHistory';
  const r = await yGet(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${mods}&crumb=${encodeURIComponent(auth.crumb)}`, auth.cookie);
  if (r.status === 401) { yAuth = null; return { ok: false, reason: 'auth' }; }
  if (r.status !== 200) return { ok: false, reason: 'http-' + r.status };
  let m;
  try { m = JSON.parse(r.body).quoteSummary?.result?.[0]; } catch { m = null; }
  if (!m) return { ok: false, reason: 'empty' };

  const ap = m.assetProfile || {}, sd = m.summaryDetail || {}, ks = m.defaultKeyStatistics || {},
        fd = m.financialData || {}, pr = m.price || {};
  const data = {
    ok: true,
    symbol,
    name: pr.longName || pr.shortName || symbol,
    exchange: pr.exchangeName || '',
    currency: pr.currency || '',
    marketState: pr.marketState || '',
    sector: ap.sector || '', industry: ap.industry || '',
    about: {
      description: ap.longBusinessSummary || '',
      website: ap.website || '', city: ap.city || '', country: ap.country || '',
      employees: ap.fullTimeEmployees || null,
      officers: (ap.companyOfficers || []).slice(0, 4).map((o) => ({ name: o.name, title: o.title }))
    },
    stats: {
      price: rawOr(pr.regularMarketPrice), change: rawOr(pr.regularMarketChange), changePct: rawOr(pr.regularMarketChangePercent) != null ? rawOr(pr.regularMarketChangePercent) * 100 : null,
      prevClose: rawOr(sd.previousClose), open: rawOr(sd.open),
      dayLow: rawOr(sd.dayLow), dayHigh: rawOr(sd.dayHigh),
      wk52Low: rawOr(sd.fiftyTwoWeekLow), wk52High: rawOr(sd.fiftyTwoWeekHigh),
      marketCap: fmtOr(sd.marketCap), enterpriseValue: fmtOr(ks.enterpriseValue),
      pe: rawOr(sd.trailingPE), forwardPe: rawOr(ks.forwardPE), peg: rawOr(ks.pegRatio),
      eps: rawOr(ks.trailingEps), bookValue: rawOr(ks.bookValue), priceToBook: rawOr(ks.priceToBook),
      divYield: rawOr(sd.dividendYield) != null ? rawOr(sd.dividendYield) * 100 : null,
      divRate: rawOr(sd.dividendRate), beta: rawOr(sd.beta),
      sharesOut: fmtOr(ks.sharesOutstanding), floatShares: fmtOr(ks.floatShares),
      avgVolume: fmtOr(sd.averageVolume), volume: fmtOr(sd.volume),
      targetMean: rawOr(fd.targetMeanPrice), targetHigh: rawOr(fd.targetHighPrice), targetLow: rawOr(fd.targetLowPrice),
      roe: rawOr(fd.returnOnEquity) != null ? rawOr(fd.returnOnEquity) * 100 : null,
      roa: rawOr(fd.returnOnAssets) != null ? rawOr(fd.returnOnAssets) * 100 : null,
      grossMargin: rawOr(fd.grossMargins) != null ? rawOr(fd.grossMargins) * 100 : null,
      opMargin: rawOr(fd.operatingMargins) != null ? rawOr(fd.operatingMargins) * 100 : null,
      netMargin: rawOr(fd.profitMargins) != null ? rawOr(fd.profitMargins) * 100 : null,
      debtToEquity: rawOr(fd.debtToEquity), currentRatio: rawOr(fd.currentRatio), quickRatio: rawOr(fd.quickRatio),
      totalCash: fmtOr(fd.totalCash), totalDebt: fmtOr(fd.totalDebt), revenue: fmtOr(fd.totalRevenue),
      revenueGrowth: rawOr(fd.revenueGrowth) != null ? rawOr(fd.revenueGrowth) * 100 : null
    },
    analyst: {
      recommendation: fd.recommendationKey || '',
      count: rawOr(fd.numberOfAnalystOpinions),
      trend: (m.recommendationTrend?.trend || []).slice(0, 1).map((t) => ({
        strongBuy: t.strongBuy, buy: t.buy, hold: t.hold, sell: t.sell, strongSell: t.strongSell
      }))[0] || null
    },
    holders: m.majorHoldersBreakdown ? {
      insiders: rawOr(m.majorHoldersBreakdown.insidersPercentHeld) != null ? rawOr(m.majorHoldersBreakdown.insidersPercentHeld) * 100 : null,
      institutions: rawOr(m.majorHoldersBreakdown.institutionsPercentHeld) != null ? rawOr(m.majorHoldersBreakdown.institutionsPercentHeld) * 100 : null
    } : null,
    institutions: (m.institutionOwnership?.ownershipList || []).slice(0, 8).map((o) => ({
      org: o.organization, pct: rawOr(o.pctHeld) != null ? rawOr(o.pctHeld) * 100 : null,
      shares: fmtOr(o.position), value: fmtOr(o.value)
    })),
    insiders: (m.insiderTransactions?.transactions || []).slice(0, 8).map((t) => ({
      name: t.filerName, relation: t.filerRelation, text: t.transactionText || '',
      shares: fmtOr(t.shares), value: fmtOr(t.value), date: fmtOr(t.startDate)
    })),
    earnings: {
      next: (m.calendarEvents?.earnings?.earningsDate || []).map(fmtOr).filter(Boolean),
      history: (m.earningsHistory?.history || []).map((h) => ({
        quarter: fmtOr(h.quarter), epsEst: rawOr(h.epsEstimate), epsActual: rawOr(h.epsActual),
        surprisePct: rawOr(h.surprisePercent) != null ? rawOr(h.surprisePercent) * 100 : null
      }))
    }
  };
  profileCache.set(symbol, { at: Date.now(), data });
  if (profileCache.size > 60) profileCache.delete(profileCache.keys().next().value);
  return data;
}

// Financial statements via the crumbless fundamentals-timeseries endpoint.
const FUND_TYPES = {
  income: ['TotalRevenue', 'GrossProfit', 'OperatingIncome', 'EBITDA', 'NetIncome', 'DilutedEPS'],
  balance: ['TotalAssets', 'TotalLiabilitiesNetMinorityInterest', 'StockholdersEquity', 'CashAndCashEquivalents', 'TotalDebt', 'Inventory'],
  cashflow: ['OperatingCashFlow', 'InvestingCashFlow', 'FinancingCashFlow', 'FreeCashFlow']
};
const fundCache = new Map(); // symbol|freq → { at, data }
async function fundamentals(symbol, freq = 'annual') {
  const key = symbol + '|' + freq;
  const hit = fundCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  const all = Object.values(FUND_TYPES).flat().map((t) => freq + t).join(',');
  const now = Math.floor(Date.now() / 1000);
  const from = now - (freq === 'annual' ? 5 * 365 : 3 * 365) * 86400;
  const r = await yGet(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}&type=${all}&period1=${from}&period2=${now}`);
  if (r.status !== 200) return { ok: false, reason: 'http-' + r.status };
  let rs;
  try { rs = JSON.parse(r.body).timeseries?.result; } catch { rs = null; }
  if (!rs) return { ok: false, reason: 'empty' };
  // series name → [{date, raw, fmt}]
  const series = {};
  for (const s of rs) {
    const k = Object.keys(s).find((x) => x !== 'meta' && x !== 'timestamp');
    if (!k) continue;
    series[k.replace(freq, '')] = (s[k] || []).filter(Boolean).map((v) => ({
      date: v.asOfDate, raw: rawOr(v.reportedValue), fmt: fmtOr(v.reportedValue)
    }));
  }
  const data = { ok: true, freq, series };
  fundCache.set(key, { at: Date.now(), data });
  if (fundCache.size > 40) fundCache.delete(fundCache.keys().next().value);
  return data;
}

function registerFinanceHandlers(ipcMain) {
  // Company profile (stats, about, holders, analyst…) + financial statements
  ipcMain.handle('fin:profile', async (_e, { symbol }) => profile(symbol).catch(() => ({ ok: false, reason: 'error' })));
  ipcMain.handle('fin:fundamentals', async (_e, { symbol, freq }) => fundamentals(symbol, freq).catch(() => ({ ok: false, reason: 'error' })));

  // Batch quotes (max 60 symbols, parallel, 60s cached)
  ipcMain.handle('fin:quotes', async (_e, symbols = []) => {
    const list = [...new Set(symbols)].slice(0, 60);
    const results = await Promise.all(list.map((s) => quote(s).catch(() => null)));
    const out = {};
    results.forEach((r) => { if (r) out[r.symbol] = r; });
    return out;
  });

  // Full chart data for the interactive chart
  ipcMain.handle('fin:chart', async (_e, { symbol, range }) => {
    const ch = await chart(symbol, range);
    return ch || { error: 'No data' };
  });

  // Symbol search (for watchlist / portfolio / chart)
  ipcMain.handle('fin:search', async (_e, q) => {
    const data = await fetchJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`);
    const quotes = (data?.quotes || [])
      .filter((x) => x.symbol && (x.quoteType === 'EQUITY' || x.quoteType === 'INDEX' || x.quoteType === 'ETF' || x.quoteType === 'CRYPTOCURRENCY'))
      .slice(0, 6)
      .map((x) => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, exchange: x.exchDisp || x.exchange || '' }));
    return { quotes };
  });

  // Trending tickers (US endpoint; IN returns empty these days)
  ipcMain.handle('fin:trending', async () => {
    const data = await fetchJson('https://query1.finance.yahoo.com/v1/finance/trending/US?count=10');
    const syms = (data?.finance?.result?.[0]?.quotes || []).map((q) => q.symbol).slice(0, 8);
    const results = await Promise.all(syms.map((s) => quote(s).catch(() => null)));
    return { quotes: results.filter(Boolean) };
  });

  // Industry intelligence hub: multi-angle categorized queries for one sector
  const INDUSTRY_CATEGORIES = [
    ['Earnings',          '(earnings OR "quarterly results" OR "Q1 results" OR "Q2 results" OR "annual results")'],
    ['M&A & Deals',       '(acquisition OR merger OR "joint venture" OR stake OR takeover OR investment)'],
    ['Leadership',        '(CEO OR CFO OR chairman OR appoints OR resigns OR "steps down")'],
    ['Regulation',        '(regulation OR policy OR government OR ministry OR ban OR compliance)'],
    ['Analyst Calls',     '(upgrade OR downgrade OR "target price" OR brokerage OR rating)'],
    ['Launches',          '(launches OR "product launch" OR unveils OR rollout OR expansion)'],
    ['Corporate Actions', '(dividend OR buyback OR IPO OR "stock split" OR bonus OR delisting)']
  ];

  ipcMain.handle('fin:industry', async (_e, { industry }) => {
    if (!industry) return { error: 'No industry' };
    const suffix = 'hl=en-IN&gl=IN&ceid=IN:en';
    const feeds = [
      { tag: 'Top Stories', q: `"${industry}" India industry` },
      ...INDUSTRY_CATEGORIES.map(([tag, terms]) => ({ tag, q: `${industry} ${terms}` }))
    ];

    const results = await Promise.all(feeds.map(async (f) => {
      const xml = await fetchXml(`https://news.google.com/rss/search?q=${encodeURIComponent(f.q)}&${suffix}`);
      return { tag: f.tag, articles: xml ? parseGoogleItems(xml, f.tag === 'Top Stories' ? 7 : 5) : [] };
    }));

    // De-dupe across categories (a story stays in its first/most-specific bucket)
    const seen = new Set();
    const categories = results.map((r) => ({
      tag: r.tag,
      articles: r.articles.filter((a) => {
        const key = a.title.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
    })).filter((r) => r.articles.length);

    return categories.length ? { categories } : { error: 'No coverage found' };
  });

  // Finance news: business feed + per-industry + watchlist company feeds
  ipcMain.handle('fin:news', async (_e, { industries = [], companies = [] } = {}) => {
    const suffix = 'hl=en-IN&gl=IN&ceid=IN:en';
    const feeds = [
      { tag: 'Markets', url: `https://news.google.com/rss/headlines/section/topic/BUSINESS?${suffix}` }
    ];
    industries.slice(0, 6).forEach((ind) => {
      feeds.push({ tag: ind, url: `https://news.google.com/rss/search?q=${encodeURIComponent(`"${ind}" industry stocks`)}&${suffix}` });
    });
    companies.slice(0, 5).forEach((c) => {
      feeds.push({ tag: c, url: `https://news.google.com/rss/search?q=${encodeURIComponent(`"${c}" stock`)}&${suffix}` });
    });

    const results = await Promise.all(feeds.map(async (f) => {
      const xml = await fetchXml(f.url);
      return (xml ? parseGoogleItems(xml, f.tag === 'Markets' ? 8 : 4) : []).map((a) => ({ ...a, tag: f.tag }));
    }));

    // Interleave: markets first, then round-robin the personalized feeds
    const seen = new Set();
    const articles = [];
    results.flat().forEach((a) => {
      const key = a.title.toLowerCase();
      if (!seen.has(key)) { seen.add(key); articles.push(a); }
    });
    const top = articles.slice(0, 30);

    // Thumbnails for the first few stories inline, so the grid paints with art
    // immediately. The renderer backfills the rest via fin:news-images — doing
    // all 18 here would add seconds to first paint.
    await Promise.all(top.slice(0, 6).map(async (a) => {
      try { a.image = await fetchArticleImage(a.url); } catch { a.image = null; }
    }));
    return { articles: top };
  });

  // Batch thumbnail lookup for the cards that rendered without one.
  //
  // Three tiers, so a card is never left blank:
  //   1. the article's own og:image
  //   2. the same story as covered by another outlet (Google News cluster) —
  //      plenty of publishers omit og:image but their syndicators don't
  //   3. the publisher's logo, fetched as a data URL and shown "contained"
  // Bounded concurrency + per-item timeouts keep one slow host from stalling it.
  const imageCache = new Map();   // url → { src, kind } | null

  const withTimeout = (p, ms) =>
    Promise.race([p.catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);

  /** Same headline, different outlet — often has artwork when the original doesn't. */
  async function imageFromCluster(title) {
    if (!title) return null;
    const query = title.replace(/[|"'].*$/, '').split(/\s+/).slice(0, 9).join(' ');
    const xml = await withTimeout(
      fetchXml(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`),
      5000
    );
    if (!xml) return null;
    for (const item of parseGoogleItems(xml, 4)) {
      const img = await withTimeout(fetchArticleImage(item.url), 5000);
      if (img) return img;
    }
    return null;
  }

  /** Publisher logo, so the card still reads as "from somewhere". */
  async function publisherLogo(pageUrl) {
    let host;
    try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { return null; }
    for (const src of [
      `https://www.google.com/s2/favicons?domain=${host}&sz=128`,
      `https://icons.duckduckgo.com/ip3/${host}.ico`
    ]) {
      const got = await withTimeout(fetchBinary(src), 5000);
      if (got && got.buf.length > 300) {          // skip the 1px generic globe
        return `data:${got.type};base64,${got.buf.toString('base64')}`;
      }
    }
    return null;
  }

  ipcMain.handle('fin:news-images', async (_e, items = []) => {
    // Accepts [{url, title}] (older callers may pass bare url strings).
    const list = items.map((it) => (typeof it === 'string' ? { url: it, title: '' } : it))
                      .filter((it) => it && it.url);
    const out = {};
    const queue = list.filter(({ url }) => {
      if (imageCache.has(url)) { const v = imageCache.get(url); if (v) out[url] = v; return false; }
      return true;
    });

    const LIMIT = 6;
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(LIMIT, queue.length) }, async () => {
      while (i < queue.length) {
        const { url, title } = queue[i++];
        let hit = null;

        const own = await withTimeout(fetchArticleImage(url), 6000);
        if (own) hit = { src: own, kind: 'photo' };

        if (!hit) {
          const sibling = await imageFromCluster(title);
          if (sibling) hit = { src: sibling, kind: 'photo' };
        }
        if (!hit) {
          const logo = await publisherLogo(url);
          if (logo) hit = { src: logo, kind: 'logo' };
        }

        imageCache.set(url, hit);
        if (hit) out[url] = hit;
      }
    }));

    if (imageCache.size > 400) imageCache.clear();
    return { images: out };
  });
}

/** Byte fetch with redirect following — used for publisher logos. */
function fetchBinary(url, { timeout = 6000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchBinary(res.headers.location, { timeout, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: res.headers['content-type'] || 'image/png' }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

module.exports = { registerFinanceHandlers };
