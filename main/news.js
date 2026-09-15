// =============================================================================
// Local Mind Browser — News Hub Service
// =============================================================================
// Backend for the dedicated News page. All sources are keyless:
//   • Google News RSS       — headlines by section / geo
//   • Google Trends RSS     — what's being searched right now
//   • Polymarket Gamma API  — prediction-market odds by 24h volume
//   • Kalshi Elections API  — trending event questions
// Hero images come from each article's og:image (early-abort fetch + cache).

const https = require('https');

// ── Generic fetch helpers ──
function fetchText(target, redirectsLeft, cb) {
  https.get(target, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
      res.resume();
      return fetchText(new URL(res.headers.location, target).toString(), redirectsLeft - 1, cb);
    }
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => cb(null, data));
  }).on('error', (e) => cb(e));
}

function fetchJson(url) {
  return new Promise((resolve) => {
    fetchText(url, 4, (err, data) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
  });
}

const decode = (s) => (s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

// Mostly-ASCII test — used to keep trending topics English-only
const isEnglish = (s) => {
  const t = (s || '').trim();
  if (!t) return false;
  const ascii = t.split('').filter((c) => c.charCodeAt(0) < 128).length;
  return ascii / t.length > 0.9;
};

// ── Publication lean ratings (Ground News-style, approximate) ──
// Based on public media-bias charts (AllSides / Ad Fontes); unknown = unrated.
const SOURCE_LEAN = {
  left: [
    'the wire', 'scroll.in', 'the quint', 'ndtv', 'the guardian', 'cnn',
    'the new york times', 'washington post', 'huffpost', 'msnbc', 'the hindu',
    'al jazeera', 'vox', 'slate', 'the telegraph india', 'deccan herald'
  ],
  center: [
    'reuters', 'associated press', 'ap news', 'bbc', 'bloomberg', 'moneycontrol',
    'the economic times', 'economic times', 'mint', 'livemint', 'business standard',
    'the times of india', 'times of india', 'the indian express', 'indian express',
    'india today', 'hindustan times', 'forbes', 'cnbc', 'cnbc-tv18', 'axios',
    'the week', 'outlook india', 'business today', 'financial express', 'dw.com', 'dw'
  ],
  right: [
    'fox news', 'new york post', 'daily mail', 'the wall street journal', 'wsj',
    'republic world', 'republic', 'opindia', 'zee news', 'times now', 'news18',
    'firstpost', 'swarajya', 'the epoch times', 'breitbart', 'the washington times',
    'daily wire', 'national review', 'the print'
  ]
};

function leanOf(source) {
  const s = (source || '').toLowerCase().trim();
  if (!s) return 'unrated';
  for (const [lean, list] of Object.entries(SOURCE_LEAN)) {
    if (list.some((name) => s === name || s.includes(name))) return lean;
  }
  return 'unrated';
}

// Bump Google's lh3 thumbnails to a higher resolution variant
function upscaleImage(url) {
  if (!url) return url;
  if (/googleusercontent\.com/.test(url)) {
    return url.replace(/=s0-w\d+(-h\d+)?$/, '=s0-w1200').replace(/=w\d+(-h\d+)?$/, '=w1200');
  }
  return url;
}

const pick = (block, tag) => {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block);
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
};

// ── Google News RSS ──
const SECTION_URLS = (city) => {
  const suffix = 'hl=en-IN&gl=IN&ceid=IN:en';
  return {
    top:           `https://news.google.com/rss?${suffix}`,
    india:         `https://news.google.com/rss/headlines/section/topic/NATION?${suffix}`,
    world:         `https://news.google.com/rss/headlines/section/topic/WORLD?${suffix}`,
    business:      `https://news.google.com/rss/headlines/section/topic/BUSINESS?${suffix}`,
    technology:    `https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?${suffix}`,
    entertainment: `https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?${suffix}`,
    sports:        `https://news.google.com/rss/headlines/section/topic/SPORTS?${suffix}`,
    local:         `https://news.google.com/rss/headlines/section/geo/${encodeURIComponent(city || 'Pune')}?${suffix}`
  };
};

function parseGoogleItems(xml, max = 12) {
  const articles = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null && articles.length < max) {
    const block = m[1];
    let title = decode(pick(block, 'title'));
    const link = pick(block, 'link');
    const source = decode(pick(block, 'source'));
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    if (!title || !link) continue;

    // The <description> embeds this story's related-coverage cluster:
    // <ol><li><a href="url">title</a> <font>source</font></li>…</ol>
    const related = [];
    const desc = decode(pick(block, 'description'));
    if (desc) {
      const liRe = /<li><a href="([^"]+)"[^>]*>([^<]+)<\/a>[^<]*<font[^>]*>([^<]+)<\/font>/g;
      let r;
      while ((r = liRe.exec(desc)) !== null && related.length < 8) {
        related.push({ url: r[1], title: decode(r[2]), source: decode(r[3]) });
      }
    }
    const sources = [...new Set([source, ...related.map((x) => x.source)].filter(Boolean))];

    articles.push({
      title, url: link, source, sources, related,
      lean: leanOf(source), publishedAt: pick(block, 'pubDate') || ''
    });
  }
  return articles;
}

