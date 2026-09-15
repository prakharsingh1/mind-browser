// =============================================================================
// Local Mind Browser — Speech
// =============================================================================
// One place that owns reading text aloud, so the AI panel and the reader sound
// the same and answer to the same settings.
//
// Two details that are easy to get wrong and cause most speechSynthesis bugs:
//
//   • getVoices() is empty on first call in Chromium. The list arrives
//     asynchronously, so anything that needs it has to wait for
//     `voiceschanged` rather than reading once at startup and giving up.
//
//   • Chromium stops speaking after roughly fifteen seconds of a single
//     utterance. Long text has to be split into shorter pieces and queued, or
//     it simply cuts out mid-sentence.

const Speech = (() => {
  const PREFS_KEY = 'mind-speech-prefs';
  const defaults = { voiceURI: '', rate: 1, pitch: 1 };

  let voices = [];
  let queue = [];
  let speaking = false;
  let onStateChange = null;

  function init() {
    load();
    // Fires once the list is populated, and again if the system's voices change.
    try {
      speechSynthesis.addEventListener('voiceschanged', load);
      load();
    } catch { /* no speech support on this platform */ }
  }

  function load() {
    try { voices = speechSynthesis.getVoices() || []; } catch { voices = []; }
  }

  const prefs = () => {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
    catch { return { ...defaults }; }
  };
  const setPrefs = (p) => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs(), ...p })); } catch { /* full */ }
  };

  const available = () => typeof speechSynthesis !== 'undefined';

  /** Voices, with the ones for this UI's language first. */
  function list() {
    if (!voices.length) load();
    const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return [...voices].sort((a, b) => {
      const am = a.lang?.toLowerCase().startsWith(lang) ? 0 : 1;
      const bm = b.lang?.toLowerCase().startsWith(lang) ? 0 : 1;
      return am - bm || a.name.localeCompare(b.name);
    });
  }

  function chosenVoice() {
    const { voiceURI } = prefs();
    if (!voiceURI) return null;
    if (!voices.length) load();
    return voices.find((v) => v.voiceURI === voiceURI) || null;
  }

  /**
   * Split into chunks short enough that Chromium will not cut them off, but
   * broken at sentence ends so the pauses land where a reader would pause.
   */
  function chunk(text, max = 220) {
    const sentences = String(text)
      .replace(/\s+/g, ' ')
      .match(/[^.!?]+[.!?]*\s*/g) || [String(text)];

    const out = [];
    let buf = '';
    for (const s of sentences) {
      if (buf && (buf + s).length > max) { out.push(buf.trim()); buf = s; }
      else buf += s;
      // A single sentence longer than the limit still has to be broken up.
      while (buf.length > max * 2) {
        out.push(buf.slice(0, max).trim());
        buf = buf.slice(max);
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out.filter(Boolean);
  }

  function speak(text, opts = {}) {
    if (!available()) return false;
    stop();

    const clean = String(text || '')
      // Markdown read aloud sounds like punctuation soup.
      .replace(/```[\s\S]*?```/g, ' code block. ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^[#>\-*]+\s*/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .trim();

    if (!clean) return false;

    const p = prefs();
    const voice = chosenVoice();
    queue = chunk(clean);
    speaking = true;
    onStateChange = opts.onStateChange || null;
    onStateChange?.(true);

    let i = 0;
    const next = () => {
      if (!speaking || i >= queue.length) { finish(); return; }
      const u = new SpeechSynthesisUtterance(queue[i++]);
      if (voice) u.voice = voice;
      u.rate = opts.rate ?? p.rate ?? 1;
      u.pitch = opts.pitch ?? p.pitch ?? 1;
      u.onend = next;
      u.onerror = finish;
      speechSynthesis.speak(u);
    };

    const finish = () => {
      speaking = false;
      queue = [];
      onStateChange?.(false);
      onStateChange = null;
      opts.onEnd?.();
    };

    next();
    return true;
  }

  function stop() {
    speaking = false;
    queue = [];
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    onStateChange?.(false);
    onStateChange = null;
  }

  const isSpeaking = () => speaking;

  return { init, list, prefs, setPrefs, speak, stop, isSpeaking, available };
})();
