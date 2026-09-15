// =============================================================================
// Local Mind Browser — WebView Preload Script
// =============================================================================
// Injected into every browsed page's <webview>. Provides page content extraction,
// DOM scanning, element interaction, text selection detection, and visual cursor.

const { ipcRenderer, webFrame, contextBridge } = require('electron');

// ── PDF editor bridge ────────────────────────────────────────────────────────
// The editor is our own page, loaded from disk inside a normal tab, so it needs
// a way to read and write files. Exposed ONLY on file:// — a website given
// pdfSave could pop a save dialog at will, which is not something any page on
// the internet should be able to do.
if (location.protocol === 'file:') {
  try {
    contextBridge.exposeInMainWorld('localMind', {
      pdfLoad: (src) => ipcRenderer.invoke('pdf:load', src),
      pdfSave: (payload) => ipcRenderer.invoke('pdf:save', payload),
      pdfReveal: (p) => ipcRenderer.invoke('pdf:reveal', p),
      // Conversion output: one file, or a folder of page images.
      fileSaveAs: (payload) => ipcRenderer.invoke('file:saveAs', payload),
      fileSaveMany: (payload) => ipcRenderer.invoke('file:saveMany', payload)
    });
  } catch { /* already defined, or context isolation off */ }
}

// ── Identity masking ─────────────────────────────────────────────────────────
// Runs before any of the page's own scripts. sendSync is deliberate: the flags
// must be known before the first line of page JavaScript executes, and an async
// round trip would lose that race.
try {
  const script = ipcRenderer.sendSync('privacy:mask-script');
  // executeJavaScript from a preload lands in the page's main world, which is
  // the only place patching navigator/canvas actually fools the page.
  if (script) webFrame.executeJavaScript(script).catch(() => {});
} catch { /* masking off, or the main process is not ready — browse normally */ }

// =============================================================================
// Stored elements from last scan (for click-by-index)
// =============================================================================
let scannedElements = [];

// =============================================================================
// Visual Cursor Element
// =============================================================================
let cursor = null;
function ensureCursor() {
  if (cursor) return cursor;
  cursor = document.createElement('div');
  cursor.id = '__localmind-cursor';
  cursor.style.cssText = `
    position: fixed; z-index: 999999; width: 12px; height: 12px;
    background: #2bd473; border-radius: 50%; pointer-events: none;
    box-shadow: 0 0 12px rgba(43,212,115,0.6), 0 0 4px rgba(43,212,115,0.8);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    transform: translate(-50%, -50%); display: none;
  `;
  document.body.appendChild(cursor);
  return cursor;
}

// =============================================================================
// Message Handlers from Host (renderer process)
// =============================================================================
ipcRenderer.on('extract-content', () => {
  const headings = [];
  document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
    headings.push({ level: parseInt(h.tagName[1]), text: h.textContent.trim().slice(0, 200) });
  });

  const links = [];
  const anchors = document.querySelectorAll('a[href]');
  for (let i = 0; i < Math.min(anchors.length, 50); i++) {
    links.push({ text: anchors[i].textContent.trim().slice(0, 100), href: anchors[i].href });
  }

  const metaDesc = document.querySelector('meta[name="description"]');
  const metaKeys = document.querySelector('meta[name="keywords"]');

  ipcRenderer.sendToHost('page-content', {
    text: document.body.innerText,
    title: document.title,
    url: location.href,
    headings,
    links,
    meta: {
      description: metaDesc ? metaDesc.content : '',
      keywords: metaKeys ? metaKeys.content : ''
    }
  });
});