function fetchXml(url) {
  return new Promise((res) => fetchText(url, 4, (err, data) => res(err ? null : data)));
}

// ── og:image (hero pictures) ──
// Google News interstitials all report the same generic logo as og:image, so
// real photos require resolving the publisher URL first.
const GENERIC_OG_PREFIX = 'https://lh3.googleusercontent.com/J6_coFbog';
const realUrlCache = new Map(); // google url → publisher url | null
const heroCache = new Map(); // url → image | null

// Resolve a news.google.com interstitial to the real publisher URL via
// Google's own decode RPC (signature + timestamp live in the interstitial).
function resolveRealUrl(url) {
  if (!/news\.google\.com/.test(url)) return Promise.resolve(url);
  if (realUrlCache.has(url)) return Promise.resolve(realUrlCache.get(url));
  return new Promise((resolve) => {
    const remember = (v) => {
      realUrlCache.set(url, v);
      if (realUrlCache.size > 300) realUrlCache.delete(realUrlCache.keys().next().value);
      resolve(v);
    };
    fetchText(url, 6, (err, interstitial) => {
      if (err || !interstitial) return remember(null);
      const sig = /data-n-a-sg="([^"]+)"/.exec(interstitial)?.[1];
      const ts = /data-n-a-ts="([^"]+)"/.exec(interstitial)?.[1];
      const artId = /articles\/([^?"']+)/.exec(url)?.[1];
      if (!sig || !ts || !artId) return remember(null);

      const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], artId, Number(ts), sig]);
      const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
      const req = https.request({
        hostname: 'news.google.com',
        path: '/_/DotsSplashUi/data/batchexecute',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'Mozilla/5.0' }
      }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => {
          const um = /"garturlres\\",\\"(https?:\/\/[^\\"]+)/.exec(d);
          remember(um ? um[1] : null);
        });
      });
      req.on('error', () => remember(null));
      req.write(body);
      req.end();
    });
  });
}

// Strip paywall / boilerplate / navigation junk from scraped article text so
// the AI (and any fallback) only ever sees real reporting.
const JUNK_LINE = /subscribe|subscription|sign in|sign up|log in|already a (member|subscriber)|create (a free )?account|premium (stories|content)|unlock|paywall|newsletter|cookie|accept all|enable javascript|not a robot|captcha|advertisement|read more|continue reading|follow us|download the app|terms of (use|service)|privacy policy|all rights reserved|©|comprises a (dedicated|team)|news desk|editorial team|share this|trending (now|topics)/i;
function cleanArticleText(text) {
  if (!text) return '';
  return (text.split('\n')
    .filter((p) => p.length > 60 && !JUNK_LINE.test(p) && /[.!?]/.test(p))
    .join('\n')).slice(0, 4000);
}

