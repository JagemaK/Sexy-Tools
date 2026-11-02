// Sean's Dialer content script: floating panel + automation runner.
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
    const wasRunning = job.running;
    job.running = false;
    job.message = message;
    job.error = !!isError;
    saveJob(job);
    if (wasRunning) {
      const what = job.type === 'run' ? `Run ${job.ctrl}: ${message}` : message;
      daLog(job.type === 'run' ? 'run' : 'search', what, { error: !!isError, ok: !isError && /^Done/.test(message) });
    }
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
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
    phone: '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>',
    login: '<svg viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg>',
    logout: '<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
    user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5"/></svg>',
    cup: '<svg viewBox="0 0 24 24"><path d="M17 8h1a4 4 0 0 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/><path d="M6 2v3M10 2v3M14 2v3"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>'
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, Arial, sans-serif; }
    svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
    .panel { --blue: #2563eb; --blue-d: #1d4ed8; --ink: #0f172a; --mut: #64748b; --line: #e2e8f0; --soft: #f8fafc;
      --green: #16a34a; --red: #dc2626; --amber: #d97706;
      position: relative; display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; background: #fff; color: var(--ink);
      border: 1px solid rgba(15,23,42,.18); border-radius: 14px; overflow: hidden; font-size: 13px;
      box-shadow: 0 18px 40px rgba(15,23,42,.28), 0 2px 8px rgba(15,23,42,.10); }
    /* header */
    .head { display: flex; align-items: center; gap: 10px; padding: 9px 8px 9px 10px; flex: none; user-select: none; cursor: grab; color: #fff;
      background: radial-gradient(120% 140% at 0% 0%, #3b82f6 0%, #1e3a8a 55%, #0f172a 100%); }
    .head:active { cursor: grabbing; }
    .logo { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; font-weight: 800; font-size: 12px; letter-spacing: .02em;
      background: linear-gradient(135deg, #fff, #c7d2fe); color: #1e3a8a; box-shadow: inset 0 -2px 0 rgba(30,58,138,.15); flex: none; }
    .ttl { flex: 1; min-width: 0; line-height: 1.15; }
    .name { font-weight: 700; font-size: 13.5px; display: flex; align-items: center; gap: 7px; white-space: nowrap; }
    .hsub { font-size: 11px; color: #c7d2fe; display: flex; gap: 8px; align-items: center; white-space: nowrap; overflow: hidden; }
    .hsub b { color: #fff; font-weight: 600; font-variant-numeric: tabular-nums; }
    .pill { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 1px 7px; font-size: 10.5px; font-weight: 700; letter-spacing: .03em; }
    .pill.in { background: rgba(34,197,94,.22); color: #bbf7d0; } .pill.pb { background: rgba(251,191,36,.25); color: #fde68a; } .pill.out { background: rgba(148,163,184,.25); color: #e2e8f0; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #93c5fd; flex: none; box-shadow: 0 0 0 2px rgba(255,255,255,.15); }
    .dot.run { background: #fde047; animation: pulse 1s infinite; }
    .dot.ok { background: #4ade80; } .dot.err { background: #f87171; }
    @keyframes pulse { 50% { opacity: .35; } }
    .hbtn { background: transparent; border: 0; color: #fff; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; cursor: pointer; padding: 0; }
    .hbtn:hover { background: rgba(255,255,255,.16); }
    /* tabs */
    .tabs { display: flex; gap: 2px; padding: 0 8px; background: #f1f5f9; border-bottom: 1px solid var(--line); flex: none; }
    .tab { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 0; background: none; cursor: pointer;
      padding: 9px 4px 8px; font-size: 12.5px; font-weight: 600; color: var(--mut); border-bottom: 2px solid transparent; white-space: nowrap; }
    .tab:hover { color: var(--ink); }
    .tab.on { color: var(--blue-d); border-bottom-color: var(--blue); }
    .badge { font-size: 10px; background: #dbeafe; color: var(--blue-d); border-radius: 999px; padding: 0 6px; font-weight: 700; }
    .badge:empty { display: none; }
    .body { flex: 1; overflow: auto; padding: 12px; }
    .pane { display: none; flex-direction: column; gap: 12px; } .pane.on { display: flex; }
    .collapsed .body, .collapsed .tabs { display: none; }
    /* banner (clock countdown etc.) */
    .banner { display: none; align-items: center; gap: 8px; padding: 8px 10px; font-size: 12.5px; font-weight: 600; flex: none; }
    .banner.on { display: flex; }
    .banner.warn { background: #fffbeb; color: #92400e; border-bottom: 1px solid #fde68a; }
    .banner.ok { background: #f0fdf4; color: #166534; border-bottom: 1px solid #bbf7d0; }
    .banner.err { background: #fef2f2; color: #991b1b; border-bottom: 1px solid #fecaca; }
    .banner .sp { flex: 1; }
    .lbl { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--mut); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
    .lbl a { text-transform: none; letter-spacing: 0; font-weight: 600; }
    .field { display: flex; gap: 6px; }
    .inp { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; border: 1px solid #cbd5e1; border-radius: 9px; padding: 0 9px; background: #fff; transition: .15s; }
    .inp:focus-within { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
    .inp svg { color: var(--mut); }
    input, select { flex: 1; min-width: 0; border: 0; outline: 0; padding: 8px 0; font-size: 14px; color: var(--ink); background: transparent; }
    select { cursor: pointer; }
    input[type=time] { font-variant-numeric: tabular-nums; }
    .clear { border: 0; background: none; color: var(--mut); cursor: pointer; padding: 2px; display: grid; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 0; border-radius: 9px; padding: 8px 12px;
      background: var(--blue); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: .15s;
      box-shadow: 0 1px 2px rgba(15,23,42,.12); }
    .btn:hover { background: var(--blue-d); }
    .btn:disabled { opacity: .5; cursor: default; }
    .btn.ghost { background: #eef2ff; color: var(--blue-d); box-shadow: none; } .btn.ghost:hover { background: #e0e7ff; }
    .btn.green { background: var(--green); } .btn.green:hover { background: #15803d; }
    .btn.gray { background: #475569; } .btn.gray:hover { background: #334155; }
    .btn.danger { background: #fee2e2; color: #b91c1c; box-shadow: none; } .btn.danger:hover { background: #fecaca; }
    .btn.sm { padding: 5px 9px; font-size: 12px; } .btn.block { width: 100%; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
    .chip { border: 1px solid var(--line); background: var(--soft); border-radius: 999px; padding: 2px 9px; font-size: 11.5px; color: #334155; cursor: pointer; }
    .chip:hover { border-color: #93c5fd; }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .card { display: flex; align-items: center; gap: 8px; padding: 9px 8px 9px 11px; border: 1px solid var(--line); border-radius: 11px; background: var(--soft); }
    .card .main { flex: 1; min-width: 0; }
    .ctrl { font-family: Consolas, "Cascadia Mono", monospace; font-size: 16px; font-weight: 700; letter-spacing: .02em; cursor: copy; }
    .sub { font-size: 11.5px; color: var(--mut); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ibtn { width: 32px; height: 32px; padding: 0; }
    .meta { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; color: var(--mut); }
    .empty { padding: 10px; border: 1px dashed #cbd5e1; border-radius: 11px; color: #475569; display: flex; flex-direction: column; gap: 8px; }
    .empty b { color: var(--ink); }
    .box { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: #fff; }
    .box-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 11px; background: var(--soft); border-bottom: 1px solid var(--line); font-weight: 700; font-size: 12.5px; }
    .box-b { padding: 10px 11px; display: flex; flex-direction: column; gap: 10px; }
    .steps { list-style: none; margin: 0; padding: 6px 11px; }
    .steps li { display: flex; align-items: center; gap: 9px; padding: 5px 0; color: var(--mut); }
    .steps li.active { color: var(--ink); font-weight: 600; } .steps li.done { color: #15803d; } .steps li.fail { color: #b91c1c; }
    .si { width: 20px; height: 20px; border-radius: 50%; border: 2px solid #cbd5e1; display: grid; place-items: center; flex: none; font-size: 10px; }
    .done .si { background: #22c55e; border-color: #22c55e; color: #fff; } .done .si svg { width: 12px; height: 12px; stroke-width: 3; }
    .active .si { border-color: var(--blue); border-top-color: transparent; animation: spin .8s linear infinite; }
    .fail .si { border-color: #ef4444; background: #ef4444; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .msg { padding: 8px 11px; font-size: 12px; border-top: 1px solid var(--line); color: #334155; }
    .msg.ok { background: #f0fdf4; color: #166534; } .msg.err { background: #fef2f2; color: #b91c1c; }
    .foot { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; color: var(--mut); gap: 8px; }
    a.lnk, .foot a { color: var(--blue); cursor: pointer; text-decoration: none; font-size: 11.5px; } a.lnk:hover, .foot a:hover { text-decoration: underline; }
    .warn { color: #b45309; }
    details summary { cursor: pointer; font-size: 12px; color: var(--mut); list-style: none; }
    details summary::before { content: "▸ "; } details[open] summary::before { content: "▾ "; }
    details .field { margin-top: 6px; }
    /* time clock */
    .status { display: flex; align-items: center; gap: 10px; }
    .big { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 800; padding: 5px 11px; border-radius: 999px; }
    .big.in { background: #dcfce7; color: #166534; } .big.out { background: #f1f5f9; color: #475569; } .big.unk { background: #fef3c7; color: #92400e; }
    .big i { width: 8px; height: 8px; border-radius: 50%; background: currentColor; display: block; }
    .timer { font-family: Consolas, monospace; font-size: 15px; font-weight: 700; color: var(--ink); margin-left: auto; }
    .clocks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .clk { border: 1px solid var(--line); border-radius: 10px; padding: 7px 9px; background: var(--soft); }
    .clk.sel { border-color: #93c5fd; background: #eff6ff; }
    .clk small { display: block; font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--mut); }
    .clk b { font-size: 16px; font-variant-numeric: tabular-nums; }
    .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .next { font-size: 12.5px; color: #334155; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .next b { color: var(--ink); }
    .today { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
    .today div { display: flex; align-items: center; gap: 7px; color: #475569; }
    .tag { font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 1px 7px; background: #f1f5f9; color: #475569; text-transform: uppercase; letter-spacing: .03em; }
    .tag.done { background: #dcfce7; color: #166534; } .tag.missed { background: #fee2e2; color: #991b1b; }
    .tag.due, .tag.warn { background: #fef3c7; color: #92400e; } .tag.skipped { background: #e2e8f0; color: #475569; }
    .switch { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-weight: 600; cursor: pointer; }
    .switch input { display: none; }
    .switch span.t { width: 38px; height: 22px; border-radius: 999px; background: #cbd5e1; position: relative; transition: .2s; flex: none; }
    .switch span.t::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: .2s; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
    .switch input:checked + span.t { background: var(--green); } .switch input:checked + span.t::after { left: 19px; }
    .days { display: flex; gap: 4px; }
    .day { flex: 1; border: 1px solid #cbd5e1; background: #fff; border-radius: 8px; padding: 5px 0; font-size: 12px; font-weight: 700; color: #475569; cursor: pointer; }
    .day.on { background: var(--blue); border-color: var(--blue); color: #fff; }
    .seg { display: flex; background: #f1f5f9; border-radius: 9px; padding: 3px; gap: 3px; }
    .seg button { flex: 1; border: 0; background: none; border-radius: 7px; padding: 6px 4px; font-size: 12px; font-weight: 600; color: #475569; cursor: pointer; }
    .seg button.on { background: #fff; color: var(--blue-d); box-shadow: 0 1px 3px rgba(15,23,42,.15); }
    .flab { font-size: 11.5px; font-weight: 600; color: #475569; margin-bottom: 4px; }
    .hint { font-size: 11.5px; color: var(--mut); }
    .brk { border: 1px solid var(--line); border-radius: 11px; padding: 9px 10px; display: flex; flex-direction: column; gap: 8px; background: var(--soft); }
    .brk.on { background: #fffbeb; border-color: #fde68a; }
    .brk-h { display: flex; align-items: center; gap: 8px; font-weight: 700; }
    .brk-h .timer { color: #92400e; }
    .brk .inp select { padding: 6px 0; font-size: 13px; }
    .btn.amber { background: #f59e0b; color: #fff; } .btn.amber:hover { background: #d97706; }
    .brow { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
    .brow .inp { flex: 1; } .brow .inp:first-child { flex: 1.3; } .brow .rm { border: 0; background: #fee2e2; color: #b91c1c; border-radius: 8px; width: 30px; height: 34px; cursor: pointer; display: grid; place-items: center; }
    /* activity */
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .stat { border: 1px solid var(--line); border-radius: 10px; padding: 7px 8px; background: var(--soft); text-align: center; }
    .stat b { display: block; font-size: 18px; } .stat small { font-size: 10.5px; color: var(--mut); font-weight: 600; }
    .log { display: flex; flex-direction: column; }
    .li { display: flex; gap: 8px; padding: 7px 2px; border-bottom: 1px solid #f1f5f9; font-size: 12px; align-items: flex-start; }
    .li .ic { width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center; background: #eef2ff; color: var(--blue-d); flex: none; }
    .li .ic svg { width: 12px; height: 12px; }
    .li.err .ic { background: #fee2e2; color: #b91c1c; } .li.ok .ic { background: #dcfce7; color: #166534; }
    .li .tx { flex: 1; min-width: 0; color: #334155; } .li time { color: var(--mut); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
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
      padding: 7px 13px; border-radius: 999px; font-size: 12px; opacity: 0; pointer-events: none; transition: .18s; white-space: nowrap; z-index: 3; }
    .toast.show { opacity: 1; transform: translateX(-50%); }
  `;

  const MIN_W = 290, MIN_H = 220, DEF_W = 350, MARGIN = 8;
  let shadow, els, host, layout, toastTimer, dataInfo = null;
  let clockState = null, supervisors = { list: [], current: '' }, activity = [], clockMsg = null;

  function buildPanel() {
    host = document.createElement('div');
    host.id = 'da-host';
    host.style.cssText = 'position:fixed;z-index:2147483647;display:flex;flex-direction:column;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="panel">
        <div class="head" id="head">
          <div class="logo">SD</div>
          <div class="ttl">
            <div class="name">Sean's Dialer <span class="dot" id="dot"></span></div>
            <div class="hsub" id="hsub"></div>
          </div>
          <button class="hbtn" id="opts" title="Settings / import data">${ICON.gear}</button>
          <button class="hbtn" id="tog" title="Minimize">${ICON.min}</button>
        </div>
        <div id="bannerWrap"></div>
        <nav class="tabs">
          <button class="tab" data-tab="lookup">${ICON.search} Lookup</button>
          <button class="tab" data-tab="clock">${ICON.clock} Time Clock <span class="badge" id="clockBadge"></span></button>
          <button class="tab" data-tab="log">${ICON.list} Activity</button>
        </nav>
        <div class="body">
          <section class="pane" data-pane="lookup">
            <div>
              <div class="lbl">Caller phone</div>
              <div class="field">
                <label class="inp">${ICON.phone}<input id="phone" placeholder="Paste or type a number" autocomplete="off">
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
          </section>
          <section class="pane" data-pane="clock">
            <div class="box"><div class="box-b" id="ckLive"></div></div>
            <div class="box">
              <div class="box-h"><span style="display:flex;align-items:center;gap:7px">${ICON.clock} Schedule</span></div>
              <div class="box-b" id="ckForm"></div>
            </div>
          </section>
          <section class="pane" data-pane="log">
            <div class="stats" id="stats"></div>
            <div class="lbl">Recent activity <a class="lnk" data-act="clear-log">Clear</a></div>
            <div class="log" id="log"></div>
          </section>
        </div>
        ${['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].map(d => `<div class="rz ${d}" data-rz="${d}"></div>`).join('')}
        <div class="toast" id="toast"></div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = id => shadow.getElementById(id);
    els = { panel: shadow.querySelector('.panel'), phone: $('phone'), results: $('results'), progress: $('progress'),
            recent: $('recent'), ctrl: $('ctrl'), dot: $('dot'), tog: $('tog'), data: $('data'), toast: $('toast'),
            hsub: $('hsub'), bannerWrap: $('bannerWrap'), ckLive: $('ckLive'), ckForm: $('ckForm'), clockBadge: $('clockBadge'),
            stats: $('stats'), log: $('log') };

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
      const tab = e.target.closest('[data-tab]');
      if (tab) {
        const ui = loadUi();
        ui.tab = tab.dataset.tab;
        saveUi(ui);
        return;
      }
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
      else if (act === 'clear-log') chrome.storage.local.set({ activity: [] });
      else clockAction(act, v, b);
    });
    els.ckForm.addEventListener('change', () => saveClockForm(false));
    els.ckLive.addEventListener('change', e => {
      if (e.target.id !== 'brMin') return;
      const ui = loadUi(); ui.brMin = Number(e.target.value); saveUi(ui);
      e.target.blur();
    });

    initDragResize($('head'));

    const ui = loadUi();
    if (ui.phone) els.phone.value = ui.phone;
    chrome.storage.local.get(['panelLayout', 'importInfo', 'supervisors', 'activity']).then(st => {
      dataInfo = st.importInfo || null;
      layout = st.panelLayout || {};
      supervisors = st.supervisors || supervisors;
      activity = st.activity || [];
      applyLayout();
      render();
    });
    chrome.storage.onChanged.addListener(ch => {
      if (ch.importInfo) { dataInfo = ch.importInfo.newValue || null; render(); }
      if (ch.supervisors) { supervisors = ch.supervisors.newValue || supervisors; renderClockForm(false); }
      if (ch.activity) { activity = ch.activity.newValue || []; renderLog(); }
      if (ch.clock) renderClockForm(false);
    });
    window.addEventListener('resize', () => applyLayout());
    // Content grows/shrinks with results: keep the panel fully on screen.
    let lastH = 0;
    new ResizeObserver(() => {
      const h = host.offsetHeight;
      if (h !== lastH && layout) { lastH = h; applyLayout(); }
    }).observe(host);
    render();
    renderClockForm(true);
    setInterval(liveTick, 1000);
    liveTick();
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
    daLog('lookup', `Looked up ${fmtPhone(phone)}: ${ui.results.length ? ui.results.map(r => r.ctrl).join(', ') : ui.names.length ? 'name only (' + ui.names.join(', ') + ')' : 'no match'}`);
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
    const tab = ui.tab || 'lookup';
    for (const t of shadow.querySelectorAll('[data-tab]')) t.classList.toggle('on', t.dataset.tab === tab);
    for (const p of shadow.querySelectorAll('[data-pane]')) p.classList.toggle('on', p.dataset.pane === tab);

    els.dot.className = 'dot' + (job && job.running ? ' run' : job && job.error ? ' err' : job && job.message && /^Done/.test(job.message) ? ' ok' : '');

    els.recent.innerHTML = (ui.recent || [])
      .filter(p => p !== ui.lookedUp || !Array.isArray(ui.results))
      .map(p => `<span class="chip" data-act="recent" data-v="${p}">${fmtPhone(p)}</span>`).join('');
    els.results.innerHTML = renderResults(ui);
    els.progress.innerHTML = renderProgress(job);

    els.data.innerHTML = dataInfo
      ? `${dataInfo.phones.toLocaleString()} phones loaded`
      : '<span class="warn">No cellphone data imported yet</span>';
    renderLog();
  }

  // ---------- Time Clock tab ----------
  const SDC = window.SDClock;
  const fmtTime = (d, sec = true) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: sec ? '2-digit' : undefined });
  const clockFmt = ms => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${s >= 3600 ? Math.floor(s / 3600) + ':' : ''}${String(Math.floor(s / 60) % 60).padStart(s >= 3600 ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  function fmtIn(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  function wallOf(at) { // real ms -> Date showing the chosen source's wall time
    return daWallNow(clockState.cfg.source, clockState.offsetMs, at);
  }

  async function liveTick() {
    clockState = await daGetClock();
    const { cfg, offsetMs, hasDialerClock } = clockState;
    const brk = clockState.breakState;
    const plan = daClockPlan(clockState);
    const st = SDC ? SDC.status() : null;
    const timer = SDC ? SDC.shiftTimer() : '';
    const dialerNow = new Date(Date.now() + offsetMs);

    // header line: dialer time + clock status
    els.hsub.title = hasDialerClock ? 'Dialer time' : 'This PC (dialer clock not seen yet)';
    els.hsub.innerHTML = `${ICON.clock}<b>${hasDialerClock ? fmtTime(dialerNow) : fmtTime(new Date())}</b>` +
      (brk.on ? `<span class="pill pb">BREAK ${clockFmt(Date.now() - brk.since)}</span>`
        : st ? `<span class="pill ${st}">${st === 'in' ? 'IN' : 'OUT'}${st === 'in' && timer ? ' ' + timer : ''}</span>` : '');

    // countdown / result banner (shown on every tab, even minimized)
    const warn = plan.today.find(e => e.status === 'warn' || e.status === 'due');
    let banner = '';
    const brkLeft = brk.on && brk.plannedEnd ? brk.plannedEnd - Date.now() : null;
    if (brkLeft != null && brkLeft <= Math.max(cfg.warnMin, 1) * 60000) {
      banner = `<div class="banner on warn">${ICON.cup}<span>Break ends ${brkLeft > 0 ? 'in ' + fmtIn(brkLeft) : 'now…'}</span><span class="sp"></span>
        <button class="btn sm ghost" data-act="br-ext" data-v="5">+5 min</button>
        <button class="btn sm ghost" data-act="br-end">End now</button></div>`;
    } else if (warn) {
      const left = warn.at - Date.now();
      banner = `<div class="banner on warn">${warn.kind[0] === 'b' ? ICON.cup : ICON.alert}<span>${daKindLabel(warn.kind)} ${left > 0 ? 'in ' + fmtIn(left) : 'now…'}</span><span class="sp"></span>
        <button class="btn sm ghost" data-act="ck-skip" data-v="${warn.kind}">Skip today</button></div>`;
    } else if (clockMsg && Date.now() - clockMsg.at < 15000) {
      banner = `<div class="banner on ${clockMsg.err ? 'err' : 'ok'}">${clockMsg.err ? ICON.alert : ICON.check}<span>${esc(clockMsg.text)}</span></div>`;
    }
    if (els.bannerWrap.dataset.h !== banner) {
      els.bannerWrap.innerHTML = banner;
      els.bannerWrap.dataset.h = banner;
    }
    els.clockBadge.textContent = cfg.enabled && plan.next ? daFmtHm(`${wallOf(plan.next.at).getHours()}:${wallOf(plan.next.at).getMinutes()}`) : '';

    if ((loadUi().tab || 'lookup') !== 'clock') return;
    // don't redraw under an open dropdown
    if (els.ckLive.contains(shadow.activeElement) && shadow.activeElement.tagName === 'SELECT') return;
    const pcNow = new Date();
    const diffMin = Math.round(offsetMs / 60000);
    const diffText = !hasDialerClock ? 'Dialer clock not seen yet (open the dialer page with the top bar).'
      : Math.abs(diffMin) < 1 ? 'Dialer and PC clocks match.'
      : `Dialer is ${fmtIn(Math.abs(offsetMs))} ${diffMin > 0 ? 'ahead of' : 'behind'} this PC.`;
    const stHtml = st === 'in' ? '<span class="big in"><i></i>Clocked in</span>'
      : st === 'out' ? '<span class="big out"><i></i>Clocked out</span>'
      : '<span class="big unk"><i></i>Status unknown</span>';
    let next = '<span class="hint">Automatic clock in/out is off.</span>';
    if (cfg.enabled && plan.next) {
      const w = wallOf(plan.next.at);
      const isToday = plan.next.key === plan.key;
      next = `${ICON.clock}<span>Next: <b>${daKindLabel(plan.next.kind)}</b> ${isToday ? 'today' : w.toLocaleDateString([], { weekday: 'short' })} at <b>${fmtTime(w, false)}</b> · in ${fmtIn(plan.next.at - Date.now())}</span>`;
    }
    const today = cfg.enabled ? plan.today.filter(e => e.status !== 'off').map(e => {
      const r = e.result && e.result.at ? ` · ${fmtTime(new Date(e.result.at), false)}` : '';
      const skip = e.status === 'skipped'
        ? `<a class="lnk" data-act="ck-unskip" data-v="${e.kind}">undo</a>`
        : ['upcoming', 'warn'].includes(e.status) ? `<a class="lnk" data-act="ck-skip" data-v="${e.kind}">skip today</a>` : '';
      const at = e.kind === 'in' ? cfg.inTime : e.kind === 'out' ? cfg.outTime : cfg.breaks[Number(e.kind.slice(1))].start;
      return `<div><span class="tag ${e.status}">${e.status}</span>${daKindLabel(e.kind)} ${daFmtHm(at)}${e.minutes ? ` · ${e.minutes} min` : ''}${r} ${skip}</div>`;
    }).join('') : '';
    const brkHtml = brk.on
      ? `<div class="brk on"><div class="brk-h">${ICON.cup} On break <span class="timer">${clockFmt(Date.now() - brk.since)}</span></div>
          <div class="hint">${brk.plannedEnd ? `Back at <b>${fmtTime(wallOf(brk.plannedEnd), false)}</b> · in ${fmtIn(brk.plannedEnd - Date.now())} (the tea cup is turned off automatically)` : 'Until you end it.'}</div>
          <div class="row2"><button class="btn green" data-act="br-end">${ICON.check} End break</button>
            <button class="btn ghost" data-act="br-ext" data-v="5">+5 min</button></div></div>`
      : `<div class="brk"><div class="brk-h">${ICON.cup} Break</div>
          <div class="field"><label class="inp"><select id="brMin">${[[15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 hour'], [0, 'Until I end it']]
            .map(([v, t]) => `<option value="${v}" ${v === (loadUi().brMin ?? 15) ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
            <button class="btn amber" data-act="br-start" ${st === 'out' ? 'disabled title="Clocked out"' : ''}>${ICON.cup} Start break</button></div></div>`;
    els.ckLive.innerHTML = `
      <div class="status">${stHtml}<span class="timer" title="Shift timer from the dialer">${esc(timer)}</span></div>
      <div class="clocks">
        <div class="clk ${cfg.source === 'dialer' ? 'sel' : ''}"><small>Dialer time</small><b>${hasDialerClock ? fmtTime(dialerNow) : '—'}</b></div>
        <div class="clk ${cfg.source === 'system' ? 'sel' : ''}"><small>This PC</small><b>${fmtTime(pcNow)}</b></div>
      </div>
      <div class="hint">${diffText}</div>
      <div class="row2">
        <button class="btn green" data-act="ck-now" data-v="in" ${st === 'in' ? 'disabled' : ''}>${ICON.login} Clock in now</button>
        <button class="btn gray" data-act="ck-now" data-v="out" ${st === 'out' ? 'disabled' : ''}>${ICON.logout} Clock out now</button>
      </div>
      ${brkHtml}
      <div class="next">${next}</div>
      ${today ? `<div class="today">${today}</div>` : ''}`;
  }

  function renderClockForm(force) {
    if (!els || !els.ckForm) return;
    if (!force && els.ckForm.contains(shadow.activeElement)) return;
    daGetClock().then(({ cfg }) => {
      const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
      const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const sups = supervisors.list || [];
      const supOpts = [`<option value="">Keep dialer's current${supervisors.current ? ` (${esc(supervisors.current)})` : ''}</option>`]
        .concat(sups.map(n => `<option ${n === cfg.supervisor ? 'selected' : ''}>${esc(n)}</option>`));
      if (cfg.supervisor && !sups.includes(cfg.supervisor)) supOpts.push(`<option selected>${esc(cfg.supervisor)}</option>`);
      els.ckForm.innerHTML = `
        <label class="switch"><span>Automatic clock in / out</span><input type="checkbox" id="ckOn" ${cfg.enabled ? 'checked' : ''}><span class="t"></span></label>
        <div class="row2">
          <div><div class="flab">Clock in at</div><label class="inp">${ICON.login}<input type="time" id="ckIn" value="${esc(cfg.inTime)}"></label></div>
          <div><div class="flab">Clock out at</div><label class="inp">${ICON.logout}<input type="time" id="ckOut" value="${esc(cfg.outTime)}"></label></div>
        </div>
        <div><div class="flab">Days</div><div class="days">${days.map((d, i) =>
          `<button class="day ${cfg.days.includes(i) ? 'on' : ''}" data-act="ck-day" data-v="${i}" title="${names[i]}">${d}</button>`).join('')}</div></div>
        <div>
          <div class="flab" style="display:flex;justify-content:space-between">Supervisor in charge
            <a class="lnk" data-act="ck-readsup">${ICON.refresh} ${sups.length ? 'Refresh list' : 'Load list from dialer'}</a></div>
          <div class="field"><label class="inp">${ICON.user}<select id="ckSup">${supOpts.join('')}</select></label>
            <button class="btn ghost sm" data-act="ck-sup" title="Change the supervisor in the dialer now">Set now</button></div>
        </div>
        <div><div class="flab" style="display:flex;justify-content:space-between">Breaks (tea cup)
            <a class="lnk" data-act="ck-addbrk">+ Add break</a></div>
          ${(cfg.breaks || []).map((b, i) => `<div class="brow">
            <label class="inp"><input type="time" class="brStart" value="${esc(b.start)}"></label>
            <label class="inp"><select class="brLen">${[5, 10, 15, 20, 30, 45, 60].map(m =>
              `<option value="${m}" ${Number(b.minutes) === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></label>
            <button class="rm" data-act="ck-rmbrk" data-v="${i}" title="Remove">${ICON.x}</button></div>`).join('')
            || '<div class="hint">No scheduled breaks.</div>'}
        </div>
        <div><div class="flab">Use time from</div><div class="seg">
          <button data-act="ck-src" data-v="dialer" class="${cfg.source === 'dialer' ? 'on' : ''}">Dialer time</button>
          <button data-act="ck-src" data-v="system" class="${cfg.source === 'system' ? 'on' : ''}">Computer time</button></div></div>
        <div class="row2">
          <div><div class="flab">Warn before</div><label class="inp"><select id="ckWarn">${[0, 1, 2, 5].map(m =>
            `<option value="${m}" ${cfg.warnMin === m ? 'selected' : ''}>${m ? m + ' min' : 'No warning'}</option>`).join('')}</select></label></div>
          <div><div class="flab">Late by up to</div><label class="inp"><select id="ckGrace">${[5, 15, 30, 60].map(m =>
            `<option value="${m}" ${cfg.graceMin === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></label></div>
        </div>
        <div class="hint">Keep a dialer tab open (Edge opens one by itself a few minutes before). Times already past today are skipped when you change the schedule.</div>`;
    });
  }

  async function saveClockForm(silent, patch) {
    const $ = id => shadow.getElementById(id);
    const { cfg: old } = await daGetClock();
    const cfg = Object.assign({}, old, {
      enabled: $('ckOn').checked,
      inTime: $('ckIn').value || old.inTime,
      outTime: $('ckOut').value || old.outTime,
      supervisor: $('ckSup').value,
      warnMin: Number($('ckWarn').value),
      graceMin: Number($('ckGrace').value),
      breaks: [...shadow.querySelectorAll('.brow')].map(r => ({
        start: r.querySelector('.brStart').value || '12:00', minutes: Number(r.querySelector('.brLen').value) }))
    }, patch || {});
    await chrome.storage.local.set({ clock: cfg });
    // Don't fire for times that already passed today when the schedule changes.
    const state = await daGetClock();
    for (const e of daClockPlan(state).today) {
      if (['due', 'missed'].includes(e.status) && (JSON.stringify(old) !== JSON.stringify(cfg))) await SDC.skip(e.key, e.kind, true);
    }
    if (!silent) toast(cfg.enabled ? 'Schedule saved' : 'Automatic clock in/out off');
    liveTick();
  }

  async function clockAction(act, v, btn) {
    if (!SDC) return;
    const sup = shadow.getElementById('ckSup');
    try {
      if (act === 'ck-day') {
        const { cfg } = await daGetClock();
        const d = Number(v);
        const days = cfg.days.includes(d) ? cfg.days.filter(x => x !== d) : cfg.days.concat(d).sort();
        await saveClockForm(false, { days });
        renderClockForm(true);
      } else if (act === 'ck-addbrk' || act === 'ck-rmbrk') {
        const { cfg } = await daGetClock();
        const breaks = (cfg.breaks || []).slice();
        if (act === 'ck-addbrk') breaks.push({ start: '12:00', minutes: 15 });
        else breaks.splice(Number(v), 1);
        await chrome.storage.local.set({ clock: Object.assign({}, cfg, { breaks }) });
        renderClockForm(true);
      } else if (act === 'br-start' || act === 'br-end' || act === 'br-ext') {
        if (btn) btn.disabled = true;
        let msg;
        if (act === 'br-ext') { await SDC.extendBreak(Number(v)); msg = `Break extended by ${v} min`; }
        else if (act === 'br-end') msg = await SDC.endBreak();
        else {
          const minutes = Number(shadow.getElementById('brMin').value);
          const ui = loadUi(); ui.brMin = minutes; saveUi(ui);
          msg = await SDC.startBreak(minutes);
        }
        clockMsg = { text: msg, at: Date.now() };
        toast(msg);
      } else if (act === 'ck-src') {
        await saveClockForm(false, { source: v });
        renderClockForm(true);
      } else if (act === 'ck-skip' || act === 'ck-unskip') {
        const plan = daClockPlan(await daGetClock());
        await SDC.skip(plan.key, v, act === 'ck-skip');
        await daLog('clock', `${act === 'ck-skip' ? 'Skipped' : 'Un-skipped'} today's ${daKindLabel(v).toLowerCase()}.`);
        liveTick();
      } else if (act === 'ck-readsup') {
        toast('Reading supervisors…');
        await SDC.readSupervisors();
        toast('Supervisor list updated');
      } else if (act === 'ck-sup' || act === 'ck-now') {
        if (btn) btn.disabled = true;
        const kind = act === 'ck-sup' ? 'supervisor' : v;
        if (kind === 'supervisor' && !sup.value) { toast('Pick a supervisor first'); return; }
        if (kind !== 'supervisor') {
          // a manual clock in/out stands in for today's scheduled one if it hasn't run yet
          const plan = daClockPlan(await daGetClock());
          const ev = plan.today.find(e => e.kind === kind && ['upcoming', 'warn', 'due'].includes(e.status));
          if (ev) await SDC.skip(ev.key, kind, true);
        }
        const msg = await SDC.perform(kind, sup ? sup.value : '');
        clockMsg = { text: msg, at: Date.now() };
        toast(msg);
      }
    } catch (e) {
      clockMsg = { text: e.message, err: true, at: Date.now() };
      toast(e.message);
    } finally {
      if (btn) btn.disabled = false;
      liveTick();
    }
  }

  // ---------- Activity tab ----------
  function renderLog() {
    if (!els || !els.log) return;
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const today = activity.filter(a => a.t >= startOfDay.getTime());
    const count = k => today.filter(a => a.kind === k).length;
    const runs = today.filter(a => a.kind === 'run' && !a.error).length;
    const brk = (clockState && clockState.breakState) || {};
    const brkMs = today.reduce((t, a) => t + (a.breakMs || 0), 0) + (brk.on ? Date.now() - brk.since : 0);
    els.stats.innerHTML = `
      <div class="stat"><b>${count('lookup')}</b><small>Lookups</small></div>
      <div class="stat"><b>${Math.round(brkMs / 60000)}m</b><small>On break</small></div>
      <div class="stat"><b>${runs}</b><small>Runs done</small></div>
      <div class="stat"><b>${count('call')}</b><small>Zoiper calls</small></div>`;
    const icon = { break: ICON.cup, lookup: ICON.search, run: ICON.play, call: ICON.phone, clock: ICON.clock, search: ICON.search };
    els.log.innerHTML = activity.slice(0, 80).map(a => `
      <div class="li ${a.error ? 'err' : a.ok ? 'ok' : ''}"><span class="ic">${icon[a.kind] || ICON.list}</span>
        <span class="tx">${esc(a.text)}</span><time>${new Date(a.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>`).join('')
      || '<div class="hint">Nothing yet.</div>';
  }

  // ---------- Zoiper hand-off ----------
  // Zoiper opens  <dialer>/members/search#da-phone=<caller number>  on a call.
  async function incomingCall(phone) {
    if (!phone) return;
    if (loadUi().collapsed) setCollapsed(false);
    { const ui = loadUi(); ui.tab = 'lookup'; saveUi(ui); }
    els.phone.value = phone;
    await doLookup();
    toast('Incoming call: ' + fmtPhone(phone));
    daLog('call', `Zoiper call from ${fmtPhone(phone)}`);
    const ui = loadUi();
    const job = loadJob();
    if (settings.autoRunOnCall && ui.results && ui.results.length === 1 && !(job && job.running)) {
      startRun(ui.results[0].ctrl);
    }
  }

  async function checkCallHash() {
    const m = location.hash.match(/da-phone=([^&]*)/);
    if (!m) return;
    const phone = daCallerIdToPhone(decodeURIComponent(m[1]));
    history.replaceState(null, '', location.pathname + location.search);
    const res = await chrome.runtime.sendMessage({ type: 'incomingCall', phone });
    if (res && res.handleHere) incomingCall(phone);
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'incomingCall') incomingCall(msg.phone);
    if (msg.type === 'togglePanel') setCollapsed(!loadUi().collapsed);
    if (msg.type === 'focusPhone') {
      if (loadUi().collapsed) setCollapsed(false);
      const ui = loadUi(); ui.tab = 'lookup'; saveUi(ui);
      els.phone.focus();
      els.phone.select();
    }
  });

  daGetSettings().then(s => {
    settings = s;
    chrome.storage.local.set({ lastOrigin: location.origin });
    buildPanel();
    runner();
    if (window.SDClock) {
      window.SDClock.start({
        isJobRunning: () => { const j = loadJob(); return !!(j && j.running); },
        onEvent: ev => {
          const starting = { in: 'Clocking in', out: 'Clocking out', break: 'Starting break', 'break-end': 'Ending break' };
          if (ev.phase === 'start') clockMsg = { text: `${starting[ev.kind] || 'Working'}…`, at: Date.now() };
          else clockMsg = { text: ev.msg, err: ev.phase === 'error', at: Date.now() };
          liveTick();
        }
      });
    }
    checkCallHash();
    window.addEventListener('hashchange', checkCallHash);
  });
})();
