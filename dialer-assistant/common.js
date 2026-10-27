// Shared helpers: loaded by background.js, options.html and the content script.

const DA_DEFAULTS = {
  // Dispositions saved automatically, in order. After the last one the flow
  // runs one more search -> select -> finish and stops on the disposition page.
  dispositions: ['Shareholder called in', 'Endeavor letter'],
  searchPath: '/members/search',
  timeoutMs: 20000,
  // Pause after clicking Save before going back to search.
  afterSaveMs: 1500
};

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

async function daLookup(phone) {
  const p = daNormalizePhone(phone);
  if (!p) return [];
  const db = await daOpenDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(DA_STORE).objectStore(DA_STORE).get(p);
    // Normalize again so data imported before the zero-padding fix is still right.
    req.onsuccess = () => resolve(req.result ? [...new Set(req.result.c.map(daNormalizeCtrl))] : []);
    req.onerror = () => reject(req.error);
  });
}
