// =============================================================================
// Local Mind Browser — Utility Functions
// =============================================================================

/** Generate a short unique ID */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Escape HTML to prevent XSS (regex — no DOM allocation, called in hot loops) */
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(text) {
  if (text == null) return '';
  return String(text).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

/** Truncate text with ellipsis */
function truncate(text, maxLen = 60) {
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

function getGreeting(name = '') {
  const hour = new Date().getHours();
  let greeting = 'Good evening';
  if (hour < 12) greeting = 'Good morning';
  else if (hour < 17) greeting = 'Good afternoon';
  
  return name ? `${greeting}, ${name}` : greeting;
}

/** Format date relative to now */
function formatRelativeDate(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

/**
 * Debounce, with a way to force the pending call.
 *
 * Without flush(), anything debounced is silently lost if the page goes away
 * inside the delay window — which is exactly what happens when someone quits
 * right after loading a page. Callers that persist data need to be able to
 * settle their last write on the way out.
 */
function debounce(fn, delay = 300) {
  let timer = null;
  let lastArgs = null;
  let lastThis = null;

  const wrapped = function (...args) {
    lastArgs = args;
    lastThis = this;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(lastThis, lastArgs); }, delay);
  };

  /** Run the pending call now. No-op if nothing is pending. */
  wrapped.flush = () => {
    if (timer === null) return false;
    clearTimeout(timer);
    timer = null;
    fn.apply(lastThis, lastArgs);
    return true;
  };

  wrapped.cancel = () => { clearTimeout(timer); timer = null; };

  return wrapped;
}

/** Simple event emitter for app-wide communication */
const EventBus = {
  _listeners: {},
  on(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  },
  off(event, callback) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
  },
  emit(event, ...args) {
    if (!this._listeners[event]) return;
    this._listeners[event].forEach(cb => cb(...args));
  }
};
