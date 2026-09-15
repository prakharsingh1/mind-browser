// =============================================================================
// Local Mind Browser — New Tab Page Services
// =============================================================================
// Backend for the New Tab widgets: weather, wallpapers and news headlines.
// Everything here is keyless and cached, so the page renders instantly on
// repeat visits and degrades gracefully when the network is unavailable.

const https = require('https');
// Resolves Google News interstitial links and pulls the article's og:image,
// rejecting Google's generic placeholder. Already battle-tested by the News page.
const { fetchArticleImage } = require('./news');

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) MindBrowser/1.1' };

// ── Tiny fetch helper with a real timeout ────────────────────────────────────
// The old weather widget hung forever on a stalled socket, leaving "--°C" on
// screen with no way to recover. Every request here is time-boxed.
function fetchText(url, { timeout = 8000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: UA }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchText(res.headers.location, { timeout, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const fetchJson = async (url, opts) => JSON.parse(await fetchText(url, opts));

// ── Cache ────────────────────────────────────────────────────────────────────
const cache = new Map();  // key → { at, ttl, value }

function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return Promise.resolve(hit.value);
  return producer().then((value) => {
    cache.set(key, { at: Date.now(), ttl: ttlMs, value });
    return value;
  }).catch((err) => {
    // Serve stale data rather than a broken widget when the network blips.
    if (hit) return hit.value;
    throw err;
  });
}

// ── Weather ──────────────────────────────────────────────────────────────────
// Open-Meteo instead of wttr.in: wttr.in rate-limits aggressively and answers
// with a plaintext error that isn't JSON, which is what left the widget stuck
// on "Unavailable". Open-Meteo is keyless, high-limit and returns real JSON.

// WMO weather code → { label, icon }. Icons are drawn client-side from these ids.
const WMO = {
  0: ['Clear', 'sun'], 1: ['Mainly clear', 'sun'], 2: ['Partly cloudy', 'cloud-sun'],
  3: ['Overcast', 'cloud'], 45: ['Fog', 'fog'], 48: ['Rime fog', 'fog'],
  51: ['Light drizzle', 'drizzle'], 53: ['Drizzle', 'drizzle'], 55: ['Heavy drizzle', 'drizzle'],
  56: ['Freezing drizzle', 'sleet'], 57: ['Freezing drizzle', 'sleet'],
  61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'],
  66: ['Freezing rain', 'sleet'], 67: ['Freezing rain', 'sleet'],
  71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'],
  77: ['Snow grains', 'snow'], 80: ['Showers', 'rain'], 81: ['Showers', 'rain'],
  82: ['Heavy showers', 'rain'], 85: ['Snow showers', 'snow'], 86: ['Snow showers', 'snow'],
  95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm', 'storm'], 99: ['Thunderstorm', 'storm']
};

/** Detect the user's city from their IP (no permission prompt needed). */
async function detectLocation() {
  return cached('geo:auto', 6 * 60 * 60 * 1000, async () => {
    const providers = [
      { url: 'https://ipapi.co/json/', map: (j) => ({ city: j.city, lat: j.latitude, lon: j.longitude }) },
      { url: 'https://ipwho.is/', map: (j) => ({ city: j.city, lat: j.latitude, lon: j.longitude }) }
    ];
    for (const p of providers) {
      try {
        const geo = p.map(await fetchJson(p.url, { timeout: 5000 }));
        if (geo.city && geo.lat != null) return geo;
      } catch { /* try the next provider */ }
    }
    throw new Error('location-unavailable');
  });
}

/** Resolve a typed city name to coordinates. */
async function geocode(city) {
  return cached(`geo:${city.toLowerCase()}`, 30 * 24 * 60 * 60 * 1000, async () => {
    const j = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
      { timeout: 6000 }
    );
    const r = j.results && j.results[0];
    if (!r) throw new Error('city-not-found');
    return { city: r.name, lat: r.latitude, lon: r.longitude };
  });
}

async function getWeather(city) {
  // `city` empty/"auto" → detect from IP, otherwise geocode what the user set.
  const place = (!city || city === 'auto') ? await detectLocation() : await geocode(city);
  const key = `wx:${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
  return cached(key, 15 * 60 * 1000, async () => {
    const j = await fetchJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
      `&current=temperature_2m,weather_code,is_day,apparent_temperature` +
      `&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`,
      { timeout: 8000 }
    );
    const [label, icon] = WMO[j.current.weather_code] || ['—', 'cloud'];
    return {
      city: place.city,
      temp: Math.round(j.current.temperature_2m),
      feelsLike: Math.round(j.current.apparent_temperature),
      high: Math.round(j.daily.temperature_2m_max[0]),
      low: Math.round(j.daily.temperature_2m_min[0]),
      label,
      icon,
      isDay: j.current.is_day === 1,
      unit: '°C'
    };
  });
}

// ── Wallpapers ───────────────────────────────────────────────────────────────
// Bing's daily image archive is keyless and serves genuine 4K (UHD) photos.
async function getWallpapers() {
  return cached('wallpapers', 6 * 60 * 60 * 1000, async () => {
    const j = await fetchJson(
      'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=en-US',
      { timeout: 8000 }
    );
    return (j.images || []).map((img) => ({
      id: img.hsh || img.urlbase,
      title: (img.title || '').trim(),
      copyright: (img.copyright || '').replace(/\s*\(©.*$/, '').trim(),
      url: `https://www.bing.com${img.urlbase}_UHD.jpg`,
      thumb: `https://www.bing.com${img.urlbase}_320x240.jpg`
    }));
  });
}

