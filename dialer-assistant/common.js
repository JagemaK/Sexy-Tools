// Shared helpers: loaded by background.js, options.html and the content script.

const DA_DEFAULTS = {
  // Dispositions saved automatically, in order. After the last one the flow
  // runs one more search -> select -> finish and stops on the disposition page.
  dispositions: ['Shareholder called in', 'Endeavor letter'],
  searchPath: '/members/search',
  timeoutMs: 20000,
  // Pause after clicking Save before going back to search.
  afterSaveMs: 1500,
  // Zoiper hand-off: start the run by itself when the caller's phone matches
  // exactly one control number.
  autoRunOnCall: false
};

// Caller ID from a softphone may look like "sip:+12025551234@10.0.0.5" or
// "\"John\" <2025551234>": keep only the user part before '@'.
function daCallerIdToPhone(raw) {
  let s = String(raw || '').trim();
  const angle = s.match(/<([^>]*)>/);
  if (angle) s = angle[1];
  s = s.replace(/^sips?:/i, '').split('@')[0];
  return daNormalizePhone(s);
}

async function daGetSettings() {
  const s = await chrome.storage.local.get('settings');
  return Object.assign({}, DA_DEFAULTS, s.settings || {});
}

// "(201) 218-2840", "+1 201 218 2840", 2012182840 -> "2012182840"; junk -> "".
function daNormalizePhone(v) {
  if (v === null || v === undefined) return '';
  let d = String(typeof v === 'number' ? Math.round(v) : v).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10) return '';
  if (/^(\d)\1{9}$/.test(d)) return ''; // 9999999999 filler
  return d;
}

// Control numbers are 10 digits; Excel stores them as numbers and drops the
// leading zero (0499956773 -> 499956773), so pad it back. Text with letters
// (some rows hold a name in the ctrl column) is not a control number.
function daNormalizeCtrl(v) {
  if (v === null || v === undefined) return '';
  const s = String(typeof v === 'number' ? Math.round(v) : v).trim();
  if (/[a-z]/i.test(s)) return '';
  const d = s.replace(/\D/g, '');
  return d ? d.padStart(10, '0') : '';
}

// ---- IndexedDB (extension origin): phone -> [control numbers] ----
const DA_DB = 'dialer-assistant';
const DA_STORE = 'phones';

function daOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DA_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DA_STORE, { keyPath: 'p' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// -> { ctrls: [...], names: [...] }. names come from rows whose ctrl cell holds
// a person's name instead of a number (phone known, control number not).
async function daLookup(phone) {
  const p = daNormalizePhone(phone);
  if (!p) return { ctrls: [], names: [] };
  const db = await daOpenDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(DA_STORE).objectStore(DA_STORE).get(p);
    // Normalize again so data imported before the zero-padding fix is still right.
    req.onsuccess = () => {
      const r = req.result;
      resolve({ ctrls: r ? [...new Set(r.c.map(daNormalizeCtrl))].filter(Boolean) : [], names: (r && r.n) || [] });
    };
    req.onerror = () => reject(req.error);
  });
}

// ---- Time clock schedule (shared by the content script and background) ----
const DA_CLOCK_DEFAULTS = {
  enabled: false,
  inTime: '09:00',
  outTime: '17:00',
  days: [1, 2, 3, 4, 5], // 0 = Sunday
  supervisor: '', // '' = leave whatever the dialer has selected
  source: 'dialer', // 'dialer' (time shown in the dialer's top bar) or 'system'
  warnMin: 1, // countdown shown before acting
  graceMin: 15, // still act if the tab was closed/asleep at the exact minute
  // [{ start: '10:30', minutes: 15, type: 'break' | 'bio' | 'lunch' }]
  // break = tea cup on/off; bio & lunch = clock out, then clock back in after `minutes`
  breaks: [],
  keepAwake: true // keep Windows from sleeping while the schedule or an away timer is on
};

const DA_AWAY = {
  break: { label: 'Break', method: 'cup', minutes: 15 },
  bio: { label: 'Bio', method: 'clock', minutes: 5 },
  lunch: { label: 'Lunch', method: 'clock', minutes: 30 }
};
const daAwayType = t => (DA_AWAY[t] ? t : 'break');

