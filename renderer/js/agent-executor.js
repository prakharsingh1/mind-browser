// =============================================================================
// Local Mind Browser — Agent Executor (renderer side)
// =============================================================================
// Fulfils the agent's browser tools. Webviews live in the renderer, so the main
// process asks over the bridge and this replies with the ACTUAL result — page
// text, link lists, click outcomes — rather than a fire-and-forget ack.

const AgentExecutor = (() => {
  function init() {
    window.localMind?.onAgentCall?.(async ({ id, action, params }) => {
      try {
        const handler = ACTIONS[action];
        if (!handler) throw new Error(`unknown action "${action}"`);
        // The gate needs this so it can pause the bridge deadline while it waits.
        AgentConfirm.setCallId(id);
        const data = await handler(params || {});
        window.localMind.agentResult({ id, ok: true, data });
      } catch (err) {
        window.localMind.agentResult({ id, ok: false, error: err?.message || String(err) });
      }
    });
  }

  const active = () => TabManager.getActiveTab();

  /** Wait for a webview to finish loading (or time out — some pages never idle). */
  function waitForLoad(webview, ms = 20000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; cleanup(); resolve(); } };
      const cleanup = () => {
        clearTimeout(timer);
        webview.removeEventListener('did-stop-loading', finish);
        webview.removeEventListener('did-finish-load', finish);
      };
      const timer = setTimeout(finish, ms);
      webview.addEventListener('did-stop-loading', finish);
      webview.addEventListener('did-finish-load', finish);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Readable text of a webview, with scripts/nav stripped. */
  async function pageText(webview, maxChars = 8000) {
    const js = `(() => {
      const kill = ['script','style','noscript','svg','nav','footer','header','aside','form'];
      const clone = document.body ? document.body.cloneNode(true) : null;
      if (!clone) return { title: document.title, url: location.href, text: '' };
      kill.forEach(t => clone.querySelectorAll(t).forEach(n => n.remove()));
      const main = clone.querySelector('main, article, [role="main"]') || clone;
      const text = (main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]{2,}/g, ' ').trim();
      return { title: document.title, url: location.href, text };
    })()`;
    const res = await webview.executeJavaScript(js, true);
    const text = (res?.text || '').slice(0, maxChars);
    return {
      title: res?.title,
      url: res?.url,
      text,
      truncated: (res?.text || '').length > maxChars
    };
  }

  const ACTIONS = {
    async open_page({ url, new_tab }) {
      if (!url) throw new Error('url is required');
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

      let tab;
      if (new_tab || !active()?.webview) {
        tab = TabManager.createTab(url, true);
      } else {
        tab = active();
        TabManager.navigateTo(url);
      }
      // A brand-new tab needs a moment before its webview element exists.
      for (let i = 0; i < 40 && !tab.webview; i++) await sleep(100);
      if (!tab.webview) throw new Error('tab failed to open');

      await waitForLoad(tab.webview);
      await sleep(600);                     // let late client-side render settle
      return await pageText(tab.webview);
    },

    async read_page() {
      const tab = active();
      if (!tab?.webview) throw new Error('no web page is open — use open_page first');
      return await pageText(tab.webview);
    },

    async page_links({ filter = '' }) {
      const tab = active();
      if (!tab?.webview) throw new Error('no web page is open — use open_page first');
      const js = `(() => {
        const f = ${JSON.stringify(String(filter).toLowerCase())};
        const seen = new Set(); const out = [];
        for (const a of document.querySelectorAll('a[href]')) {
          const text = (a.innerText || '').trim().replace(/\\s+/g, ' ');
          const href = a.href;
          if (!text || !href.startsWith('http') || seen.has(href)) continue;
          if (f && !(text.toLowerCase().includes(f) || href.toLowerCase().includes(f))) continue;
          seen.add(href); out.push({ text: text.slice(0, 100), url: href });
          if (out.length >= 60) break;
        }
        return out;
      })()`;
      return { links: await tab.webview.executeJavaScript(js, true) };
    },

    async click({ text }) {
      const tab = active();
      if (!tab?.webview) throw new Error('no web page is open — use open_page first');
      if (!text) throw new Error('text is required');

      // Two passes: find and label the target first, so an irreversible control
      // can be confirmed BEFORE it is pressed. Clicking then asking is useless.
      const findJs = `(() => {
        const want = ${JSON.stringify(String(text).toLowerCase())};
        const nodes = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')];
        const i = nodes.findIndex(n => ((n.innerText || n.value || '').trim().toLowerCase()).includes(want));
        if (i < 0) return { found: false };
        const hit = nodes[i];
        return { found: true, index: i, label: (hit.innerText || hit.value || '').trim().slice(0, 80) };
      })()`;
      const found = await tab.webview.executeJavaScript(findJs, true);
      if (!found?.found) throw new Error(`no clickable element matching "${text}" — try page_links to see what's available`);

      if (AgentConfirm.isRisky(found.label) || AgentConfirm.isRisky(text)) {
        const ok = await AgentConfirm.gate({ action: 'Click', label: found.label, url: tab.url });
        if (!ok) throw new Error(`BLOCKED BY USER: they declined the click on "${found.label}". Do not retry it; continue without this step or ask them what to do instead.`);
      }

      const clickJs = `(() => {
        const nodes = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')];
        const hit = nodes[${Number(found.index)}];
        if (!hit) return { clicked: false };
        hit.scrollIntoView({ block: 'center' });
        hit.click();
        return { clicked: true, label: (hit.innerText || hit.value || '').trim().slice(0, 80) };
      })()`;
      const res = await tab.webview.executeJavaScript(clickJs, true);
      if (!res?.clicked) throw new Error(`the element matching "${text}" disappeared before it could be clicked`);
      await waitForLoad(tab.webview, 12000);
      await sleep(500);
      const page = await pageText(tab.webview);
      return { clicked: res.label, ...page };
    },

    async type_text({ text, selector, submit }) {
      const tab = active();
      if (!tab?.webview) throw new Error('no web page is open — use open_page first');

      // Typing is reversible; submitting the form it sits in is not.
      if (submit) {
        const ok = await AgentConfirm.gate({ action: 'Submit form', label: String(text ?? '').slice(0, 80), url: tab.url });
        if (!ok) throw new Error('BLOCKED BY USER: they declined the form submission. Do not retry it; continue without this step or ask them what to do instead.');
      }

      const js = `(() => {
        const sel = ${JSON.stringify(selector || '')};
        const el = sel ? document.querySelector(sel)
          : (document.querySelector('input[type="search"], input[name="q"], input[type="text"], textarea'));
        if (!el) return { typed: false };
        el.focus();
        el.value = ${JSON.stringify(String(text ?? ''))};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (${submit ? 'true' : 'false'}) {
          const form = el.closest('form');
          if (form) form.submit();
          else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        }
        return { typed: true };
      })()`;
      const res = await tab.webview.executeJavaScript(js, true);
      if (!res?.typed) throw new Error('no matching input field found on this page');
      if (submit) { await waitForLoad(tab.webview, 12000); await sleep(500); }
      return { typed: true, ...(submit ? await pageText(tab.webview) : {}) };
    },

    async list_tabs() {
      const act = active();
      return {
        tabs: (TabManager.getAllTabs() || []).map((t) => ({
          id: String(t.id), title: t.title, url: t.url, active: t.id === act?.id
        }))
      };
    },

    async new_tab({ url, background }) {
      const tab = TabManager.createTab(url || '', !background);
      for (let i = 0; i < 40 && !tab.webview; i++) await sleep(100);
      if (!url) return { id: String(tab.id), opened: true };
      if (!tab.webview) throw new Error('tab failed to open');
      await waitForLoad(tab.webview);
      await sleep(500);
      return { id: String(tab.id), ...(await pageText(tab.webview)) };
    },

    async switch_tab({ id }) {
      const tab = (TabManager.getAllTabs() || []).find((t) => String(t.id) === String(id));
      if (!tab) throw new Error(`no tab with id ${id} — call list_tabs first`);
      TabManager.activateTab(tab.id);
      await sleep(400);
      if (!tab.webview) return { id: String(tab.id), text: '', note: 'tab has no page loaded' };
      return { id: String(tab.id), ...(await pageText(tab.webview)) };
    },

    async close_tab({ id }) {
      const tab = (TabManager.getAllTabs() || []).find((t) => String(t.id) === String(id));
      if (!tab) throw new Error(`no tab with id ${id}`);
      TabManager.closeTab(tab.id);
      return { closed: String(id) };
    },

    async press_key({ key, modifiers = [] }) {
      const tab = active();
      if (!tab?.webview) throw new Error('no web page is open');

      // Enter inside a form is a submit by another name, so it gets the same
      // gate — otherwise it is a trivial way around the click confirmation.
      if (String(key).toLowerCase() === 'enter') {
        const inForm = await tab.webview.executeJavaScript(
          `(() => { const a = document.activeElement;
            return !!(a && (a.closest('form') || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)); })()`,
          true
        ).catch(() => false);
        if (inForm) {
          const ok = await AgentConfirm.gate({ action: 'Press Enter (submits the focused field)', label: '', url: tab.url });
          if (!ok) throw new Error('BLOCKED BY USER: they declined pressing Enter. Do not retry it; continue without this step or ask them what to do instead.');
        }
      }
      // Real input events — synthetic KeyboardEvents are ignored by many apps.
      const mods = modifiers.map((m) => m.toLowerCase());
      ['keyDown', 'char', 'keyUp'].forEach((type) => {
        if (type === 'char' && key.length > 1) return;   // no char event for named keys
        try { tab.webview.sendInputEvent({ type, keyCode: key, modifiers: mods }); } catch {}
      });
      await sleep(400);
      return { pressed: [...mods, key].join('+') };
    },

    async type_into_editor({ text }) {
      const tab = active();
      if (!tab?.webview) throw new Error('no web page is open');
      if (!text) throw new Error('text is required');
      tab.webview.focus();
      // Google Docs / Notion listen for real key events on a hidden input, so
      // setting .value or innerText silently does nothing. Send actual chars.
      for (const ch of String(text)) {
        if (ch === '\n') {
          tab.webview.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
          tab.webview.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        } else {
          tab.webview.sendInputEvent({ type: 'char', keyCode: ch });
        }
        await sleep(6);                    // editors drop input typed too fast
      }
      await sleep(600);
      return { typed: text.length };
    },

    async scroll_page({ direction = 'down', amount = 1 }) {
      const tab = active();
      if (!tab?.webview) throw new Error('no web page is open');
      const js = `(() => {
        const d = ${JSON.stringify(direction)};
        if (d === 'bottom') window.scrollTo(0, document.body.scrollHeight);
        else if (d === 'top') window.scrollTo(0, 0);
        else window.scrollBy(0, (d === 'up' ? -1 : 1) * window.innerHeight * ${Number(amount) || 1});
        return true;
      })()`;
      await tab.webview.executeJavaScript(js, true);
      await sleep(900);                    // let lazy content load
      return await pageText(tab.webview);
    },

    async wait_for({ text, seconds = 3 }) {
      const tab = active();
      if (!text) { await sleep(Math.min(Number(seconds) || 3, 20) * 1000); return { waited: seconds }; }
      if (!tab?.webview) throw new Error('no web page is open');
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const found = await tab.webview.executeJavaScript(
          `(document.body ? document.body.innerText : '').includes(${JSON.stringify(text)})`, true
        ).catch(() => false);
        if (found) return { found: true, ...(await pageText(tab.webview)) };
        await sleep(1000);
      }
      throw new Error(`"${text}" did not appear within 25s`);
    },

    async extract_table({ match = '', max_rows = 100 }) {
      const tab = active();
      if (!tab?.webview) throw new Error('no web page is open — use open_page first');
      const js = `(() => {
        const want = ${JSON.stringify(String(match).toLowerCase())};
        const out = [];
        for (const tbl of document.querySelectorAll('table')) {
          const text = (tbl.innerText || '').toLowerCase();
          if (want && !text.includes(want)) continue;
          const rows = [];
          for (const tr of tbl.querySelectorAll('tr')) {
            const cells = [...tr.querySelectorAll('th,td')]
              .map(td => (td.innerText || '').replace(/\\s+/g, ' ').trim());
            if (cells.some(Boolean)) rows.push(cells);
            if (rows.length >= ${Number(max_rows) || 100}) break;
          }
          if (rows.length > 1) out.push(rows);
        }
        return out;
      })()`;
      const tables = await tab.webview.executeJavaScript(js, true);
      if (!tables?.length) throw new Error('no tables found on this page — try scroll_page, or read_page instead');
      // Return the largest table; that's almost always the ranking/data one.
      const best = tables.sort((a, b) => b.length - a.length)[0];
      return { rows: best.length, table: best };
    },

    async bookmark_page({ url, title }) {
      const tab = active();
      const u = url || tab?.url;
      if (!u) throw new Error('no page to bookmark');
      if (typeof Bookmarks !== 'undefined' && Bookmarks.add) {
        Bookmarks.add({ url: u, title: title || tab?.title || u });
        return { bookmarked: u };
      }
      throw new Error('bookmarks unavailable');
    },

    async save_note({ title, body }) {
      if (typeof NotesStore === 'undefined') throw new Error('notes unavailable');
      const text = [title, body].filter(Boolean).join('\n\n');
      if (!text.trim()) throw new Error('nothing to save');
      const note = NotesStore.create(text);
      return { saved: true, id: note.id };
    }
  };

  return { init };
})();
