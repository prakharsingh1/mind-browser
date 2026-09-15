// =============================================================================
// Local Mind Browser — Story Reader
// =============================================================================
// Particle.news / Perplexity-style in-app story page. Clicking a headline opens
// this full-page reader which aggregates every outlet covering the story, has
// the configured AI model write a clean headline, TL;DR, bullet Overview and
// deep titled sections (with attribution), and surfaces real podcast coverage
// (iTunes) plus a link to the X conversation.

const StoryPage = (() => {
  let current = null;
  let audio = null;

  function init() {
    EventBus.on('tab-activated', hide);
  }

  const pageEl = () => document.getElementById('story-page');

  function hide() {
    const page = pageEl();
    if (page) page.style.display = 'none';
    if (audio) { audio.pause(); audio = null; }
    current = null;
  }

  function back() {
    hide();
    if (typeof NewsPage !== 'undefined') NewsPage.show();
  }

  function openExternal(url) {
    if (!url) return;
    hide();
    TabManager.createTab(url, true);
  }

  const relTime = (dateStr) => {
    const d = new Date(dateStr);
    if (isNaN(d)) return '';
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 60) return `${Math.max(1, mins)}m ago`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  const fav = (name, size = 16) => (typeof NewsPage !== 'undefined' && NewsPage.favicon) ? NewsPage.favicon(name, size) : '';

  // ── Open ──
  async function open(article) {
    const page = pageEl();
    if (!page) return;
    current = article;
    page.style.display = 'block';
    page.scrollTop = 0;
    if (typeof NewsPage !== 'undefined') NewsPage.hide();
    if (typeof FinancePage !== 'undefined') FinancePage.hide();
    document.getElementById('sidebar-news')?.classList.add('active');

    page.innerHTML = `
      <div class="story-inner">
        <button class="story-back">← Back to News</button>
        <h1 class="story-title" id="story-title">${escapeHtml(article.title)}</h1>
        <div class="story-meta">
          ${article.publishedAt ? `<span>🕐 ${relTime(article.publishedAt)}</span>` : ''}
          <span id="story-sources-inline"></span>
        </div>
        ${article.image ? `<div class="story-hero" style="background-image:url('${article.image.replace(/'/g, '%27')}')"></div>` : '<div class="story-hero story-hero-empty" id="story-hero"></div>'}
        <div class="story-tldr" id="story-tldr" style="display:none;"></div>
        <div id="story-overview"></div>
        <div id="story-sections">
          <span class="news-shimmer-line"></span><span class="news-shimmer-line" style="width:90%"></span>
          <span class="news-shimmer-line" style="width:96%"></span><span class="news-shimmer-line" style="width:72%"></span>
        </div>
        <div id="story-podcasts"></div>
        <div id="story-x"></div>
        <div id="story-allsources"></div>
      </div>`;
    page.querySelector('.story-back').addEventListener('click', back);

    // Kick off the cluster + podcasts in parallel
    const storyP = window.localMind.newsStory({
      url: article.url, title: article.title, source: article.source, related: article.related || []
    }).catch(() => null);
    const podsP = window.localMind.newsPodcasts?.({ title: article.title }).catch(() => null);

    const cluster = await storyP;
    if (current !== article) return;

    // Hero image upgrade
    if (!article.image && cluster?.image) {
      const hero = document.getElementById('story-hero');
      if (hero) { hero.classList.remove('story-hero-empty'); hero.style.backgroundImage = `url('${cluster.image.replace(/'/g, '%27')}')`; }
    }

    const outlets = cluster?.outlets || [{ source: article.source, url: article.url }];
    renderSourcesInline(outlets, cluster?.sourceCount || outlets.length);
    renderAllSources(outlets);
    renderXSection(article);

    // Podcasts (independent)
    podsP.then((p) => { if (current === article) renderPodcasts(p); });

    const readable = (cluster?.articles || []).filter((s) => s.text && s.text.length > 250);
    const model = window.mindSettings?.news?.model;

    if (!readable.length) {
      document.getElementById('story-sections').innerHTML =
        `<div class="news-empty">Couldn't read the coverage automatically (publishers blocked access). Explore the ${outlets.length} sources below for the original reporting.</div>`;
      document.getElementById('story-overview').innerHTML = '';
      return;
    }
    if (model && window.localMind?.chat) {
      await synthesize(article, readable, outlets.length, model);
    } else {
      document.getElementById('story-sections').innerHTML =
        '<div class="news-empty">Set an AI model in Settings → News to get a synthesized brief across all sources. Meanwhile, read the originals below.</div>';
      document.getElementById('story-overview').innerHTML = '';
    }
  }

  // ── Sources ──
  function renderSourcesInline(outlets, count) {
    const box = document.getElementById('story-sources-inline');
    if (!box) return;
    const icons = outlets.slice(0, 5).map((o) => fav(o.source, 16)).join('');
    box.className = 'story-sources-inline';
    box.innerHTML = `<span class="news-src-cluster">${icons}</span><button class="story-src-count" id="story-src-count">${count} sources</button>`;
    box.querySelector('#story-src-count').addEventListener('click', () => {
      document.getElementById('story-allsources')?.scrollIntoView({ behavior: 'smooth' });
    });
  }

  function renderAllSources(outlets) {
    const box = document.getElementById('story-allsources');
    if (!box) return;
    box.innerHTML = `<h3 class="story-h">All Sources · ${outlets.length}</h3><div class="story-src-grid"></div>`;
    const grid = box.querySelector('.story-src-grid');
    outlets.forEach((o) => {
      const chip = document.createElement('button');
      chip.className = 'story-src-chip';
      chip.innerHTML = `${fav(o.source, 15)}<span>${escapeHtml(o.source)}</span>`;
      chip.title = `Open on ${o.source}`;
      chip.addEventListener('click', () => openExternal(o.realUrl || o.url));
      grid.appendChild(chip);
    });
  }

  // ── AI synthesis: TL;DR + bullet Overview + deep titled sections ──
  async function synthesize(article, readable, sourceCount, model) {
    const corpus = readable.map((s) => `【${s.source}】\n${s.text.slice(0, 1600)}`).join('\n\n───\n\n');
    try {
      const result = await window.localMind.chat([
        { role: 'system', content: `You are a news editor synthesizing coverage of ONE story from ${readable.length} outlets. Output PLAIN TEXT in EXACTLY this structure, nothing else:
HEADLINE: a clear, complete, self-explanatory headline (max 14 words)
TLDR: one sentence stating plainly what happened
OVERVIEW:
- 5 to 7 bullet points covering the key facts, numbers and developments. Each bullet is one factual sentence. Attribute specific claims inline in parentheses e.g. (Reuters).
SECTIONS:
## Section Heading
One paragraph of 2-4 sentences adding depth: background, reactions, or what happens next.
## Second Section Heading
Another paragraph.
(2 or 3 sections.) Only use facts present in the sources. Attribute inline where useful.` },
        { role: 'user', content: `Story: ${article.title}\n\n${corpus}` }
      ], model, { quiet: true });
      if (current !== article) return;

      const text = typeof result === 'string' ? result : (result?.content || result?.message?.content || '');
      if (!text || result?.error) { renderPlain(readable); return; }

      const headline = /HEADLINE:\s*(.+)/.exec(text)?.[1]?.trim();
      const tldr = /TLDR:\s*(.+)/.exec(text)?.[1]?.trim();
      const overviewBlock = /OVERVIEW:\s*([\s\S]*?)(?:\nSECTIONS:|$)/i.exec(text)?.[1] || '';
      const sectionsBlock = /SECTIONS:\s*([\s\S]+)/i.exec(text)?.[1] || '';

      if (headline) document.getElementById('story-title').textContent = headline;
      if (tldr) {
        const t = document.getElementById('story-tldr');
        t.style.display = 'block';
        t.innerHTML = `<b>TL;DR</b> ${escapeHtml(tldr)}`;
      }

      // Overview bullets
      const bullets = overviewBlock.split('\n').map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter((l) => l.length > 3);
      const ov = document.getElementById('story-overview');
      if (bullets.length) {
        ov.innerHTML = `<h3 class="story-h">Overview</h3><ul class="story-bullets">${bullets.map((b) => `<li>${highlightSources(b)}</li>`).join('')}</ul>`;
      } else { ov.innerHTML = ''; }

      // Deep sections
      const sec = document.getElementById('story-sections');
      const parts = sectionsBlock.split(/^##\s+/m).map((p) => p.trim()).filter(Boolean);
      if (parts.length) {
        sec.innerHTML = parts.map((p) => {
          const nl = p.indexOf('\n');
          const head = nl === -1 ? p : p.slice(0, nl).trim();
          const body = nl === -1 ? '' : p.slice(nl + 1).trim();
          return `<div class="story-section"><h3 class="story-section-h">${escapeHtml(head)}</h3>${body ? `<p>${highlightSources(body.replace(/\n/g, ' '))}</p>` : ''}</div>`;
        }).join('');
      } else {
        sec.innerHTML = '';
      }
      const note = document.createElement('div');
      note.className = 'story-ai-note';
      note.textContent = `✦ Synthesized by ${model} from ${sourceCount} sources — verify key details with the originals below.`;
      sec.appendChild(note);
    } catch {
      if (current === article) renderPlain(readable);
    }
  }

  // Wrap "(Source)" attributions in a subtle style
  function highlightSources(str) {
    return escapeHtml(str).replace(/\(([A-Z][A-Za-z0-9.\-' ]{1,24})\)/g, '<span class="story-attr">($1)</span>');
  }

  // Fallback (AI failed): clean single lead paragraph per source, junk-filtered
  function renderPlain(readable) {
    const sec = document.getElementById('story-sections');
    document.getElementById('story-overview').innerHTML = '';
    if (!sec) return;
    sec.innerHTML = '';
    readable.slice(0, 4).forEach((s) => {
      const para = (s.text.split('\n').find((p) => p.length > 100) || s.text.slice(0, 300)).trim();
      const block = document.createElement('div');
      block.className = 'story-excerpt';
      block.innerHTML = `<div class="story-excerpt-src">${fav(s.source, 14)}${escapeHtml(s.source || '')}</div>
        <p>${escapeHtml(para.length > 420 ? para.slice(0, 417).trimEnd() + '…' : para)}</p>
        <button class="story-excerpt-link">Read at ${escapeHtml(s.source || 'source')} →</button>`;
      block.querySelector('.story-excerpt-link').addEventListener('click', () => openExternal(s.realUrl || s.url));
      sec.appendChild(block);
    });
  }

  // ── Podcasts ──
  function renderPodcasts(res) {
    const box = document.getElementById('story-podcasts');
    if (!box) return;
    if (!res || res.error || !res.episodes?.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<h3 class="story-h">🎧 Podcast Coverage</h3><div class="story-pod-row"></div>`;
    const row = box.querySelector('.story-pod-row');
    res.episodes.forEach((ep) => {
      const card = document.createElement('div');
      card.className = 'story-pod-card';
      card.innerHTML = `
        <div class="story-pod-art" style="${ep.artwork ? `background-image:url('${ep.artwork.replace(/'/g, '%27')}')` : ''}">
          <button class="story-pod-play" title="Play">▶</button>
        </div>
        <div class="story-pod-body">
          <div class="story-pod-title">${escapeHtml(ep.title)}</div>
          <div class="story-pod-show">${escapeHtml(ep.show)}</div>
        </div>`;
      const playBtn = card.querySelector('.story-pod-play');
      playBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(ep, playBtn); });
      card.addEventListener('click', () => openExternal(ep.url));
      row.appendChild(card);
    });
  }

  function togglePlay(ep, btn) {
    if (audio && audio._url === ep.audio) {
      if (audio.paused) { audio.play(); btn.textContent = '⏸'; }
      else { audio.pause(); btn.textContent = '▶'; }
      return;
    }
    if (audio) audio.pause();
    document.querySelectorAll('.story-pod-play').forEach((b) => { b.textContent = '▶'; });
    if (!ep.audio) { openExternal(ep.url); return; }
    audio = new Audio(ep.audio);
    audio._url = ep.audio;
    audio.play().then(() => { btn.textContent = '⏸'; }).catch(() => openExternal(ep.url));
    audio.onended = () => { btn.textContent = '▶'; };
  }

  // ── X conversation ──
  function renderXSection(article) {
    const box = document.getElementById('story-x');
    if (!box) return;
    const q = article.title.replace(/[|"'].*$/, '').split(/\s+/).slice(0, 8).join(' ');
    box.innerHTML = `<h3 class="story-h">𝕏 On X</h3>
      <button class="story-x-btn">See the top posts &amp; discussion on X →</button>`;
    box.querySelector('.story-x-btn').addEventListener('click', () =>
      openExternal(`https://x.com/search?q=${encodeURIComponent(q)}&f=top`));
  }

  return { init, open, hide };
})();
