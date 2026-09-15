// =============================================================================
// Local Mind Browser — Onion Research
// =============================================================================
// Lets the AI agent search and read .onion sources, so it can answer questions
// about material that simply is not on the clearnet — censored reporting,
// SecureDrop instances, mirrors of sites blocked in a given country — and cite
// where each claim came from.
//
// This is the same shape as the standalone OSINT tools people currently run
// beside a browser: search over Tor, read the results, synthesise with
// citations. The difference is that the browser already has the agent and the
// Tor session, so the two halves do not need gluing together by hand.
//
// Two rules this module keeps:
//   • It never opens its own network path. Every request goes through the
//     onion session, which carries the SOCKS proxy — a plain https.request
//     here would silently fetch over the clearnet and leak the query.
//   • It returns URLs with every result, so the agent can cite rather than
//     assert. Unsourced claims about onion material are worthless.

const { net, session } = require('electron');
const tor = require('./tor');
const onion = require('./onion');

// DuckDuckGo's onion service: no logging, no result personalisation, and it
// indexes both clearnet and onion results.
const DDG = 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion';
// Ahmia indexes onion services specifically, and filters abuse material at the
// source — which is why it is the onion-only index worth using.
const AHMIA = 'http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion';

const MAX_BYTES = 2 * 1024 * 1024;      // a page, not a download

/** Tor up and the proxied session configured. Cheap once both are true. */
async function ready() {
  await tor.start();
  await onion.ensureSession();
}

/**
 * Fetch through Tor.
 *
 * Electron's net.request with an explicit session inherits that session's
 * proxy, which is the whole point: the onion session is the only place the
 * SOCKS proxy is configured.
 */
function torFetch(url, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({
        url,
        method: 'GET',
        session: session.fromPartition(onion.PARTITION),
        useSessionCookies: false,
        redirect: 'follow'
      });
    } catch (err) {
      return reject(new Error(`bad URL: ${err.message}`));
    }

    // A plain, common user agent. Naming this browser would tag every onion
    // request as coming from Mind Browser's agent.
    req.setHeader('User-Agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0');
    req.setHeader('Accept-Language', 'en-US,en;q=0.5');

    const timer = setTimeout(() => {
      try { req.abort(); } catch { /* already gone */ }
      reject(new Error(`timed out after ${Math.round(timeout / 1000)}s — onion services are often slow, or it may be offline`));
    }, timeout);

    const chunks = [];
    let size = 0;

    req.on('response', (res) => {
      if (res.statusCode >= 400) {
        clearTimeout(timer);
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          try { req.abort(); } catch {}
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      // The most common cause by far, and the least obvious from the raw text.
      if (/PROXY|SOCKS|ECONNREFUSED/i.test(err.message)) {
        reject(new Error(`could not reach Tor (${err.message}). Onion Mode may still be connecting.`));
      } else {
        reject(err);
      }
    });

    req.end();
  });
}

// ── HTML helpers ─────────────────────────────────────────────────────────────
const decode = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');

const strip = (html) => decode(
  String(html)
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
).replace(/\s{2,}/g, ' ').trim();

/**
 * Search over Tor.
 *
 * Ahmia is queried for onion-only results; DuckDuckGo for everything. Both are
 * scraped from HTML because neither offers an API over its onion service —
 * which makes the parsing brittle by nature, so a failure to find results is
 * reported as such rather than as "nothing exists".
 */
async function onionSearch({ query, count = 8, index = 'duckduckgo' } = {}) {
  if (!query || !String(query).trim()) throw new Error('query is required');
  await ready();

  const n = Math.max(1, Math.min(Number(count) || 8, 25));
  // DuckDuckGo by default: its onion service has stable markup and indexes both
  // clearnet and onion results. Ahmia is onion-only and useful, but its result
  // page did not yield hits to scraping, so it is opt-in rather than the
  // default — a search tool that silently returns nothing is worse than useless.
  const useAhmia = index === 'ahmia';
  const url = useAhmia
    ? `${AHMIA}/search/?q=${encodeURIComponent(query)}`
    : `${DDG}/html/?q=${encodeURIComponent(query)}`;

  const html = await torFetch(url);
  const results = [];

  if (useAhmia) {
    // Deliberately structural rather than pinned to Ahmia's CSS classes.
    //
    // The first version matched <li class="result">…</li> and broke the moment
    // that markup differed, returning zero results — which reads as "nothing
    // exists" and is the worst possible failure for a search tool. Every hit is
    // an anchor pointing at an onion, so match THAT: it survives a redesign.
    const seen = new Set();
    const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && results.length < n) {
      let href = decode(m[1]);
      // Ahmia wraps hits in /search/redirect?...redirect_url=<real onion>
      const redirect = /redirect_url=([^&"]+)/.exec(href);
      if (redirect) { try { href = decodeURIComponent(redirect[1]); } catch { /* keep raw */ } }
      if (!/^https?:\/\//i.test(href)) continue;
      if (!/\.onion(\/|$|:)/i.test(href)) continue;      // ignore Ahmia's own nav links
      const key = href.replace(/\/+$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      const title = strip(m[2]).slice(0, 140);
      results.push({ title: title || href, url: href, snippet: '' });
    }
  } else {
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && results.length < n) {
      let href = decode(m[1]);
      const uddg = /uddg=([^&"]+)/.exec(href);
      if (uddg) href = decodeURIComponent(uddg[1]);
      if (!/^https?:\/\//i.test(href)) continue;
      results.push({ title: strip(m[2]).slice(0, 140), url: href, snippet: '' });
    }
  }

  return {
    query,
    index: useAhmia ? 'ahmia' : 'duckduckgo',
    count: results.length,
    results,
    ...(results.length ? {} : {
      note: 'No results parsed. The index may have changed its markup, or the query genuinely has no hits — do not treat this as proof that nothing exists.'
    })
  };
}

/** Read one page over Tor and return its readable text. */
async function onionFetch({ url, max_chars = 6000 } = {}) {
  if (!url) throw new Error('url is required');
  let target = String(url).trim();
  // Onion services have no TLS, so an https:// onion simply fails to connect.
  if (!/^https?:\/\//i.test(target)) {
    target = (/\.onion(\/|$|:)/i.test(target) ? 'http://' : 'https://') + target;
  }
  await ready();

  const html = await torFetch(target);
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '').trim();
  const text = strip(html);
  const limit = Math.max(500, Math.min(Number(max_chars) || 6000, 20000));

  return {
    url: target,
    title: title.slice(0, 200),
    text: text.slice(0, limit),
    truncated: text.length > limit,
    chars: text.length
  };
}

module.exports = { onionSearch, onionFetch, torFetch };
