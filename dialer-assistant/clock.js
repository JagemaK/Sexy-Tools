// Sean's Dialer: Time Clock automation (content script, loaded before content.js).
//
// Reads the dialer's top bar (clock + shift timer), learns the supervisor list
// from the Time Clock dialog, and clocks in/out on the saved schedule using
// either the dialer's time or this computer's time.
window.SDClock = (() => {
  if (window.top !== window) return null;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
  const isOurs = el => el.closest && el.closest('#da-host');

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  const textOf = el => (el.tagName === 'INPUT' ? el.value : el.innerText || el.textContent || '');

  function findByText(label, { includeHidden = false, root = document, sel } = {}) {
    const want = norm(label);
    const els = root.querySelectorAll(sel || 'button, a, input[type=button], input[type=submit], [role=button], .btn');
    for (const el of els) {
      if (isOurs(el) || (!includeHidden && !visible(el))) continue;
      if (norm(includeHidden ? el.textContent || el.value : textOf(el)) === want) return el;
    }
    return null;
  }

  // Leaf text nodes in the page (not our panel) matching a regex.
  function findLeafText(re) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.trim();
      if (t && re.test(t) && !isOurs(n.parentElement) && visible(n.parentElement)) return n.parentElement;
    }
    return null;
  }

  // ---------- reading the dialer ----------
  const dialerClockEl = () => findLeafText(/^\d{1,2}:\d{2}\s*[AP]M$/i);
  const shiftTimerEl = () => findLeafText(/^\d{1,3}:\d{2}:\d{2}$/);

  function parseClock(text) {
    const m = /(\d{1,2}):(\d{2})\s*([AP])M/i.exec(text || '');
    if (!m) return null;
    let h = Number(m[1]) % 12;
    if (m[3].toUpperCase() === 'P') h += 12;
    return h * 60 + Number(m[2]);
  }

  // Dialer clock offset. When the displayed minute ticks over, the dialer is at
  // hh:mm:00 exactly, which gives a precise offset; before that, minute accuracy.
  let lastClockText = null;
  let stored = null;
  async function trackDialerClock() {
    const el = dialerClockEl();
    if (!el) return;
    const text = el.textContent.trim();
    const dMin = parseClock(text);
    if (dMin == null) return;
    const now = new Date();
    const sysMs = ((now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
    const wrap = ms => ((ms % 86400000) + 86400000 + 43200000) % 86400000 - 43200000; // to ±12h
    if (!stored) stored = (await chrome.storage.local.get('dialerClock')).dialerClock || null;
    let next = null;
    if (lastClockText && text !== lastClockText) {
      next = { offsetMs: wrap(dMin * 60000 - sysMs), precise: true, at: Date.now() };
    } else if (!stored || (!stored.precise && Date.now() - stored.at > 60000)) {
      next = { offsetMs: wrap(dMin * 60000 + 30000 - sysMs), precise: false, at: Date.now() };
    } else if (Math.abs(wrap(dMin * 60000 + 30000 - sysMs) - stored.offsetMs) > 90000) {
      // dialer clock jumped (time zone/server change): re-learn
      next = { offsetMs: wrap(dMin * 60000 + 30000 - sysMs), precise: false, at: Date.now() };
    }
    lastClockText = text;
    if (next) {
      stored = next;
      await chrome.storage.local.set({ dialerClock: next });
    }
  }

  function supervisorSelect(includeHidden) {
    for (const sel of document.querySelectorAll('select')) {
      if (isOurs(sel) || (!includeHidden && !visible(sel))) continue;
      const ctx = `${sel.name} ${sel.id}`;
      const row = sel.closest('tr, .form-group, .row, li, p, div');
      const near = row ? row.textContent : '';
      if (/supervis/i.test(ctx) || /supervisor/i.test(near.slice(0, 200))) return sel;
    }
    return null;
  }

  const optionsOf = sel => [...sel.options]
    .map(o => ({ value: o.value, text: o.text.trim() }))
    .filter(o => o.text && !/^(-+|select.*|choose.*)$/i.test(o.text));

  async function scrapeSupervisors() {
    const sel = supervisorSelect(true);
    if (!sel) return;
    const list = optionsOf(sel).map(o => o.text);
    if (!list.length) return;
    const current = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text.trim() : '';
    const { supervisors } = await chrome.storage.local.get('supervisors');
    if (!supervisors || supervisors.list.join('|') !== list.join('|') || supervisors.current !== current) {
      await chrome.storage.local.set({ supervisors: { list, current, at: Date.now() } });
    }
  }

  // Clocked in/out, judged from the dialog's button (present in the page even
  // while the dialog is hidden on most Bootstrap sites).
  function status() {
    if (findByText('Clock Out', { includeHidden: true })) return 'in';
    if (findByText('Clock In', { includeHidden: true })) return 'out';
    return null;
  }

  // ---------- acting on the Time Clock dialog ----------
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(200);
    }
    return null;
  }

  const dialogButton = () => findByText('Clock Out') || findByText('Clock In');

  async function openDialog() {
    if (dialogButton()) return true;
    const link = findByText('Time Clock') ||
      findByText('Time Clock', { sel: 'a, button, li, span, div' });
    if (!link) throw new Error('Could not find the "Time Clock" link in the top bar.');
    link.click();
    if (!(await waitFor(dialogButton, 8000))) throw new Error('The Time Clock dialog did not open.');
    await sleep(300); // let the dialog finish animating / loading options
    return true;
  }

  async function closeDialog() {
    const btn = dialogButton();
    if (!btn) return;
    const modal = btn.closest('.modal, [role=dialog], .ui-dialog') || document;
    const close = findByText('Close', { root: modal }) || modal.querySelector('.close, [data-dismiss=modal], [aria-label=Close]');
    if (close) close.click();
  }

  function pickSupervisor(name) {
    if (!name) return { ok: true, changed: false };
    const sel = supervisorSelect(false) || supervisorSelect(true);
    if (!sel) return { ok: false, error: 'Supervisor list not found in the Time Clock dialog.' };
    const want = norm(name);
    const opt = [...sel.options].find(o => norm(o.text) === want) || [...sel.options].find(o => norm(o.text).includes(want));
    if (!opt) return { ok: false, error: `Supervisor "${name}" is not in the dialer's list.` };
    if (sel.value === opt.value) return { ok: true, changed: false };
    sel.value = opt.value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, changed: true };
  }

  let busy = false;
  // kind: 'in' | 'out' | 'supervisor'. `origin` ('manual' | 'schedule') and `key`
  // are kept with the pending record so the result can still be recorded if
  // the dialer reloads the page right after the click.
  async function perform(kind, supervisor, origin = 'manual', key = null) {
    if (busy) throw new Error('A time clock action is already running.');
    busy = true;
    const prevFlag = document.documentElement.dataset.daRunning;
    document.documentElement.dataset.daRunning = '1'; // auto-accept confirm() popups
    try {
      await openDialog();
      await scrapeSupervisors();
      const pick = pickSupervisor(supervisor);
      if (!pick.ok) throw new Error(pick.error);

      if (kind === 'supervisor') {
        if (!pick.changed) return 'Supervisor already set.';
        const change = await waitFor(() => findByText('Change Supervisor'), 3000);
        if (!change) throw new Error('"Change Supervisor" button not found.');
        change.click();
        await sleep(1200);
        return `Supervisor changed to ${supervisor}.`;
      }

      if (kind === 'out') {
        const { breakState: b } = await chrome.storage.local.get('breakState');
        if (b && b.on) {
          await closeDialog().catch(() => {});
          busy = false;
          await performBreak(false).catch(() => {});
          busy = true;
          await openDialog();
          pickSupervisor(supervisor);
        }
      }
      const want = kind === 'in' ? 'Clock In' : 'Clock Out';
      const opposite = kind === 'in' ? 'Clock Out' : 'Clock In';
      if (findByText(opposite) && !findByText(want)) return kind === 'in' ? 'Already clocked in.' : 'Already clocked out.';
      const btn = findByText(want);
      if (!btn) throw new Error(`"${want}" button not found.`);
      await chrome.storage.local.set({ clockPending: { kind, origin, key, supervisor, at: Date.now() } });
      btn.click();
      // Success = the button flips, or the dialog closes / page reloads.
      const flipped = await waitFor(() => findByText(opposite) || (!findByText(want) && !findByText(opposite)), 10000);
      await chrome.storage.local.remove('clockPending');
      if (!flipped) throw new Error(`Clicked "${want}" but the dialer did not confirm it.`);
      return kind === 'in' ? 'Clocked in.' : 'Clocked out.';
    } finally {
      await sleep(400);
      await closeDialog().catch(() => {});
      document.documentElement.dataset.daRunning = prevFlag || '0';
      busy = false;
      scrapeSupervisors().catch(() => {});
    }
  }

  // ---------- breaks (the tea cup in the top bar) ----------
  const CUP_RE = /coffee|mug|cup|tea\b|break/i;
  function cupEl() {
    const cands = document.querySelectorAll('i, span, svg, img, a, button, [title], [aria-label]');
    for (const el of cands) {
      if (isOurs(el) || !visible(el)) continue;
      const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
      const attrs = `${cls} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('src') || ''} ${el.getAttribute('alt') || ''}`;
      const ownText = el.childElementCount === 0 ? el.textContent.trim() : '';
      if (CUP_RE.test(attrs) || ownText === '☕') {
        return el.closest('a, button, [role=button], [onclick]') || el;
      }
    }
    return null;
  }

  // After clicking the cup, some dialers ask for a reason/confirmation in a dialog.
  async function handleBreakDialog(on) {
    const words = on
      ? ['start break', 'go on break', 'take break', 'begin break', 'break', 'ok', 'yes', 'confirm', 'submit', 'save', 'start']
      : ['end break', 'back from break', 'return from break', 'resume', 'return', 'i m back', 'back', 'ok', 'yes', 'confirm', 'submit', 'end'];
    const modal = await waitFor(() => [...document.querySelectorAll('.modal, [role=dialog], .ui-dialog, .swal2-popup, .bootbox')]
      .find(m => !isOurs(m) && visible(m) && !findByText('Clock In', { root: m }) && !findByText('Clock Out', { root: m })), 2500);
    if (!modal) return;
    const sel = [...modal.querySelectorAll('select')].find(x => visible(x) && !x.value);
    if (sel) {
      const opt = [...sel.options].find(o => o.value && /break/i.test(o.text)) || [...sel.options].find(o => o.value);
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    for (const w of words) {
      const b = findByText(w, { root: modal });
      if (b) { b.click(); await sleep(600); return; }
    }
  }

  async function setBreakState(st) {
    await chrome.storage.local.set({ breakState: st });
  }

  // on=true: start a break for `minutes` (0 = until ended). on=false: come back.
  async function performBreak(on, { minutes = 0, origin = 'manual', label = '', beforeClick } = {}) {
    if (busy) throw new Error('Another time clock action is running.');
    const { breakState: cur = { on: false } } = await chrome.storage.local.get('breakState');
    if (on && cur.on) return 'Already on break.';
    if (!on && !cur.on) return 'Not on break.';
    if (on && status() === 'out') throw new Error('You are clocked out, so no break was started.');
    const cup = cupEl();
    if (!cup) throw new Error('Could not find the tea cup (break) button in the top bar.');
    busy = true;
    const prevFlag = document.documentElement.dataset.daRunning;
    document.documentElement.dataset.daRunning = '1';
    try {
      const now = Date.now();
      // Record everything first: the dialer may reload the page right after the click.
      let msg;
      if (on) {
        msg = minutes ? `On break for ${minutes} min.` : 'On break.';
        await setBreakState({ on: true, since: now, plannedEnd: minutes ? now + minutes * 60000 : null, origin, label });
        await daLog('break', `${origin === 'schedule' ? 'Scheduled break' : 'Break'} started${label ? ' (' + label + ')' : ''}: ${msg}`, { ok: true });
      } else {
        const ms = now - (cur.since || now);
        msg = `Back from break (${Math.round(ms / 60000)} min).`;
        await setBreakState({ on: false, lastEnd: now });
        await daLog('break', msg, { ok: true, breakMs: ms });
      }
      if (beforeClick) await beforeClick(msg);
      cup.click();
      await handleBreakDialog(on);
      return msg;
    } finally {
      document.documentElement.dataset.daRunning = prevFlag || '0';
      busy = false;
    }
  }

  async function extendBreak(minutes) {
    const { breakState: cur } = await chrome.storage.local.get('breakState');
    if (!cur || !cur.on) return;
    cur.plannedEnd = Math.max(cur.plannedEnd || Date.now(), Date.now()) + minutes * 60000;
    await setBreakState(cur);
    await daLog('break', `Break extended by ${minutes} min.`);
  }

  // ---------- scheduler ----------
  // Only one dialer tab acts: claim the event in storage, then re-check the claim.
  const token = Math.random().toString(36).slice(2);
  async function claim(key, kind) {
    const { clockClaim } = await chrome.storage.local.get('clockClaim');
    const id = `${key}:${kind}`;
    if (clockClaim && clockClaim.id === id && clockClaim.token !== token && Date.now() - clockClaim.at < 120000) return false;
    await chrome.storage.local.set({ clockClaim: { id, token, at: Date.now() } });
    await sleep(400 + Math.random() * 400);
    const again = (await chrome.storage.local.get('clockClaim')).clockClaim;
    return again && again.token === token;
  }

  async function markDone(key, field, value) {
    const { clockDone = {} } = await chrome.storage.local.get('clockDone');
    clockDone[key] = Object.assign({}, clockDone[key], { [field]: value });
    // keep two weeks
    for (const k of Object.keys(clockDone).sort().slice(0, -14)) delete clockDone[k];
    await chrome.storage.local.set({ clockDone });
  }

  let isJobRunning = () => false;
  let onEvent = () => {};

  async function tick() {
    await trackDialerClock().catch(() => {});
    const state = await daGetClock();
    const plan = daClockPlan(state);
    for (const ev of plan.today) {
      if (ev.status === 'missed' && !(state.done[ev.key] || {})['missed_' + ev.kind]) {
        if (await claim(ev.key, 'missed_' + ev.kind)) {
          await markDone(ev.key, 'missed_' + ev.kind, Date.now());
          await daLog('clock', `Missed scheduled ${daKindLabel(ev.kind).toLowerCase()} (no dialer tab open in time).`, { error: true });
          chrome.runtime.sendMessage({ type: 'notify', title: `Missed ${daKindLabel(ev.kind).toLowerCase()}`, message: 'The dialer tab was not open at the scheduled time.' });
        }
      }
      if (ev.status !== 'due' || busy) continue;
      if (isJobRunning()) continue; // wait for the disposition run to finish (within the grace window)
      if (!(await claim(ev.key, ev.kind))) continue;
      if (ev.kind[0] === 'b') {
        await scheduledBreak(ev, state);
        continue;
      }
      onEvent({ kind: ev.kind, phase: 'start' });
      try {
        const msg = await perform(ev.kind, state.cfg.supervisor, 'schedule', ev.key);
        await markDone(ev.key, ev.kind, { at: Date.now(), msg });
        await daLog('clock', `Scheduled clock ${ev.kind}: ${msg}`, { ok: true });
        chrome.runtime.sendMessage({ type: 'notify', title: `Sean's Dialer: clock ${ev.kind}`, message: msg });
        onEvent({ kind: ev.kind, phase: 'done', msg });
      } catch (e) {
        // leave it not-done so the next tick retries until the grace window ends
        await daLog('clock', `Scheduled clock ${ev.kind} failed: ${e.message}`, { error: true });
        chrome.runtime.sendMessage({ type: 'notify', title: `Clock ${ev.kind} failed`, message: e.message });
        onEvent({ kind: ev.kind, phase: 'error', msg: e.message });
        await sleep(20000);
      }
    }
    // Come back from a break when its time is up.
    const b = state.breakState;
    if (b.on && b.plannedEnd && Date.now() >= b.plannedEnd && !busy && (await claim('break', String(b.since)))) {
      onEvent({ kind: 'break-end', phase: 'start' });
      try {
        const msg = await performBreak(false, {
          origin: 'auto',
          beforeClick: m => chrome.runtime.sendMessage({ type: 'notify', title: "Sean's Dialer: break over", message: m })
        });
        onEvent({ kind: 'break-end', phase: 'done', msg });
      } catch (e) {
        await daLog('break', `Ending the break failed: ${e.message}`, { error: true });
        chrome.runtime.sendMessage({ type: 'notify', title: 'Ending the break failed', message: e.message });
        onEvent({ kind: 'break-end', phase: 'error', msg: e.message });
        await sleep(20000);
      }
    }
  }

  async function scheduledBreak(ev, state) {
    const label = daFmtHm(state.cfg.breaks[Number(ev.kind.slice(1))].start);
    if (status() === 'out') {
      await markDone(ev.key, ev.kind, { at: Date.now(), msg: 'Skipped: clocked out.' });
      await daLog('break', `Scheduled break at ${label} skipped: you were clocked out.`);
      return;
    }
    onEvent({ kind: 'break', phase: 'start' });
    try {
      const msg = await performBreak(true, {
        minutes: ev.minutes, origin: 'schedule', label,
        beforeClick: async m => {
          await markDone(ev.key, ev.kind, { at: Date.now(), msg: m });
          chrome.runtime.sendMessage({ type: 'notify', title: "Sean's Dialer: break started", message: m });
        }
      });
      onEvent({ kind: 'break', phase: 'done', msg });
    } catch (e) {
      await daLog('break', `Scheduled break at ${label} failed: ${e.message}`, { error: true });
      chrome.runtime.sendMessage({ type: 'notify', title: 'Break failed', message: e.message });
      onEvent({ kind: 'break', phase: 'error', msg: e.message });
      await sleep(20000);
    }
  }

  // The page reloaded mid-action: check the dialer now shows the new state.
  async function resolvePending() {
    const { clockPending: p } = await chrome.storage.local.get('clockPending');
    if (!p) return;
    await chrome.storage.local.remove('clockPending');
    if (Date.now() - p.at > 120000) return;
    await waitFor(status, 5000);
    const ok = status() === p.kind;
    const msg = ok ? (p.kind === 'in' ? 'Clocked in.' : 'Clocked out.') : `Clicked "Clock ${p.kind}" but the dialer did not confirm it.`;
    const label = p.origin === 'schedule' ? `Scheduled clock ${p.kind}` : `Manual clock ${p.kind}`;
    if (ok && p.key) await markDone(p.key, p.kind, { at: p.at, msg });
    await daLog('clock', `${label}: ${msg}`, ok ? { ok: true } : { error: true });
    if (p.origin === 'schedule' || !ok) {
      chrome.runtime.sendMessage({ type: 'notify', title: `Sean's Dialer: clock ${p.kind}${ok ? '' : ' failed'}`, message: msg });
    }
    onEvent({ kind: p.kind, phase: ok ? 'done' : 'error', msg });
  }

  function start(hooks) {
    isJobRunning = hooks.isJobRunning || isJobRunning;
    onEvent = hooks.onEvent || onEvent;
    resolvePending().catch(() => {});
    scrapeSupervisors().catch(() => {});
    setInterval(() => scrapeSupervisors().catch(() => {}), 30000);
    setInterval(() => trackDialerClock().catch(() => {}), 1000);
    const loop = async () => {
      try { await tick(); } catch (e) { /* keep ticking */ }
      setTimeout(loop, 5000);
    };
    loop();
  }

  return {
    start,
    perform: async (kind, supervisor, key) => {
      try {
        const msg = await perform(kind, supervisor, 'manual', key);
        await daLog('clock', `Manual ${kind === 'supervisor' ? 'supervisor change' : 'clock ' + kind}: ${msg}`, { ok: true });
        return msg;
      } catch (e) {
        await daLog('clock', `Manual ${kind === 'supervisor' ? 'supervisor change' : 'clock ' + kind} failed: ${e.message}`, { error: true });
        throw e;
      }
    },
    startBreak: minutes => performBreak(true, { minutes }),
    endBreak: () => performBreak(false),
    extendBreak,
    hasCup: () => !!cupEl(),
    status,
    shiftTimer: () => { const el = shiftTimerEl(); return el ? el.textContent.trim() : ''; },
    dialerClockText: () => { const el = dialerClockEl(); return el ? el.textContent.trim() : ''; },
    readSupervisors: async () => {
      await openDialog();
      await scrapeSupervisors();
      await sleep(300);
      await closeDialog();
    },
    skip: (key, kind, on) => markDone(key, 'skip_' + kind, on ? Date.now() : null)
  };
})();
