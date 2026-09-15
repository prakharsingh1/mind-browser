// =============================================================================
// Local Mind Browser — Company Page
// =============================================================================
// Full-page company research view (Google/Yahoo Finance style, AI-driven).
// Opened by clicking any company on the Finance page (search, watchlist,
// movers, heatmap, trending). Data tiers degrade gracefully:
//   always      — chart (fin:chart), news (fin:news), AI sections, AI chat
//   crumb-gated — key stats, about, holders, insiders, analyst (fin:profile)
//   timeseries  — income / balance sheet / cash flow tabs (fin:fundamentals)
// Sections with no data hide themselves rather than render empty shells.

const CompanyPage = (() => {
  let current = null;        // { symbol, name }
  let chartRange = '1D';
  let chartType = 'line';
  let indicators = { sma20: false, sma50: false, bb: false, rsi: false, macd: false };
  let finTab = 'income';
  let finFreq = 'annual';
  let fundData = {};         // freq → fundamentals result
  let profileData = null;
  let newsItems = [];
  let chatHistory = [];
  const aiCache = new Map(); // symbol → overview html

  const RANGES = ['1D', '1W', '1M', '6M', '1Y', '5Y', 'MAX'];

  // Peer map for the Competitors section (click-through opens that company).
  const PEERS = {
    'RELIANCE.NS': ['ONGC.NS', 'IOC.NS', 'ADANIENT.NS', 'BHARTIARTL.NS'],
    'TCS.NS': ['INFY.NS', 'HCLTECH.NS', 'WIPRO.NS', 'TECHM.NS'],
    'INFY.NS': ['TCS.NS', 'HCLTECH.NS', 'WIPRO.NS', 'TECHM.NS'],
    'HCLTECH.NS': ['TCS.NS', 'INFY.NS', 'WIPRO.NS', 'TECHM.NS'],
    'WIPRO.NS': ['TCS.NS', 'INFY.NS', 'HCLTECH.NS', 'TECHM.NS'],
    'TECHM.NS': ['TCS.NS', 'INFY.NS', 'HCLTECH.NS', 'WIPRO.NS'],
    'HDFCBANK.NS': ['ICICIBANK.NS', 'SBIN.NS', 'KOTAKBANK.NS', 'AXISBANK.NS'],
    'ICICIBANK.NS': ['HDFCBANK.NS', 'SBIN.NS', 'KOTAKBANK.NS', 'AXISBANK.NS'],
    'SBIN.NS': ['HDFCBANK.NS', 'ICICIBANK.NS', 'KOTAKBANK.NS', 'AXISBANK.NS'],
    'KOTAKBANK.NS': ['HDFCBANK.NS', 'ICICIBANK.NS', 'SBIN.NS', 'AXISBANK.NS'],
    'AXISBANK.NS': ['HDFCBANK.NS', 'ICICIBANK.NS', 'SBIN.NS', 'KOTAKBANK.NS'],
    'MARUTI.NS': ['TATAMOTORS.NS', 'M&M.NS', 'BAJAJ-AUTO.NS', 'EICHERMOT.NS'],
    'TATAMOTORS.NS': ['MARUTI.NS', 'M&M.NS', 'BAJAJ-AUTO.NS', 'EICHERMOT.NS'],
    'M&M.NS': ['MARUTI.NS', 'TATAMOTORS.NS', 'BAJAJ-AUTO.NS', 'EICHERMOT.NS'],
    'SUNPHARMA.NS': ['DRREDDY.NS', 'CIPLA.NS', 'DIVISLAB.NS', 'LUPIN.NS'],
    'DRREDDY.NS': ['SUNPHARMA.NS', 'CIPLA.NS', 'DIVISLAB.NS', 'LUPIN.NS'],
    'CIPLA.NS': ['SUNPHARMA.NS', 'DRREDDY.NS', 'DIVISLAB.NS', 'LUPIN.NS'],
    'HINDUNILVR.NS': ['ITC.NS', 'NESTLEIND.NS', 'BRITANNIA.NS', 'DABUR.NS'],
    'ITC.NS': ['HINDUNILVR.NS', 'NESTLEIND.NS', 'BRITANNIA.NS', 'DABUR.NS'],
    'NTPC.NS': ['POWERGRID.NS', 'TATAPOWER.NS', 'ADANIGREEN.NS', 'COALINDIA.NS'],
    'TATASTEEL.NS': ['JSWSTEEL.NS', 'HINDALCO.NS', 'COALINDIA.NS', 'ULTRACEMCO.NS'],
    'AAPL': ['MSFT', 'GOOGL', 'META', 'AMZN'],
    'MSFT': ['AAPL', 'GOOGL', 'ORCL', 'CRM'],
    'GOOGL': ['MSFT', 'META', 'AAPL', 'AMZN'],
    'META': ['GOOGL', 'AAPL', 'MSFT', 'NFLX'],
    'AMZN': ['WMT', 'GOOGL', 'MSFT', 'AAPL'],
    'NVDA': ['AMD', 'AVGO', 'INTC', 'TSM'],
    'AMD': ['NVDA', 'INTC', 'AVGO', 'TSM'],
    'INTC': ['NVDA', 'AMD', 'TSM', 'AVGO'],
    'TSLA': ['RIVN', 'NIO', 'BYDDY', 'GM'],
    'JPM': ['BAC', 'GS', 'V', 'MA'],
    'WMT': ['COST', 'AMZN', 'HD', 'PG'],
    'XOM': ['CVX', 'BP', 'SHEL', 'COP']
  };

  // ── Helpers (match finance-page conventions) ──
  const pageEl = () => document.getElementById('company-page');
  const pct = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  const num = (v) => v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 10 ? 3 : 2 });
  const cls = (v) => v == null ? '' : v >= 0 ? 'fin-up' : 'fin-down';
  const CUR_SYM = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
  const curSym = (c) => CUR_SYM[c] || '';
  const or = (v) => v == null || v === '' ? '—' : v;

  const relTime = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d)) return '';
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 60) return `${Math.max(1, mins)}m ago`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  const logoHtml = (symbol, size = 40) => {
    const letter = (symbol || '?')[0].toUpperCase();
    return `<span class="fin-logo-wrap" style="width:${size}px;height:${size}px;" data-letter="${letter}">
      <img class="fin-logo" src="https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png"
        style="width:${size}px;height:${size}px;" loading="lazy"
        data-on-error="logo-failed"></span>`;
  };

  const model = () => window.mindSettings?.news?.model;
  const aiText = (r) => typeof r === 'string' ? r : (r?.content || r?.message?.content || '');

  function init() {
    if (typeof EventBus !== 'undefined') EventBus.on('tab-activated', hide);
  }

  function hide() {
    const page = pageEl();
    if (page) page.style.display = 'none';
  }

  function back() {
    hide();
    if (typeof FinancePage !== 'undefined') FinancePage.show();
  }

  const isCompany = (symbol) => symbol && !symbol.startsWith('^') && !symbol.includes('=') && !/-(USD|INR|EUR)$/.test(symbol);

  // ── Open ──
  async function open(symbol, name) {
    const page = pageEl();
    if (!page) return;
    current = { symbol, name: name || symbol };
    chartRange = '1D'; chartType = 'line';
    indicators = { sma20: false, sma50: false, bb: false, rsi: false, macd: false };
    finTab = 'income'; finFreq = 'annual';
    fundData = {}; profileData = null; newsItems = []; chatHistory = [];

    page.style.display = 'block';
    page.scrollTop = 0;
    if (typeof FinancePage !== 'undefined') FinancePage.hide();
    if (typeof NewsPage !== 'undefined') NewsPage.hide();
    if (typeof StoryPage !== 'undefined') StoryPage.hide();

    buildSkeleton(page);
    // Independent loads settle into their own sections.
    loadChart();
    loadProfile().then(() => { loadAI(); });
    loadFundamentals();
    loadNews();
    loadPeers();
  }

  // ── Skeleton ──
  function buildSkeleton(page) {
    const { symbol, name } = current;
    const starred = (window.mindSettings?.finance?.watchlist || []).includes(symbol);
    page.innerHTML = `
      <div class="cp-inner">
        <button class="story-back" id="cp-back">← Finance</button>

        <div class="cp-header">
          ${logoHtml(symbol, 44)}
          <div class="cp-head-main">
            <h1 id="cp-name">${escapeHtml(name)}</h1>
            <div class="cp-head-meta" id="cp-meta">${escapeHtml(symbol)}</div>
          </div>
          <div class="cp-head-price">
            <div id="cp-price" class="cp-price">—</div>
            <div id="cp-chg" class="cp-chg"></div>
          </div>
          <div class="cp-head-actions">
            <button id="cp-star" class="cp-btn ${starred ? 'active' : ''}" title="Watchlist">${starred ? '★' : '☆'}</button>
            <button id="cp-ai-btn" class="cp-btn">✦ AI Analysis</button>
          </div>
        </div>

        <div class="fin-chart-card cp-chart-card">
          <div class="fin-chart-controls">
            <div class="fin-pills" id="cp-ranges">${RANGES.map((r) => `<button data-r="${r}" class="${r === chartRange ? 'active' : ''}">${r}</button>`).join('')}</div>
            <div class="fin-pills" id="cp-types"><button data-t="line" class="active">Line</button><button data-t="candle">Candles</button></div>
            <div class="fin-pills" id="cp-inds">
              <button data-i="sma20">SMA 20</button><button data-i="sma50">SMA 50</button>
              <button data-i="bb">Bollinger</button><button data-i="rsi">RSI</button><button data-i="macd">MACD</button>
            </div>
          </div>
          <div id="cp-chart"><div class="news-shimmer" style="height:320px"></div></div>
        </div>

        <div id="cp-stats-sec" style="display:none">
          <h2 class="cp-h2">Key statistics</h2>
          <div class="cp-stats" id="cp-stats"></div>
        </div>

        <div id="cp-ai-sec">
          <h2 class="cp-h2">✦ AI analysis</h2>
          <div id="cp-ai" class="cp-ai"><div class="news-shimmer" style="height:80px"></div></div>
        </div>

        <div id="cp-fin-sec" style="display:none">
          <h2 class="cp-h2">Financials</h2>
          <div class="fin-chart-controls">
            <div class="fin-pills" id="cp-fin-tabs">
              <button data-f="income" class="active">Income</button>
              <button data-f="balance">Balance sheet</button>
              <button data-f="cashflow">Cash flow</button>
            </div>
            <div class="fin-pills" id="cp-fin-freq">
              <button data-q="annual" class="active">Annual</button>
              <button data-q="quarterly">Quarterly</button>
            </div>
          </div>
          <div id="cp-fin-chart"></div>
          <div id="cp-fin-table"></div>
        </div>

        <div class="cp-two-col">
          <div id="cp-analyst-sec" style="display:none">
            <h2 class="cp-h2">Analyst ratings</h2>
            <div id="cp-analyst"></div>
          </div>
          <div id="cp-earnings-sec" style="display:none">
            <h2 class="cp-h2">Earnings</h2>
            <div id="cp-earnings"></div>
          </div>
        </div>

        <div class="cp-two-col">
          <div id="cp-holders-sec" style="display:none">
            <h2 class="cp-h2">Ownership</h2>
            <div id="cp-holders"></div>
          </div>
          <div id="cp-insiders-sec" style="display:none">
            <h2 class="cp-h2">Insider transactions</h2>
            <div id="cp-insiders"></div>
          </div>
        </div>

        <div id="cp-about-sec" style="display:none">
          <h2 class="cp-h2">About</h2>
          <div id="cp-about"></div>
        </div>

        <div id="cp-peers-sec" style="display:none">
          <h2 class="cp-h2">Competitors</h2>
          <div id="cp-peers" class="cp-peers"></div>
        </div>

        <div id="cp-news-sec" style="display:none">
          <h2 class="cp-h2">News</h2>
          <div id="cp-news"></div>
        </div>

        <div id="cp-chat-sec">
          <h2 class="cp-h2">✦ Ask about ${escapeHtml(name)}</h2>
          <div id="cp-chat-log" class="cp-chat-log"></div>
          <div class="cp-chat-row">
            <input id="cp-chat-input" placeholder="Why did the stock move today? Is it profitable? Biggest risks?">
            <button id="cp-chat-send" class="cp-btn">→</button>
          </div>
        </div>
      </div>`;

    wire(page);
  }

  function wire(page) {
    page.querySelector('#cp-back').addEventListener('click', back);
    page.querySelector('#cp-ranges').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-r]'); if (!b) return;
      chartRange = b.dataset.r;
      page.querySelectorAll('#cp-ranges button').forEach((x) => x.classList.toggle('active', x === b));
      loadChart();
    });
    page.querySelector('#cp-types').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-t]'); if (!b) return;
      chartType = b.dataset.t;
      page.querySelectorAll('#cp-types button').forEach((x) => x.classList.toggle('active', x === b));
      drawChart();
    });
    page.querySelector('#cp-inds').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]'); if (!b) return;
      indicators[b.dataset.i] = !indicators[b.dataset.i];
      b.classList.toggle('active');
      drawChart();
    });
    page.querySelector('#cp-fin-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-f]'); if (!b) return;
      finTab = b.dataset.f;
      page.querySelectorAll('#cp-fin-tabs button').forEach((x) => x.classList.toggle('active', x === b));
      renderFinancials();
    });
    page.querySelector('#cp-fin-freq').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-q]'); if (!b) return;
      finFreq = b.dataset.q;
      page.querySelectorAll('#cp-fin-freq button').forEach((x) => x.classList.toggle('active', x === b));
      loadFundamentals();
    });
    page.querySelector('#cp-star').addEventListener('click', () => {
      const f = window.mindSettings.finance || (window.mindSettings.finance = {});
      if (!Array.isArray(f.watchlist)) f.watchlist = [];
      const i = f.watchlist.indexOf(current.symbol);
      const btn = page.querySelector('#cp-star');
      if (i >= 0) { f.watchlist.splice(i, 1); btn.textContent = '☆'; btn.classList.remove('active'); }
      else { f.watchlist.push(current.symbol); btn.textContent = '★'; btn.classList.add('active'); }
      window.localMind?.saveSettings?.(window.mindSettings);
    });
    page.querySelector('#cp-ai-btn').addEventListener('click', () => {
      page.querySelector('#cp-ai-sec')?.scrollIntoView({ behavior: 'smooth' });
    });
    const send = () => sendChat();
    page.querySelector('#cp-chat-send').addEventListener('click', send);
    page.querySelector('#cp-chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }

  // ── Chart ──
  let chartData = null;
  async function loadChart() {
    const box = document.getElementById('cp-chart');
    if (!box) return;
    box.innerHTML = '<div class="news-shimmer" style="height:320px"></div>';
    const d = await window.localMind.finChart(current.symbol, chartRange);
    if (!box.isConnected || !current) return;
    if (!d || d.error) { box.innerHTML = '<div class="news-empty">No chart data.</div>'; return; }
    chartData = d;
    const last = d.price ?? d.c[d.c.length - 1];
    const vs = d.start || 0;
    const base = chartRange === '1D' ? (d.c[vs - 1] ?? d.c[vs]) : d.c[vs];
    const chg = last - base, chgPct = base ? (chg / base) * 100 : null;
    const priceEl = document.getElementById('cp-price');
    const chgEl = document.getElementById('cp-chg');
    if (priceEl) priceEl.textContent = `${curSym(d.currency)}${num(last)}`;
    if (chgEl) {
      chgEl.innerHTML = `${chg >= 0 ? '▲' : '▼'} ${num(Math.abs(chg))} (${pct(chgPct)}) <span class="fin-chg-range">· ${chartRange === '1D' ? 'Today' : chartRange}</span>`;
      chgEl.className = 'cp-chg ' + cls(chg);
    }
    drawChart();
  }

  function drawChart() {
    const box = document.getElementById('cp-chart');
    if (!box || !chartData) return;
    box.innerHTML = '';
    FinanceChart.render(box, chartData, { type: chartType, ...indicators });
  }

  // ── Profile: header meta, key stats, about, holders, insiders, analyst, earnings ──
  async function loadProfile() {
    const p = await window.localMind.finProfile(current.symbol);
    if (!current || !pageEl()?.isConnected) return;
    if (!p?.ok) return; // crumb blocked or unavailable — sections stay hidden
    profileData = p;

    const meta = document.getElementById('cp-meta');
    if (meta) {
      const state = p.marketState === 'REGULAR' ? '<span class="cp-open">● Open</span>' : '<span class="cp-closed">● Closed</span>';
      meta.innerHTML = [escapeHtml(current.symbol), escapeHtml(p.exchange), escapeHtml(p.sector), escapeHtml(p.industry)].filter(Boolean).join(' · ') + ' ' + state;
    }
    const nameEl = document.getElementById('cp-name');
    if (nameEl && p.name) nameEl.textContent = p.name;

    renderStats(p);
    renderAbout(p);
    renderAnalyst(p);
    renderEarnings(p);
    renderHolders(p);
    renderInsiders(p);
  }

  const statCard = (label, value) => value == null || value === '—' || value === '' ? '' :
    `<div class="cp-stat"><span>${label}</span><b>${value}</b></div>`;

  function renderStats(p) {
    const s = p.stats, cur = curSym(p.currency);
    const range = (a, b) => a != null && b != null ? `${cur}${num(a)} – ${cur}${num(b)}` : null;
    const html = [
      statCard('Previous close', s.prevClose != null ? cur + num(s.prevClose) : null),
      statCard('Open', s.open != null ? cur + num(s.open) : null),
      statCard('Day range', range(s.dayLow, s.dayHigh)),
      statCard('52-week range', range(s.wk52Low, s.wk52High)),
      statCard('Market cap', s.marketCap),
      statCard('Enterprise value', s.enterpriseValue),
      statCard('P/E ratio', s.pe != null ? num(s.pe) : null),
      statCard('Forward P/E', s.forwardPe != null ? num(s.forwardPe) : null),
      statCard('PEG ratio', s.peg != null ? num(s.peg) : null),
      statCard('EPS', s.eps != null ? cur + num(s.eps) : null),
      statCard('Book value', s.bookValue != null ? cur + num(s.bookValue) : null),
      statCard('Price / book', s.priceToBook != null ? num(s.priceToBook) : null),
      statCard('Dividend yield', s.divYield != null ? s.divYield.toFixed(2) + '%' : null),
      statCard('Beta', s.beta != null ? num(s.beta) : null),
      statCard('Shares outstanding', s.sharesOut),
      statCard('Free float', s.floatShares),
      statCard('Avg volume', s.avgVolume),
      statCard("Today's volume", s.volume),
      statCard('Revenue (ttm)', s.revenue),
      statCard('Revenue growth', s.revenueGrowth != null ? pct(s.revenueGrowth) : null),
      statCard('ROE', s.roe != null ? s.roe.toFixed(1) + '%' : null),
      statCard('Operating margin', s.opMargin != null ? s.opMargin.toFixed(1) + '%' : null),
      statCard('Net margin', s.netMargin != null ? s.netMargin.toFixed(1) + '%' : null),
      statCard('Debt / equity', s.debtToEquity != null ? num(s.debtToEquity) : null),
      statCard('Total cash', s.totalCash),
      statCard('Total debt', s.totalDebt),
      statCard('Currency', p.currency)
    ].join('');
    if (html) {
      document.getElementById('cp-stats').innerHTML = html;
      document.getElementById('cp-stats-sec').style.display = 'block';
    }
  }

  function renderAbout(p) {
    const a = p.about;
    if (!a.description && !a.website) return;
    const officers = a.officers.map((o) => `<div class="cp-stat"><span>${escapeHtml(o.title || '')}</span><b>${escapeHtml(o.name || '')}</b></div>`).join('');
    document.getElementById('cp-about').innerHTML = `
      ${a.description ? `<p class="cp-desc">${escapeHtml(a.description)}</p>` : ''}
      <div class="cp-stats">
        ${statCard('Headquarters', [a.city, a.country].filter(Boolean).map(escapeHtml).join(', ') || null)}
        ${statCard('Employees', a.employees ? a.employees.toLocaleString() : null)}
        ${statCard('Sector', escapeHtml(p.sector) || null)}
        ${statCard('Industry', escapeHtml(p.industry) || null)}
        ${a.website ? `<div class="cp-stat"><span>Website</span><b><a href="#" id="cp-site">${escapeHtml(a.website.replace(/^https?:\/\/(www\.)?/, ''))}</a></b></div>` : ''}
        ${officers}
      </div>`;
    document.getElementById('cp-about-sec').style.display = 'block';
    document.getElementById('cp-site')?.addEventListener('click', (e) => {
      e.preventDefault(); hide(); TabManager.createTab(a.website, true);
    });
  }

  function renderAnalyst(p) {
    const a = p.analyst, s = p.stats, cur = curSym(p.currency);
    if (!a.trend && a.count == null) return;
    let bars = '';
    if (a.trend) {
      const t = a.trend;
      const total = (t.strongBuy || 0) + (t.buy || 0) + (t.hold || 0) + (t.sell || 0) + (t.strongSell || 0);
      if (total) {
        bars = [['Buy', (t.strongBuy || 0) + (t.buy || 0), 'var(--accent)'], ['Hold', t.hold || 0, '#e0b45c'], ['Sell', (t.sell || 0) + (t.strongSell || 0), '#e05c5c']]
          .map(([lbl, v, col]) => `
            <div class="cp-rating-row"><span>${lbl}</span>
              <div class="cp-rating-bar"><div style="width:${(v / total) * 100}%;background:${col}"></div></div>
              <b>${v}</b></div>`).join('');
      }
    }
    const rec = a.recommendation ? `<div class="cp-rec">${escapeHtml(a.recommendation.replace(/_/g, ' ').toUpperCase())}${a.count ? ` · ${a.count} analysts` : ''}</div>` : '';
    const targets = s.targetMean != null ? `
      <div class="cp-stats" style="margin-top:10px">
        ${statCard('Avg target', cur + num(s.targetMean))}
        ${statCard('High', cur + num(s.targetHigh))}
        ${statCard('Low', cur + num(s.targetLow))}
      </div>` : '';
    if (rec || bars || targets) {
      document.getElementById('cp-analyst').innerHTML = rec + bars + targets;
      document.getElementById('cp-analyst-sec').style.display = 'block';
    }
  }

  function renderEarnings(p) {
    const e = p.earnings;
    if (!e.next.length && !e.history.length) return;
    const next = e.next.length ? `<div class="cp-rec">Next earnings: ${escapeHtml(e.next.join(' – '))}</div>` : '';
    const rows = e.history.filter((h) => h.epsActual != null || h.epsEst != null).map((h) => `
      <tr><td>${escapeHtml(h.quarter || '')}</td><td>${num(h.epsEst)}</td><td>${num(h.epsActual)}</td>
        <td class="${cls(h.surprisePct)}">${pct(h.surprisePct)}</td></tr>`).join('');
    const table = rows ? `<table class="cp-table"><thead><tr><th>Quarter</th><th>EPS est.</th><th>Actual</th><th>Surprise</th></tr></thead><tbody>${rows}</tbody></table>` : '';
    if (next || table) {
      document.getElementById('cp-earnings').innerHTML = next + table;
      document.getElementById('cp-earnings-sec').style.display = 'block';
    }
  }

  function renderHolders(p) {
    const pieces = [];
    if (p.holders && (p.holders.insiders != null || p.holders.institutions != null)) {
      pieces.push(`<div class="cp-stats">
        ${statCard('Insiders', p.holders.insiders != null ? p.holders.insiders.toFixed(2) + '%' : null)}
        ${statCard('Institutions', p.holders.institutions != null ? p.holders.institutions.toFixed(2) + '%' : null)}
      </div>`);
    }
    if (p.institutions.length) {
      pieces.push(`<table class="cp-table"><thead><tr><th>Institution</th><th>Shares</th><th>%</th></tr></thead><tbody>
        ${p.institutions.map((o) => `<tr><td>${escapeHtml(o.org || '')}</td><td>${or(o.shares)}</td><td>${o.pct != null ? o.pct.toFixed(2) + '%' : '—'}</td></tr>`).join('')}
      </tbody></table>`);
    }
    if (pieces.length) {
      document.getElementById('cp-holders').innerHTML = pieces.join('');
      document.getElementById('cp-holders-sec').style.display = 'block';
    }
  }

  function renderInsiders(p) {
    if (!p.insiders.length) return;
    document.getElementById('cp-insiders').innerHTML = `
      <table class="cp-table"><thead><tr><th>Name</th><th>Action</th><th>Shares</th><th>Date</th></tr></thead><tbody>
      ${p.insiders.map((t) => `<tr><td>${escapeHtml(t.name || '')}<div class="cp-sub">${escapeHtml(t.relation || '')}</div></td>
        <td>${escapeHtml((t.text || '').slice(0, 40))}</td><td>${or(t.shares)}</td><td>${or(t.date)}</td></tr>`).join('')}
      </tbody></table>`;
    document.getElementById('cp-insiders-sec').style.display = 'block';
  }

  // ── Financial statements ──
  async function loadFundamentals() {
    const sec = document.getElementById('cp-fin-sec');
    if (!sec) return;
    if (!fundData[finFreq]) {
      const tbl = document.getElementById('cp-fin-table');
      if (tbl) tbl.innerHTML = '<div class="news-shimmer" style="height:100px"></div>';
      sec.style.display = 'block';
      fundData[finFreq] = await window.localMind.finFundamentals(current.symbol, finFreq);
    }
    if (!current || !pageEl()?.isConnected) return;
    renderFinancials();
  }

  const FIN_LABELS = {
    TotalRevenue: 'Revenue', GrossProfit: 'Gross profit', OperatingIncome: 'Operating income',
    EBITDA: 'EBITDA', NetIncome: 'Net income', DilutedEPS: 'Diluted EPS',
    TotalAssets: 'Total assets', TotalLiabilitiesNetMinorityInterest: 'Total liabilities',
    StockholdersEquity: 'Equity', CashAndCashEquivalents: 'Cash', TotalDebt: 'Total debt', Inventory: 'Inventory',
    OperatingCashFlow: 'Operating CF', InvestingCashFlow: 'Investing CF',
    FinancingCashFlow: 'Financing CF', FreeCashFlow: 'Free cash flow'
  };
  const FIN_TABS = {
    income: ['TotalRevenue', 'GrossProfit', 'OperatingIncome', 'EBITDA', 'NetIncome', 'DilutedEPS'],
    balance: ['TotalAssets', 'TotalLiabilitiesNetMinorityInterest', 'StockholdersEquity', 'CashAndCashEquivalents', 'TotalDebt', 'Inventory'],
    cashflow: ['OperatingCashFlow', 'InvestingCashFlow', 'FinancingCashFlow', 'FreeCashFlow']
  };

  function renderFinancials() {
    const d = fundData[finFreq];
    const sec = document.getElementById('cp-fin-sec');
    const tbl = document.getElementById('cp-fin-table');
    const chart = document.getElementById('cp-fin-chart');
    if (!sec || !tbl) return;
    if (!d?.ok || !Object.keys(d.series || {}).length) {
      // No statements (throttled or unavailable) — hide unless the other freq worked
      const other = fundData[finFreq === 'annual' ? 'quarterly' : 'annual'];
      if (!other?.ok) sec.style.display = 'none';
      else { tbl.innerHTML = '<div class="news-empty">Not available.</div>'; chart.innerHTML = ''; }
      return;
    }
    sec.style.display = 'block';

    const keys = FIN_TABS[finTab].filter((k) => d.series[k]?.length);
    if (!keys.length) { tbl.innerHTML = '<div class="news-empty">Not available.</div>'; chart.innerHTML = ''; return; }
    // Union of dates, newest first, capped at 5 columns
    const dates = [...new Set(keys.flatMap((k) => d.series[k].map((v) => v.date)))].sort().reverse().slice(0, 5);
    const at = (k, date) => d.series[k]?.find((v) => v.date === date);

    tbl.innerHTML = `<table class="cp-table cp-fin-table"><thead><tr><th></th>${dates.map((dt) => `<th>${dt.slice(0, 7)}</th>`).join('')}</tr></thead>
      <tbody>${keys.map((k) => `<tr><td>${FIN_LABELS[k]}</td>${dates.map((dt) => {
        const v = at(k, dt);
        const neg = v?.raw != null && v.raw < 0;
        return `<td class="${neg ? 'fin-down' : ''}">${v?.fmt ?? '—'}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table>`;

    // Bar chart of the tab's headline metric (oldest → newest)
    const mainKey = keys[0];
    const pts = [...dates].reverse().map((dt) => at(mainKey, dt)).filter(Boolean);
    chart.innerHTML = pts.length > 1 ? barChart(pts, FIN_LABELS[mainKey]) : '';
  }

  function barChart(pts, label) {
    const W = 560, H = 150, pad = 6, bw = Math.min(70, (W - pad * 2) / pts.length * 0.6);
    const max = Math.max(...pts.map((p) => Math.abs(p.raw || 0)), 1);
    const bars = pts.map((p, i) => {
      const x = pad + ((i + 0.5) / pts.length) * (W - pad * 2) - bw / 2;
      const h = Math.max(2, (Math.abs(p.raw || 0) / max) * (H - 44));
      const up = (p.raw || 0) >= 0;
      return `<rect x="${x}" y="${H - 26 - h}" width="${bw}" height="${h}" rx="3" fill="${up ? 'var(--accent)' : '#e05c5c'}" opacity="0.75"/>
        <text x="${x + bw / 2}" y="${H - 12}" class="fin-axis" text-anchor="middle">${p.date.slice(0, 7)}</text>
        <text x="${x + bw / 2}" y="${H - 32 - h}" class="fin-axis" text-anchor="middle">${p.fmt || ''}</text>`;
    }).join('');
    return `<div class="cp-barchart"><div class="cp-sub">${label}</div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${bars}</svg></div>`;
  }

  // ── AI analysis (bull / bear / risks / insights) ──
  async function loadAI() {
    const box = document.getElementById('cp-ai');
    if (!box) return;
    const m = model();
    if (!m || !window.localMind?.chat) { document.getElementById('cp-ai-sec').style.display = 'none'; return; }
    if (aiCache.has(current.symbol)) { box.innerHTML = aiCache.get(current.symbol); return; }

    const p = profileData;
    const facts = [];
    if (p?.ok) {
      const s = p.stats;
      facts.push(`Sector: ${p.sector} / ${p.industry}. Market cap ${s.marketCap}, P/E ${num(s.pe)}, ROE ${s.roe != null ? s.roe.toFixed(1) + '%' : 'n/a'}, net margin ${s.netMargin != null ? s.netMargin.toFixed(1) + '%' : 'n/a'}, revenue ${s.revenue} (growth ${s.revenueGrowth != null ? pct(s.revenueGrowth) : 'n/a'}), debt/equity ${num(s.debtToEquity)}, dividend yield ${s.divYield != null ? s.divYield.toFixed(2) + '%' : 'none'}. Analyst view: ${p.analyst.recommendation || 'n/a'}, target ${num(s.targetMean)} vs price ${num(s.price)}.`);
      if (p.about.description) facts.push(`Business: ${p.about.description.slice(0, 500)}`);
    }
    if (newsItems.length) facts.push('Recent headlines: ' + newsItems.slice(0, 6).map((n) => n.title).join(' | '));
    if (!facts.length) facts.push('(Live fundamentals unavailable right now — use your general knowledge, and say so.)');

    try {
      const result = await window.localMind.chat([
        { role: 'system', content: `You are an equity analyst. For the given company, output PLAIN TEXT in EXACTLY this structure (no markdown headers, no extra sections):
SUMMARY: 2-3 sentence overview of what the company does and where it stands.
BULL:
- 3 short bullet points for the bull case
BEAR:
- 3 short bullet points for the bear case
RISKS:
- 3 short bullet points on key risks
INSIGHTS:
- 3 punchy data-driven observations (valuation vs history, margins, ownership, growth) based on the facts given` },
        { role: 'user', content: `Company: ${current.name} (${current.symbol})\n\n${facts.join('\n\n')}` }
      ], m, { quiet: true });
      const text = aiText(result).trim();
      if (!text || result?.error) throw new Error('empty');
      const html = renderAIText(text);
      aiCache.set(current.symbol, html);
      if (box.isConnected) box.innerHTML = html;
    } catch {
      if (box.isConnected) box.innerHTML = '<div class="news-empty">AI analysis unavailable.</div>';
    }
  }

  function renderAIText(text) {
    const secs = { SUMMARY: '', BULL: [], BEAR: [], RISKS: [], INSIGHTS: [] };
    let cur = null;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const mHead = t.match(/^(SUMMARY|BULL|BEAR|RISKS|INSIGHTS):?\s*(.*)$/i);
      if (mHead) { cur = mHead[1].toUpperCase(); if (mHead[2] && cur === 'SUMMARY') secs.SUMMARY = mHead[2]; continue; }
      if (!cur) continue;
      if (cur === 'SUMMARY') secs.SUMMARY += (secs.SUMMARY ? ' ' : '') + t;
      else if (t.startsWith('-') || t.startsWith('•')) secs[cur].push(t.replace(/^[-•]\s*/, ''));
    }
    const list = (items) => `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
    return `
      ${secs.SUMMARY ? `<p class="cp-desc">${escapeHtml(secs.SUMMARY)}</p>` : ''}
      <div class="cp-ai-grid">
        ${secs.BULL.length ? `<div class="cp-ai-card cp-bull"><h3>▲ Bull case</h3>${list(secs.BULL)}</div>` : ''}
        ${secs.BEAR.length ? `<div class="cp-ai-card cp-bear"><h3>▼ Bear case</h3>${list(secs.BEAR)}</div>` : ''}
        ${secs.RISKS.length ? `<div class="cp-ai-card cp-risk"><h3>⚠ Risks</h3>${list(secs.RISKS)}</div>` : ''}
        ${secs.INSIGHTS.length ? `<div class="cp-ai-card cp-insight"><h3>✦ Insights</h3>${list(secs.INSIGHTS)}</div>` : ''}
      </div>`;
  }

  // ── News ──
  async function loadNews() {
    const r = await window.localMind.finNews({ companies: [current.name.replace(/\s+(Ltd|Limited|Inc|Corp|Corporation)\.?$/i, '')] }).catch(() => null);
    if (!current || !pageEl()?.isConnected) return;
    const items = (r?.articles || r?.items || []).slice(0, 8);
    if (!items.length) return;
    newsItems = items;
    const box = document.getElementById('cp-news');
    box.innerHTML = items.map((a, i) => {
      const when = relTime(a.publishedAt);
      return `<div class="cp-news-row" data-i="${i}">
        <div class="cp-news-main"><b>${escapeHtml(a.title)}</b>
        <div class="cp-sub">${escapeHtml(a.source || '')}${when ? ' · ' + when : ''}</div></div>
      </div>`;
    }).join('');
    box.addEventListener('click', (e) => {
      const row = e.target.closest('.cp-news-row');
      if (!row) return;
      const a = items[+row.dataset.i];
      if (a && typeof StoryPage !== 'undefined') { hide(); StoryPage.open(a); }
    });
    document.getElementById('cp-news-sec').style.display = 'block';
  }

  // ── Competitors ──
  async function loadPeers() {
    const peers = PEERS[current.symbol];
    if (!peers?.length) return;
    const quotes = await window.localMind.finQuotes(peers).catch(() => ({}));
    if (!current || !pageEl()?.isConnected) return;
    const cards = peers.filter((s) => quotes[s]).map((s) => {
      const q = quotes[s];
      return `<div class="cp-peer" data-sym="${escapeHtml(s)}" data-name="${escapeHtml(q.name || s)}">
        ${logoHtml(s, 26)}
        <div class="cp-peer-main"><b>${escapeHtml(s.replace(/\.NS$/, ''))}</b><span>${escapeHtml(q.name || '')}</span></div>
        <div class="cp-peer-px"><b>${num(q.price)}</b><span class="${cls(q.changePct)}">${pct(q.changePct)}</span></div>
      </div>`;
    }).join('');
    if (!cards) return;
    const box = document.getElementById('cp-peers');
    box.innerHTML = cards;
    box.addEventListener('click', (e) => {
      const card = e.target.closest('.cp-peer');
      if (card) open(card.dataset.sym, card.dataset.name);
    });
    document.getElementById('cp-peers-sec').style.display = 'block';
  }

  // ── AI chat about this company ──
  async function sendChat() {
    const input = document.getElementById('cp-chat-input');
    const log = document.getElementById('cp-chat-log');
    const q = input?.value.trim();
    const m = model();
    if (!q || !log || !m || !window.localMind?.chat) return;
    input.value = '';
    log.insertAdjacentHTML('beforeend', `<div class="cp-msg cp-msg-user">${escapeHtml(q)}</div>`);
    const pending = document.createElement('div');
    pending.className = 'cp-msg cp-msg-ai';
    pending.textContent = '✦ Thinking…';
    log.appendChild(pending);
    log.scrollTop = log.scrollHeight;

    const ctx = [];
    if (profileData?.ok) {
      const s = profileData.stats;
      ctx.push(`${profileData.name} (${current.symbol}), ${profileData.sector}/${profileData.industry}, ${profileData.exchange}. Price ${num(s.price)} (${pct(s.changePct)} today). Mcap ${s.marketCap}, P/E ${num(s.pe)}, EPS ${num(s.eps)}, ROE ${s.roe != null ? s.roe.toFixed(1) + '%' : 'n/a'}, margins gross/${s.grossMargin?.toFixed(0)}% op/${s.opMargin?.toFixed(0)}% net/${s.netMargin?.toFixed(0)}%, revenue ${s.revenue}, growth ${s.revenueGrowth != null ? pct(s.revenueGrowth) : 'n/a'}, D/E ${num(s.debtToEquity)}, cash ${s.totalCash}, debt ${s.totalDebt}. 52wk ${num(s.wk52Low)}–${num(s.wk52High)}. Analyst: ${profileData.analyst.recommendation}, target ${num(s.targetMean)}.`);
      if (profileData.about.description) ctx.push(profileData.about.description.slice(0, 400));
    }
    const fd = fundData.annual;
    if (fd?.ok) {
      const rev = fd.series.TotalRevenue || [], ni = fd.series.NetIncome || [];
      if (rev.length) ctx.push('Annual revenue: ' + rev.map((v) => `${v.date.slice(0, 4)}=${v.fmt}`).join(', '));
      if (ni.length) ctx.push('Annual net income: ' + ni.map((v) => `${v.date.slice(0, 4)}=${v.fmt}`).join(', '));
    }
    if (newsItems.length) ctx.push('Recent news: ' + newsItems.slice(0, 6).map((n) => n.title).join(' | '));

    chatHistory.push({ role: 'user', content: q });
    try {
      const result = await window.localMind.chat([
        { role: 'system', content: `You are a sharp, honest equity research assistant embedded in a company page for ${current.name} (${current.symbol}). Answer using the DATA below plus general knowledge; if the data doesn't cover it, say so plainly. Be concise — a few sentences or a short list. Plain text only.\n\nDATA:\n${ctx.join('\n') || '(live data unavailable)'}` },
        ...chatHistory.slice(-6)
      ], m, { quiet: true });
      const text = aiText(result).trim();
      if (!text || result?.error) throw new Error('empty');
      chatHistory.push({ role: 'assistant', content: text });
      pending.textContent = text;
    } catch {
      pending.textContent = 'Sorry — the model is unavailable right now.';
    }
    log.scrollTop = log.scrollHeight;
  }

  return { init, open, hide, isCompany };
})();
