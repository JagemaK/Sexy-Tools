const $ = id => document.getElementById(id);

async function loadSettings() {
  const s = await daGetSettings();
  $('dispositions').value = s.dispositions.join('\n');
  $('searchPath').value = s.searchPath;
  $('timeoutMs').value = s.timeoutMs;
  $('afterSaveMs').value = s.afterSaveMs;
  const { importInfo } = await chrome.storage.local.get('importInfo');
  if (importInfo) {
    $('importStatus').textContent =
      `Loaded ${importInfo.phones.toLocaleString()} phone numbers from ${importInfo.file} (${new Date(importInfo.at).toLocaleString()}).`;
  } else {
    $('importStatus').textContent = 'No data imported yet.';
  }
}

$('save').onclick = async () => {
  const settings = {
    dispositions: $('dispositions').value.split('\n').map(s => s.trim()).filter(Boolean),
    searchPath: $('searchPath').value.trim() || DA_DEFAULTS.searchPath,
    timeoutMs: Number($('timeoutMs').value) || DA_DEFAULTS.timeoutMs,
    afterSaveMs: Number($('afterSaveMs').value) || 0
  };
  await chrome.storage.local.set({ settings });
  $('saved').textContent = 'Saved.';
  setTimeout(() => ($('saved').textContent = ''), 1500);
};

$('test').onclick = async () => {
  const ctrls = await daLookup($('testPhone').value);
  $('testOut').textContent = ctrls.length ? ctrls.join(', ') : 'No match.';
};

// Pick the sheet holding the data: header row with a ctrl/control column.
function findDataSheet(wb) {
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, blankrows: false });
    const header = (rows[0] || []).map(h => String(h || ''));
    if (header.some(h => /^(ctrl|control)/i.test(h.trim()))) return rows;
  }
  return null;
}

function buildMap(rows) {
  const header = rows[0].map(h => String(h || '').trim());
  const ctrlCol = header.findIndex(h => /^(ctrl|control)/i.test(h));
  const phoneCols = header.map((h, i) => (/cell|phone/i.test(h) ? i : -1)).filter(i => i >= 0);
  const map = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const ctrl = daNormalizeCtrl(row[ctrlCol]);
    if (!ctrl) continue;
    for (const c of phoneCols) {
      const p = daNormalizePhone(row[c]);
      if (!p) continue;
      let list = map.get(p);
      if (!list) map.set(p, (list = []));
      if (!list.includes(ctrl)) list.push(ctrl);
    }
  }
  return map;
}

async function writeMap(map) {
  const db = await daOpenDb();
  await new Promise((res, rej) => {
    const tx = db.transaction(DA_STORE, 'readwrite');
    tx.objectStore(DA_STORE).clear();
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  const entries = [...map];
  const BATCH = 10000;
  for (let i = 0; i < entries.length; i += BATCH) {
    await new Promise((res, rej) => {
      const tx = db.transaction(DA_STORE, 'readwrite');
      const st = tx.objectStore(DA_STORE);
      for (const [p, c] of entries.slice(i, i + BATCH)) st.put({ p, c });
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    $('importStatus').textContent = `Saving... ${Math.min(i + BATCH, entries.length).toLocaleString()} / ${entries.length.toLocaleString()}`;
  }
}

$('file').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $('importStatus');
  try {
    status.textContent = 'Reading file (large workbooks take a few seconds)...';
    await new Promise(r => setTimeout(r, 50));
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', dense: true, cellFormula: false, cellHTML: false, cellText: false });
    const rows = findDataSheet(wb);
    if (!rows) throw new Error('No sheet with a "ctrl" header column found.');
    status.textContent = `Parsing ${rows.length.toLocaleString()} rows...`;
    const map = buildMap(rows);
    await writeMap(map);
    await chrome.storage.local.set({ importInfo: { file: file.name, phones: map.size, at: Date.now() } });
    await loadSettings();
  } catch (err) {
    status.textContent = `Import failed: ${err.message}`;
  }
  e.target.value = '';
};

loadSettings();
