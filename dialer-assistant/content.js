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
    return m ? m[1] : null;
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

  function startPhoneSearch(phone) {
    saveJob({ type: 'phone', running: true, phone, phase: 'search', message: 'Searching site by phone...' });
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
        if (job.type === 'phone') await stepPhone(job);
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

  async function stepPhone(job) {
    switch (job.phase) {
      case 'search': {
        if (!(await ensureSearchPage())) return setPhase('search', { navigating: true });
        const input = await waitFor(searchPhoneInput, 'Phone Number field');
        const ctrl = searchCtrlInput();
        if (ctrl && ctrl.value) setValue(ctrl, '');
        setValue(input, job.phone);
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
        const ctrls = [...new Set(rows.map(r => rowCtrl(r.tr)).filter(Boolean))];
        const ui = loadUi();
        ui.results = ctrls;
        ui.source = 'site';
        saveUi(ui);
        stopJob(ctrls.length ? `Site search found ${ctrls.length} account(s).` : 'Site search: no accounts found.');
        return;
      }
    }
  }

  // ---------- floating panel ----------
  function loadUi() {
    try { return JSON.parse(sessionStorage.getItem(UI_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveUi(ui) {
    sessionStorage.setItem(UI_KEY, JSON.stringify(ui));
    render();
  }

  let shadow, els;

  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'da-host';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: Segoe UI, Arial, sans-serif; font-size: 13px; }
        .panel { width: 290px; background: #fff; color: #1f2937; border: 1px solid #cbd5e1;
                 border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.18); overflow: hidden; }
        .head { background: #2563eb; color: #fff; padding: 7px 10px; display: flex;
                align-items: center; justify-content: space-between; cursor: pointer; user-select: none; }
        .head b { font-size: 13px; }
        .body { padding: 10px; display: grid; gap: 8px; }
        .collapsed .body { display: none; }
        .row { display: flex; gap: 6px; }
        input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 5px; }
        button { padding: 6px 9px; border: 0; border-radius: 5px; background: #2563eb; color: #fff; cursor: pointer; }
        button.sec { background: #e2e8f0; color: #1f2937; }
        button.stop { background: #dc2626; }
        button:disabled { opacity: .5; cursor: default; }
        .res { display: grid; gap: 4px; }
        .item { display: flex; align-items: center; gap: 6px; padding: 5px 6px; background: #f1f5f9; border-radius: 5px; }
        .item code { flex: 1; font-family: Consolas, monospace; font-size: 14px; font-weight: 600; }
        .muted { color: #64748b; font-size: 12px; }
        .status { padding: 6px 8px; border-radius: 5px; background: #eff6ff; font-size: 12px; }
        .status.err { background: #fef2f2; color: #b91c1c; }
        .status:empty { display: none; }
        a { color: #2563eb; cursor: pointer; font-size: 12px; }
      </style>
      <div class="panel">
        <div class="head"><b>Dialer Assistant</b><span id="tog">–</span></div>
        <div class="body">
          <div class="row">
            <input id="phone" placeholder="Caller phone number">
            <button id="lookup">Find</button>
          </div>
          <div id="results" class="res"></div>
          <div class="row">
            <input id="ctrl" placeholder="Control # (manual)">
            <button id="runManual">Run</button>
          </div>
          <div id="status" class="status"></div>
          <div class="row">
            <button id="stop" class="stop" style="flex:1">Stop</button>
          </div>
          <a id="opts">Settings / import data</a>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = id => shadow.getElementById(id);
    els = { panel: shadow.querySelector('.panel'), phone: $('phone'), results: $('results'),
            ctrl: $('ctrl'), status: $('status'), stop: $('stop'), tog: $('tog') };

    shadow.querySelector('.head').onclick = () => {
      const ui = loadUi();
      ui.collapsed = !ui.collapsed;
      saveUi(ui);
    };
    $('lookup').onclick = doLookup;
    els.phone.onkeydown = e => { if (e.key === 'Enter') doLookup(); };
    $('runManual').onclick = () => {
      const c = daNormalizeCtrl(els.ctrl.value);
      if (c) startRun(c);
    };
    els.ctrl.onkeydown = e => { if (e.key === 'Enter') $('runManual').click(); };
    els.stop.onclick = () => stopJob('Stopped by user.');
    $('opts').onclick = () => chrome.runtime.sendMessage({ type: 'openOptions' });
    els.results.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.copy) {
        copyText(b.dataset.copy);
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = 'Copy'), 1200);
      } else if (b.dataset.run) {
        startRun(b.dataset.run);
      } else if (b.dataset.site) {
        startPhoneSearch(b.dataset.site);
      }
    };

    const ui = loadUi();
    if (ui.phone) els.phone.value = ui.phone;
    render();
  }

  async function doLookup() {
    const phone = daNormalizePhone(els.phone.value);
    const ui = loadUi();
    ui.phone = els.phone.value;
    if (!phone) {
      ui.results = null;
      ui.note = 'Enter a 10-digit phone number.';
      return saveUi(ui);
    }
    const res = await chrome.runtime.sendMessage({ type: 'lookup', phone });
    ui.results = res && res.ok ? res.ctrls : [];
    ui.source = 'file';
    ui.lookedUp = phone;
    ui.note = res && !res.ok ? `Lookup error: ${res.error}` : '';
    saveUi(ui);
    if (ui.results.length === 1) copyText(ui.results[0]);
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

  function render() {
    if (!shadow) return;
    const ui = loadUi();
    const job = loadJob();
    els.panel.classList.toggle('collapsed', !!ui.collapsed);
    els.tog.textContent = ui.collapsed ? '+' : '–';

    let html = '';
    if (Array.isArray(ui.results)) {
      for (const c of ui.results) {
        html += `<div class="item"><code>${c}</code>
          <button class="sec" data-copy="${c}">Copy</button>
          <button data-run="${c}">Run</button></div>`;
      }
      const src = ui.source === 'site' ? 'site search' : 'cellphone file';
      if (!ui.results.length) html += `<div class="muted">No control number in the ${src}.</div>`;
      else html += `<div class="muted">From ${src}. ${ui.results.length >= 3 ? 'There may be more accounts.' : ''}</div>`;
      if (ui.lookedUp && ui.source !== 'site') {
        html += `<button class="sec" data-site="${ui.lookedUp}">Search site by phone</button>`;
      }
    }
    if (ui.note) html += `<div class="muted">${ui.note}</div>`;
    els.results.innerHTML = html;

    els.status.textContent = job ? job.message || '' : '';
    els.status.classList.toggle('err', !!(job && job.error));
    els.stop.disabled = !(job && job.running);
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'togglePanel') {
      const ui = loadUi();
      ui.collapsed = !ui.collapsed;
      saveUi(ui);
    }
  });

  daGetSettings().then(s => {
    settings = s;
    buildPanel();
    runner();
  });
})();