// Fetch a publisher article: resolve the real URL, then extract readable
// paragraph text and the og:image from the page.
async function fetchArticleContent(url) {
  const realUrl = (await resolveRealUrl(url)) || url;
  const page = await new Promise((res) => fetchText(realUrl, 6, (err, d) => res(err ? null : d)));
  if (!page) return { realUrl };
  const body = page
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((p) => decode(p[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 60);
  const text = paras.join('\n').slice(0, 3500);
  let image = matchOg(page);
  if (image && image.startsWith(GENERIC_OG_PREFIX)) image = null;
  return { realUrl, text, image };
}

// Get a real article image: resolve the publisher URL, then read its og:image.
async function fetchArticleImage(googleUrl) {
  if (heroCache.has('img:' + googleUrl)) return heroCache.get('img:' + googleUrl);
  const real = await resolveRealUrl(googleUrl);
  let img = real ? await fetchOgImage(real) : null;
  if (img && img.startsWith(GENERIC_OG_PREFIX)) img = null;
  heroCache.set('img:' + googleUrl, img);
  return img;
}
function matchOg(html) {
  const m = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)
        || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html);
  return m ? decode(m[1]) : null;
}

function fetchOgImage(target) {
  if (heroCache.has(target)) return Promise.resolve(heroCache.get(target));
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      heroCache.set(target, val);
      if (heroCache.size > 100) heroCache.delete(heroCache.keys().next().value);
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), 7000);
    let redirects = 6;
    const get = (u) => {
      try {
        https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects-- > 0) {
            res.resume();
            return get(new URL(res.headers.location, u).toString());
          }
          let html = '';
          res.on('data', (chunk) => {
            html += chunk;
            const og = matchOg(html);
            if (og || /<\/head>/i.test(html) || html.length > 800000) { res.destroy(); finish(og); }
          });
          res.on('end', () => finish(matchOg(html)));
          res.on('error', () => finish(null));
        }).on('error', () => finish(null));
      } catch { finish(null); }
    };
    get(target);
  });
}