// ── News ─────────────────────────────────────────────────────────────────────
// Google News RSS titles arrive as "Headline - Publisher"; the old widget kept
// the suffix and then clamped it away, which is why headlines read as truncated
// fragments. We strip the publisher, keep the full sentence, and tag a category.
const CATEGORIES = {
  general: 'Top Stories', world: 'World', nation: 'India', business: 'Business',
  technology: 'Technology', entertainment: 'Entertainment', sports: 'Sports',
  science: 'Science', health: 'Health'
};

const SECTIONS = {
  world: 'WORLD', nation: 'NATION', business: 'BUSINESS', technology: 'TECHNOLOGY',
  entertainment: 'ENTERTAINMENT', sports: 'SPORTS', science: 'SCIENCE', health: 'HEALTH'
};

const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

function cleanHeadline(raw) {
  let t = decodeEntities(raw).trim();
  // Google appends " - Publisher", and outlets often add their own " | Section"
  // on top, so strip up to two trailing tags rather than just one. The tail must
  // be short and separator-free to avoid eating real headline text.
  for (let i = 0; i < 2; i++) {
    const next = t.replace(/\s+[-–|]\s+[^-–|]{2,40}$/, '').trim();
    if (next === t || next.length < 25) break;   // don't strip into the headline
    t = next;
  }
  return t;
}

async function getNews(topic = 'general') {
  const section = SECTIONS[topic];
  const suffix = 'hl=en-IN&gl=IN&ceid=IN:en';
  const url = section
    ? `https://news.google.com/rss/headlines/section/topic/${section}?${suffix}`
    : `https://news.google.com/rss?${suffix}`;

  return cached(`news:${topic}`, 10 * 60 * 1000, async () => {
    const xml = await fetchText(url, { timeout: 8000 });
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) && items.length < 8) {
      const block = m[1];
      const pick = (tag) => {
        const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
        return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      };
      const title = cleanHeadline(pick('title'));
      if (!title) continue;
      items.push({
        title,
        url: pick('link'),
        source: decodeEntities(pick('source')),
        publishedAt: pick('pubDate'),
        category: CATEGORIES[topic] || 'Top Stories'
      });
    }
    if (!items.length) throw new Error('no-news');

    // Attach artwork to the ones the widget can actually show. Bounded in count
    // and time so a slow publisher can't hold up the whole widget; anything that
    // misses simply falls back to the gradient.
    const withArt = items.slice(0, 5);
    await Promise.allSettled(withArt.map(async (a) => {
      const img = await Promise.race([
        fetchArticleImage(a.url).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 6000))
      ]);
      if (img) a.image = img;
    }));

    // Lead with the ones that have artwork — the tile is image-first.
    items.sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0));
    return { articles: items, category: CATEGORIES[topic] || 'Top Stories' };
  });
}

