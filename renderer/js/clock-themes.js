// =============================================================================
// Local Mind Browser — Clock Themes
// =============================================================================
// A small registry of self-contained clock faces. Every theme renders inside a
// fixed 160×160 coordinate box and is scaled to fit its host, so the same code
// drives both the New Tab widget and the settings Cover Flow previews.
//
// A theme is { id, name, render() -> html, tick(rootEl, parts) }.
// `parts` is produced by timeParts() and carries pre-computed hand angles and
// padded digit strings so individual themes stay tiny.

const ClockThemes = (() => {
  // ── 7-segment digit rendering ──
  //  aaa
  // f   b
  //  ggg
  // e   c
  //  ddd
  const SEG = {
    '0': 'abcdef', '1': 'bc',   '2': 'abged', '3': 'abgcd', '4': 'fgbc',
    '5': 'afgcd',  '6': 'afgecd','7': 'abc',   '8': 'abcdefg','9': 'abcdfg'
  };
  function sevenSeg(ch) {
    const on = SEG[ch] || '';
    return `<span class="ct-seg">` +
      ['a', 'b', 'c', 'd', 'e', 'f', 'g']
        .map(s => `<i class="ct-s ct-s-${s}${on.includes(s) ? ' on' : ''}"></i>`)
        .join('') +
      `</span>`;
  }
  const segNumber = str => str.split('').map(sevenSeg).join('');

  // ── Analog hand positioning (shared) ──
  function setHands(root, p) {
    const h = root.querySelector('.ct-hour');
    const m = root.querySelector('.ct-minute');
    const s = root.querySelector('.ct-second');
    if (h) h.style.transform = `translateX(-50%) rotate(${p.hDeg}deg)`;
    if (m) m.style.transform = `translateX(-50%) rotate(${p.mDeg}deg)`;
    if (s) s.style.transform = `translateX(-50%) rotate(${p.sDeg}deg)`;
  }

  // Build 12 clock numbers positioned around a circle (radius %, from center).
  function clockNumbers(radius) {
    let out = '';
    for (let n = 1; n <= 12; n++) {
      const ang = (n * 30 - 90) * Math.PI / 180;
      const x = 50 + radius * Math.cos(ang);
      const y = 50 + radius * Math.sin(ang);
      out += `<span class="ct-num" style="left:${x}%;top:${y}%">${n}</span>`;
    }
    return out;
  }

  // 60 tick marks around a circle.
  function clockTicks() {
    let out = '';
    for (let i = 0; i < 60; i++) {
      out += `<i class="ct-tick${i % 5 === 0 ? ' major' : ''}" style="transform:translateX(-50%) rotate(${i * 6}deg)"></i>`;
    }
    return out;
  }

  // ── Themes ──
  const THEMES = [
    {
      id: 'minimal', name: 'Minimal',
      render() {
        return `<div class="ct ct-minimal">
          <div class="ct-face">
            ${clockTicks()}
            <div class="ct-hand ct-hour"></div>
            <div class="ct-hand ct-minute"></div>
            <div class="ct-hand ct-second"></div>
            <div class="ct-cap"></div>
          </div>
        </div>`;
      },
      tick(root, p) { setHands(root, p); }
    },

    {
      id: 'digital', name: 'Digital',
      render() {
        return `<div class="ct ct-digital">
          <div class="ct-dig-time"><span class="ct-dig-hh">00</span><span class="ct-colon">:</span><span class="ct-dig-mm">00</span></div>
          <div class="ct-dig-sub"><span class="ct-dig-ampm">AM</span><span class="ct-dig-sec">00</span></div>
        </div>`;
      },
      tick(root, p) {
        root.querySelector('.ct-dig-hh').textContent = p.h12;
        root.querySelector('.ct-dig-mm').textContent = p.m;
        root.querySelector('.ct-dig-ampm').textContent = p.ampm;
        root.querySelector('.ct-dig-sec').textContent = p.s;
      }
    },

    {
      id: 'lcd', name: 'LCD',
      render() {
        return `<div class="ct ct-lcd">
          <div class="ct-lcd-panel">
            <div class="ct-lcd-side">
              <span class="ct-lcd-am">AM</span>
              <span class="ct-lcd-pm">PM</span>
            </div>
            <div class="ct-lcd-digits">
              <span class="ct-lcd-hh"></span>
              <span class="ct-lcd-colon"><i></i><i></i></span>
              <span class="ct-lcd-mm"></span>
            </div>
            <div class="ct-lcd-bell">🔔</div>
          </div>
        </div>`;
      },
      tick(root, p) {
        root.querySelector('.ct-lcd-hh').innerHTML = segNumber(p.h12);
        root.querySelector('.ct-lcd-mm').innerHTML = segNumber(p.m);
        root.querySelector('.ct-lcd-am').classList.toggle('on', p.ampm === 'AM');
        root.querySelector('.ct-lcd-pm').classList.toggle('on', p.ampm === 'PM');
      }
    },

    {
      id: 'alarm', name: 'Alarm',
      render() {
        return `<div class="ct ct-alarm">
          <div class="ct-alarm-bell"></div>
          <div class="ct-face">
            ${clockTicks()}
            ${clockNumbers(29)}
            <div class="ct-hand ct-hour"></div>
            <div class="ct-hand ct-minute"></div>
            <div class="ct-hand ct-second"></div>
            <div class="ct-cap"></div>
          </div>
        </div>`;
      },
      tick(root, p) { setHands(root, p); }
    },

    {
      id: 'flip', name: 'Flip',
      render() {
        return `<div class="ct ct-flip">
          <div class="ct-flip-cards">
            <div class="ct-flip-card ct-flip-hh"><span class="ct-flip-line"></span><span class="ct-flip-val">6</span></div>
            <div class="ct-flip-card ct-flip-mm"><span class="ct-flip-line"></span><span class="ct-flip-val">20</span></div>
          </div>
          <div class="ct-flip-foot">
            <div class="ct-flip-speaker"></div>
            <div class="ct-flip-ampm"><span class="ct-flip-am">AM</span><span class="ct-flip-pm">PM</span></div>
          </div>
        </div>`;
      },
      tick(root, p) {
        flipTo(root.querySelector('.ct-flip-hh'), String(p.h12raw));
        flipTo(root.querySelector('.ct-flip-mm'), p.m);
        root.querySelector('.ct-flip-am').classList.toggle('on', p.ampm === 'AM');
        root.querySelector('.ct-flip-pm').classList.toggle('on', p.ampm === 'PM');
      }
    },

    {
      id: 'vinyl', name: 'Vinyl',
      render() {
        return `<div class="ct ct-vinyl">
          <div class="ct-vinyl-plate">
            <i class="ct-screw tl"></i><i class="ct-screw tr"></i>
            <i class="ct-screw bl"></i><i class="ct-screw br"></i>
            <div class="ct-vinyl-record">
              <div class="ct-vinyl-label"><span>HOROLIJE</span></div>
            </div>
            <div class="ct-face ct-vinyl-hands">
              <div class="ct-hand ct-hour"></div>
              <div class="ct-hand ct-minute"></div>
              <div class="ct-cap"></div>
            </div>
            <div class="ct-vinyl-arm"><i class="ct-vinyl-head"></i></div>
          </div>
        </div>`;
      },
      tick(root, p) { setHands(root, p); }
    }
  ];

  // Flip a card to a new value, replaying the flip animation only on change.
  function flipTo(card, val) {
    if (!card || card.dataset.val === val) return;
    card.dataset.val = val;
    card.querySelector('.ct-flip-val').textContent = val;
    card.classList.remove('flip');
    void card.offsetWidth; // force reflow so the animation restarts
    card.classList.add('flip');
  }

  function timeParts(now) {
    const h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
    const h12raw = h % 12 === 0 ? 12 : h % 12;
    return {
      h24: String(h).padStart(2, '0'),
      h12: String(h12raw).padStart(2, '0'),
      h12raw,
      m: String(m).padStart(2, '0'),
      s: String(s).padStart(2, '0'),
      ampm: h < 12 ? 'AM' : 'PM',
      hDeg: (h % 12) * 30 + m * 0.5,
      mDeg: m * 6 + s * 0.1,
      sDeg: s * 6
    };
  }

  const byId = id => THEMES.find(t => t.id === id) || THEMES[0];

  // Render `id` into host element and remember it for ticking.
  function mount(host, id, scale = 1) {
    const theme = byId(id);
    host.classList.add('ct-host');
    host.style.setProperty('--ct-scale', scale);
    host.dataset.ctId = theme.id;
    host.innerHTML = `<div class="ct-sizer"><div class="ct-scale">${theme.render()}</div></div>`;
  }

  // Tick a previously-mounted host to the given time.
  function tick(host, now) {
    const id = host.dataset.ctId;
    if (id) byId(id).tick(host, timeParts(now));
  }

  // Resolve a stored clock config (supports the legacy analog/digital field).
  function resolveId(clockCfg = {}) {
    if (clockCfg.theme && byId(clockCfg.theme).id === clockCfg.theme) return clockCfg.theme;
    return clockCfg.appearance === 'digital' ? 'digital' : 'minimal';
  }

  return { THEMES, mount, tick, byId, resolveId, timeParts };
})();
