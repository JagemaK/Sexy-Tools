// Dialer Assistant content script: floating panel + automation runner.
//
// The run state lives in sessionStorage (per tab, survives page loads), so the
// runner resumes at the right phase whether the site navigates or swaps DOM.
(() => {
  if (window.top !== window) return;
  if (window.__daLoaded) return;
  window.__daLoaded = true;

  const JOB_KEY = 'da_job';
  const UI_KEY = 'da_ui';
  let settings = null;
  let runnerActive = false;

  // ---------- small DOM utils ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function textOf(el) {
    if (el.tagName === 'INPUT') return el.value || '';
    return el.innerText || el.textContent || '';
  }

  // Visible clickable element whose text matches exactly (normalized).
  function findButton(label, root = document) {
    const want = norm(label);
    const els = root.querySelectorAll('button, a, input[type=button], input[type=submit], [role=button], .btn');
    for (const el of els) {
      if (isOurs(el) || !visible(el)) continue;
      if (norm(textOf(el)) === want) return el;
    }
    return null;
  }

  function isOurs(el) {
    return el.closest && el.closest('#da-host');
  }

  // Find the input next to a label like "Control Number:".
  function findFieldByLabel(re, fallbackRe) {
    const cands = document.querySelectorAll('label, td, th, span, div, dt, p, b, strong');
    for (const el of cands) {
      if (isOurs(el) || el.children.length > 2) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 40 || !re.test(t)) continue;
      if (el.tagName === 'LABEL' && el.htmlFor) {
        const f = document.getElementById(el.htmlFor);
        if (f && visible(f)) return f;
      }
      const inner = el.querySelector('input, select');
      if (inner && visible(inner)) return inner;
      let sib = el.nextElementSibling;
      for (let i = 0; sib && i < 3; i++, sib = sib.nextElementSibling) {
        const f = sib.matches('input, select') ? sib : sib.querySelector('input, select');
        if (f && visible(f)) return f;
      }
      const row = el.closest('tr, .form-group, .row, li');
      if (row) {
        const f = row.querySelector('input:not([type=hidden]), select');
        if (f && visible(f)) return f;
      }
    }
    if (fallbackRe) {
      for (const f of document.querySelectorAll('input:not([type=hidden])')) {
        if (!isOurs(f) && visible(f) && fallbackRe.test(`${f.name} ${f.id} ${f.placeholder}`)) return f;
      }
    }
    return null;
  }

  function setValue(el, value) {
    el.focus();
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function waitFor(fn, what, timeout = settings.timeoutMs) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const job = loadJob();
      if (!job || !job.running) throw new Error('Stopped');
      const v = fn();
      if (v) return v;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for: ${what}`);
  }

  function click(el) {
    el.scrollIntoView({ block: 'center' });
    el.click();
  }

  // ---------- page detection ----------
  const searchCtrlInput = () => findFieldByLabel(/^control\s*(number|#|no)?\s*:?$/i, /control|ctrl/i);
  const searchPhoneInput = () => findFieldByLabel(/^phone\s*(number|#)?\s*:?$/i, /phone/i);

  function searchButtonFor(input) {
    const form = input.closest('form') || input.closest('.panel, .box, .card, table') || document;
    return findButton('Search', form) || findButton('Search');
  }

  function onCallDetails() {
    return findButton('Back to Search Results') && findButton('Finish');
  }

  function callDetailsCtrl() {
    const m = (document.body.innerText || '').match(/Control\s*#\s*:?\s*(\d{5,})/i);
    return m ? daNormalizeCtrl(m[1]) : null;
  }

  // Results table: header cells + data rows that carry a "Select" button.
  function resultRows() {
    const out = [];
    for (const btn of document.querySelectorAll('button, a, input[type=button], input[type=submit]')) {
      if (isOurs(btn) || !visible(btn) || norm(textOf(btn)) !== 'select') continue;
      const tr = btn.closest('tr');
      if (tr) out.push({ btn, tr });
    }
    return out;
  }

  function ctrlColumnIndex(table) {
    const ths = table.querySelectorAll('thead th, thead td, tr:first-child th');
    for (let i = 0; i < ths.length; i++) {
      if (/control/i.test(ths[i].textContent)) return i;
    }
    return -1;
  }

  function rowCtrl(tr) {
    const table = tr.closest('table');
    const idx = table ? ctrlColumnIndex(table) : -1;
    if (idx >= 0 && tr.cells[idx]) return daNormalizeCtrl(tr.cells[idx].textContent);
    for (const td of tr.cells) {
      const t = td.textContent.trim();
      if (/^\d{6,12}$/.test(t)) return t;
    }
    return '';
  }

  function noResults() {
    return /no (results|records|matches|members)|nothing found|0 results/i.test(document.body.innerText || '');
  }

  // Disposition target: <select> option, radio/checkbox label, or a clickable tile.
  function findDisposition(name) {
    const want = norm(name);
    for (const sel of document.querySelectorAll('select')) {
      if (isOurs(sel) || !visible(sel)) continue;
      for (const opt of sel.options) {
        if (norm(opt.text) === want) return { kind: 'select', sel, opt };
      }
    }
    for (const lab of document.querySelectorAll('label')) {
      if (isOurs(lab) || !visible(lab) || norm(lab.textContent) !== want) continue;
      const inp = lab.htmlFor ? document.getElementById(lab.htmlFor) : lab.querySelector('input');
      return { kind: 'click', el: inp || lab };
    }
    const els = document.querySelectorAll('button, a, input[type=button], input[type=submit], li, td, span, div, [role=button], [role=option]');
    for (const el of els) {
      if (isOurs(el) || !visible(el) || el.children.length > 1) continue;
      if (norm(textOf(el)) === want) return { kind: 'click', el };
    }
    // Looser match: option text contains the wanted text.
    for (const sel of document.querySelectorAll('select')) {
      if (isOurs(sel) || !visible(sel)) continue;
      for (const opt of sel.options) {
        if (want && norm(opt.text).includes(want)) return { kind: 'select', sel, opt };
      }
    }
    return null;
  }

  const findSave = () => findButton('Save') || findButton('Save Disposition') || findButton('Submit');

  function onDispositionPage() {
    if (settings.dispositions.some(d => findDisposition(d))) return true;
    return !onCallDetails() && !!findSave();
  }

  // ---------- job state ----------
  function loadJob() {
    try { return JSON.parse(sessionStorage.getItem(JOB_KEY)); } catch (e) { return null; }
  }
  function saveJob(job) {
    sessionStorage.setItem(JOB_KEY, JSON.stringify(job));
    document.documentElement.dataset.daRunning = job && job.running ? '1' : '0';
    render();
  }
  function stopJob(message, isError) {
    const job = loadJob() || {};
    job.running = false;
    job.message = message;
    job.error = !!isError;
    saveJob(job);
  }

  async function startRun(ctrl) {
    settings = await daGetSettings();
    const steps = settings.dispositions.filter(Boolean).concat([null]);
    saveJob({ type: 'run', running: true, ctrl, steps, idx: 0, phase: 'search', message: 'Starting...' });
    runner();
  }

  // fields: { phone } or { first, last }
  function startSiteSearch(fields, label) {
    saveJob({ type: 'site', running: true, fields, label, phase: 'search', message: `Searching site by ${label}...` });
    runner();
  }

  function status(msg) {
    const job = loadJob();
    if (!job) return;
    job.message = msg;
    saveJob(job);
  }

  function setPhase(phase, extra) {
    const job = loadJob();
    Object.assign(job, { phase }, extra || {});
    saveJob(job);
    return job;
  }

  // Get to the search form: use "New Search" if it's there, else load the URL.
  async function ensureSearchPage() {
    if (searchCtrlInput()) return true;
    const ns = findButton('New Search');
    if (ns) {
      click(ns);
      try {
        await waitFor(searchCtrlInput, 'search form', 5000);
        return true;
      } catch (e) {
        if (e.message === 'Stopped') throw e;
      }
    }
    location.href = location.origin + settings.searchPath;
    return false; // page is navigating; runner resumes on the new page
  }

  async function runner() {
    if (runnerActive) return;
    runnerActive = true;
    try {
      settings = await daGetSettings();
      let job = loadJob();
      document.documentElement.dataset.daRunning = job && job.running ? '1' : '0';
      while (job && job.running) {
        if (job.type === 'site') await stepSite(job);
        else await stepRun(job);
        job = loadJob();
        if (job && job.navigating) {
          job.navigating = false;
          saveJob(job);
          return;
        }
      }
    } catch (e) {
      if (e.message !== 'Stopped') stopJob(`Error: ${e.message}`, true);
    } finally {
      runnerActive = false;
    }
  }

  async function stepRun(job) {
    const stepNo = `Pass ${job.idx + 1}/${job.steps.length}`;
    const dispo = job.steps[job.idx];

    switch (job.phase) {
      case 'search': {
        status(`${stepNo}: searching ${job.ctrl}`);
        if (!(await ensureSearchPage())) return setPhase('search', { navigating: true });
        const input = await waitFor(searchCtrlInput, 'Control Number field');
        // Clear the other search fields so only the control number is used.
        const phone = searchPhoneInput();
        if (phone && phone.value) setValue(phone, '');
        setValue(input, job.ctrl);
        const btn = await waitFor(() => searchButtonFor(input), 'Search button');
        setPhase('select');
        click(btn);
        return;
      }
      case 'select': {
        status(`${stepNo}: selecting account`);
        const row = await waitFor(() => {
          const rows = resultRows();
          return rows.find(r => rowCtrl(r.tr) === job.ctrl) || (rows.length === 1 ? rows[0] : null);
        }, `result row for ${job.ctrl}`);
        setPhase('finish');
        click(row.btn);
        return;
      }
      case 'finish': {
        status(`${stepNo}: clicking Finish`);
        await waitFor(onCallDetails, 'Call Details page');
        const shown = callDetailsCtrl();
        if (shown && shown !== job.ctrl) throw new Error(`Opened control ${shown}, expected ${job.ctrl}`);
        setPhase('dispo');
        click(findButton('Finish'));
        return;
      }
      case 'dispo': {
        if (dispo === null) {
          await waitFor(onDispositionPage, 'disposition page');
          stopJob(`Done. ${job.ctrl} is on the disposition page — your turn.`);
          return;
        }
        status(`${stepNo}: disposition "${dispo}"`);
        const target = await waitFor(() => findDisposition(dispo), `disposition "${dispo}"`);
        if (target.kind === 'select') setValue(target.sel, target.opt.value);
        else click(target.el);
        await sleep(300);
        const save = await waitFor(findSave, 'Save button');
        setPhase('saved', { savedAt: Date.now() });
        click(save);
        return;
      }
      case 'saved': {
        status(`${stepNo}: saved, back to search`);
        const wait = settings.afterSaveMs - (Date.now() - (job.savedAt || 0));
        if (wait > 0) await sleep(wait);
        setPhase('search', { idx: job.idx + 1 });
        return;
      }
      default:
        throw new Error(`Unknown phase ${job.phase}`);
    }
  }


  const firstNameInput = () => findFieldByLabel(/^first\s*name\s*:?$/i, /first/i);
  const lastNameInput = () => findFieldByLabel(/^last\s*name\s*:?$/i, /last/i);

  function columnText(tr, re) {
    const table = tr.closest('table');
    if (!table) return '';
    const ths = table.querySelectorAll('thead th, thead td, tr:first-child th');
    for (let i = 0; i < ths.length; i++) {
      if (re.test(ths[i].textContent) && tr.cells[i]) return tr.cells[i].textContent.trim();
    }
    return '';
  }

  async function stepSite(job) {
    switch (job.phase) {
      case 'search': {
        if (!(await ensureSearchPage())) return setPhase('search', { navigating: true });
        const wanted = job.fields.phone
          ? [[searchPhoneInput, job.fields.phone, 'Phone Number field']]
          : [[firstNameInput, job.fields.first, 'First Name field'], [lastNameInput, job.fields.last, 'Last Name field']];
        // Clear every search field we know, then fill only the wanted ones.
        for (const f of [searchCtrlInput, searchPhoneInput, firstNameInput, lastNameInput]) {
          const el = f();
          if (el && el.value) setValue(el, '');
        }
        let input;
        for (const [find, value, what] of wanted) {
          if (!value) continue;
          input = await waitFor(find, what);
          setValue(input, value);
        }
        const btn = await waitFor(() => searchButtonFor(input), 'Search button');
        setPhase('results');
        click(btn);
        return;
      }
      case 'results': {
        const rows = await waitFor(() => {
          const r = resultRows();
          if (r.length) return r;
          return noResults() ? [] : null;
        }, 'search results');
        const seen = new Set();
        const results = [];
        for (const { tr } of rows) {
          const ctrl = rowCtrl(tr);
          if (!ctrl || seen.has(ctrl)) continue;
          seen.add(ctrl);
          const city = columnText(tr, /city/i);
          const state = columnText(tr, /^\s*state/i);
          results.push({ ctrl, name: columnText(tr, /^\s*name/i), info: [city, state].filter(Boolean).join(', ') });
        }
        const ui = loadUi();
        Object.assign(ui, { results, source: `site search (${job.label})`, names: [], note: '' });
        saveUi(ui);
        stopJob(results.length ? `Site search found ${results.length} account(s).` : `Site search by ${job.label}: no accounts found.`);
        return;
      }
    }
  }

  // ---------- floating panel ----------
  // Per-tab panel state (last lookup, results) lives in sessionStorage; the
  // panel's position/size is shared across tabs in chrome.storage.local.
  function loadUi() {
    try { return JSON.parse(sessionStorage.getItem(UI_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveUi(ui) {
    sessionStorage.setItem(UI_KEY, JSON.stringify(ui));
    render();
  }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const fmtPhone = p => (p && p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p || '');

  const ICON = {
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    min: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
    max: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, Arial, sans-serif; }
    svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
    .panel { --blue: #2563eb; --blue-d: #1d4ed8; --ink: #0f172a; --mut: #64748b; --line: #e2e8f0; --soft: #f8fafc;
      position: relative; display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; background: #fff; color: var(--ink);
      border: 1px solid #cbd5e1; border-radius: 12px; box-shadow: 0 12px 32px rgba(15,23,42,.22), 0 2px 6px rgba(15,23,42,.08);
      overflow: hidden; font-size: 13px; }
    .head { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; background: linear-gradient(180deg, #2563eb, #1d4ed8);
      color: #fff; cursor: grab; user-select: none; flex: none; }
    .head:active { cursor: grabbing; }
    .title { font-weight: 600; font-size: 13px; flex: 1; display: flex; align-items: center; gap: 8px; white-space: nowrap; overflow: hidden; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #93c5fd; flex: none; }
    .dot.run { background: #fde047; animation: pulse 1s infinite; }
    .dot.ok { background: #4ade80; } .dot.err { background: #f87171; }
    @keyframes pulse { 50% { opacity: .35; } }
    .hbtn { background: transparent; border: 0; color: #fff; width: 26px; height: 26px; border-radius: 6px; display: grid; place-items: center; cursor: pointer; padding: 0; }
    .hbtn:hover { background: rgba(255,255,255,.18); }
    .body { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
    .collapsed .body { display: none; }
    .lbl { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--mut); margin-bottom: 5px; }
    .field { display: flex; gap: 6px; }
    .inp { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; border: 1px solid #cbd5e1; border-radius: 8px; padding: 0 8px; background: #fff; }
    .inp:focus-within { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
    .inp svg { color: var(--mut); }
    input { flex: 1; min-width: 0; border: 0; outline: 0; padding: 8px 0; font-size: 14px; color: var(--ink); background: transparent; }
    .clear { border: 0; background: none; color: var(--mut); cursor: pointer; padding: 2px; display: grid; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; border: 0; border-radius: 8px; padding: 8px 12px;
      background: var(--blue); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .btn:hover { background: var(--blue-d); }
    .btn.ghost { background: #eef2ff; color: var(--blue-d); }
    .btn.ghost:hover { background: #e0e7ff; }
    .btn.danger { background: #fee2e2; color: #b91c1c; } .btn.danger:hover { background: #fecaca; }
    .btn.sm { padding: 5px 9px; font-size: 12px; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
    .chip { border: 1px solid var(--line); background: var(--soft); border-radius: 999px; padding: 2px 9px; font-size: 11.5px; color: #334155; cursor: pointer; }
    .chip:hover { border-color: #93c5fd; }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .card { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--soft); }
    .card .main { flex: 1; min-width: 0; }
    .ctrl { font-family: Consolas, "Cascadia Mono", monospace; font-size: 16px; font-weight: 700; letter-spacing: .02em; cursor: copy; }
    .sub { font-size: 11.5px; color: var(--mut); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ibtn { width: 32px; height: 32px; padding: 0; }
    .meta { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; color: var(--mut); }
    .empty { padding: 10px; border: 1px dashed #cbd5e1; border-radius: 10px; color: #475569; display: flex; flex-direction: column; gap: 8px; }
    .empty b { color: var(--ink); }
    .prog { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
    .prog-h { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: var(--soft); border-bottom: 1px solid var(--line); font-weight: 600; }
    .steps { list-style: none; margin: 0; padding: 6px 10px; }
    .steps li { display: flex; align-items: center; gap: 9px; padding: 5px 0; color: var(--mut); }
    .steps li.active { color: var(--ink); font-weight: 600; } .steps li.done { color: #15803d; } .steps li.fail { color: #b91c1c; }
    .si { width: 20px; height: 20px; border-radius: 50%; border: 2px solid #cbd5e1; display: grid; place-items: center; flex: none; font-size: 10px; }
    .done .si { background: #22c55e; border-color: #22c55e; color: #fff; } .done .si svg { width: 12px; height: 12px; stroke-width: 3; }
    .active .si { border-color: var(--blue); border-top-color: transparent; animation: spin .8s linear infinite; }
    .fail .si { border-color: #ef4444; background: #ef4444; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .msg { padding: 8px 10px; font-size: 12px; border-top: 1px solid var(--line); color: #334155; }
    .msg.ok { background: #f0fdf4; color: #166534; } .msg.err { background: #fef2f2; color: #b91c1c; }
    .foot { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; color: var(--mut); gap: 8px; }
    .foot a { color: var(--blue); cursor: pointer; text-decoration: none; } .foot a:hover { text-decoration: underline; }
    .warn { color: #b45309; }
    details summary { cursor: pointer; font-size: 12px; color: var(--mut); list-style: none; }
    details summary::before { content: "▸ "; } details[open] summary::before { content: "▾ "; }
    details .field { margin-top: 6px; }
    .rz { position: absolute; z-index: 2; }
    .rz.n, .rz.s { left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
    .rz.e, .rz.w { top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }
    .rz.n { top: 0; } .rz.s { bottom: 0; } .rz.e { right: 0; } .rz.w { left: 0; }
    .rz.nw, .rz.ne, .rz.sw, .rz.se { width: 12px; height: 12px; }
    .rz.nw { left: 0; top: 0; cursor: nwse-resize; } .rz.se { right: 0; bottom: 0; cursor: nwse-resize; }
    .rz.ne { right: 0; top: 0; cursor: nesw-resize; } .rz.sw { left: 0; bottom: 0; cursor: nesw-resize; }
    .rz.se::after { content: ""; position: absolute; right: 3px; bottom: 3px; width: 8px; height: 8px;
      border-right: 2px solid #94a3b8; border-bottom: 2px solid #94a3b8; border-bottom-right-radius: 3px; }
    .collapsed .rz { display: none; }
    .toast { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%) translateY(8px); background: #0f172a; color: #fff;
      padding: 6px 12px; border-radius: 999px; font-size: 12px; opacity: 0; pointer-events: none; transition: .18s; white-space: nowrap; }
    .toast.show { opacity: 1; transform: translateX(-50%); }
  `;

  const MIN_W = 270, MIN_H = 200, DEF_W = 330, MARGIN = 8;
  let shadow, els, host, layout, toastTimer, dataInfo = null;

  function buildPanel() {
    host = document.createElement('div');
    host.id = 'da-host';
    host.style.cssText = 'position:fixed;z-index:2147483647;display:flex;flex-direction:column;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="panel">
        <div class="head" id="head">
          <div class="title"><span class="dot" id="dot"></span><span>Dialer Assistant</span></div>
          <button class="hbtn" id="opts" title="Settings / import data">${ICON.gear}</button>
          <button class="hbtn" id="tog" title="Minimize">${ICON.min}</button>
        </div>
        <div class="body">
          <div>
            <div class="lbl">Caller phone</div>
            <div class="field">
              <label class="inp">${ICON.search}<input id="phone" placeholder="Paste or type a number" autocomplete="off">
                <button class="clear" id="clr" title="Clear">${ICON.x}</button></label>
              <button class="btn" id="lookup">Find</button>
            </div>
            <div class="chips" id="recent"></div>
          </div>
          <div id="results"></div>
          <div id="progress"></div>
          <details id="manual">
            <summary>Run with a control number</summary>
            <div class="field">
              <label class="inp"><input id="ctrl" placeholder="Control #" autocomplete="off"></label>
              <button class="btn" id="runManual">${ICON.play} Run</button>
            </div>
          </details>
          <div class="foot"><span id="data"></span><a id="opts2">Settings</a></div>
        </div>
        ${['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].map(d => `<div class="rz ${d}" data-rz="${d}"></div>`).join('')}
        <div class="toast" id="toast"></div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = id => shadow.getElementById(id);
    els = { panel: shadow.querySelector('.panel'), phone: $('phone'), results: $('results'), progress: $('progress'),
            recent: $('recent'), ctrl: $('ctrl'), dot: $('dot'), tog: $('tog'), data: $('data'), toast: $('toast') };

    $('tog').onclick = () => setCollapsed(!loadUi().collapsed);
    $('opts').onclick = $('opts2').onclick = () => chrome.runtime.sendMessage({ type: 'openOptions' });
    $('lookup').onclick = () => doLookup();
    $('clr').onclick = e => {
      e.preventDefault();
      els.phone.value = '';
      const ui = loadUi();
      Object.assign(ui, { phone: '', results: null, names: [], note: '' });
      saveUi(ui);
      els.phone.focus();
    };
    els.phone.onkeydown = e => { if (e.key === 'Enter') doLookup(); };
    // Pasting a number looks it up right away.
    els.phone.onpaste = () => setTimeout(() => { if (daNormalizePhone(els.phone.value)) doLookup(); }, 0);
    $('runManual').onclick = () => {
      const c = daNormalizeCtrl(els.ctrl.value);
      if (c) startRun(c);
    };
    els.ctrl.onkeydown = e => { if (e.key === 'Enter') $('runManual').click(); };

    shadow.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const { act, v } = b.dataset;
      if (act === 'copy') { copyText(v); toast(`Copied ${v}`); }
      else if (act === 'run') startRun(v);
      else if (act === 'recent') { els.phone.value = v; doLookup(); }
      else if (act === 'site-phone') startSiteSearch({ phone: v }, 'phone');
      else if (act === 'site-name') {
        const parts = v.trim().split(/\s+/);
        startSiteSearch({ first: parts.length > 1 ? parts[0] : '', last: parts[parts.length - 1] }, `name "${v}"`);
      }
      else if (act === 'stop') stopJob('Stopped by user.');
      else if (act === 'dismiss') { sessionStorage.removeItem(JOB_KEY); render(); }
    });

    initDragResize($('head'));

    const ui = loadUi();
    if (ui.phone) els.phone.value = ui.phone;
    chrome.storage.local.get(['panelLayout', 'importInfo']).then(st => {
      dataInfo = st.importInfo || null;
      layout = st.panelLayout || {};
      applyLayout();
      render();
    });
    chrome.storage.onChanged.addListener(ch => {
      if (ch.importInfo) { dataInfo = ch.importInfo.newValue || null; render(); }
    });
    window.addEventListener('resize', () => applyLayout());
    // Content grows/shrinks with results: keep the panel fully on screen.
    let lastH = 0;
    new ResizeObserver(() => {
      const h = host.offsetHeight;
      if (h !== lastH && layout) { lastH = h; applyLayout(); }
    }).observe(host);
    render();
  }

  // ---- position & size (drag the header, resize from the corner grip) ----
  function applyLayout() {
    const collapsed = !!loadUi().collapsed;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(Math.max(layout.w || DEF_W, MIN_W), vw - 2 * MARGIN);
    host.style.width = `${w}px`;
    if (collapsed || !layout.h) {
      host.style.height = '';
      host.style.maxHeight = `${vh - 2 * MARGIN}px`;
    } else {
      host.style.height = `${Math.min(Math.max(layout.h, MIN_H), vh - 2 * MARGIN)}px`;
      host.style.maxHeight = '';
    }
    const rect = host.getBoundingClientRect();
    const x = layout.x == null ? vw - w - 16 : layout.x;
    const y = layout.y == null ? vh - rect.height - 16 : layout.y;
    host.style.left = `${Math.min(Math.max(x, MARGIN), vw - w - MARGIN)}px`;
    host.style.top = `${Math.min(Math.max(y, MARGIN), vh - rect.height - MARGIN)}px`;
  }

  function saveLayout() {
    chrome.storage.local.set({ panelLayout: layout });
  }

  function initDragResize(head) {
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const r = host.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const move = ev => {
        layout.x = ev.clientX - dx;
        layout.y = ev.clientY - dy;
        applyLayout();
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        const r2 = host.getBoundingClientRect();
        layout.x = r2.left; layout.y = r2.top;
        saveLayout();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up, { once: true });
    });
    head.addEventListener('dblclick', e => { if (!e.target.closest('button')) setCollapsed(!loadUi().collapsed); });

    // Resize from any edge or corner; the opposite edge stays put.
    for (const grip of shadow.querySelectorAll('[data-rz]')) {
      const d = grip.dataset.rz;
      grip.addEventListener('pointerdown', e => {
        e.preventDefault();
        const r = host.getBoundingClientRect();
        const sx = e.clientX, sy = e.clientY;
        const vw = window.innerWidth, vh = window.innerHeight;
        grip.setPointerCapture(e.pointerId);
        const move = ev => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          let { left, top, right, bottom } = r;
          if (d.includes('w')) left = Math.min(Math.max(left + dx, MARGIN), right - MIN_W);
          if (d.includes('e')) right = Math.max(Math.min(right + dx, vw - MARGIN), left + MIN_W);
          if (d.includes('n')) top = Math.min(Math.max(top + dy, MARGIN), bottom - MIN_H);
          if (d.includes('s')) bottom = Math.max(Math.min(bottom + dy, vh - MARGIN), top + MIN_H);
          Object.assign(layout, { x: left, y: top, w: right - left });
          if (d.includes('n') || d.includes('s')) layout.h = bottom - top;
          applyLayout();
        };
        const up = () => { grip.removeEventListener('pointermove', move); saveLayout(); };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up, { once: true });
      });
      // Double-click an edge to go back to automatic height.
      grip.addEventListener('dblclick', () => { delete layout.h; saveLayout(); applyLayout(); });
    }
  }

  function setCollapsed(c) {
    const ui = loadUi();
    ui.collapsed = c;
    saveUi(ui);
    applyLayout();
  }

  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1400);
  }

  async function doLookup() {
    const phone = daNormalizePhone(els.phone.value);
    const ui = loadUi();
    ui.phone = els.phone.value;
    if (!phone) {
      Object.assign(ui, { results: null, names: [], note: 'Enter a 10-digit phone number.' });
      return saveUi(ui);
    }
    els.phone.value = fmtPhone(phone);
    ui.phone = els.phone.value;
    const res = await chrome.runtime.sendMessage({ type: 'lookup', phone });
    ui.results = res && res.ok ? res.ctrls.map(ctrl => ({ ctrl })) : [];
    ui.names = res && res.ok ? res.names : [];
    ui.source = 'cellphone file';
    ui.lookedUp = phone;
    ui.note = res && !res.ok ? `Lookup error: ${res.error}` : '';
    ui.recent = [phone].concat((ui.recent || []).filter(p => p !== phone)).slice(0, 5);
    saveUi(ui);
    if (ui.results.length === 1) {
      copyText(ui.results[0].ctrl);
      toast(`Copied ${ui.results[0].ctrl}`);
    }
  }

  // The dialer is plain http, where navigator.clipboard is unavailable.
  function copyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }

  function renderResults(ui) {
    if (ui.note && !Array.isArray(ui.results)) return `<div class="meta">${esc(ui.note)}</div>`;
    if (!Array.isArray(ui.results)) return '';
    // Older sessions stored plain strings.
    const results = ui.results.map(r => (typeof r === 'string' ? { ctrl: r } : r));
    let html = '';
    if (results.length) {
      html += `<div class="meta"><span>${results.length} account${results.length > 1 ? 's' : ''} · ${esc(ui.source)}</span></div><div class="list">`;
      for (const r of results) {
        const sub = [r.name, r.info].filter(Boolean).join(' · ');
        html += `<div class="card">
          <div class="main"><div class="ctrl" data-act="copy" data-v="${esc(r.ctrl)}" title="Click to copy">${esc(r.ctrl)}</div>
            ${sub ? `<div class="sub" title="${esc(sub)}">${esc(sub)}</div>` : ''}</div>
          <button class="btn ghost ibtn" data-act="copy" data-v="${esc(r.ctrl)}" title="Copy">${ICON.copy}</button>
          <button class="btn sm" data-act="run" data-v="${esc(r.ctrl)}" title="Run the disposition passes">${ICON.play} Run</button>
        </div>`;
      }
      html += '</div>';
    } else {
      html += `<div class="empty"><div>No control number for <b>${esc(fmtPhone(ui.lookedUp) || 'this search')}</b> in the ${esc(ui.source)}.</div>`;
      for (const n of ui.names || []) {
        html += `<div>This phone belongs to <b>${esc(n)}</b>.</div>
          <button class="btn ghost sm" data-act="site-name" data-v="${esc(n)}">${ICON.search} Search site for “${esc(n)}”</button>`;
      }
      if (ui.lookedUp) html += `<button class="btn ghost sm" data-act="site-phone" data-v="${esc(ui.lookedUp)}">${ICON.search} Search site by phone</button>`;
      html += '</div>';
    }
    if (ui.note) html += `<div class="meta">${esc(ui.note)}</div>`;
    return html;
  }

  function renderProgress(job) {
    if (!job) return '';
    if (job.type !== 'run') {
      if (!job.message) return '';
      const cls = job.error ? 'err' : job.running ? '' : 'ok';
      return `<div class="prog"><div class="msg ${cls}" style="border-top:0">${esc(job.message)}</div></div>`;
    }
    const steps = job.steps.map((d, i) => {
      let cls = 'todo';
      if (i < job.idx) cls = 'done';
      else if (i === job.idx) cls = job.running ? 'active' : job.error ? 'fail' : /^Done/.test(job.message) ? 'done' : 'todo';
      const label = d === null ? 'Open disposition page for agent' : esc(d);
      return `<li class="${cls}"><span class="si">${cls === 'done' ? ICON.check : ''}</span>${label}</li>`;
    }).join('');
    const msgCls = job.error ? 'err' : !job.running && /^Done/.test(job.message) ? 'ok' : '';
    const btn = job.running
      ? '<button class="btn danger sm" data-act="stop">Stop</button>'
      : '<button class="hbtn" style="color:#64748b" data-act="dismiss" title="Dismiss">' + ICON.x + '</button>';
    return `<div class="prog">
      <div class="prog-h"><span>Run · <span class="ctrl" style="font-size:13px">${esc(job.ctrl)}</span></span>${btn}</div>
      <ol class="steps">${steps}</ol>
      ${job.message ? `<div class="msg ${msgCls}">${esc(job.message)}</div>` : ''}
    </div>`;
  }

  function render() {
    if (!shadow) return;
    const ui = loadUi();
    const job = loadJob();
    els.panel.classList.toggle('collapsed', !!ui.collapsed);
    els.tog.innerHTML = ui.collapsed ? ICON.max : ICON.min;
    els.tog.title = ui.collapsed ? 'Expand' : 'Minimize';

    els.dot.className = 'dot' + (job && job.running ? ' run' : job && job.error ? ' err' : job && job.message && /^Done/.test(job.message) ? ' ok' : '');

    els.recent.innerHTML = (ui.recent || [])
      .filter(p => p !== ui.lookedUp || !Array.isArray(ui.results))
      .map(p => `<span class="chip" data-act="recent" data-v="${p}">${fmtPhone(p)}</span>`).join('');
    els.results.innerHTML = renderResults(ui);
    els.progress.innerHTML = renderProgress(job);

    els.data.innerHTML = dataInfo
      ? `${dataInfo.phones.toLocaleString()} phones loaded`
      : '<span class="warn">No cellphone data imported yet</span>';
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'togglePanel') setCollapsed(!loadUi().collapsed);
    if (msg.type === 'focusPhone') {
      if (loadUi().collapsed) setCollapsed(false);
      els.phone.focus();
      els.phone.select();
    }
  });

  daGetSettings().then(s => {
    settings = s;
    buildPanel();
    runner();
  });
})();
