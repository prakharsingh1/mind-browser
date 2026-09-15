// =============================================================================
// Local Mind Browser — Chrome Key Forwarding
// =============================================================================
// Menu accelerators fire once per press and say nothing about release, so they
// cannot express "hold Ctrl and tap Tab to walk back through your tabs" — the
// switcher has to know when Ctrl finally comes up.
//
// A plain keydown listener in the renderer is no good either: once a page has
// focus, its webview swallows the keys and the host window never sees them.
//
// So the main process watches each webview's raw input and forwards only the
// handful of keys the browser chrome cares about. Everything else is left
// completely alone — pages must keep their own Tab handling for forms.

const { app } = require('electron');

// Only these reach the renderer. Keeping the list tight means a page's own
// shortcuts keep working and we never see what someone types.
const isChromeKey = (input) =>
  (input.key === 'Tab' && input.control) ||
  (input.key === 'Control' && input.type === 'keyUp') ||
  (input.key === 'Escape' && input.type === 'keyDown');

// Ctrl+Tab is ours alone, so the page must not also act on it. Escape is only
// observed: pages use it to close their own dialogs and stop loads, and taking
// it away to serve a browser mode would break them.
const isOursExclusively = (input) => input.key === 'Tab' && input.control && input.type === 'keyDown';

function initChromeKeys(windowGetter) {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;

    contents.on('before-input-event', (event, input) => {
      if (!isChromeKey(input)) return;

      const win = windowGetter();
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;

      if (isOursExclusively(input)) event.preventDefault();

      win.webContents.send('chrome-key', {
        type: input.type,          // 'keyDown' | 'keyUp'
        key: input.key,
        shift: !!input.shift,
        control: !!input.control
      });
    });
  });
}

module.exports = { initChromeKeys };
