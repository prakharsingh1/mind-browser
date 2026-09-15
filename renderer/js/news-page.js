// =============================================================================
// Local Mind Browser — News Page
// =============================================================================
// Full-page news dashboard: top headlines with hero images, sectioned cards,
// Google + X trends, prediction markets, Ground News-style publication-lean
// filtering, and AI features (daily briefing + per-article summaries) powered
// by the model chosen in Settings → News.

const NewsPage = (() => {
  const REFRESH_MS = 15 * 60 * 1000;
  let lastLoaded = 0;
  let refreshTimer = null;
  let loading = false;
  let leanFilter = 'all';
  const cache = { top: null, sections: {} };

  const SECTIONS = [
    { id: 'india',         label: 'India' },
    { id: 'local',         label: 'Local' },
    { id: 'world',         label: 'World' },
    { id: 'business',      label: 'Business & Finance' },
    { id: 'technology',    label: 'Technology & AI' },
    { id: 'entertainment', label: 'Culture & Entertainment' }
  ];

  const LEAN_META = {
    left:    { label: 'Left',    color: '#5b9dd9' },
    center:  { label: 'Center',  color: '#b0b7c3' },
    right:   { label: 'Right',   color: '#e06c5c' },
    unrated: { label: '',        color: 'transparent' }
  };

  // Publication → website domain, for source favicons (Perplexity-style chips)
  const SOURCE_DOMAINS = {
    'ndtv': 'ndtv.com', 'the hindu': 'thehindu.com', 'hindustan times': 'hindustantimes.com',
    'the times of india': 'timesofindia.indiatimes.com', 'times of india': 'timesofindia.indiatimes.com',
    'the indian express': 'indianexpress.com', 'indian express': 'indianexpress.com',
    'india today': 'indiatoday.in', 'moneycontrol': 'moneycontrol.com', 'moneycontrol.com': 'moneycontrol.com',
    'livemint': 'livemint.com', 'mint': 'livemint.com', 'the economic times': 'economictimes.indiatimes.com',
    'economic times': 'economictimes.indiatimes.com', 'business standard': 'business-standard.com',
    'reuters': 'reuters.com', 'bbc': 'bbc.com', 'bbc news': 'bbc.com', 'cnn': 'cnn.com',
    'al jazeera': 'aljazeera.com', 'the guardian': 'theguardian.com', 'bloomberg': 'bloomberg.com',
    'bloomberg.com': 'bloomberg.com', 'cnbc': 'cnbc.com', 'cnbc tv18': 'cnbctv18.com', 'cnbctv18': 'cnbctv18.com',
    'news18': 'news18.com', 'firstpost': 'firstpost.com', 'deccan herald': 'deccanherald.com',
    'the wire': 'thewire.in', 'scroll.in': 'scroll.in', 'the quint': 'thequint.com',
    'dw': 'dw.com', 'dw.com': 'dw.com', 'times now': 'timesnownews.com', 'zee news': 'zeenews.india.com',
    'ani': 'aninews.in', 'the new york times': 'nytimes.com', 'washington post': 'washingtonpost.com',
    'the washington post': 'washingtonpost.com', 'ap news': 'apnews.com', 'associated press': 'apnews.com',
    'sky news': 'news.sky.com', 'fox news': 'foxnews.com', 'financial times': 'ft.com',
    'the wall street journal': 'wsj.com', 'wsj': 'wsj.com', 'forbes': 'forbes.com',
    'techcrunch': 'techcrunch.com', 'the verge': 'theverge.com', 'wired': 'wired.com',
    'pinkvilla': 'pinkvilla.com', 'bollywood hungama': 'bollywoodhungama.com',
    'espn': 'espn.com', 'espncricinfo': 'espncricinfo.com', 'cricbuzz': 'cricbuzz.com',
    'upstox': 'upstox.com', 'gsmarena.com': 'gsmarena.com', 'techradar': 'techradar.com',
    'autocar india': 'autocarindia.com', 'news on air': 'newsonair.gov.in', 'the print': 'theprint.in',
    'outlook india': 'outlookindia.com', 'business today': 'businesstoday.in', 'the week': 'theweek.in',
    'free press journal': 'freepressjournal.in', 'telegraph india': 'telegraphindia.com', 'mid-day': 'mid-day.com',
    'greatandhra.com': 'greatandhra.com', 'koimoi': 'koimoi.com', 'oneindia': 'oneindia.com'
  };

  function sourceFavicon(name, size = 16) {
    const domain = SOURCE_DOMAINS[(name || '').toLowerCase().trim()];
    if (domain) {
      return `<img class="news-src-ico" style="width:${size}px;height:${size}px;" loading="lazy"
        src="https://www.google.com/s2/favicons?domain=${domain}&sz=64" data-on-error="hide">`;
    }
    const letter = (name || '?').trim()[0] || '?';
    return `<span class="news-src-ico news-src-letter" style="width:${size}px;height:${size}px;line-height:${size}px;">${escapeHtml(letter.toUpperCase())}</span>`;
  }

  // Overlapping favicon cluster + "N sources" (Perplexity-style)
  function sourceCluster(article) {
    const sources = (article.sources && article.sources.length ? article.sources : [article.source]).filter(Boolean);
    const icons = sources.slice(0, 4).map((s) => sourceFavicon(s, 16)).join('');
    const label = sources.length > 1 ? `${sources.length} sources` : escapeHtml(sources[0] || '');
    return `<span class="news-src-cluster">${icons}</span><span class="news-src-count">${label}</span>`;
  }

  function init() {
    document.getElementById('sidebar-news')?.addEventListener('click', toggle);
    EventBus.on('tab-activated', hide);
    EventBus.on('leave-page-views', hide);
  }

  function isVisible() {
    const page = document.getElementById('news-page');
    return page && page.style.display !== 'none';
  }

  function toggle() { isVisible() ? hide() : show(); }

  function show() {
    if (typeof NotesPage !== 'undefined') NotesPage.hide();
    const page = document.getElementById('news-page');
    if (!page) return;
    page.style.display = 'block';
    document.getElementById('sidebar-news')?.classList.add('active');
    if (typeof FinancePage !== 'undefined') FinancePage.hide();
    if (typeof StoryPage !== 'undefined') StoryPage.hide();
    if (Date.now() - lastLoaded > REFRESH_MS) loadAll();
    if (!refreshTimer) refreshTimer = setInterval(() => { if (isVisible()) loadAll(); }, REFRESH_MS);
  }

  function hide() {
    const page = document.getElementById('news-page');
    if (page) page.style.display = 'none';
    document.getElementById('sidebar-news')?.classList.remove('active');
  }

  function openArticle(url) {
    if (!url) return;
    hide();
    TabManager.createTab(url, true);
  }

  // ── Loading ──
  async function loadAll() {
    if (loading || !window.localMind?.newsSection) return;
    loading = true;
    lastLoaded = Date.now();

    const page = document.getElementById('news-page');
    if (!page.querySelector('.news-inner')) buildSkeleton(page);
    setUpdatedLabel('Updating…');

    const city = window.mindSettings?.news?.city || window.mindSettings?.widgets?.weather?.city || 'Pune';

    const jobs = [
      window.localMind.newsSection('top', city, 7).then(r => { cache.top = r; renderTop(); }),
      ...SECTIONS.map(s =>
        window.localMind.newsSection(s.id, city, 2).then(r => { cache.sections[s.id] = r; renderSection(s, city); })),
      window.localMind.newsTrending().then(r => renderTrending(r)),
      window.localMind.newsXTrends?.().then(r => renderXTrends(r)),
      window.localMind.newsPredictions().then(r => renderPredictions(r)),
      runBriefing(city)
    ];

    await Promise.allSettled(jobs);
    setUpdatedLabel(`Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    loading = false;
  }

  function setUpdatedLabel(text) {
    const el = document.getElementById('news-updated');
    if (el) el.textContent = text;
  }

  // ── Skeleton ──
  function buildSkeleton(page) {
    const today = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    page.innerHTML = `
      <div class="news-inner">
        <div class="news-header">
          <div>
            <h1>News</h1>
            <div class="news-date">${today} · <span id="news-updated">Loading…</span></div>
          </div>
          <div class="news-header-actions">
            <div class="news-lean-filter" id="news-lean-filter" title="Filter by publication lean">
              ${['all', 'left', 'center', 'right'].map(l =>
                `<button data-lean="${l}" class="${l === leanFilter ? 'active' : ''}">${l === 'all' ? 'All' : LEAN_META[l].label}</button>`).join('')}
            </div>
            <button id="news-refresh" class="news-refresh-btn" title="Refresh">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5V5H11"/></svg>
              Refresh
            </button>
          </div>
        </div>
        <div id="news-briefing"></div>
        <div id="news-top">${shimmerBlock(240)}</div>
        <div id="news-trending-wrap"></div>
        <div id="news-xtrends-wrap"></div>
        <div class="news-grid" id="news-grid">
          ${SECTIONS.map(s => `<div class="news-col" id="news-sec-${s.id}"><h2>${s.label}</h2><div class="news-col-body">${shimmerBlock(72)}${shimmerBlock(72)}</div></div>`).join('')}
        </div>
        <div id="news-predictions"></div>
      </div>`;

    page.querySelector('#news-refresh').addEventListener('click', () => { lastLoaded = 0; loadAll(); });
    page.querySelector('#news-lean-filter').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-lean]');
      if (!btn) return;
      leanFilter = btn.dataset.lean;
      page.querySelectorAll('#news-lean-filter button').forEach(b => b.classList.toggle('active', b === btn));
      renderTop();
      const city = window.mindSettings?.news?.city || window.mindSettings?.widgets?.weather?.city || 'Pune';
      SECTIONS.forEach(s => renderSection(s, city));
    });
  }

  const shimmerBlock = (h) => `<div class="news-shimmer" style="height:${h}px"></div>`;

  function filterArticles(articles) {
    if (leanFilter === 'all') return articles;
    return articles.filter(a => a.lean === leanFilter);
  }

  // ── Article card ──
  function articleCard(a, { hero = false } = {}) {
    const el = document.createElement('div');
    el.className = hero ? 'news-hero news-fade' : 'news-row news-fade';
    const lean = LEAN_META[a.lean] || LEAN_META.unrated;
    const dot = a.lean && a.lean !== 'unrated'
      ? `<span class="news-lean-dot" style="background:${lean.color}" title="${lean.label}-leaning source"></span>` : '';

    const img = a.image
      ? `<div class="${hero ? 'news-hero-img' : 'news-row-img'}" style="background-image:url('${a.image.replace(/'/g, '%27')}')"></div>`
      : (hero ? '<div class="news-hero-img news-hero-img-empty"></div>' : '');

    el.innerHTML = `
      ${img}
      <div class="${hero ? 'news-hero-body' : 'news-row-main'}">
        <div class="${hero ? 'news-hero-title' : 'news-row-title'}">${escapeHtml(a.title)}</div>
        <div class="news-row-meta">
          ${dot}${a.source ? `${sourceFavicon(a.source, 13)}<span class="news-source">${escapeHtml(a.source)}</span>` : ''}
          ${a.publishedAt ? `<span>${relTime(a.publishedAt)}</span>` : ''}
          <button class="news-sum-btn" title="AI summary">✦ Summarize</button>
        </div>
        <div class="news-sum" style="display:none;"></div>
      </div>`;

    el.addEventListener('click', (e) => {
      if (e.target.closest('.news-sum-btn') || e.target.closest('.news-sum')) return;
      openStory(a);
    });
    el.querySelector('.news-sum-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      summarizeInto(el.querySelector('.news-sum'), a);
    });
    return el;
  }

  // ── Pre-click AI summary ──
  async function summarizeInto(box, article) {
    if (!box) return;
    if (box.dataset.done) { box.style.display = box.style.display === 'none' ? 'block' : 'none'; return; }

    const model = window.mindSettings?.news?.model;
    box.style.display = 'block';
    if (!model) {
      box.innerHTML = '<span class="news-sum-note">Choose an AI model in Settings → News to enable summaries.</span>';
      box.dataset.done = '1';
      return;
    }

    box.innerHTML = '<span class="news-sum-note news-sum-loading">✦ Reading article…</span>';
    try {
      const art = await window.localMind.newsArticle(article.url);
      if (!art?.text) {
        box.innerHTML = '<span class="news-sum-note">Couldn\'t read this article — open it instead.</span>';
        box.dataset.done = '1';
        return;
      }
      box.innerHTML = '<span class="news-sum-note news-sum-loading">✦ Summarizing…</span>';
      const result = await window.localMind.chat([
        { role: 'system', content: 'Summarize the given news article in one tight paragraph of 3-4 sentences. Plain text only, no preamble, no markdown.' },
        { role: 'user', content: `Headline: ${article.title}\n\nArticle:\n${art.text}` }
      ], model, { quiet: true });
      const text = typeof result === 'string' ? result : (result?.content || result?.message?.content || '');
      box.innerHTML = text && !result?.error
        ? `<div class="news-sum-text">${escapeHtml(text.trim())}</div>`
        : '<span class="news-sum-note">Summary failed — open the article instead.</span>';
      box.dataset.done = '1';
    } catch {
      box.innerHTML = '<span class="news-sum-note">Summary failed.</span>';
      box.dataset.done = '1';
    }
  }

  function relTime(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d)) return '';
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m ago`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  // ── Section renderers ──
  function renderTop() {
    const wrap = document.getElementById('news-top');
    const res = cache.top;
    if (!wrap) return;
    if (!res || res.error || !res.articles?.length) { wrap.innerHTML = ''; return; }

    const list = filterArticles(res.articles);
    wrap.innerHTML = '<h2>Top Headlines</h2>';
    if (!list.length) { wrap.innerHTML += '<div class="news-empty">No stories match this filter.</div>'; return; }

    const [hero, ...rest] = list;

    // ── Hero story: big headline + published time + summary + image right ──
    const heroEl = document.createElement('div');
    heroEl.className = 'news-phero news-fade';
    heroEl.innerHTML = `
      <div class="news-phero-text">
        <div class="news-phero-title" id="news-phero-title">${escapeHtml(hero.title)}</div>
        <div class="news-phero-time">🕐 Published ${relTime(hero.publishedAt).replace('now', 'just now')}</div>
        <div class="news-phero-desc" id="news-phero-desc"><span class="news-shimmer-line"></span><span class="news-shimmer-line" style="width:82%"></span><span class="news-shimmer-line" style="width:64%"></span></div>
        <div class="news-phero-foot">${sourceCluster(hero)}<button class="news-sum-btn" style="opacity:1">✦ Summarize</button></div>
        <div class="news-sum" style="display:none;"></div>
      </div>
      ${hero.image ? `<div class="news-phero-img" style="background-image:url('${hero.image.replace(/'/g, '%27')}')"></div>` : '<div class="news-phero-img news-img-empty"></div>'}`;
    heroEl.addEventListener('click', (e) => {
      if (e.target.closest('.news-sum-btn') || e.target.closest('.news-sum')) return;
      openStory(hero);
    });
    heroEl.querySelector('.news-sum-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      summarizeInto(heroEl.querySelector('.news-sum'), hero);
    });
    wrap.appendChild(heroEl);
    fillHeroDesc(hero);
    if (!hero.image) ensureImage(hero, heroEl.querySelector('.news-phero-img'));

    // ── Grid of image-top cards (Perplexity Discover style) ──
    const grid = document.createElement('div');
    grid.className = 'news-pgrid';
    rest.slice(0, 6).forEach((a) => {
      const card = document.createElement('div');
      card.className = 'news-pcard news-fade';
      card.innerHTML = `
        ${a.image ? `<div class="news-pcard-img" style="background-image:url('${a.image.replace(/'/g, '%27')}')"></div>` : '<div class="news-pcard-img news-img-empty"></div>'}
        <div class="news-pcard-body">
          <div class="news-pcard-title">${escapeHtml(a.title)}</div>
          <div class="news-pcard-foot">${sourceCluster(a)}<button class="news-sum-btn" title="AI summary">✦</button></div>
          <div class="news-sum" style="display:none;"></div>
        </div>`;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.news-sum-btn') || e.target.closest('.news-sum')) return;
        openStory(a);
      });
      card.querySelector('.news-sum-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        summarizeInto(card.querySelector('.news-sum'), a);
      });
      grid.appendChild(card);
      if (!a.image) ensureImage(a, card.querySelector('.news-pcard-img'));
    });
    wrap.appendChild(grid);
  }

  // Self-healing image: when a card/hero has no photo, search the wider story
  // cluster for one and fill it in (many outlets covering the story have a pic).
  async function ensureImage(article, imgEl) {
    if (!imgEl || article.image || !window.localMind?.newsImage) return;
    try {
      const r = await window.localMind.newsImage({ url: article.url, title: article.title, related: article.related || [] });
      if (r?.image && imgEl.isConnected) {
        article.image = r.image;
        imgEl.classList.remove('news-img-empty');
        imgEl.style.backgroundImage = `url('${r.image.replace(/'/g, '%27')}')`;
      }
    } catch { /* leave the placeholder */ }
  }

  // Fill the hero's description with the article's opening lines (async)
  async function fillHeroDesc(hero) {
    const box = document.getElementById('news-phero-desc');
    if (!box || !window.localMind?.newsArticle) return;
    let text = '';
    try {
      const art = await window.localMind.newsArticle(hero.url);
      text = art?.text || '';
    } catch { /* fall through */ }
    if (document.getElementById('news-phero-desc') !== box) return; // re-rendered

    // With a model: clean the headline + write a "what happened" summary
    const model = window.mindSettings?.news?.model;
    if (model && text && window.localMind?.chat) {
      try {
        const result = await window.localMind.chat([
          { role: 'system', content: 'You rewrite one news story for a homepage hero. Reply in EXACTLY this format, plain text:\nHEADLINE: a clear, complete, self-explanatory headline (max 13 words)\nSUMMARY: 1-2 sentences plainly stating what happened and why it matters. Only use facts from the text.' },
          { role: 'user', content: `Original headline: ${hero.title}\n\nArticle:\n${text.slice(0, 2500)}` }
        ], model, { quiet: true });
        if (document.getElementById('news-phero-desc') !== box) return;
        const out = typeof result === 'string' ? result : (result?.content || result?.message?.content || '');
        const headline = /HEADLINE:\s*(.+)/.exec(out)?.[1]?.trim();
        const summary = /SUMMARY:\s*([\s\S]+)/.exec(out)?.[1]?.trim();
        if (!result?.error && (headline || summary)) {
          if (headline) { const t = document.getElementById('news-phero-title'); if (t) t.textContent = headline; }
          if (summary) box.textContent = summary; else box.style.display = 'none';
          return;
        }
      } catch { /* fall through to excerpt */ }
    }

    // Fallback: scraped prose excerpt
    if (!text) { box.style.display = 'none'; return; }
    const junk = /not a robot|captcha|enable javascript|cookies|subscribe|sign in|sign up|log in|advertisement|access denied|unusual activity|navigation|menu|show more|sections/i;
    const firstPara = text.split('\n').find((p) => {
      if (p.length < 80 || junk.test(p)) return false;
      const sent = p.match(/[^.!?]+[.!?]+/g);
      return sent && sent[0] && sent[0].length < 400;
    }) || '';
    if (!firstPara) { box.style.display = 'none'; return; }
    let snippet = firstPara;
    const sentences = firstPara.match(/[^.!?]+[.!?]+/g);
    if (sentences) snippet = sentences.slice(0, 2).join(' ').trim();
    if (snippet.length > 300) snippet = snippet.slice(0, 297).trimEnd() + '…';
    box.textContent = snippet;
  }

  function renderSection(section, city) {
    const col = document.getElementById(`news-sec-${section.id}`);
    const res = cache.sections[section.id];
    if (!col) return;
    const body = col.querySelector('.news-col-body');
    body.innerHTML = '';
    if (section.id === 'local') col.querySelector('h2').textContent = `Local · ${city}`;
    if (!res || res.error || !res.articles?.length) {
      body.innerHTML = '<div class="news-empty">Nothing available right now.</div>';
      return;
    }
    const list = filterArticles(res.articles);
    if (!list.length) { body.innerHTML = '<div class="news-empty">No stories match this filter.</div>'; return; }
    list.slice(0, 6).forEach(a => body.appendChild(articleCard(a)));
  }

  function renderTrending(res) {
    const wrap = document.getElementById('news-trending-wrap');
    if (!wrap) return;
    if (!res || res.error || !res.topics?.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = '<h2>Trending on Google</h2>';
    const row = document.createElement('div');
    row.className = 'news-trend-row';
    res.topics.forEach(t => {
      const chip = document.createElement('div');
      chip.className = 'news-trend-chip news-fade';
      chip.title = t.newsTitle || t.topic;
      chip.innerHTML = `<span class="news-trend-topic">${escapeHtml(t.topic)}</span>${t.traffic ? `<span class="news-trend-traffic">${escapeHtml(t.traffic)}</span>` : ''}`;
      chip.addEventListener('click', () => openArticle(t.url));
      row.appendChild(chip);
    });
    wrap.appendChild(row);
  }

  function renderXTrends(res) {
    const wrap = document.getElementById('news-xtrends-wrap');
    if (!wrap) return;
    if (!res || res.error || !res.topics?.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = '<h2>Trending on X</h2>';
    const row = document.createElement('div');
    row.className = 'news-trend-row';
    res.topics.forEach(t => {
      const chip = document.createElement('div');
      chip.className = 'news-trend-chip news-fade';
      chip.innerHTML = `<span class="news-x-logo">𝕏</span><span class="news-trend-topic">${escapeHtml(t.topic)}</span>`;
      chip.addEventListener('click', () => openArticle(t.url));
      row.appendChild(chip);
    });
    wrap.appendChild(row);
  }

  function renderPredictions(res) {
    const wrap = document.getElementById('news-predictions');
    if (!wrap) return;
    if (!res || res.error || (!res.markets?.length && !res.kalshi?.length)) { wrap.innerHTML = ''; return; }

    wrap.innerHTML = '<h2>Prediction Markets</h2>';
    const grid = document.createElement('div');
    grid.className = 'news-pred-grid';

    (res.markets || []).forEach(mk => {
      const yes = Math.round((mk.probabilities[0] || 0) * 100);
      const card = document.createElement('div');
      card.className = 'news-pred-card news-fade';
      card.innerHTML = `
        <div class="news-pred-q">${escapeHtml(mk.question)}</div>
        <div class="news-pred-bar"><div class="news-pred-fill" style="width:${yes}%"></div></div>
        <div class="news-pred-meta">
          <span class="news-pred-odds">${escapeHtml(mk.outcomes[0] || 'Yes')} ${yes}%</span>
          <span>${mk.volume24h ? '$' + abbreviate(mk.volume24h) + ' · 24h' : ''} · ${mk.platform}</span>
        </div>`;
      card.addEventListener('click', () => openArticle(mk.url));
      grid.appendChild(card);
    });
    wrap.appendChild(grid);

    if (res.kalshi?.length) {
      const kal = document.createElement('div');
      kal.className = 'news-kalshi-row';
      res.kalshi.forEach(ev => {
        const chip = document.createElement('div');
        chip.className = 'news-trend-chip news-fade';
        chip.innerHTML = `<span class="news-trend-topic">${escapeHtml(ev.question)}</span><span class="news-trend-traffic">Kalshi</span>`;
        chip.addEventListener('click', () => openArticle(ev.url));
        kal.appendChild(chip);
      });
      wrap.appendChild(kal);
    }
  }

  // ── AI Briefing ──
  async function runBriefing(city) {
    const box = document.getElementById('news-briefing');
    if (!box) return;
    const model = window.mindSettings?.news?.model;
    if (!model || window.mindSettings?.news?.briefing === false || !window.localMind?.chat) {
      box.innerHTML = '';
      return;
    }

    box.innerHTML = `<div class="news-brief-card news-fade"><div class="news-brief-head">✦ AI Briefing <span class="news-brief-model">${escapeHtml(model)}</span></div><div class="news-brief-body news-loading">Reading today's headlines…</div></div>`;

    try {
      const [top, biz, tech] = await Promise.all([
        window.localMind.newsSection('top', city, 0),
        window.localMind.newsSection('business', city, 0),
        window.localMind.newsSection('technology', city, 0)
      ]);
      const headlines = []
        .concat(top?.articles || [], biz?.articles || [], tech?.articles || [])
        .slice(0, 25).map(a => `- ${a.title} (${a.source})`).join('\n');
      if (!headlines) { box.innerHTML = ''; return; }

      const result = await window.localMind.chat([
        { role: 'system', content: 'You are a concise news editor. Reply with exactly 4 bullet points (each starting with "• "), one line each, no preamble, summarizing the most important developments from the given headlines. Prioritize significance and variety.' },
        { role: 'user', content: `Today's headlines:\n${headlines}` }
      ], model, { quiet: true });

      const text = typeof result === 'string' ? result : (result?.content || result?.message?.content || '');
      const body = box.querySelector('.news-brief-body');
      if (!text || result?.error) { box.innerHTML = ''; return; }
      body.classList.remove('news-loading');
      body.innerHTML = text.split('\n').filter(l => l.trim()).slice(0, 5)
        .map(l => `<div class="news-brief-line">${escapeHtml(l.trim())}</div>`).join('');
    } catch {
      box.innerHTML = '';
    }
  }

  function abbreviate(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'K';
    return String(n);
  }

  // Open the in-app multi-source reader for cluster articles; plain links
  // (trends, prediction markets) still open as normal tabs.
  function openStory(article) {
    if (typeof StoryPage !== 'undefined' && (article.related?.length || article.sources?.length)) {
      StoryPage.open(article);
    } else if (typeof StoryPage !== 'undefined' && article.source) {
      StoryPage.open(article);
    } else {
      openArticle(article.url);
    }
  }

  return { init, show, hide, toggle, favicon: sourceFavicon, openStory };
})();
