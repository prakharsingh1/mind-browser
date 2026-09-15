// =============================================================================
// Local Mind Browser — Task manager (UI)
// =============================================================================
// A floating panel rather than a page: you open it to answer one question —
// what is making the fan spin — and you want the tabs still visible behind it
// so you can act on the answer.
//
// It polls while open and stops the moment it closes. A task manager that keeps
// sampling in the background would be its own entry in the list.

const TaskManager = (() => {
  let el = null;
  let timer = null;
  let sortBy = 'memoryKb';

  const POLL_MS = 1400;

  const fmtMem = (kb) => {
    if (!kb) return '—';
    const mb = kb / 1024;
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
  };

  function init() {
    // The menu route lives in app.js's action map — onMenuAction fans one
    // callback out across every channel rather than taking a per-channel one.
    // The main process asks us to close a tab when a row's Close is used, so
    // the tab goes through the same path as any other close.
    window.localMind?.onCloseTabByContentsId?.((contentsId) => {
      for (const tab of TabManager.getAllTabs?.() || []) {
        let id = null;
        try { id = tab.webview?.getWebContentsId?.(); } catch { id = null; }
        if (id === contentsId) { TabManager.closeTab(tab.id); return; }
      }
    });
  }

  function build() {
    el = document.createElement('div');
    el.id = 'task-manager';
    el.innerHTML = `
      <div class="tm-head">
        <div class="tm-title">Task Manager</div>
        <div class="tm-sub" id="tm-sub"></div>
        <button class="tm-close" id="tm-close" title="Close (Esc)">×</button>
      </div>
      <div class="tm-cols">
        <span class="tm-c-name">Task</span>
        <button class="tm-c-num tm-sort" data-sort="memoryKb">Memory</button>
        <button class="tm-c-num tm-sort" data-sort="cpu">CPU</button>
        <span class="tm-c-act"></span>
      </div>
      <div class="tm-rows" id="tm-rows"></div>`;
    document.body.appendChild(el);

    el.querySelector('#tm-close').addEventListener('click', hide);
    el.querySelectorAll('.tm-sort').forEach((b) => {
      b.addEventListener('click', () => { sortBy = b.dataset.sort; refresh(); });
    });
  }

  async function refresh() {
    if (!el) return;
    const res = await window.localMind?.listTasks?.();
    if (!res?.ok) return;

    const rows = [...res.rows].sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0));
    const totalMem = rows.reduce((n, r) => n + (r.memoryKb || 0), 0);
    const totalCpu = rows.reduce((n, r) => n + (r.cpu || 0), 0);

    el.querySelector('#tm-sub').textContent =
      `${rows.length} processes · ${fmtMem(totalMem)} · ${totalCpu.toFixed(1)}% CPU`;

    el.querySelectorAll('.tm-sort').forEach((b) =>
      b.classList.toggle('on', b.dataset.sort === sortBy));

    const host = el.querySelector('#tm-rows');
    host.innerHTML = '';
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = `tm-row${r.kind === 'system' ? ' system' : ''}`;

      const name = document.createElement('span');
      name.className = 'tm-c-name';
      // textContent: a row's name is a page title, which is attacker-controlled.
      name.textContent = r.name;
      name.title = `${r.name}  (pid ${r.pid})`;

      const mem = document.createElement('span');
      mem.className = 'tm-c-num';
      mem.textContent = fmtMem(r.memoryKb);

      const cpu = document.createElement('span');
      cpu.className = 'tm-c-num';
      cpu.textContent = `${(r.cpu || 0).toFixed(1)}%`;
      if (r.cpu >= 25) cpu.classList.add('hot');

      const act = document.createElement('span');
      act.className = 'tm-c-act';
      // Only tabs get a Close button — offering to kill the GPU process would
      // be a one-click way to break the window.
      if (r.contentsIds?.length) {
        const btn = document.createElement('button');
        btn.className = 'tm-kill';
        btn.textContent = 'Close';
        btn.title = 'Close this tab';
        btn.addEventListener('click', async () => {
          for (const id of r.contentsIds) await window.localMind.closeTask(id);
          refresh();
        });
        act.appendChild(btn);
      }

      row.append(name, mem, cpu, act);
      host.appendChild(row);
    }
  }

  function show() {
    if (!el) build();
    el.classList.add('on');
    refresh();
    clearInterval(timer);
    timer = setInterval(refresh, POLL_MS);
    document.addEventListener('keydown', onKey, true);
  }

  function hide() {
    el?.classList.remove('on');
    // Stop sampling: a task manager that polls while closed is its own problem.
    clearInterval(timer);
    timer = null;
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); hide(); }
  }

  const isOpen = () => Boolean(el?.classList.contains('on'));
  const toggle = () => (isOpen() ? hide() : show());

  return { init, show, hide, toggle, isOpen };
})();