ipcRenderer.on('scan-elements', () => {
  scannedElements = [];
  const selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [onclick], [tabindex]';
  const allElements = document.querySelectorAll(selectors);

  for (let i = 0; i < Math.min(allElements.length, 200); i++) {
    const el = allElements[i];
    const rect = el.getBoundingClientRect();
    const isVisible = rect.width > 0 && rect.height > 0 &&
      rect.top < window.innerHeight && rect.bottom > 0 &&
      rect.left < window.innerWidth && rect.right > 0 &&
      getComputedStyle(el).visibility !== 'hidden' &&
      getComputedStyle(el).display !== 'none';

    if (!isVisible) continue;

    scannedElements.push(el);
    // We'll send the metadata separately
  }

  const metadata = scannedElements.map((el, idx) => ({
    index: idx,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent || el.value || '').trim().slice(0, 80),
    type: el.type || '',
    placeholder: el.placeholder || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    href: el.href || '',
    isVisible: true,
    rect: {
      x: Math.round(el.getBoundingClientRect().x),
      y: Math.round(el.getBoundingClientRect().y),
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height)
    }
  }));

  ipcRenderer.sendToHost('scan-results', metadata);
});

ipcRenderer.on('execute-action', (_event, { action, params }) => {
  try {
    switch (action) {
      case 'click': {
        const el = scannedElements[params.index];
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => el.click(), 300);
        }
        ipcRenderer.sendToHost('action-result', { success: true, action });
        break;
      }
      case 'type': {
        const el = scannedElements[params.index];
        if (el) {
          el.focus();
          el.value = params.text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        ipcRenderer.sendToHost('action-result', { success: true, action });
        break;
      }
      case 'scroll': {
        const amount = params.direction === 'down' ? 500 : -500;
        window.scrollBy({ top: amount, behavior: 'smooth' });
        ipcRenderer.sendToHost('action-result', { success: true, action });
        break;
      }
      case 'scroll-to-top': {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        ipcRenderer.sendToHost('action-result', { success: true, action });
        break;
      }
      case 'scroll-to-bottom': {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        ipcRenderer.sendToHost('action-result', { success: true, action });
        break;
      }
      default:
        ipcRenderer.sendToHost('action-result', { success: false, error: `Unknown action: ${action}` });
    }
  } catch (err) {
    ipcRenderer.sendToHost('action-result', { success: false, error: err.message });
  }
});

// =============================================================================
// Visual Cursor Control
// =============================================================================
ipcRenderer.on('move-cursor', (_event, { x, y }) => {
  const c = ensureCursor();
  c.style.display = 'block';
  c.style.left = x + 'px';
  c.style.top = y + 'px';
});

ipcRenderer.on('show-cursor', () => {
  ensureCursor().style.display = 'block';
});

ipcRenderer.on('hide-cursor', () => {
  if (cursor) cursor.style.display = 'none';
});

// =============================================================================
// Text Selection Detection — for Smart Highlights floating toolbar
// =============================================================================
document.addEventListener('mouseup', () => {
  const selection = window.getSelection();
  const text = selection.toString().trim();
  if (text.length > 2) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    ipcRenderer.sendToHost('text-selected', {
      text: text.slice(0, 2000),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }
    });
  }
});

// Clear selection notification when clicking elsewhere
document.addEventListener('mousedown', () => {
  ipcRenderer.sendToHost('text-deselected');
});

// =============================================================================
// Smart Autofill Detection and Execution (Autocomplete UI)
// =============================================================================
let autofillProfiles = [];
let activeAutofillInput = null;
let autocompletePopup = null;

function ensureAutocompletePopup() {
  if (autocompletePopup) return autocompletePopup;
  autocompletePopup = document.createElement('div');
  autocompletePopup.id = '__localmind-autofill-popup';
  autocompletePopup.style.cssText = `
    position: fixed; z-index: 9999999; background: var(--bg-base, #111814); border: 1px solid var(--border-color, #222d26); 
    border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); display: none; flex-direction: column; 
    min-width: 250px; max-width: 350px; overflow: hidden; font-family: system-ui, -apple-system, sans-serif;
  `;
  document.body.appendChild(autocompletePopup);

  // Close when clicking outside
  document.addEventListener('mousedown', (e) => {
    if (autocompletePopup && autocompletePopup.style.display !== 'none' && !autocompletePopup.contains(e.target) && e.target !== activeAutofillInput) {
      autocompletePopup.style.display = 'none';
      activeAutofillInput = null;
    }
  });
  return autocompletePopup;
}

