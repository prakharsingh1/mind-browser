// =============================================================================
// Local Mind Browser — Finance Page
// =============================================================================
// Perplexity-Finance-style dashboard: country toggle (India/USA), Overview and
// Focused (industry hub) views, sector heatmap treemap, interactive pro chart,
// watchlist + portfolio with company logos, sectors, economy, trending, news.

const FinancePage = (() => {
  const REFRESH_MS = 5 * 60 * 1000;
  let lastLoaded = 0;
  let refreshTimer = null;
  let loading = false;
  let view = 'overview';        // 'overview' | 'focused'
  let activeIndustry = null;

  // Chart state
  let chartSymbol = '^NSEI';
  let chartName = 'NIFTY 50';
  let chartRange = '1D';
  let chartType = 'line';
  const chartInd = { sma20: false, sma50: false, bb: false, rsi: false, macd: false };
  let chartData = null;
  let hmQuotes = null;         // cached heatmap quotes for resize re-layouts
  let resizeWired = false;

  // ── Country configs ──
  const COUNTRIES = {
    IN: {
      label: 'India', flag: '🇮🇳', defaultChart: ['^NSEI', 'NIFTY 50'],
      indices: [
        { s: '^NSEI', n: 'NIFTY 50' }, { s: '^BSESN', n: 'SENSEX' }, { s: '^NSEBANK', n: 'BANK NIFTY' }, { s: '^CNXIT', n: 'NIFTY IT' },
        { s: '^GSPC', n: 'S&P 500' }, { s: '^IXIC', n: 'NASDAQ' }, { s: '^FTSE', n: 'FTSE 100' }, { s: '^N225', n: 'NIKKEI' }
      ],
      sectors: [
        { s: '^NSEBANK', n: 'Banking' }, { s: '^CNXIT', n: 'IT' }, { s: '^CNXAUTO', n: 'Auto' },
        { s: '^CNXPHARMA', n: 'Pharma' }, { s: '^CNXFMCG', n: 'FMCG' }, { s: '^CNXENERGY', n: 'Energy' },
        { s: '^CNXMETAL', n: 'Metal' }, { s: '^CNXREALTY', n: 'Realty' }
      ]
    },
    US: {
      label: 'USA', flag: '🇺🇸', defaultChart: ['^GSPC', 'S&P 500'],
      indices: [
        { s: '^GSPC', n: 'S&P 500' }, { s: '^IXIC', n: 'NASDAQ' }, { s: '^DJI', n: 'DOW JONES' }, { s: '^RUT', n: 'RUSSELL 2000' },
        { s: '^VIX', n: 'VIX' }, { s: '^FTSE', n: 'FTSE 100' }, { s: '^N225', n: 'NIKKEI' }, { s: '^NSEI', n: 'NIFTY 50' }
      ],
      sectors: [
        { s: 'XLK', n: 'Technology' }, { s: 'XLF', n: 'Financials' }, { s: 'XLV', n: 'Healthcare' },
        { s: 'XLY', n: 'Cons. Cyclical' }, { s: 'XLP', n: 'Cons. Staples' }, { s: 'XLE', n: 'Energy' },
        { s: 'XLI', n: 'Industrials' }, { s: 'XLC', n: 'Comm. Services' }
      ]
    }
  };

  // Heatmap constituents: [symbol, sector, approx weight]
  const HEATMAP = {
    IN: [
      ['RELIANCE.NS', 'Energy', 9.2], ['ONGC.NS', 'Energy', 1.1], ['COALINDIA.NS', 'Energy', 1.0], ['IOC.NS', 'Energy', 0.7], ['ADANIENT.NS', 'Energy', 1.2],
      ['HDFCBANK.NS', 'Financials', 8.6], ['ICICIBANK.NS', 'Financials', 6.4], ['SBIN.NS', 'Financials', 3.1], ['KOTAKBANK.NS', 'Financials', 2.4],
      ['AXISBANK.NS', 'Financials', 2.4], ['BAJFINANCE.NS', 'Financials', 2.1], ['LICI.NS', 'Financials', 1.4], ['SBILIFE.NS', 'Financials', 0.8],
      ['TCS.NS', 'Technology', 3.9], ['INFY.NS', 'Technology', 3.4], ['HCLTECH.NS', 'Technology', 1.4], ['WIPRO.NS', 'Technology', 0.8], ['TECHM.NS', 'Technology', 0.7],
      ['BHARTIARTL.NS', 'Telecom', 2.8], ['IDEA.NS', 'Telecom', 0.3],
      ['HINDUNILVR.NS', 'Cons. Defensive', 2.2], ['ITC.NS', 'Cons. Defensive', 2.6], ['NESTLEIND.NS', 'Cons. Defensive', 0.9],
      ['TATACONSUM.NS', 'Cons. Defensive', 0.6], ['BRITANNIA.NS', 'Cons. Defensive', 0.5], ['DABUR.NS', 'Cons. Defensive', 0.4],
      ['MARUTI.NS', 'Cons. Cyclical', 1.6], ['M&M.NS', 'Cons. Cyclical', 1.7], ['TATAMOTORS.NS', 'Cons. Cyclical', 1.5],
      ['TITAN.NS', 'Cons. Cyclical', 1.2], ['BAJAJ-AUTO.NS', 'Cons. Cyclical', 0.8], ['TRENT.NS', 'Cons. Cyclical', 0.7],
      ['SUNPHARMA.NS', 'Healthcare', 1.6], ['DRREDDY.NS', 'Healthcare', 0.7], ['CIPLA.NS', 'Healthcare', 0.7], ['DIVISLAB.NS', 'Healthcare', 0.6], ['APOLLOHOSP.NS', 'Healthcare', 0.6],
      ['LT.NS', 'Industrials', 3.0], ['ADANIPORTS.NS', 'Industrials', 1.0], ['BEL.NS', 'Industrials', 0.9], ['HAL.NS', 'Industrials', 0.8],
      ['NTPC.NS', 'Utilities', 1.3], ['POWERGRID.NS', 'Utilities', 1.1], ['TATAPOWER.NS', 'Utilities', 0.6],
      ['ULTRACEMCO.NS', 'Materials', 1.0], ['JSWSTEEL.NS', 'Materials', 0.8], ['TATASTEEL.NS', 'Materials', 0.8], ['HINDALCO.NS', 'Materials', 0.7],
      ['DLF.NS', 'Real Estate', 0.5]
    ],
    US: [
      ['AAPL', 'Technology', 6.8], ['MSFT', 'Technology', 6.5], ['NVDA', 'Technology', 6.9], ['AVGO', 'Technology', 2.3], ['AMD', 'Technology', 1.0], ['ORCL', 'Technology', 1.3], ['CRM', 'Technology', 0.7],
      ['GOOGL', 'Comm. Services', 4.1], ['META', 'Comm. Services', 2.9], ['NFLX', 'Comm. Services', 1.0], ['DIS', 'Comm. Services', 0.6],
      ['AMZN', 'Cons. Cyclical', 3.9], ['TSLA', 'Cons. Cyclical', 2.2], ['HD', 'Cons. Cyclical', 1.0], ['MCD', 'Cons. Cyclical', 0.6], ['NKE', 'Cons. Cyclical', 0.4],
      ['BRK-B', 'Financials', 1.8], ['JPM', 'Financials', 1.5], ['V', 'Financials', 1.2], ['MA', 'Financials', 1.0], ['BAC', 'Financials', 0.7], ['GS', 'Financials', 0.5],
      ['LLY', 'Healthcare', 1.5], ['UNH', 'Healthcare', 1.2], ['JNJ', 'Healthcare', 0.9], ['ABBV', 'Healthcare', 0.8], ['MRK', 'Healthcare', 0.6],
      ['WMT', 'Cons. Defensive', 1.2], ['PG', 'Cons. Defensive', 0.9], ['COST', 'Cons. Defensive', 0.9], ['KO', 'Cons. Defensive', 0.7], ['PEP', 'Cons. Defensive', 0.6],
      ['XOM', 'Energy', 1.1], ['CVX', 'Energy', 0.7],
      ['CAT', 'Industrials', 0.5], ['GE', 'Industrials', 0.5], ['BA', 'Industrials', 0.4], ['UPS', 'Industrials', 0.3],
      ['NEE', 'Utilities', 0.4], ['LIN', 'Materials', 0.5]
    ]
  };

  const ECON = [
    { s: 'GC=F', n: 'Gold' }, { s: 'SI=F', n: 'Silver' }, { s: 'CL=F', n: 'Crude Oil' },
    { s: 'BTC-USD', n: 'Bitcoin' }, { s: 'USDINR=X', n: 'USD/INR' }, { s: 'EURUSD=X', n: 'EUR/USD' },
    { s: '^TNX', n: 'US 10Y Yield' }
  ];

  const INDUSTRY_TICKERS = {
    'FMCG': ['HINDUNILVR.NS', 'ITC.NS', 'NESTLEIND.NS', 'BRITANNIA.NS', 'DABUR.NS', 'TATACONSUM.NS'],
    'Technology': ['TCS.NS', 'INFY.NS', 'HCLTECH.NS', 'WIPRO.NS', 'TECHM.NS'],
    'AI': ['NVDA', 'MSFT', 'GOOGL', 'META', 'PLTR'],
    'Semiconductors': ['NVDA', 'TSM', 'AMD', 'INTC', 'AVGO'],
    'Banking': ['HDFCBANK.NS', 'ICICIBANK.NS', 'SBIN.NS', 'KOTAKBANK.NS', 'AXISBANK.NS'],
    'Pharma': ['SUNPHARMA.NS', 'DRREDDY.NS', 'CIPLA.NS', 'DIVISLAB.NS', 'LUPIN.NS'],
    'Energy': ['RELIANCE.NS', 'ONGC.NS', 'NTPC.NS', 'POWERGRID.NS', 'IOC.NS'],
    'Automobile': ['TATAMOTORS.NS', 'M&M.NS', 'MARUTI.NS', 'BAJAJ-AUTO.NS', 'EICHERMOT.NS'],
    'EV': ['TSLA', 'TATAMOTORS.NS', 'RIVN', 'NIO', 'BYDDY'],
    'Defense': ['HAL.NS', 'BEL.NS', 'BDL.NS', 'MAZDOCK.NS', 'LMT'],
    'Retail': ['DMART.NS', 'TRENT.NS', 'WMT', 'AMZN', 'COST'],
    'Real Estate': ['DLF.NS', 'LODHA.NS', 'GODREJPROP.NS', 'OBEROIRLTY.NS', 'PRESTIGE.NS'],
    'Telecom': ['BHARTIARTL.NS', 'IDEA.NS', 'TATACOMM.NS', 'T', 'VZ'],
    'Renewable Energy': ['ADANIGREEN.NS', 'SUZLON.NS', 'TATAPOWER.NS', 'FSLR', 'ENPH']
  };

  // Ticker → website domain, for company logos (Clearbit; falls back to a letter)
  const DOMAINS = {
    'RELIANCE.NS': 'ril.com', 'HDFCBANK.NS': 'hdfcbank.com', 'ICICIBANK.NS': 'icicibank.com', 'SBIN.NS': 'onlinesbi.sbi',
    'KOTAKBANK.NS': 'kotak.com', 'AXISBANK.NS': 'axisbank.com', 'BAJFINANCE.NS': 'bajajfinserv.in', 'LICI.NS': 'licindia.in',
    'SBILIFE.NS': 'sbilife.co.in', 'TCS.NS': 'tcs.com', 'INFY.NS': 'infosys.com', 'HCLTECH.NS': 'hcltech.com',
    'WIPRO.NS': 'wipro.com', 'TECHM.NS': 'techmahindra.com', 'BHARTIARTL.NS': 'airtel.in', 'IDEA.NS': 'myvi.in',
    'HINDUNILVR.NS': 'hul.co.in', 'ITC.NS': 'itcportal.com', 'NESTLEIND.NS': 'nestle.in', 'TATACONSUM.NS': 'tataconsumer.com',
    'BRITANNIA.NS': 'britannia.co.in', 'DABUR.NS': 'dabur.com', 'MARUTI.NS': 'marutisuzuki.com', 'M&M.NS': 'mahindra.com',
    'TATAMOTORS.NS': 'tatamotors.com', 'TITAN.NS': 'titan.co.in', 'BAJAJ-AUTO.NS': 'bajajauto.com', 'TRENT.NS': 'westside.com',
    'SUNPHARMA.NS': 'sunpharma.com', 'DRREDDY.NS': 'drreddys.com', 'CIPLA.NS': 'cipla.com', 'DIVISLAB.NS': 'divislabs.com',
    'APOLLOHOSP.NS': 'apollohospitals.com', 'LT.NS': 'larsentoubro.com', 'ADANIPORTS.NS': 'adaniports.com', 'BEL.NS': 'bel-india.com',
    'HAL.NS': 'hal-india.com', 'NTPC.NS': 'ntpc.co.in', 'POWERGRID.NS': 'powergrid.in', 'TATAPOWER.NS': 'tatapower.com',
    'ULTRACEMCO.NS': 'ultratechcement.com', 'JSWSTEEL.NS': 'jsw.in', 'TATASTEEL.NS': 'tatasteel.com', 'HINDALCO.NS': 'hindalco.com',
    'DLF.NS': 'dlf.in', 'ONGC.NS': 'ongcindia.com', 'COALINDIA.NS': 'coalindia.in', 'IOC.NS': 'iocl.com', 'ADANIENT.NS': 'adani.com',
    'DMART.NS': 'dmartindia.com', 'LODHA.NS': 'lodhagroup.in', 'GODREJPROP.NS': 'godrejproperties.com',
    'OBEROIRLTY.NS': 'oberoirealty.com', 'PRESTIGE.NS': 'prestigeconstructions.com', 'ADANIGREEN.NS': 'adanigreenenergy.com',
    'SUZLON.NS': 'suzlon.com', 'MAZDOCK.NS': 'mazagondock.in', 'BDL.NS': 'bdl-india.in', 'EICHERMOT.NS': 'royalenfield.com',
    'LUPIN.NS': 'lupin.com', 'TATACOMM.NS': 'tatacommunications.com',
    'AAPL': 'apple.com', 'MSFT': 'microsoft.com', 'NVDA': 'nvidia.com', 'GOOGL': 'google.com', 'META': 'meta.com',
    'AMZN': 'amazon.com', 'TSLA': 'tesla.com', 'AVGO': 'broadcom.com', 'AMD': 'amd.com', 'ORCL': 'oracle.com',
    'CRM': 'salesforce.com', 'NFLX': 'netflix.com', 'DIS': 'disney.com', 'HD': 'homedepot.com', 'MCD': 'mcdonalds.com',
    'NKE': 'nike.com', 'BRK-B': 'berkshirehathaway.com', 'JPM': 'jpmorganchase.com', 'V': 'visa.com', 'MA': 'mastercard.com',
    'BAC': 'bankofamerica.com', 'GS': 'goldmansachs.com', 'LLY': 'lilly.com', 'UNH': 'unitedhealthgroup.com',
    'JNJ': 'jnj.com', 'ABBV': 'abbvie.com', 'MRK': 'merck.com', 'WMT': 'walmart.com', 'PG': 'pg.com', 'COST': 'costco.com',
    'KO': 'coca-cola.com', 'PEP': 'pepsico.com', 'XOM': 'exxonmobil.com', 'CVX': 'chevron.com', 'CAT': 'caterpillar.com',
    'GE': 'ge.com', 'BA': 'boeing.com', 'UPS': 'ups.com', 'NEE': 'nexteraenergy.com', 'LIN': 'linde.com',
    'TSM': 'tsmc.com', 'INTC': 'intel.com', 'PLTR': 'palantir.com', 'RIVN': 'rivian.com', 'NIO': 'nio.com',
    'BYDDY': 'byd.com', 'LMT': 'lockheedmartin.com', 'FSLR': 'firstsolar.com', 'ENPH': 'enphase.com',
    'T': 'att.com', 'VZ': 'verizon.com'
  };

  // Company logos, tried in order: FMP → Google favicon → letter avatar.
  // FMP is keyed by ticker, so it covers symbols outside DOMAINS (any search
  // result), and it has logos for companies whose sites Google has no favicon
  // for. It can't be the only source though: it drops connections under bursts
  // and occasionally serves a 16x16 stub. Google's favicon service can only be
  // the fallback because it answers unknown domains with a generic globe image
  // instead of a 404, which would silently render as a fake "logo".
  function logoHtml(symbol, size = 22) {
    const letter = (symbol || '?')[0].toUpperCase();
    const domain = DOMAINS[symbol];
    const primary = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`;
    const fallback = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : '';
    return `<span class="fin-logo-wrap" style="width:${size}px;height:${size}px;" data-letter="${letter}">
      <img class="fin-logo" src="${primary}" style="width:${size}px;height:${size}px;" loading="lazy"
        data-fallback="${fallback}" data-on-error="logo-next" data-on-load="logo-check">
    </span>`;
  }

  // Advance to the next source; fall back to the letter avatar once exhausted.
  window.finLogoNext = (img) => {
    const next = img.dataset.fallback;
    if (next) { img.dataset.fallback = ''; img.src = next; return; }
    img.parentElement.classList.add('fin-logo-failed');
  };
  // A 200 response isn't proof of a usable logo — FMP returns 16x16 stubs for
  // some tickers where a real source has a proper one.
  window.finLogoCheck = (img) => {
    if (img.naturalWidth && img.naturalWidth < 32) window.finLogoNext(img);
  };

  const fin = () => {
    if (!window.mindSettings.finance) window.mindSettings.finance = {};
    const f = window.mindSettings.finance;
    if (!Array.isArray(f.watchlist)) f.watchlist = ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'AAPL', 'NVDA'];
    if (!Array.isArray(f.portfolio)) f.portfolio = [];
    if (!f.country) f.country = 'IN';
    return f;
  };
  const country = () => COUNTRIES[fin().country] || COUNTRIES.IN;
  const persist = () => window.localMind?.saveSettings?.(window.mindSettings);

  function init() {
    document.getElementById('sidebar-finance')?.addEventListener('click', toggle);
    EventBus.on('tab-activated', hide);
    EventBus.on('leave-page-views', hide);

    // Re-layout the fixed-width visuals (heatmap treemap + chart SVG) whenever
    // the page container resizes — sidebar toggles, AI panel, window resize.
    const page = pageEl();
    if (page && !resizeWired && typeof ResizeObserver !== 'undefined') {
      resizeWired = true;
      let lastW = 0, timer = null;
      new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect?.width || 0;
        if (!isVisible() || Math.abs(w - lastW) < 12) return;
        lastW = w;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (view === 'overview') {
            renderHeatmap();
            drawChart();
          }
        }, 180);
      }).observe(page);
    }
  }

  const pageEl = () => document.getElementById('finance-page');
  const isVisible = () => pageEl() && pageEl().style.display !== 'none';
  function toggle() { isVisible() ? hide() : show(); }

  function show() {
    if (typeof NotesPage !== 'undefined') NotesPage.hide();
    const page = pageEl();
    if (!page) return;
    page.style.display = 'block';
    document.getElementById('sidebar-finance')?.classList.add('active');
    if (typeof NewsPage !== 'undefined') NewsPage.hide();
    if (typeof CompanyPage !== 'undefined') CompanyPage.hide();
    if (typeof StoryPage !== 'undefined') StoryPage.hide();
    if (Date.now() - lastLoaded > REFRESH_MS) loadAll();
    if (!refreshTimer) refreshTimer = setInterval(() => { if (isVisible()) loadAll(); }, REFRESH_MS);
  }

  function hide() {
    const page = pageEl();
    if (page) page.style.display = 'none';
    document.getElementById('sidebar-finance')?.classList.remove('active');
  }

  function openUrl(url) { hide(); TabManager.createTab(url, true); }

  const pct = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  const num = (v) => v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 10 ? 3 : 2 });
  const cls = (v) => v == null ? '' : v >= 0 ? 'fin-up' : 'fin-down';
  const CUR_SYM = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$', CNY: '¥', AUD: 'A$', CAD: 'C$' };
  const curSym = (c) => CUR_SYM[c] || (c && c !== '—' ? c + ' ' : '');
  const money = (v, c) => v == null ? '—' : curSym(c) + num(v);

  // ── Load orchestration ──
  async function loadAll() {
    if (loading || !window.localMind?.finQuotes) return;
    loading = true;
    lastLoaded = Date.now();
    const page = pageEl();
    if (!page.querySelector('.fin-inner')) buildSkeleton(page);
    setLabel('Updating…');

    const jobs = view === 'overview' ? [
      loadQuotesInto('fin-indices', country().indices, { spark: true }),
      loadHeatmap(),
      loadChart(),
      renderWatchlist(),
      renderPortfolio(),
      loadSectors(),
      loadQuotesInto('fin-econ', ECON, { spark: false }),
      loadTrending(),
      loadNews()
    ] : [loadIndustryHub()];

    await Promise.allSettled(jobs);
    setLabel(`Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    loading = false;
  }

  const setLabel = (t) => { const e = document.getElementById('fin-updated'); if (e) e.textContent = t; };

  function switchView(v) {
    view = v;
    lastLoaded = 0;
    const page = pageEl();
    page.querySelector('.fin-inner')?.remove();
    loadAll();
  }

  function switchCountry(c) {
    fin().country = c;
    persist();
    [chartSymbol, chartName] = COUNTRIES[c].defaultChart;
    lastLoaded = 0;
    const page = pageEl();
    page.querySelector('.fin-inner')?.remove();
    loadAll();
  }

  // ── Skeleton ──
  function buildSkeleton(page) {
    const f = fin();
    const industries = f.industries || [];
    page.innerHTML = `
      <div class="fin-inner">
        <div class="fin-topbar">
          <div>
            <h1>Finance</h1>
            <div class="news-date"><span id="fin-updated">Loading…</span></div>
          </div>
          <div class="fin-topbar-controls">
            <div class="fin-pills fin-country-pills">
              ${Object.entries(COUNTRIES).map(([code, c]) =>
                `<button data-c="${code}" class="${f.country === code ? 'active' : ''}">${c.flag} ${c.label}</button>`).join('')}
            </div>
            <div class="fin-pills fin-view-pills">
              <button data-v="overview" class="${view === 'overview' ? 'active' : ''}">Overview</button>
              <button data-v="focused" class="${view === 'focused' ? 'active' : ''}">Focused${industries.length ? ` · ${industries.length}` : ''}</button>
            </div>
            <button id="fin-refresh" class="news-refresh-btn">↻</button>
          </div>
        </div>
        ${view === 'overview' ? overviewSkeleton() : '<div id="fin-industry-hub"><div class="news-shimmer" style="height:120px"></div></div>'}
      </div>`;

    page.querySelector('#fin-refresh').addEventListener('click', () => { lastLoaded = 0; loadAll(); });
    page.querySelector('.fin-country-pills').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-c]');
      if (b && b.dataset.c !== fin().country) switchCountry(b.dataset.c);
    });
    page.querySelector('.fin-view-pills').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b && b.dataset.v !== view) switchView(b.dataset.v);
    });

    if (view === 'overview') wireOverview(page);
  }

  function overviewSkeleton() {
    return `
      <div class="fin-tape" id="fin-tape"></div>

      <h2>Markets · ${country().label}</h2>
      <div class="fin-index-grid" id="fin-indices">${'<div class="news-shimmer" style="height:76px"></div>'.repeat(8)}</div>

      <h2>Sector Heatmap</h2>
      <div id="fin-heatmap" class="fin-heatmap"><div class="news-shimmer" style="height:380px"></div></div>

      <h2>Top Movers</h2>
      <div class="fin-movers" id="fin-movers"></div>

      <div class="fin-chart-card">
        <div class="fin-chart-head">
          <div class="fin-chart-title"><span id="fin-chart-name">—</span><span id="fin-chart-price"></span><span id="fin-chart-chg"></span></div>
          <div class="fin-chart-search"><input id="fin-search" placeholder="Search any stock, index, crypto…"><div id="fin-search-results"></div></div>
        </div>
        <div class="fin-chart-controls">
          <div class="fin-pills" id="fin-ranges">${['1D', '1W', '1M', '6M', '1Y', '5Y', 'MAX'].map(r => `<button data-r="${r}" class="${r === chartRange ? 'active' : ''}">${r}</button>`).join('')}</div>
          <div class="fin-pills" id="fin-types"><button data-t="line" class="${chartType === 'line' ? 'active' : ''}">Line</button><button data-t="candle" class="${chartType === 'candle' ? 'active' : ''}">Candles</button></div>
          <div class="fin-pills" id="fin-inds">${['sma20', 'sma50', 'bb', 'rsi', 'macd'].map(k => `<button data-i="${k}" class="${chartInd[k] ? 'active' : ''}">${{ sma20: 'SMA 20', sma50: 'SMA 50', bb: 'Bollinger', rsi: 'RSI', macd: 'MACD' }[k]}</button>`).join('')}</div>
        </div>
        <div id="fin-chart" class="fin-chart-body"><div class="news-shimmer" style="height:340px"></div></div>
      </div>

      <div class="fin-two-col">
        <div><h2>Watchlist <button class="fin-mini-btn" id="fin-watch-add">+ Add</button></h2><div id="fin-watchlist"></div></div>
        <div><h2>Portfolio <button class="fin-mini-btn" id="fin-port-add">+ Add holding</button></h2><div id="fin-portfolio"></div></div>
      </div>

      <div class="fin-two-col">
        <div><h2>Sector Performance</h2><div id="fin-sectors"></div></div>
        <div><h2>Economy & Commodities</h2><div class="fin-index-grid fin-econ-grid" id="fin-econ"></div></div>
      </div>

      <h2>Trending Tickers · US</h2>
      <div class="news-trend-row" id="fin-trending"></div>

      <h2 id="fin-news-head">Market News</h2>
      <div class="fin-news-grid" id="fin-news"></div>`;
  }

  function wireOverview(page) {
    page.querySelector('#fin-ranges')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-r]'); if (!b) return;
      chartRange = b.dataset.r;
      page.querySelectorAll('#fin-ranges button').forEach(x => x.classList.toggle('active', x === b));
      loadChart();
    });
    page.querySelector('#fin-types')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-t]'); if (!b) return;
      chartType = b.dataset.t;
      page.querySelectorAll('#fin-types button').forEach(x => x.classList.toggle('active', x === b));
      drawChart();
    });
    page.querySelector('#fin-inds')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]'); if (!b) return;
      chartInd[b.dataset.i] = !chartInd[b.dataset.i];
      b.classList.toggle('active', chartInd[b.dataset.i]);
      drawChart();
    });
    wireSearch(page);
    page.querySelector('#fin-watch-add')?.addEventListener('click', () => addSymbolFlow('watch'));
    page.querySelector('#fin-port-add')?.addEventListener('click', () => addSymbolFlow('portfolio'));
  }

  // ── Heatmap (squarified treemap) ──
  function heatColor(p) {
    if (p == null) return '#31353a';
    const t = Math.max(-3, Math.min(3, p)) / 3;
    if (t >= 0) {
      const g = Math.round(58 + t * 64);
      return `rgb(${Math.round(34 - t * 8)}, ${g + 40}, ${Math.round(58 + t * 12)})`;
    }
    const r = Math.round(120 + (-t) * 60);
    return `rgb(${r}, ${Math.round(52 - (-t) * 8)}, ${Math.round(56 - (-t) * 6)})`;
  }

  // Classic squarify: items [{v,...}] → rects filling {x,y,w,h}
  function squarify(items, rect) {
    const out = [];
    let list = items.filter(i => i.v > 0).sort((a, b) => b.v - a.v);
    const total = list.reduce((s, i) => s + i.v, 0);
    if (!total) return out;
    const scale = (rect.w * rect.h) / total;
    let { x, y, w, h } = rect;

    let row = [];
    const worst = (r, side) => {
      const s = r.reduce((a, i) => a + i.v * scale, 0);
      let mx = 0;
      r.forEach((i) => {
        const a = i.v * scale;
        const ratio = Math.max((side * side * a) / (s * s), (s * s) / (side * side * a));
        mx = Math.max(mx, ratio);
      });
      return mx;
    };
    const layoutRow = (r) => {
      const s = r.reduce((a, i) => a + i.v * scale, 0);
      if (w >= h) {
        const rw = s / h;
        let cy = y;
        r.forEach((i) => {
          const ih = (i.v * scale) / rw;
          out.push({ ...i, x, y: cy, w: rw, h: ih });
          cy += ih;
        });
        x += rw; w -= rw;
      } else {
        const rh = s / w;
        let cx = x;
        r.forEach((i) => {
          const iw = (i.v * scale) / rh;
          out.push({ ...i, x: cx, y, w: iw, h: rh });
          cx += iw;
        });
        y += rh; h -= rh;
      }
    };

    list.forEach((item) => {
      const side = Math.min(w, h);
      if (!row.length || worst([...row, item], side) <= worst(row, side)) {
        row.push(item);
      } else {
        layoutRow(row);
        row = [item];
      }
    });
    if (row.length) layoutRow(row);
    return out;
  }

  async function loadHeatmap() {
    const box = document.getElementById('fin-heatmap');
    if (!box) return;
    const constituents = HEATMAP[fin().country] || HEATMAP.IN;
    hmQuotes = await window.localMind.finQuotes(constituents.map((c) => c[0]));
    renderHeatmap();
    renderMovers();
    loadTape();
  }

  function renderHeatmap() {
    const box = document.getElementById('fin-heatmap');
    if (!box || !hmQuotes) return;
    const constituents = HEATMAP[fin().country] || HEATMAP.IN;
    const quotes = hmQuotes;

    const W = box.clientWidth || 940, H = 400;
    box.innerHTML = '';
    box.style.height = H + 'px';

    // Group by sector
    const groups = {};
    constituents.forEach(([sym, sector, wgt]) => {
      (groups[sector] = groups[sector] || []).push({ sym, v: wgt, q: quotes[sym] });
    });
    const sectorItems = Object.entries(groups).map(([name, stocks]) => ({
      name, stocks, v: stocks.reduce((s, i) => s + i.v, 0)
    }));

    const HEAD = 18, PAD = 3;
    squarify(sectorItems, { x: 0, y: 0, w: W, h: H }).forEach((sec) => {
      const g = document.createElement('div');
      g.className = 'fin-hm-sector';
      g.style.cssText = `left:${sec.x + 1}px;top:${sec.y + 1}px;width:${sec.w - 2}px;height:${sec.h - 2}px;`;
      const label = document.createElement('div');
      label.className = 'fin-hm-sector-label';
      label.textContent = sec.name;
      g.appendChild(label);
      box.appendChild(g);

      squarify(sec.stocks, { x: 0, y: 0, w: sec.w - 2 - PAD * 2, h: sec.h - 2 - HEAD - PAD }).forEach((t) => {
        const el = document.createElement('div');
        el.className = 'fin-hm-tile';
        el.style.cssText = `left:${PAD + t.x}px;top:${HEAD + t.y}px;width:${Math.max(0, t.w - 1.5)}px;height:${Math.max(0, t.h - 1.5)}px;background:${heatColor(t.q?.changePct)};`;
        const short = t.sym.replace(/\.NS$/, '');
        el.title = `${t.q?.name || short} · ${num(t.q?.price)} (${pct(t.q?.changePct)})`;
        if (t.w > 58 && t.h > 34) el.innerHTML = `<b>${short}</b><span>${pct(t.q?.changePct)}</span>`;
        else if (t.w > 34 && t.h > 16) el.innerHTML = `<b style="font-size:8.5px">${short}</b>`;
        el.addEventListener('click', () => setChartSymbol(t.sym, t.q?.name));
        g.appendChild(el);
      });
    });
  }

  // Top gainers & losers computed from the heatmap universe
  function renderMovers() {
    const box = document.getElementById('fin-movers');
    if (!box || !hmQuotes) return;
    const all = Object.values(hmQuotes).filter((q) => q.changePct != null)
      .sort((a, b) => b.changePct - a.changePct);
    if (all.length < 4) { box.innerHTML = ''; return; }
    const gainers = all.slice(0, 5);
    const losers = all.slice(-5).reverse();

    const card = (q) => `
      <div class="fin-mover news-fade" data-sym="${escapeHtml(q.symbol)}">
        ${logoHtml(q.symbol, 24)}
        <div class="fin-mover-main"><b>${escapeHtml(q.symbol.replace(/\.NS$/, ''))}</b><span>${num(q.price)}</span></div>
        <span class="fin-mover-pct ${cls(q.changePct)}">${pct(q.changePct)}</span>
      </div>`;

    box.innerHTML = `
      <div class="fin-movers-col"><h3>▲ Top Gainers</h3>${gainers.map(card).join('')}</div>
      <div class="fin-movers-col"><h3 class="fin-down">▼ Top Losers</h3>${losers.map(card).join('')}</div>`;
    box.querySelectorAll('.fin-mover').forEach((el) => {
      el.addEventListener('click', () => {
        const q = hmQuotes[el.dataset.sym];
        setChartSymbol(el.dataset.sym, q?.name);
      });
    });
  }

  // Scrolling ticker tape (indices + watchlist)
  async function loadTape() {
    const tape = document.getElementById('fin-tape');
    if (!tape) return;
    const syms = [...country().indices.map((i) => i.s), ...fin().watchlist.slice(0, 8)];
    const quotes = await window.localMind.finQuotes(syms);
    if (!tape.isConnected) return;
    const items = syms.map((s) => quotes[s]).filter(Boolean).map((q) => {
      const short = q.symbol.replace(/\.NS$/, '').replace(/^\^/, '');
      return `<span class="fin-tape-item"><b>${escapeHtml(short)}</b> ${num(q.price)} <em class="${cls(q.changePct)}">${pct(q.changePct)}</em></span>`;
    }).join('');
    if (!items) { tape.innerHTML = ''; return; }
    tape.innerHTML = `<div class="fin-tape-track">${items}${items}</div>`;
  }

  // ── Quotes grids ──
  async function loadQuotesInto(id, defs, { spark }) {
    const grid = document.getElementById(id);
    if (!grid) return;
    const quotes = await window.localMind.finQuotes(defs.map(d => d.s));
    if (!grid.isConnected) return;
    grid.innerHTML = '';
    defs.forEach((d) => {
      const q = quotes[d.s];
      const card = document.createElement('div');
      card.className = 'fin-index-card news-fade';
      card.innerHTML = q ? `
        <div class="fin-index-name">${d.n}</div>
        <div class="fin-index-price">${num(q.price)}</div>
        <div class="fin-index-foot">
          <div class="fin-index-chg ${cls(q.changePct)}">${q.change != null ? num(q.change) : ''} (${pct(q.changePct)})</div>
          ${spark ? `<div class="fin-spark">${FinanceChart.sparkline(q.spark, 68, 24, q.changePct >= 0 ? 'var(--accent)' : '#e05c5c')}</div>` : ''}
        </div>`
        : `<div class="fin-index-name">${d.n}</div><div class="news-empty">n/a</div>`;
      if (q) card.addEventListener('click', () => setChartSymbol(d.s, d.n));
      grid.appendChild(card);
    });
  }

  // ── Chart ──
  // Single choke point for every "user picked a symbol" path (search, watchlist,
  // movers, heatmap, trending, tape). Companies open the full research page;
  // indices / FX / crypto have no company profile, so they stay on this chart.
  function setChartSymbol(symbol, name) {
    if (typeof CompanyPage !== 'undefined' && CompanyPage.isCompany(symbol)) {
      CompanyPage.open(symbol, name);
      return;
    }
    chartSymbol = symbol;
    chartName = name || symbol;
    if (view !== 'overview') { switchView('overview'); return; }
    loadChart();
    pageEl()?.querySelector('.fin-chart-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function loadChart() {
    const box = document.getElementById('fin-chart');
    if (!box) return;
    box.innerHTML = '<div class="news-shimmer" style="height:340px"></div>';
    const d = await window.localMind.finChart(chartSymbol, chartRange);
    if (!box.isConnected) return;
    if (!d || d.error) { box.innerHTML = '<div class="news-empty">No chart data.</div>'; return; }
    chartData = d;
    document.getElementById('fin-chart-name').textContent = d.name || chartName;
    const last = d.price ?? d.c[d.c.length - 1];
    // 1D shows the daily move (vs previous close); every other range shows the
    // return OVER THAT PERIOD (vs the first close in view), clearly labelled —
    // so a green daily index can still correctly show a red 6-month change.
    const vs = d.start || 0;
    const base = chartRange === '1D' ? (d.c[vs - 1] ?? d.c[vs]) : d.c[vs];
    const chg = last - base, chgPct = base ? (chg / base) * 100 : null;
    const rangeLabel = chartRange === '1D' ? 'Today' : chartRange;
    document.getElementById('fin-chart-price').textContent = `${num(last)} ${d.currency || ''}`;
    const chgEl = document.getElementById('fin-chart-chg');
    chgEl.innerHTML = `${chg >= 0 ? '▲' : '▼'} ${num(Math.abs(chg))} (${pct(chgPct)}) <span class="fin-chg-range">· ${rangeLabel}</span>`;
    chgEl.className = cls(chg);
    drawChart();
  }

  function drawChart() {
    const box = document.getElementById('fin-chart');
    if (!box || !chartData) return;
    box.innerHTML = '';
    FinanceChart.render(box, chartData, { type: chartType, ...chartInd });
  }

  // ── Search ──
  function wireSearch(page) {
    const input = page.querySelector('#fin-search');
    const results = page.querySelector('#fin-search-results');
    if (!input) return;
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { results.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        const r = await window.localMind.finSearch(q);
        results.innerHTML = '';
        (r?.quotes || []).forEach((s) => {
          const row = document.createElement('div');
          row.className = 'fin-search-row';
          row.innerHTML = `${logoHtml(s.symbol, 18)}<b>${escapeHtml(s.symbol)}</b><span>${escapeHtml(s.name)}</span><em>${escapeHtml(s.exchange)}</em>`;
          row.addEventListener('click', () => {
            results.innerHTML = '';
            input.value = '';
            setChartSymbol(s.symbol, s.name);
          });
          results.appendChild(row);
        });
      }, 250);
    });
    input.addEventListener('blur', () => setTimeout(() => { results.innerHTML = ''; }, 250));
  }

  // Search-and-select modal for adding to watchlist / portfolio. The user picks
  // the exact ticker from live search results (no blind first-match), and for
  // portfolio enters quantity + avg price (price pre-filled with the live quote).
  function addSymbolFlow(kind) {
    const isPort = kind === 'portfolio';
    let selected = null;

    const ov = document.createElement('div');
    ov.className = 'fin-modal-ov';
    ov.innerHTML = `
      <div class="fin-modal" role="dialog">
        <div class="fin-modal-title">${isPort ? 'Add holding' : 'Add to watchlist'}</div>
        <input id="fm-search" class="fin-modal-input" placeholder="Search company or symbol — e.g. Reliance, AAPL, NIFTY" autocomplete="off" spellcheck="false">
        <div id="fm-results" class="fin-modal-results"></div>
        <div id="fm-selected" class="fin-modal-selected" style="display:none;"></div>
        ${isPort ? `
          <div id="fm-qtycost" class="fin-modal-fields" style="display:none;">
            <label>Quantity<input id="fm-qty" type="number" min="0" step="any" class="fin-modal-input" placeholder="0"></label>
            <label>Avg buy price<input id="fm-cost" type="number" min="0" step="any" class="fin-modal-input" placeholder="0.00"></label>
          </div>` : ''}
        <div class="fin-modal-actions">
          <button id="fm-cancel" class="fin-modal-btn">Cancel</button>
          <button id="fm-add" class="fin-modal-btn primary" disabled>Add</button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    const search = ov.querySelector('#fm-search');
    const results = ov.querySelector('#fm-results');
    const selBox = ov.querySelector('#fm-selected');
    const qtycost = ov.querySelector('#fm-qtycost');
    const addBtn = ov.querySelector('#fm-add');
    const close = () => ov.remove();
    search.focus();

    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      const qtext = search.value.trim();
      if (!qtext) { results.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        const r = await window.localMind.finSearch(qtext);
        if (search.value.trim() !== qtext) return;
        results.innerHTML = '';
        (r?.quotes || []).forEach((s) => {
          const row = document.createElement('div');
          row.className = 'fin-search-row';
          row.innerHTML = `${logoHtml(s.symbol, 20)}<b>${escapeHtml(s.symbol)}</b><span>${escapeHtml(s.name)}</span><em>${escapeHtml(s.exchange)}</em>`;
          row.addEventListener('click', async () => {
            selected = s;
            results.innerHTML = '';
            search.style.display = 'none';
            selBox.style.display = 'flex';
            selBox.innerHTML = `${logoHtml(s.symbol, 26)}<div class="fin-modal-sel-main"><b>${escapeHtml(s.symbol)}</b><span>${escapeHtml(s.name)} · ${escapeHtml(s.exchange)}</span></div><button id="fm-change">Change</button>`;
            selBox.querySelector('#fm-change').addEventListener('click', () => {
              selected = null; addBtn.disabled = true;
              selBox.style.display = 'none'; search.style.display = '';
              if (qtycost) qtycost.style.display = 'none';
              search.value = ''; search.focus();
            });
            addBtn.disabled = false;
            if (isPort) {
              qtycost.style.display = 'grid';
              const q = await window.localMind.finQuotes([s.symbol]);
              const px = q[s.symbol]?.price;
              if (px != null) ov.querySelector('#fm-cost').value = px.toFixed(2);
              ov.querySelector('#fm-qty').focus();
            }
          });
          results.appendChild(row);
        });
        if (!results.children.length) results.innerHTML = '<div class="news-empty" style="padding:10px 12px;">No matching symbols.</div>';
      }, 250);
    });

    const submit = () => {
      if (!selected) return;
      const f = fin();
      if (isPort) {
        const qty = parseFloat(ov.querySelector('#fm-qty').value) || 0;
        const cost = parseFloat(ov.querySelector('#fm-cost').value) || 0;
        if (qty <= 0) { ov.querySelector('#fm-qty').focus(); return; }
        f.portfolio.push({ symbol: selected.symbol, name: selected.name, qty, cost });
        persist(); renderPortfolio();
      } else {
        if (!f.watchlist.includes(selected.symbol)) f.watchlist.push(selected.symbol);
        persist(); renderWatchlist();
      }
      close();
    };

    addBtn.addEventListener('click', submit);
    ov.querySelector('#fm-cancel').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && selected && !addBtn.disabled) submit();
    });
  }

  // ── Watchlist ──
  async function renderWatchlist() {
    const box = document.getElementById('fin-watchlist');
    if (!box) return;
    const f = fin();
    if (!f.watchlist.length) { box.innerHTML = '<div class="news-empty">Empty — add stocks you follow.</div>'; return; }
    box.innerHTML = '<div class="news-shimmer" style="height:60px"></div>';
    const quotes = await window.localMind.finQuotes(f.watchlist);
    if (!box.isConnected) return;
    box.innerHTML = '';
    f.watchlist.forEach((sym) => {
      const q = quotes[sym];
      const row = document.createElement('div');
      row.className = 'fin-row news-fade';
      row.innerHTML = q ? `
        ${logoHtml(sym, 26)}
        <div class="fin-row-main"><b>${escapeHtml(sym.replace(/\.NS$/, ''))}</b><span>${escapeHtml(q.name || '')}</span></div>
        <div class="fin-spark">${FinanceChart.sparkline(q.spark, 70, 22, q.changePct >= 0 ? 'var(--accent)' : '#e05c5c')}</div>
        <div class="fin-row-quote"><div>${num(q.price)}</div><div class="${cls(q.changePct)}">${pct(q.changePct)}</div></div>
        <button class="fin-x" title="Remove">×</button>`
        : `${logoHtml(sym, 26)}<div class="fin-row-main"><b>${escapeHtml(sym)}</b><span class="news-empty">no data</span></div><button class="fin-x">×</button>`;
      row.addEventListener('click', (e) => { if (!e.target.closest('.fin-x')) setChartSymbol(sym, q?.name); });
      row.querySelector('.fin-x').addEventListener('click', (e) => {
        e.stopPropagation();
        f.watchlist = f.watchlist.filter((s) => s !== sym);
        persist(); renderWatchlist();
      });
      box.appendChild(row);
    });
  }

  // ── Portfolio ──
  async function renderPortfolio() {
    const box = document.getElementById('fin-portfolio');
    if (!box) return;
    const f = fin();
    if (!f.portfolio.length) {
      box.innerHTML = '<div class="news-empty">No holdings yet — add what you own to track value, P/L and allocation. Stored locally only.</div>';
      return;
    }
    box.innerHTML = '<div class="news-shimmer" style="height:80px"></div>';
    const quotes = await window.localMind.finQuotes(f.portfolio.map((h) => h.symbol));
    if (!box.isConnected) return;

    // Group holdings by their native currency so totals are meaningful
    // (no FX conversion — a mixed ₹/$ portfolio shows separate ₹ and $ totals).
    const groups = {};
    f.portfolio.forEach((h, idx) => {
      const q = quotes[h.symbol];
      const cur = q?.currency || '—';
      const value = q?.price != null ? q.price * h.qty : null;
      const c = h.cost * h.qty;
      const g = (groups[cur] = groups[cur] || { cur, value: 0, cost: 0, day: 0, rows: [] });
      if (value != null) { g.value += value; g.cost += c; g.day += (q.change || 0) * h.qty; }
      g.rows.push({ ...h, idx, q, value, c });
    });

    box.innerHTML = '';
    const multi = Object.keys(groups).length > 1;
    Object.values(groups).sort((a, b) => b.value - a.value).forEach((g) => {
      const totPL = g.value - g.cost;
      const groupEl = document.createElement('div');
      groupEl.className = 'fin-port-group';
      groupEl.innerHTML = `
        <div class="fin-port-summary news-fade">
          <div><span>Value${multi && g.cur !== '—' ? ' · ' + escapeHtml(g.cur) : ''}</span><b>${money(g.value, g.cur)}</b></div>
          <div><span>Today</span><b class="${cls(g.day)}">${money(g.day, g.cur)}</b></div>
          <div><span>Total P/L</span><b class="${cls(totPL)}">${money(totPL, g.cur)} (${g.cost ? pct((totPL / g.cost) * 100) : '—'})</b></div>
        </div>`;

      g.rows.forEach((r) => {
        const w = g.value ? ((r.value || 0) / g.value) * 100 : 0;
        const pl = r.value != null ? r.value - r.c : null;
        const row = document.createElement('div');
        row.className = 'fin-row news-fade';
        row.innerHTML = `
          ${logoHtml(r.symbol, 26)}
          <div class="fin-row-main"><b>${escapeHtml(r.symbol.replace(/\.NS$/, ''))}</b><span>${r.qty} × ${money(r.cost, g.cur)}</span>
            <div class="fin-alloc"><div style="width:${w.toFixed(1)}%"></div></div></div>
          <div class="fin-row-quote"><div>${money(r.value, g.cur)}</div>
            <div class="${cls(pl)}">${pl != null ? money(pl, g.cur) : ''} ${r.c && pl != null ? '(' + pct((pl / r.c) * 100) + ')' : ''}</div></div>
          <button class="fin-x" title="Remove">×</button>`;
        row.addEventListener('click', (e) => { if (!e.target.closest('.fin-x')) setChartSymbol(r.symbol, r.name); });
        row.querySelector('.fin-x').addEventListener('click', (e) => {
          e.stopPropagation();
          f.portfolio.splice(r.idx, 1);
          persist(); renderPortfolio();
        });
        groupEl.appendChild(row);
      });
      box.appendChild(groupEl);
    });
  }

  // ── Sectors ──
  async function loadSectors() {
    const box = document.getElementById('fin-sectors');
    if (!box) return;
    const defs = country().sectors;
    const quotes = await window.localMind.finQuotes(defs.map((s) => s.s));
    if (!box.isConnected) return;
    const rows = defs.map((s) => ({ ...s, q: quotes[s.s] })).filter((r) => r.q?.changePct != null)
      .sort((a, b) => b.q.changePct - a.q.changePct);
    if (!rows.length) { box.innerHTML = '<div class="news-empty">Unavailable right now.</div>'; return; }
    const maxAbs = Math.max(...rows.map((r) => Math.abs(r.q.changePct)), 0.5);
    box.innerHTML = '';
    rows.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'fin-sector-row news-fade';
      const w = (Math.abs(r.q.changePct) / maxAbs) * 100;
      row.innerHTML = `
        <span class="fin-sector-name">${r.n}</span>
        <div class="fin-sector-bar"><div class="${r.q.changePct >= 0 ? 'pos' : 'neg'}" style="width:${w.toFixed(0)}%"></div></div>
        <span class="${cls(r.q.changePct)}">${pct(r.q.changePct)}</span>`;
      row.addEventListener('click', () => setChartSymbol(r.s, r.n));
      box.appendChild(row);
    });
  }

  // ── Trending ──
  async function loadTrending() {
    const box = document.getElementById('fin-trending');
    if (!box) return;
    const r = await window.localMind.finTrending();
    if (!box.isConnected) return;
    box.innerHTML = '';
    (r?.quotes || []).forEach((q) => {
      const chip = document.createElement('div');
      chip.className = 'news-trend-chip news-fade';
      chip.innerHTML = `${logoHtml(q.symbol, 16)}<span class="news-trend-topic"><b>${escapeHtml(q.symbol)}</b> ${num(q.price)}</span><span class="${cls(q.changePct)}" style="font-size:11px">${pct(q.changePct)}</span>`;
      chip.addEventListener('click', () => setChartSymbol(q.symbol, q.name));
      box.appendChild(chip);
    });
    if (!box.children.length) box.innerHTML = '<div class="news-empty">Unavailable right now.</div>';
  }

  // ── News ──
  async function loadNews() {
    const box = document.getElementById('fin-news');
    if (!box) return;
    const f = fin();
    const industries = f.industries || [];
    const companies = f.portfolio.map((h) => h.name).filter(Boolean).slice(0, 4);
    const head = document.getElementById('fin-news-head');
    if (head) head.textContent = industries.length ? `Market News · ${industries.join(' · ')}` : 'Market News';
    box.innerHTML = '<div class="news-shimmer" style="height:70px"></div>';
    const r = await window.localMind.finNews({ industries, companies });
    if (!box.isConnected) return;
    box.innerHTML = '';
    const shown = (r?.articles || []).slice(0, 18);
    shown.forEach((a) => {
      const card = document.createElement('div');
      card.className = 'news-row news-fade';
      card.innerHTML = `
        ${a.image ? `<div class="news-row-img" style="background-image:url('${a.image.replace(/'/g, '%27')}')"></div>` : ''}
        <div class="news-row-main">
          <div class="news-row-title">${escapeHtml(a.title)}</div>
          <div class="news-row-meta">
            ${a.tag && a.tag !== 'Markets' ? `<span class="fin-tag">${escapeHtml(a.tag)}</span>` : ''}
            <span class="news-source">${escapeHtml(a.source || '')}</span><span>${relTime(a.publishedAt)}</span>
          </div>
        </div>`;
      card.addEventListener('click', () => openUrl(a.url));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        newsMenu(e.clientX, e.clientY, a);
      });
      card._article = a;
      box.appendChild(card);
    });
    if (!box.children.length) {
      box.innerHTML = '<div class="news-empty">No news right now.</div>';
      return;
    }
    backfillImages(box, shown);
  }

  /**
   * Only the first few stories arrive with artwork (fetching all of them would
   * stall first paint), so ask for the rest once the grid is on screen and fade
   * them in as they land.
   */
  async function backfillImages(box, articles) {
    const missing = articles.filter((a) => !a.image && a.url);
    if (!missing.length || !window.localMind?.finNewsImages) return;
    let res;
    try {
      // Titles let the backend find the same story at another outlet when this
      // publisher ships no og:image.
      res = await window.localMind.finNewsImages(missing.map((a) => ({ url: a.url, title: a.title })));
    } catch { return; }
    if (!box.isConnected) return;

    const images = res?.images || {};
    [...box.children].forEach((card) => {
      const a = card._article;
      const hit = a && !a.image && images[a.url];
      if (!hit || card.querySelector('.news-row-img')) return;
      const src = typeof hit === 'string' ? hit : hit.src;
      const isLogo = typeof hit === 'object' && hit.kind === 'logo';
      a.image = src;
      const el = document.createElement('div');
      el.className = `news-row-img news-fade${isLogo ? ' is-logo' : ''}`;
      el.style.backgroundImage = `url('${src.replace(/'/g, '%27')}')`;
      card.insertBefore(el, card.firstElementChild);
    });
  }

  /** Right-click a story: summarize it, or read it in the in-app reader. */
  function newsMenu(x, y, article) {
    document.querySelector('.ntp-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'ntp-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const items = [
      { label: 'Summarize with AI', action: () => summarizeArticle(article) },
      { label: 'Read Full Article', action: () => {
        if (typeof StoryPage !== 'undefined') StoryPage.open(article);
        else openUrl(article.url);
      }},
      { sep: true },
      { label: 'Open in New Tab', action: () => TabManager.createTab(article.url, true) },
      { label: 'Copy Link', action: () => navigator.clipboard?.writeText(article.url) }
    ];

    items.forEach((it) => {
      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'ntp-menu-sep';
        menu.appendChild(s);
        return;
      }
      const el = document.createElement('div');
      el.className = 'ntp-menu-item';
      el.textContent = it.label;
      el.addEventListener('click', () => { menu.remove(); it.action(); });
      menu.appendChild(el);
    });

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (rect.right > innerWidth) menu.style.left = `${innerWidth - rect.width - 8}px`;
    if (rect.bottom > innerHeight) menu.style.top = `${innerHeight - rect.height - 8}px`;

    const close = (e) => {
      if (e.type === 'mousedown' && menu.contains(e.target)) return;
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      menu.remove();
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
    setTimeout(() => {
      document.addEventListener('mousedown', close);
      document.addEventListener('keydown', close);
    }, 10);
  }

  function summarizeArticle(article) {
    EventBus.emit('ai-command', {
      type: 'summarize',
      query: `Summarize this news article in 4-5 concise bullet points, then note why it matters for investors.\n\nHeadline: ${article.title}\nSource: ${article.source || 'unknown'}\nURL: ${article.url}`
    });
  }

  function relTime(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d)) return '';
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 60) return `${Math.max(1, mins)}m ago`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  // ── Focused view: industry hub ──
  async function loadIndustryHub() {
    const hub = document.getElementById('fin-industry-hub');
    if (!hub) return;
    const industries = fin().industries || [];
    if (!industries.length) {
      hub.innerHTML = `<h2>Focused</h2>
        <div class="news-empty">Pick the industries you follow in Settings → Finance, and this view becomes a live intelligence hub for each sector — earnings, deals, leadership moves, regulation, analyst calls and more.</div>`;
      return;
    }
    if (!activeIndustry || !industries.includes(activeIndustry)) activeIndustry = industries[0];

    hub.innerHTML = `
      <div class="fin-pills fin-ind-tabs" id="fin-ind-tabs">
        ${industries.map(i => `<button data-ind="${escapeHtml(i)}" class="${i === activeIndustry ? 'active' : ''}">${escapeHtml(i)}</button>`).join('')}
      </div>
      <div id="fin-ind-leaders" class="fin-index-grid" style="grid-template-columns:repeat(3,1fr);margin-top:14px;"></div>
      <div id="fin-ind-brief"></div>
      <div id="fin-ind-cats" class="fin-ind-cats"><div class="news-shimmer" style="height:90px"></div></div>`;

    hub.querySelector('#fin-ind-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-ind]');
      if (!b) return;
      activeIndustry = b.dataset.ind;
      loadIndustryHub();
    });

    renderIndustryLeaders(activeIndustry);
    renderIndustryFeed(activeIndustry);
  }

  async function renderIndustryLeaders(industry) {
    const grid = document.getElementById('fin-ind-leaders');
    if (!grid) return;
    const tickers = INDUSTRY_TICKERS[industry];
    if (!tickers) { grid.innerHTML = ''; return; }
    grid.innerHTML = '<div class="news-shimmer" style="height:70px"></div>';
    const quotes = await window.localMind.finQuotes(tickers);
    if (industry !== activeIndustry || !grid.isConnected) return;
    grid.innerHTML = '';
    tickers.forEach((s) => {
      const q = quotes[s];
      if (!q) return;
      const card = document.createElement('div');
      card.className = 'fin-index-card news-fade';
      card.innerHTML = `
        <div class="fin-index-name" style="display:flex;align-items:center;gap:6px;">${logoHtml(s, 16)}${escapeHtml(q.name || s)}</div>
        <div class="fin-index-price">${num(q.price)}</div>
        <div class="fin-index-foot">
          <div class="fin-index-chg ${cls(q.changePct)}">${pct(q.changePct)}</div>
          <div class="fin-spark">${FinanceChart.sparkline(q.spark, 68, 22, q.changePct >= 0 ? 'var(--accent)' : '#e05c5c')}</div>
        </div>`;
      card.addEventListener('click', () => setChartSymbol(s, q.name));
      grid.appendChild(card);
    });
  }

  async function renderIndustryFeed(industry) {
    const box = document.getElementById('fin-ind-cats');
    if (!box) return;
    const res = await window.localMind.finIndustry(industry);
    if (industry !== activeIndustry || !box.isConnected) return;
    if (!res || res.error || !res.categories?.length) {
      box.innerHTML = '<div class="news-empty">No coverage found right now.</div>';
      return;
    }

    box.innerHTML = '';
    res.categories.forEach((cat) => {
      const col = document.createElement('div');
      col.className = 'fin-ind-cat news-fade';
      col.innerHTML = `<h3>${escapeHtml(cat.tag)}</h3>`;
      cat.articles.slice(0, 5).forEach((a) => {
        const row = document.createElement('div');
        row.className = 'news-row';
        row.innerHTML = `
          <div class="news-row-main">
            <div class="news-row-title">${escapeHtml(a.title)}</div>
            <div class="news-row-meta">
              <span class="news-source">${escapeHtml(a.source || '')}</span><span>${relTime(a.publishedAt)}</span>
              <button class="news-sum-btn" title="AI: why this matters">✦ Why it matters</button>
            </div>
            <div class="news-sum" style="display:none;"></div>
          </div>`;
        row.addEventListener('click', (e) => {
          if (e.target.closest('.news-sum-btn') || e.target.closest('.news-sum')) return;
          openUrl(a.url);
        });
        row.querySelector('.news-sum-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          whyItMatters(row.querySelector('.news-sum'), a, industry);
        });
        col.appendChild(row);
      });
      box.appendChild(col);
    });

    runIndustryBrief(industry, res.categories);
  }

  async function whyItMatters(el, article, industry) {
    if (!el) return;
    if (el.dataset.done) { el.style.display = el.style.display === 'none' ? 'block' : 'none'; return; }
    const model = window.mindSettings?.news?.model;
    el.style.display = 'block';
    if (!model) {
      el.innerHTML = '<span class="news-sum-note">Choose an AI model in Settings → News to enable this.</span>';
      el.dataset.done = '1';
      return;
    }
    el.innerHTML = '<span class="news-sum-note news-sum-loading">✦ Analyzing…</span>';
    try {
      const art = await window.localMind.newsArticle(article.url);
      const result = await window.localMind.chat([
        { role: 'system', content: `You are a sector analyst covering the ${industry} industry. In 2-3 plain sentences, explain why the given development matters for the ${industry} sector and its likely impact (companies affected, direction). No preamble, no markdown.` },
        { role: 'user', content: `Headline: ${article.title}\n\n${art?.text ? `Article:\n${art.text.slice(0, 2500)}` : '(Article text unavailable — reason from the headline.)'}` }
      ], model, { quiet: true });
      const text = typeof result === 'string' ? result : (result?.content || result?.message?.content || '');
      el.innerHTML = text && !result?.error
        ? `<div class="news-sum-text">${escapeHtml(text.trim())}</div>`
        : '<span class="news-sum-note">Analysis failed — open the article instead.</span>';
      el.dataset.done = '1';
    } catch {
      el.innerHTML = '<span class="news-sum-note">Analysis failed.</span>';
      el.dataset.done = '1';
    }
  }

  async function runIndustryBrief(industry, categories) {
    const box = document.getElementById('fin-ind-brief');
    if (!box) return;
    const model = window.mindSettings?.news?.model;
    if (!model || window.mindSettings?.news?.briefing === false) { box.innerHTML = ''; return; }

    box.innerHTML = `<div class="news-brief-card news-fade"><div class="news-brief-head">✦ ${escapeHtml(industry)} Sector Brief <span class="news-brief-model">${escapeHtml(model)}</span></div><div class="news-brief-body news-loading">Analyzing sector developments…</div></div>`;
    const headlines = categories.flatMap((c) => c.articles.slice(0, 3).map((a) => `[${c.tag}] ${a.title} (${a.source})`)).slice(0, 22).join('\n');
    try {
      const result = await window.localMind.chat([
        { role: 'system', content: `You are a ${industry}-sector analyst. Reply with exactly 4 bullet points (each starting with "• "), one line each, no preamble. Each bullet: the most important development and WHY it matters for the ${industry} industry.` },
        { role: 'user', content: `Latest ${industry} developments:\n${headlines}` }
      ], model, { quiet: true });
      if (industry !== activeIndustry) return;
      const text = typeof result === 'string' ? result : (result?.content || result?.message?.content || '');
      const body = box.querySelector('.news-brief-body');
      if (!text || result?.error) { box.innerHTML = ''; return; }
      body.classList.remove('news-loading');
      body.innerHTML = text.split('\n').filter((l) => l.trim()).slice(0, 5)
        .map((l) => `<div class="news-brief-line">${escapeHtml(l.trim())}</div>`).join('');
    } catch {
      box.innerHTML = '';
    }
  }

  return { init, show, hide, toggle };
})();