// ── Handlers ──
function registerNewsHandlers(ipcMain) {
  // One news section. `withImages` fetches og:image for the first N articles.
  ipcMain.handle('news:section', async (_e, { section, city, withImages = 0 }) => {
    let articles;
    const suffix = 'hl=en-IN&gl=IN&ceid=IN:en';

    if (section === 'local') {
      // Geo feeds are sparse — merge with a search feed for the city and dedupe
      const town = city || 'Pune';
      const [geoXml, searchXml] = await Promise.all([
        fetchXml(SECTION_URLS(town).local),
        fetchXml(`https://news.google.com/rss/search?q=${encodeURIComponent(town)}&${suffix}`)
      ]);
      const seen = new Set();
      articles = [];
      [...parseGoogleItems(geoXml || '', 10), ...parseGoogleItems(searchXml || '', 20)].forEach((a) => {
        const key = a.title.toLowerCase();
        if (!seen.has(key)) { seen.add(key); articles.push(a); }
      });
      articles = articles.slice(0, 10);
    } else {
      const url = SECTION_URLS(city)[section];
      if (!url) return { error: `Unknown section: ${section}` };
      const xml = await fetchXml(url);
      if (!xml) return { error: 'Fetch failed' };
      articles = parseGoogleItems(xml, 12);
    }

    if (!articles || !articles.length) return { error: 'No articles' };

    if (withImages > 0) {
      await Promise.all(articles.slice(0, withImages).map(async (a) => {
        a.image = upscaleImage(await fetchArticleImage(a.url));
        // Main source blocked us or had no picture — try the related coverage
        if (!a.image && a.related?.length) {
          for (const r of a.related.slice(0, 2)) {
            a.image = upscaleImage(await fetchArticleImage(r.url));
            if (a.image) break;
          }
        }
      }));
    }
    return { articles };
  });

  // Trending on X — scraped from trends24.in (no keyless official API exists)
  ipcMain.handle('news:xtrends', async () => {
    const html = await new Promise((res) =>
      fetchText('https://trends24.in/india/', 4, (err, data) => res(err ? null : data)));
    if (!html) return { error: 'Fetch failed' };

    const seen = new Set();
    const topics = [];
    const re = /<a href="https?:\/\/(?:twitter|x)\.com\/search\?q=([^"]*)"[^>]*>([^<]+)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null && topics.length < 12) {
      const topic = decode(m[2]).trim();
      const key = topic.toLowerCase();
      if (!topic || seen.has(key) || !isEnglish(topic)) continue;
      seen.add(key);
      topics.push({ topic, url: `https://x.com/search?q=${m[1]}` });
    }
    return topics.length ? { topics } : { error: 'No topics' };
  });

  // Resolve a Google News interstitial to the real article URL, then pull the
  // article's paragraph text (for pre-click AI summaries).
  ipcMain.handle('news:article', async (_e, { url }) => {
    try {
      const c = await fetchArticleContent(url);
      if (!c.text) return { realUrl: c.realUrl, error: 'No readable text' };
      return { realUrl: c.realUrl, text: c.text };
    } catch (e) {
      return { error: e.message };
    }
  });

  // Full story cluster (Particle/Perplexity style):
  //  • Aggregate ALL outlets covering the story (RSS cluster + a keyword search)
  //  • Fetch readable text from the top few for AI synthesis
  ipcMain.handle('news:story', async (_e, { url, title, source, related = [] }) => {
    const suffix = 'hl=en-IN&gl=IN&ceid=IN:en';

    // Search Google News for this story to pull in the wider cluster of outlets
    const query = title.replace(/[|"'].*$/, '').split(/\s+/).slice(0, 9).join(' ');
    const searchXml = await fetchXml(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${suffix}`);
    const searchItems = searchXml ? parseGoogleItems(searchXml, 40) : [];

    // Collect every unique outlet name + a representative link for each
    const outletMap = new Map(); // sourceName → { source, url }
    const addOutlet = (s, u) => { if (s && !outletMap.has(s)) outletMap.set(s, { source: s, url: u }); };
    addOutlet(source, url);
    related.forEach((r) => addOutlet(r.source, r.url));
    searchItems.forEach((it) => {
      addOutlet(it.source, it.url);
      (it.related || []).forEach((r) => addOutlet(r.source, r.url));
    });
    const outlets = [...outletMap.values()];

    // Pick a handful of readable candidates to actually fetch (prefer the
    // primary + related, then fill from the search cluster)
    const fetchTargets = [{ url, title, source }, ...related, ...searchItems.map((i) => ({ url: i.url, title: i.title, source: i.source }))]
      .filter((t, i, arr) => arr.findIndex((x) => x.source === t.source) === i)
      .slice(0, 6);

    const fetched = await Promise.all(fetchTargets.map(async (t) => {
      try {
        const c = await fetchArticleContent(t.url);
        return { title: t.title, source: t.source, url: t.url, realUrl: c.realUrl, text: cleanArticleText(c.text), image: c.image || null };
      } catch {
        return { title: t.title, source: t.source, url: t.url, realUrl: null, text: '', image: null };
      }
    }));

    const readable = fetched.filter((s) => s.text.length > 250);
    const image = fetched.map((s) => upscaleImage(s.image)).find(Boolean) || null;
    return { outlets, sourceCount: outlets.length, articles: readable, image, ok: readable.length > 0 };
  });

  // Robust image finder for a story: try the main article + its related
  // coverage, then the wider search cluster — return the first real photo.
  ipcMain.handle('news:image', async (_e, { url, title, related = [] }) => {
    const firstImage = async (urls) => {
      const imgs = await Promise.all(urls.map(async (u) => {
        try { return upscaleImage(await fetchArticleImage(u)); } catch { return null; }
      }));
      return imgs.find(Boolean) || null;
    };

    let img = await firstImage([url, ...related.slice(0, 4).map((r) => r.url)]);
    if (img) return { image: img };

    const suffix = 'hl=en-IN&gl=IN&ceid=IN:en';
    const query = title.replace(/[|"'].*$/, '').split(/\s+/).slice(0, 8).join(' ');
    const xml = await fetchXml(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${suffix}`);
    const items = xml ? parseGoogleItems(xml, 6) : [];
    img = await firstImage(items.map((i) => i.url));
    return { image: img };
  });

  // Podcast episodes covering the story (Apple iTunes Search API — keyless)
  ipcMain.handle('news:podcasts', async (_e, { title }) => {
    const query = title.replace(/[|"'].*$/, '').split(/\s+/).slice(0, 7).join(' ');
    const data = await fetchJson(`https://itunes.apple.com/search?media=podcast&entity=podcastEpisode&limit=8&term=${encodeURIComponent(query)}`);
    const eps = (data?.results || [])
      .filter((r) => r.trackName && (r.episodeUrl || r.previewUrl || r.trackViewUrl))
      .slice(0, 6)
      .map((r) => ({
        title: r.trackName,
        show: r.collectionName || '',
        artwork: r.artworkUrl600 || r.artworkUrl160 || r.artworkUrl100 || '',
        audio: r.episodeUrl || r.previewUrl || '',
        url: r.trackViewUrl || r.collectionViewUrl || '',
        date: r.releaseDate || ''
      }));
    return eps.length ? { episodes: eps } : { error: 'No podcasts' };
  });

  // Google Trends — what people are searching right now
  ipcMain.handle('news:trending', async () => {
    const xml = await new Promise((res) =>
      fetchText('https://trends.google.com/trending/rss?geo=IN', 4, (err, data) => res(err ? null : data)));
    if (!xml) return { error: 'Fetch failed' };

    const topics = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) !== null && topics.length < 14) {
      const block = m[1];
      const topic = decode(pick(block, 'title'));
      if (!topic || !isEnglish(topic)) continue;
      topics.push({
        topic,
        traffic: pick(block, 'ht:approx_traffic'),
        newsTitle: decode(pick(block, 'ht:news_item_title')),
        url: pick(block, 'ht:news_item_url') || `https://www.google.com/search?q=${encodeURIComponent(topic)}`
      });
    }
    return topics.length ? { topics } : { error: 'No topics' };
  });

  // Prediction markets — Polymarket (odds) + Kalshi (trending questions)
  ipcMain.handle('news:predictions', async () => {
    const [poly, kalshi] = await Promise.all([
      fetchJson('https://gamma-api.polymarket.com/markets?closed=false&order=volume24hr&ascending=false&limit=10'),
      fetchJson('https://api.elections.kalshi.com/trade-api/v2/events?limit=8&status=open')
    ]);

    const markets = [];
    if (Array.isArray(poly)) {
      poly.forEach((mk) => {
        try {
          const outcomes = JSON.parse(mk.outcomes || '[]');
          const prices = (JSON.parse(mk.outcomePrices || '[]') || []).map(Number);
          if (!mk.question || !outcomes.length || !prices.length) return;
          markets.push({
            platform: 'Polymarket',
            question: mk.question,
            outcomes: outcomes.slice(0, 2),
            probabilities: prices.slice(0, 2),
            volume24h: Math.round(mk.volume24hr || 0),
            url: mk.slug ? `https://polymarket.com/market/${mk.slug}` : 'https://polymarket.com'
          });
        } catch { /* skip malformed market */ }
      });
    }

    const kalshiEvents = [];
    if (kalshi && Array.isArray(kalshi.events)) {
      kalshi.events.forEach((ev) => {
        if (!ev.title) return;
        const series = (ev.event_ticker || '').split('-')[0].toLowerCase();
        kalshiEvents.push({
          platform: 'Kalshi',
          question: ev.title,
          url: series ? `https://kalshi.com/markets/${series}` : 'https://kalshi.com'
        });
      });
    }

    if (!markets.length && !kalshiEvents.length) return { error: 'No prediction data' };
    return { markets: markets.slice(0, 8), kalshi: kalshiEvents.slice(0, 6) };
  });
}

module.exports = { registerNewsHandlers, parseGoogleItems, fetchXml, leanOf, fetchArticleImage, fetchArticleContent };