function showAutocomplete(inputEl, profiles) {
  if (!profiles || profiles.length === 0) return;
  const popup = ensureAutocompletePopup();
  activeAutofillInput = inputEl;
  
  popup.innerHTML = '';
  const header = document.createElement('div');
  header.style.cssText = 'padding: 8px 12px; font-size: 11px; font-weight: 600; color: #888; text-transform: uppercase; border-bottom: 1px solid var(--border-color, #222d26); background: rgba(0,0,0,0.2);';
  header.textContent = 'Autofill Suggestion';
  popup.appendChild(header);

  profiles.forEach(p => {
    const item = document.createElement('div');
    item.style.cssText = 'padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; border-bottom: 1px solid rgba(255,255,255,0.05); color: #e5e5e5;';
    item.onmouseover = () => item.style.background = 'rgba(43, 212, 115, 0.15)';
    item.onmouseout = () => item.style.background = 'transparent';
    
    let content = `<div style="font-size: 13px; font-weight: 500; display:flex; justify-content: space-between;">
                     <span>${p.name || '(No Name)'}</span>
                     <span style="font-size: 10px; color: #2bd473; border: 1px solid rgba(43,212,115,0.3); border-radius: 4px; padding: 2px 6px;">${p.label || 'Profile'}</span>
                   </div>`;
    if (p.email) {
      content += `<div style="font-size: 11px; color: #888;">${p.email}</div>`;
    }
    
    item.innerHTML = content;
    item.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      fillProfile(p);
      popup.style.display = 'none';
      activeAutofillInput = null;
    };
    popup.appendChild(item);
  });

  const rect = inputEl.getBoundingClientRect();
  popup.style.top = (rect.bottom + 4) + 'px';
  popup.style.left = rect.left + 'px';
  popup.style.display = 'flex';
}

