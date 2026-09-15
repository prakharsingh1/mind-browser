// =============================================================================
// Local Mind Browser — Finance Chart
// =============================================================================
// Dependency-free SVG price chart: line/area or candlesticks, volume, SMA20/50,
// Bollinger bands, and optional RSI / MACD subpanels, with a hover crosshair.

const FinanceChart = (() => {
  // ── Indicator math ──
  const sma = (arr, n) => arr.map((_, i) => {
    if (i < n - 1) return null;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += arr[j];
    return s / n;
  });

  const ema = (arr, n) => {
    const k = 2 / (n + 1);
    const out = [];
    let prev = arr[0];
    arr.forEach((v, i) => { prev = i === 0 ? v : v * k + prev * (1 - k); out.push(prev); });
    return out;
  };

  const bollinger = (arr, n = 20, mult = 2) => {
    const mid = sma(arr, n);
    const up = [], lo = [];
    arr.forEach((_, i) => {
      if (i < n - 1) { up.push(null); lo.push(null); return; }
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += Math.pow(arr[j] - mid[i], 2);
      const sd = Math.sqrt(s / n);
      up.push(mid[i] + mult * sd);
      lo.push(mid[i] - mult * sd);
    });
    return { mid, up, lo };
  };

  const rsi = (arr, n = 14) => {
    const out = [null];
    let gain = 0, loss = 0;
    for (let i = 1; i < arr.length; i++) {
      const d = arr[i] - arr[i - 1];
      const g = Math.max(d, 0), l = Math.max(-d, 0);
      if (i <= n) { gain += g; loss += l; out.push(null); if (i === n) { out[i] = 100 - 100 / (1 + (gain / n) / ((loss / n) || 1e-9)); } continue; }
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out.push(100 - 100 / (1 + gain / (loss || 1e-9)));
    }
    return out;
  };

  const macd = (arr) => {
    const line = ema(arr, 12).map((v, i) => v - ema(arr, 26)[i]);
    const signal = ema(line, 9);
    return { line, signal, hist: line.map((v, i) => v - signal[i]) };
  };

  // ── Rendering helpers ──
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  };

  function pathFrom(points) {
    let d = '';
    points.forEach((p, i) => { if (p) d += (d ? ' L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); });
    return d;
  }

  const fmt = (n) => {
    if (n == null || isNaN(n)) return '—';
    if (Math.abs(n) >= 1e5) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 10 ? 3 : 2 });
  };

  /**
   * Render a chart into `container`.
   * data: { t[], o[], h[], l[], c[], v[], prevClose }
   * opts: { type: 'line'|'candle', sma20, sma50, bb, rsi, macd }
   */
  function render(container, data, opts = {}) {
    container.innerHTML = '';
    const W = container.clientWidth || 860;
    const subCount = (opts.rsi ? 1 : 0) + (opts.macd ? 1 : 0);
    const priceH = 300, volH = 46, subH = 74, gap = 8, padR = 62, padL = 8;
    const H = priceH + volH + subCount * (subH + gap) + 24;

    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'fin-chart-svg' });
    const n = data.c.length;
    if (!n) { container.textContent = 'No data'; return; }

    // `start` = first VISIBLE bar. Bars before it are warm-up history: indicators
    // are computed over the full series (so they're valid at the left edge) but
    // only the [start, n) window is painted.
    const start = Math.max(0, Math.min(data.start || 0, n - 2));
    const visN = n - start;
    const xs = (i) => padL + ((i - start) / Math.max(1, visN - 1)) * (W - padL - padR);

    // Price scale over the VISIBLE window (include bands if shown)
    let lo = Math.min(...data.l.slice(start)), hi = Math.max(...data.h.slice(start));
    let bands = null;
    if (opts.bb) {
      bands = bollinger(data.c);
      const bu = bands.up.slice(start).filter(Boolean), bl = bands.lo.slice(start).filter(Boolean);
      if (bu.length) { hi = Math.max(hi, ...bu); lo = Math.min(lo, ...bl); }
    }
    const span = (hi - lo) || 1;
    hi += span * 0.04; lo -= span * 0.04;
    const ys = (v) => 4 + (1 - (v - lo) / (hi - lo)) * (priceH - 8);

    const up = data.c[n - 1] >= (data.prevClose ?? data.c[start]);
    const upC = 'var(--accent)', downC = '#e05c5c';
    const mainC = up ? upC : downC;

    // Grid + price labels
    for (let g = 0; g <= 4; g++) {
      const val = lo + ((hi - lo) * g) / 4;
      const y = ys(val);
      svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'fin-grid' }));
      const t = el('text', { x: W - padR + 6, y: y + 3, class: 'fin-axis' });
      t.textContent = fmt(val);
      svg.appendChild(t);
    }

    // Bollinger fill
    if (opts.bb && bands) {
      const upPts = bands.up.map((v, i) => (v == null || i < start) ? null : [xs(i), ys(v)]);
      const loPts = bands.lo.map((v, i) => (v == null || i < start) ? null : [xs(i), ys(v)]).filter(Boolean).reverse();
      const dUp = pathFrom(upPts);
      if (dUp && loPts.length) {
        const dLo = loPts.map((p, i) => (i ? 'L' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
        svg.appendChild(el('path', { d: dUp + ' ' + dLo + ' Z', class: 'fin-bb-fill' }));
        svg.appendChild(el('path', { d: dUp, class: 'fin-bb-line' }));
        svg.appendChild(el('path', { d: pathFrom(bands.lo.map((v, i) => (v == null || i < start) ? null : [xs(i), ys(v)])), class: 'fin-bb-line' }));
      }
    }

    // Price area fill (line mode) — sits behind the indicators
    if (opts.type !== 'candle') {
      const d = pathFrom(data.c.map((v, i) => i < start ? null : [xs(i), ys(v)]));
      svg.appendChild(el('path', { d: `${d} L ${xs(n - 1)} ${priceH} L ${xs(start)} ${priceH} Z`, fill: up ? 'rgba(43,212,115,0.09)' : 'rgba(224,92,92,0.07)', stroke: 'none' }));
    }

    // Previous close reference
    if (data.prevClose != null && data.prevClose > lo && data.prevClose < hi) {
      svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: ys(data.prevClose), y2: ys(data.prevClose), class: 'fin-prevclose' }));
    }

    // SMAs (under the price line)
    [[opts.sma20, 20, '#e0b45c'], [opts.sma50, 50, '#a78bfa']].forEach(([on, len, col]) => {
      if (!on || n < len) return;
      const s = sma(data.c, len);
      svg.appendChild(el('path', { d: pathFrom(s.map((v, i) => (v == null || i < start) ? null : [xs(i), ys(v)])), fill: 'none', stroke: col, 'stroke-width': 1.1, opacity: 0.9 }));
    });

    // Price series ON TOP so it stays readable over every indicator
    if (opts.type === 'candle' && visN <= 260) {
      const cw = Math.max(1.5, ((W - padL - padR) / visN) * 0.6);
      for (let i = start; i < n; i++) {
        const x = xs(i), o = ys(data.o[i]), c = ys(data.c[i]), h = ys(data.h[i]), l = ys(data.l[i]);
        const col = data.c[i] >= data.o[i] ? upC : downC;
        svg.appendChild(el('line', { x1: x, x2: x, y1: h, y2: l, stroke: col, 'stroke-width': 1 }));
        svg.appendChild(el('rect', { x: x - cw / 2, y: Math.min(o, c), width: cw, height: Math.max(1, Math.abs(o - c)), fill: col, rx: 0.5 }));
      }
    } else {
      svg.appendChild(el('path', { d: pathFrom(data.c.map((v, i) => i < start ? null : [xs(i), ys(v)])), class: 'fin-price-line', stroke: mainC }));
    }

    // Volume
    const vTop = priceH + 6;
    const vMax = Math.max(...data.v.slice(start), 1);
    for (let i = start; i < n; i++) {
      const vh = (data.v[i] / vMax) * volH;
      svg.appendChild(el('rect', {
        x: xs(i) - 1, y: vTop + volH - vh, width: 2, height: Math.max(0.5, vh),
        fill: data.c[i] >= data.o[i] ? 'rgba(43,212,115,0.4)' : 'rgba(224,92,92,0.4)'
      }));
    }

    // Subpanels
    let subTop = vTop + volH + gap;
    const subPanel = (label) => {
      svg.appendChild(el('rect', { x: padL, y: subTop, width: W - padL - padR, height: subH, class: 'fin-sub-bg' }));
      const t = el('text', { x: padL + 6, y: subTop + 12, class: 'fin-axis' });
      t.textContent = label;
      svg.appendChild(t);
    };

    if (opts.rsi) {
      subPanel('RSI 14');
      const r = rsi(data.c);
      const ry = (v) => subTop + 4 + (1 - v / 100) * (subH - 8);
      [30, 70].forEach((lvl) => svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: ry(lvl), y2: ry(lvl), class: 'fin-grid' })));
      svg.appendChild(el('path', { d: pathFrom(r.map((v, i) => (v == null || i < start) ? null : [xs(i), ry(v)])), fill: 'none', stroke: '#5b9dd9', 'stroke-width': 1.2 }));
      subTop += subH + gap;
    }

    if (opts.macd) {
      subPanel('MACD 12·26·9');
      const m = macd(data.c);
      const all = [...m.line.slice(start), ...m.signal.slice(start), ...m.hist.slice(start)];
      const mLo = Math.min(...all), mHi = Math.max(...all);
      const my = (v) => subTop + 4 + (1 - (v - mLo) / ((mHi - mLo) || 1)) * (subH - 8);
      for (let i = start; i < n; i++) {
        svg.appendChild(el('rect', {
          x: xs(i) - 1, y: Math.min(my(0), my(m.hist[i])), width: 2,
          height: Math.max(0.5, Math.abs(my(0) - my(m.hist[i]))),
          fill: m.hist[i] >= 0 ? 'rgba(43,212,115,0.45)' : 'rgba(224,92,92,0.45)'
        }));
      }
      svg.appendChild(el('path', { d: pathFrom(m.line.map((v, i) => i < start ? null : [xs(i), my(v)])), fill: 'none', stroke: '#5b9dd9', 'stroke-width': 1.2 }));
      svg.appendChild(el('path', { d: pathFrom(m.signal.map((v, i) => i < start ? null : [xs(i), my(v)])), fill: 'none', stroke: '#e0b45c', 'stroke-width': 1.2 }));
      subTop += subH + gap;
    }

    // ── Hover crosshair + drag-to-select a range ──
    const idxAt = (clientX) => {
      const r = svg.getBoundingClientRect();
      const i = start + Math.round((((clientX - r.left) - padL) / (W - padL - padR)) * (visN - 1));
      return Math.max(start, Math.min(n - 1, i));
    };
    // Bars are intraday when consecutive stamps are less than a day apart.
    const intraday = n > 1 && (data.t[n - 1] - data.t[n - 2]) < 86400;
    const stamp = (i) => {
      const d = new Date(data.t[i] * 1000);
      return intraday
        ? d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
        : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    };

    // Shaded band goes behind the series; edge markers go on top.
    const band = el('rect', { y: 0, height: priceH, class: 'fin-sel-band', visibility: 'hidden' });
    svg.insertBefore(band, svg.firstChild);
    const edges = [0, 1].map(() => {
      const line = el('line', { y1: 0, y2: priceH, class: 'fin-sel-line', visibility: 'hidden' });
      const dot = el('circle', { r: 4, class: 'fin-sel-dot', visibility: 'hidden' });
      svg.appendChild(line); svg.appendChild(dot);
      return { line, dot };
    });

    const cross = el('line', { y1: 0, y2: priceH, class: 'fin-cross', visibility: 'hidden' });
    svg.appendChild(cross);
    container.style.position = 'relative';
    const tip = document.createElement('div');
    tip.className = 'fin-tip';
    tip.style.display = 'none';
    container.appendChild(tip);
    const selTip = document.createElement('div');
    selTip.className = 'fin-sel-tip';
    selTip.style.display = 'none';
    container.appendChild(selTip);

    let anchor = null;  // drag origin index, null when not dragging
    let sel = null;     // [a, b] once the drag actually spans >1 bar

    const clearSel = () => {
      sel = null;
      band.setAttribute('visibility', 'hidden');
      edges.forEach(({ line, dot }) => { line.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
      selTip.style.display = 'none';
    };

    const drawSel = () => {
      const [a, b] = sel;
      const xa = xs(a), xb = xs(b);
      band.setAttribute('x', Math.min(xa, xb));
      band.setAttribute('width', Math.max(1, Math.abs(xb - xa)));
      band.setAttribute('visibility', 'visible');

      // Change always reads left→right in time, regardless of drag direction.
      const [i0, i1] = a <= b ? [a, b] : [b, a];
      const from = data.c[i0], to = data.c[i1];
      const chg = to - from, chgPct = from ? (chg / from) * 100 : 0;
      const tone = chg >= 0 ? 'fin-up' : 'fin-down';
      const sign = chg >= 0 ? '+' : '-';

      [a, b].forEach((i, k) => {
        const { line, dot } = edges[k];
        line.setAttribute('x1', xs(i)); line.setAttribute('x2', xs(i));
        line.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', xs(i)); dot.setAttribute('cy', ys(data.c[i]));
        dot.setAttribute('class', `fin-sel-dot ${tone}`);
        dot.setAttribute('visibility', 'visible');
      });

      const vols = data.v.slice(i0, i1 + 1);
      selTip.innerHTML = `<div class="fin-sel-chg ${tone}">${sign}${fmt(Math.abs(chg))} (${sign}${Math.abs(chgPct).toFixed(2)}%)</div>
        <div class="fin-sel-meta">${stamp(i0)} - ${stamp(i1)}</div>
        <div class="fin-sel-meta">Volume: ${abbr(Math.min(...vols))} - ${abbr(Math.max(...vols))}</div>`;
      selTip.style.display = 'block';
      selTip.style.left = Math.max(0, Math.min(Math.min(xa, xb), W - 250)) + 'px';
    };

    // Pointer capture keeps the drag alive outside the svg without window
    // listeners that would outlive this render.
    svg.addEventListener('pointerdown', (evt) => {
      evt.preventDefault();
      try { svg.setPointerCapture(evt.pointerId); } catch { /* not captureable */ }
      clearSel();
      anchor = idxAt(evt.clientX);
    });
    svg.addEventListener('pointerup', (evt) => {
      anchor = null;
      try { svg.releasePointerCapture(evt.pointerId); } catch { /* already released */ }
    });

    svg.addEventListener('pointermove', (evt) => {
      const x = evt.clientX - svg.getBoundingClientRect().left;
      const i = idxAt(evt.clientX);
      if (anchor != null) {                       // dragging out a selection
        if (i !== anchor) { sel = [anchor, i]; drawSel(); }
        cross.setAttribute('visibility', 'hidden');
        tip.style.display = 'none';
        return;
      }
      if (x < padL || x > W - padR) { cross.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; return; }
      cross.setAttribute('x1', xs(i)); cross.setAttribute('x2', xs(i));
      cross.setAttribute('visibility', 'visible');
      if (sel) { tip.style.display = 'none'; return; }  // selection box owns the readout
      tip.innerHTML = `<b>${stamp(i)}</b>  O ${fmt(data.o[i])}  H ${fmt(data.h[i])}  L ${fmt(data.l[i])}  C <b>${fmt(data.c[i])}</b>  Vol ${abbr(data.v[i])}`;
      tip.style.display = 'block';
      tip.style.left = Math.min(x + 12, W - 320) + 'px';
    });
    svg.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });

    container.appendChild(svg);
  }

  const abbr = (x) => {
    if (x == null) return '—';
    if (x >= 1e9) return (x / 1e9).toFixed(1) + 'B';
    if (x >= 1e6) return (x / 1e6).toFixed(1) + 'M';
    if (x >= 1e3) return (x / 1e3).toFixed(1) + 'K';
    return String(Math.round(x));
  };

  // Tiny sparkline used in index/watchlist cards
  function sparkline(values, w = 90, h = 28, color = 'var(--accent)') {
    if (!values || values.length < 2) return '';
    const lo = Math.min(...values), hi = Math.max(...values);
    const pts = values.map((v, i) =>
      `${((i / (values.length - 1)) * w).toFixed(1)},${(2 + (1 - (v - lo) / ((hi - lo) || 1)) * (h - 4)).toFixed(1)}`).join(' ');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.4"/></svg>`;
  }

  return { render, sparkline };
})();