// ── Favicons ─────────────────────────────────────────────────────────────────
// Fetched in the main process and handed back as data URLs. Renderer-side <img>
// loads against favicon services can stall with no error event (leaving blank
// tiles); doing it here gives us real status codes, timeouts and a fallback
// chain, and the result is cacheable by the renderer across restarts.
function fetchBinary(url, { timeout = 6000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: UA }, (res) => {
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

async function getFavicon(pageUrl) {
  let host;
  try { host = new URL(pageUrl).hostname; } catch { throw new Error('bad-url'); }

  return cached(`icon:${host}`, 7 * 24 * 60 * 60 * 1000, async () => {
    const sources = [
      `https://www.google.com/s2/favicons?domain=${host}&sz=128`,
      `https://icons.duckduckgo.com/ip3/${host}.ico`,
      `https://${host}/favicon.ico`
    ];
    for (const src of sources) {
      try {
        const { buf, type } = await fetchBinary(src);
        // Google answers unknown domains with a tiny generic globe — skip it.
        if (buf.length < 120) continue;
        return `data:${type};base64,${buf.toString('base64')}`;
      } catch { /* next source */ }
    }
    throw new Error('no-icon');
  });
}

// ── Wallpaper caching ────────────────────────────────────────────────────────
// Download the chosen wallpaper here and hand back a local file path. Renderer
// image loads against remote hosts can stall silently in the packaged app (the
// same failure that blanked the favicons), and caching also means the wallpaper
// survives going offline. Too large to keep in localStorage, so it goes to disk.
async function cacheWallpaper(url) {
  if (!url || url.startsWith('data:') || url.startsWith('file:')) return url;

  const { app } = require('electron');
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');

  const dir = path.join(app.getPath('userData'), 'local-mind-data', 'wallpapers');
  const name = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + '.jpg';
  const dest = path.join(dir, name);

  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) return dest;

  const { buf } = await fetchBinary(url, { timeout: 25000 });
  if (buf.length < 1024) throw new Error('too-small');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, buf);

  // Keep only the most recent handful so this can't grow without bound.
  try {
    const files = fs.readdirSync(dir)
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    files.slice(6).forEach(({ f }) => { try { fs.unlinkSync(path.join(dir, f)); } catch {} });
  } catch { /* pruning is best-effort */ }

  return dest;
}

// ── Display name ─────────────────────────────────────────────────────────────
let cachedName = null;
function getDisplayName() {
  if (cachedName !== null) return cachedName;
  try {
    // macOS full name ("Prakhar Singh") → first name for the greeting.
    const full = require('child_process').execFileSync('id', ['-F'], { encoding: 'utf8', timeout: 1500 }).trim();
    cachedName = full ? full.split(/\s+/)[0] : '';
  } catch {
    const u = require('os').userInfo().username || '';
    cachedName = u ? u.charAt(0).toUpperCase() + u.slice(1) : '';
  }
  return cachedName;
}

function registerNtpHandlers(ipcMain) {
  const wrap = (fn) => async (...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message || 'failed' }; }
  };

  ipcMain.handle('ntp:weather', wrap((_e, city) => getWeather(city)));
  ipcMain.handle('ntp:wallpapers', wrap(() => getWallpapers()));
  ipcMain.handle('ntp:news', wrap((_e, topic) => getNews(topic)));
  ipcMain.handle('ntp:favicon', wrap((_e, url) => getFavicon(url)));
  ipcMain.handle('ntp:cache-wallpaper', wrap((_e, url) => cacheWallpaper(url)));
  ipcMain.handle('ntp:display-name', wrap(() => getDisplayName()));
}

module.exports = { registerNtpHandlers };