function fillProfile(profile) {
  const autofillStyle = 'background-color: #fffbdd !important; transition: background-color 0.5s ease;';
  
  // Fill all relevant fields on the page
  const emailInputs = document.querySelectorAll('input[type="email"], input[name*="email" i], input[autocomplete="email"]');
  const nameInputs = document.querySelectorAll('input[name="name" i], input[name*="fullname" i], input[autocomplete="name"]');
  
  if (profile.email) {
    emailInputs.forEach(el => {
      if (!el.value || el === activeAutofillInput) {
        el.value = profile.email;
        el.style.cssText += autofillStyle;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }

  if (profile.name) {
    nameInputs.forEach(el => {
      if (!el.value || el === activeAutofillInput) {
        el.value = profile.name;
        el.style.cssText += autofillStyle;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Request profiles from host
  ipcRenderer.sendToHost('request-autofill');
});

ipcRenderer.on('autofill-data', (_event, profiles) => {
  if (!profiles || !Array.isArray(profiles)) return;
  autofillProfiles = profiles;
  
  // Attach listeners to relevant inputs
  const allInputs = document.querySelectorAll('input[type="email"], input[name*="email" i], input[autocomplete="email"], input[name="name" i], input[name*="fullname" i], input[autocomplete="name"]');
  
  allInputs.forEach(input => {
    input.addEventListener('focus', (e) => {
      showAutocomplete(e.target, autofillProfiles);
    });
    input.addEventListener('click', (e) => {
      if (autocompletePopup && autocompletePopup.style.display === 'none') {
        showAutocomplete(e.target, autofillProfiles);
      }
    });
  });
});

// 2. Listen for form submissions to save profile data
document.addEventListener('submit', (e) => {
  const form = e.target;
  let extractedEmail = '';
  let extractedName = '';

  const emailEl = form.querySelector('input[type="email"], input[name*="email" i], input[autocomplete="email"]');
  const nameEl = form.querySelector('input[name="name" i], input[name*="fullname" i], input[autocomplete="name"]');

  if (emailEl && emailEl.value) extractedEmail = emailEl.value.trim();
  if (nameEl && nameEl.value) extractedName = nameEl.value.trim();

  if (extractedEmail || extractedName) {
    ipcRenderer.sendToHost('form-submitted', {
      email: extractedEmail,
      name: extractedName
    });
  }
});

// ── Audio boost ──────────────────────────────────────────────────────────────
// Sites cap out at the element's own volume, which is why people install a
// "volume booster" extension. All those extensions do is route the media
// element through a Web Audio GainNode, whose gain is not clamped at 1. That is
// a dozen lines, so there is no reason to send anyone to a third party for it.
//
// Two things this deliberately does NOT do:
//
//   • It does not touch Web Audio at all until a boost above 100% is actually
//     asked for. Once a media element is routed through createMediaElementSource
//     it stays routed, and for DRM-protected or cross-origin media that path
//     yields silence. Wiring every page pre-emptively would break playback on
//     exactly the sites people care most about.
//
//   • It does not pretend to work on protected content. Netflix and Disney+
//     hand decoded audio straight to the platform, out of the page's reach, so
//     the honest response there is to say so rather than move a slider that
//     does nothing.
const audioBoost = (() => {
  let ctx = null;
  let gain = null;
  let level = 1;
  let unavailable = null;                 // reason string once we know
  const wired = new WeakSet();

  const media = () => [...document.querySelectorAll('video, audio')];

  const isProtected = (el) => Boolean(el.mediaKeys) ||
    (typeof el.webkitKeys !== 'undefined' && el.webkitKeys);

  function ensureGraph() {
    if (ctx) return true;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio is not available on this page');
      ctx = new Ctor();
      gain = ctx.createGain();
      gain.gain.value = level;
      gain.connect(ctx.destination);
      return true;
    } catch (err) {
      unavailable = err.message;
      return false;
    }
  }

  function wire(el) {
    if (wired.has(el)) return true;
    if (isProtected(el)) {
      unavailable = 'This site protects its audio (DRM), so it cannot be boosted past 100%.';
      return false;
    }
    if (!ensureGraph()) return false;
    try {
      ctx.createMediaElementSource(el).connect(gain);
      wired.add(el);
      return true;
    } catch (err) {
      // Cross-origin media without CORS headers lands here. Marking it wired
      // stops us retrying on every slider move.
      wired.add(el);
      unavailable = 'This page will not let its audio be re-routed, so it cannot go past 100%.';
      return false;
    }
  }

  function apply(next) {
    level = Math.max(0, Math.min(5, Number(next) || 0));
    const els = media();

    if (level <= 1) {
      // Below 100% there is nothing to gain up — set the element's own volume
      // and leave the audio graph out of it entirely.
      for (const el of els) { try { el.volume = level; } catch { /* not settable */ } }
      if (gain) gain.gain.value = 1;
      return { ok: true, level, boosted: false };
    }

    let any = false;
    for (const el of els) {
      try { el.volume = 1; } catch { /* ignore */ }
      if (wire(el)) any = true;
    }
    if (!any) return { ok: false, level: 1, reason: unavailable || 'No audio to boost on this page.' };

    ctx.resume?.().catch(() => {});
    gain.gain.value = level;
    return { ok: true, level, boosted: true };
  }

  // A site that swaps in a new <video> mid-session (most players do) has to be
  // picked up, or the boost silently stops applying.
  const rewire = () => { if (level > 1) apply(level); };
  document.addEventListener('play', rewire, true);

  return { apply, state: () => ({ level, unavailable }) };
})();

ipcRenderer.on('audio-boost-set', (_e, value) => {
  const res = audioBoost.apply(value);
  ipcRenderer.sendToHost('audio-boost-state', res);
});
ipcRenderer.on('audio-boost-query', () => {
  ipcRenderer.sendToHost('audio-boost-state', { ok: true, ...audioBoost.state() });
});