// Schedule event kinds: 'in', 'out', and 'b0', 'b1', ... (start of break #n).
function daKindLabel(kind, cfg) {
  if (kind === 'in') return 'Clock in';
  if (kind === 'out') return 'Clock out';
  const b = cfg && cfg.breaks && cfg.breaks[Number(kind.slice(1))];
  return DA_AWAY[daAwayType(b && b.type)].label;
}

function daScheduleEvents(cfg) {
  return [{ kind: 'in', min: daHmToMin(cfg.inTime) }, { kind: 'out', min: daHmToMin(cfg.outTime) }]
    .concat((cfg.breaks || []).map((b, i) => ({
      kind: 'b' + i, min: daHmToMin(b.start), type: daAwayType(b.type),
      minutes: Number(b.minutes) || DA_AWAY[daAwayType(b.type)].minutes })))
    .filter(e => e.min != null);
}

async function daGetClock() {
  const s = await chrome.storage.local.get(['clock', 'dialerClock', 'clockDone', 'breakState']);
  return {
    cfg: Object.assign({}, DA_CLOCK_DEFAULTS, s.clock || {}),
    // offsetMs: dialer wall clock minus this computer's wall clock
    offsetMs: (s.dialerClock && s.dialerClock.offsetMs) || 0,
    hasDialerClock: !!s.dialerClock,
    done: s.clockDone || {},
    breakState: s.breakState || { on: false }
  };
}

// "Wall" Date for the chosen time source: read it with getHours()/getDay().
function daWallNow(source, offsetMs, now = Date.now()) {
  return new Date(now + (source === 'dialer' ? offsetMs : 0));
}

function daDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daHmToMin(hm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(hm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function daFmtHm(hm) {
  const min = daHmToMin(hm);
  if (min == null) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// Today's clock events with their status, plus the next upcoming event (within a week).
// status: upcoming | warn | due | done | skipped | missed | off
function daClockPlan({ cfg, offsetMs, done }, now = Date.now()) {
  const wall = daWallNow(cfg.source, offsetMs, now);
  const key = daDateKey(wall);
  const nowMin = wall.getHours() * 60 + wall.getMinutes() + wall.getSeconds() / 60;
  const todayOn = cfg.enabled && cfg.days.includes(wall.getDay());
  const rec = done[key] || {};
  const today = daScheduleEvents(cfg).map(({ kind, min: tMin, minutes, type }) => {
    const at = now + (tMin - nowMin) * 60000; // real ms of the event
    let status = 'upcoming';
    if (!todayOn || tMin == null) status = 'off';
    else if (rec[kind]) status = 'done';
    else if (rec['skip_' + kind]) status = 'skipped';
    else if (nowMin >= tMin + cfg.graceMin) status = 'missed';
    else if (nowMin >= tMin) status = 'due';
    else if (nowMin >= tMin - cfg.warnMin) status = 'warn';
    return { kind, at, status, key, minutes, type, result: rec[kind] };
  });
  let next = today.filter(e => ['upcoming', 'warn', 'due'].includes(e.status)).sort((a, b) => a.at - b.at)[0];
  if (!next && cfg.enabled) {
    for (let d = 1; d <= 7 && !next; d++) {
      const w = new Date(wall.getFullYear(), wall.getMonth(), wall.getDate() + d);
      if (!cfg.days.includes(w.getDay())) continue;
      const kinds = daScheduleEvents(cfg).sort((a, b) => a.min - b.min);
      if (kinds.length) {
        const dayStartReal = now + (w.getTime() - wall.getTime());
        next = { kind: kinds[0].kind, at: dayStartReal + kinds[0].min * 60000, status: 'upcoming', key: daDateKey(w) };
      }
    }
  }
  return { today, next, key };
}

// ---- Activity log ----
async function daLog(kind, text, extra) {
  const { activity = [] } = await chrome.storage.local.get('activity');
  activity.unshift(Object.assign({ t: Date.now(), kind, text }, extra || {}));
  await chrome.storage.local.set({ activity: activity.slice(0, 300) });
}
