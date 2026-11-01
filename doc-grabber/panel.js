const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  autoScroll: true, speed: 'fast', minSize: 300, pageSize: 'fit', quality: '0.95', saveAs: false,
  colorMode: 'color', enhance: false, trim: false, ocr: true, ocrLang: 'eng',
};
const SETTING_IDS = Object.keys(DEFAULTS);

let pages = [];          // [{ id, tabId, frameId, url, data, width, height, page, selected, rotate, checkSize }]
let pdfs = new Map();    // url -> { url, label, source, tabId, frameId }
let nextId = 0;
let busy = false;
let scanningTabId = null;
let previewIndex = -1;

// ---------- settings ----------
async function loadSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(SETTING_IDS)) };
  for (const id of SETTING_IDS) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = s[id]; else el.value = s[id];
  }
  applyLookPreview();
}
function saveSettings() {
  const s = {};
  for (const id of SETTING_IDS) {
    const el = $(id);
    s[id] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (+el.value || DEFAULTS[id]) : el.value;
  }
  chrome.storage.local.set(s);
}
for (const id of SETTING_IDS) {
  $(id).addEventListener('change', () => { saveSettings(); applyLookPreview(); });
}

// Live preview of Look / enhance settings on the thumbnails and the preview.
function applyLookPreview() {
  for (const el of [$('grid'), $('preview')]) {
    el.classList.toggle('gray', $('colorMode').value === 'gray');
    el.classList.toggle('bw', $('colorMode').value === 'bw');
    el.classList.toggle('enhance', $('enhance').checked);
  }
}

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

function setBusy(on) {
  busy = on;
  $('scan').disabled = on;
  $('scanAdd').disabled = on;
  $('stop').hidden = !on || scanningTabId == null;
  renderPages();
}

// ---------- utilities ----------
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function sanitizeName(name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || 'document';
}

function fileNameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    if (/\.pdf$/i.test(last)) return sanitizeName(last.replace(/\.pdf$/i, '')) + '.pdf';
  } catch {}
  return null;
}

const isPdfUrl = (url) => { try { return /\.pdf$/i.test(new URL(url).pathname); } catch { return false; } };
const hostOf = (url) => { try { return new URL(url).host || url.slice(0, 40); } catch { return ''; } };
const dataUrlToBlob = async (dataUrl) => (await fetch(dataUrl)).blob();

async function download(url, filename) {
  await chrome.downloads.download({ url, filename, saveAs: $('saveAs').checked, conflictAction: 'uniquify' });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function fetchInFrame(tabId, frameId, url) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (u) => window.__docGrabber.fetchAsDataUrl(u),
    args: [url],
  });
  return dataUrlToBlob(result);
}

// ---------- scanning ----------
async function scan(append) {
  if (busy) return;
  const tab = await getActiveTab();
  if (!tab || !/^(https?|file):/.test(tab.url || '')) {
    setStatus('This page can\'t be scanned. Open a normal web page (http/https) and try again.', true);
    return;
  }
  saveSettings();
  if (!append) { pages = []; pdfs = new Map(); }
  scanningTabId = tab.id;
  setBusy(true);
  const min = +$('minSize').value || DEFAULTS.minSize;
  const opts = {
    autoScroll: $('autoScroll').checked,
    speed: $('speed').value,
    minWidth: min, minHeight: min, quality: 0.95,
  };
  setStatus(opts.autoScroll ? 'Scanning… scrolling through the page to load every page.\nKeep this tab in front until it finishes.' : 'Scanning…');
  const t0 = performance.now();
  // Live progress while the page scrolls.
  const poll = setInterval(async () => {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => window.__docGrabber && window.__docGrabber.progress(),
      });
      let found = 0, pct = 0, phase = 'scanning';
      for (const { result } of res) {
        if (!result) continue;
        found += result.found;
        if (result.pct > pct) { pct = result.pct; }
        if (result.phase !== 'scanning' && result.phase !== 'done') phase = result.phase;
      }
      if (busy) setStatus(`Scanning… ${pct}% · ${plural(found, 'page')} found${phase !== 'scanning' ? ` · ${phase}` : ''}\nKeep this tab in front until it finishes.`);
    } catch {}
  }, 700);

  const pdfsBefore = pdfs.size, pagesBefore = pages.length;
  const knownKeys = new Set(pages.map((p) => `${p.tabId}|${p.key}`));
  let tainted = 0, stopped = false;
  const missing = [];
  let title = tab.title || '';
  if (isPdfUrl(tab.url) && !pdfs.has(tab.url)) {
    pdfs.set(tab.url, { url: tab.url, label: tab.title, source: 'page', tabId: tab.id, frameId: 0 });
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['scanner.js'] });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (o) => window.__docGrabber && window.__docGrabber.scan(o),
      args: [opts],
    });
    for (const { frameId, result } of results) {
      if (!result) continue;
      if (frameId === 0 && result.title) title = result.title;
      tainted += result.tainted;
      stopped = stopped || result.stopped;
      missing.push(...result.missing);
      for (const p of result.pdfs) if (!pdfs.has(p.url)) pdfs.set(p.url, { ...p, tabId: tab.id, frameId });
      for (const img of result.images) {
        const k = `${tab.id}|${img.key}`;
        if (knownKeys.has(k)) continue; // already captured from this tab
        knownKeys.add(k);
        pages.push({ ...img, id: ++nextId, tabId: tab.id, frameId, selected: true, rotate: 0 });
      }
    }
  } catch (e) {
    // Chrome's built-in PDF viewer and some protected pages refuse script injection.
    if (pdfs.size === pdfsBefore) setStatus('Could not scan this page: ' + e.message, true);
  } finally {
    clearInterval(poll);
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);

  if (!append || !$('fileName').value) $('fileName').value = sanitizeName(title);
  scanningTabId = null;
  renderPdfs();
  setBusy(false);

  const newPdfs = pdfs.size - pdfsBefore, newPages = pages.length - pagesBefore;
  if ($('status').classList.contains('error') && !newPdfs) return;
  let msg = append
    ? `Added ${plural(newPages, 'page')} and ${plural(newPdfs, 'PDF')}. Total: ${plural(pages.length, 'page')}.`
    : `Found ${plural(newPdfs, 'PDF file')} and ${plural(newPages, 'page image')} in ${secs} s.`;
  if (stopped) msg += '\nStopped early: pages below where it stopped were not scanned.';
  if (missing.length) {
    msg += `\nThe viewer never showed page(s) ${missing.slice(0, 15).join(', ')}${missing.length > 15 ? '…' : ''}. ` +
      'Try Scan speed "Careful", or scroll to them and press "+ Scan & add".';
  }
  if (tainted) msg += `\n${tainted} canvas page(s) were blocked by the site and could not be captured.`;
  if (!$('status').classList.contains('error') && (missing.length || tainted)) {
    setStatus(msg, true);
    return;
  }
  if (!newPdfs && !newPages) msg += '\nTry lowering "Ignore images smaller than", or scroll the document once and scan again.';
  if (pages.length) msg += '\nTip: open another tab and press "+ Scan & add" to combine documents.';
  setStatus(msg);
}

async function stopScan() {
  if (scanningTabId == null) return;
  await chrome.scripting.executeScript({
    target: { tabId: scanningTabId, allFrames: true },
    func: () => window.__docGrabber && window.__docGrabber.stop(),
  }).catch(() => {});
}

// ---------- PDF list ----------
function pdfFileName(p) {
  return fileNameFromUrl(p.url) || sanitizeName(p.label) + '.pdf';
}

function renderPdfs() {
  const list = [...pdfs.values()];
  $('pdfSection').hidden = !list.length;
  $('pdfCount').textContent = list.length;
  $('dlAll').hidden = list.length < 2;
  const ul = $('pdfList');
  ul.replaceChildren();
  const rank = { page: 0, embed: 1, viewer: 1, link: 2 };
  list.sort((a, b) => (rank[a.source] ?? 3) - (rank[b.source] ?? 3));
  for (const p of list) {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = p.label && p.source === 'link' ? p.label : pdfFileName(p);
    name.title = p.url;
    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = `${p.source === 'link' ? 'Link' : 'On page'} · ${hostOf(p.url)}`;
    meta.append(name, src);
    const btn = document.createElement('button');
    btn.textContent = 'Download';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await downloadPdf(p);
      btn.disabled = false;
    });
    li.append(meta, btn);
    ul.append(li);
  }
}

async function downloadPdf(p) {
  const fname = pdfFileName(p);
  try {
    if (p.url.startsWith('blob:')) {
      // blob: URLs belong to the page, so read the bytes from inside it.
      const url = URL.createObjectURL(await fetchInFrame(p.tabId, p.frameId, p.url));
      await download(url, fname);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } else {
      await download(p.url, fname);
    }
    setStatus(`Downloading ${fname}`);
    return true;
  } catch (e) {
    setStatus(`Download of ${fname} failed: ${e.message}`, true);
    return false;
  }
}

$('dlAll').addEventListener('click', async () => {
  $('dlAll').disabled = true;
  let ok = 0;
  for (const p of pdfs.values()) if (await downloadPdf(p)) ok++;
  setStatus(`Downloading ${plural(ok, 'PDF file')}.`, ok < pdfs.size);
  $('dlAll').disabled = false;
});

// ---------- page grid ----------
let dragId = null;

function renderPages() {
  $('pageSection').hidden = !pages.length;
  $('scanAdd').hidden = !pages.length && !pdfs.size;
  const grid = $('grid');
  grid.replaceChildren();
  let n = 0;
  pages.forEach((p, index) => {
    const el = document.createElement('div');
    el.className = 'thumb' + (p.selected ? ' selected' : '');
    el.draggable = true;
    el.title = `#${index + 1}` + (p.page ? ` · page ${p.page}` : '') + (p.url ? ` · ${hostOf(p.url)}` : '');

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = p.data || p.url;
    img.style.transform = rotateCss(p.rotate);

    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = p.width ? `${p.width}×${p.height}` : '';

    if (p.checkSize) {
      img.addEventListener('load', () => {
        const min = +$('minSize').value || DEFAULTS.minSize;
        if (img.naturalWidth < min || img.naturalHeight < min) {
          pages = pages.filter((x) => x !== p); // background image too small to be a page
          renderPages();
        } else {
          p.width = img.naturalWidth; p.height = img.naturalHeight; p.checkSize = false;
          size.textContent = `${p.width}×${p.height}`;
        }
      }, { once: true });
    }

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = p.selected ? ++n : '–';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = p.selected;
    box.tabIndex = -1;
    const rot = document.createElement('button');
    rot.className = 'rot';
    rot.textContent = '↻';
    rot.title = 'Rotate 90°';
    rot.addEventListener('click', (e) => {
      e.stopPropagation();
      p.rotate = (p.rotate + 90) % 360;
      img.style.transform = rotateCss(p.rotate);
    });
    rot.addEventListener('dblclick', (e) => e.stopPropagation());

    el.append(img, num, size, box, rot);
    // Delay single-click toggling slightly so a double-click (preview) doesn't toggle twice.
    let clickTimer = null;
    el.addEventListener('click', () => {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { p.selected = !p.selected; renderPages(); }, 220);
    });
    el.addEventListener('dblclick', () => { clearTimeout(clickTimer); openPreview(index); });
    el.addEventListener('dragstart', () => { dragId = p.id; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-target'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      if (dragId == null || dragId === p.id) return;
      const [moved] = pages.splice(pages.findIndex((x) => x.id === dragId), 1);
      pages.splice(pages.findIndex((x) => x.id === p.id), 0, moved);
      renderPages();
    });
    grid.append(el);
  });
  const sel = pages.filter((p) => p.selected).length;
  $('pageCount').textContent = `${sel}/${pages.length}`;
  $('build').textContent = sel ? `Download ${plural(sel, 'page')} as PDF` : 'Select pages to download';
  $('build').disabled = busy || !sel;
}

function rotateCss(deg) {
  // Sideways pages shrink so they still fit the portrait thumbnail.
  return deg % 180 ? `rotate(${deg}deg) scale(0.75)` : deg ? `rotate(${deg}deg)` : '';
}

// "1-5, 8, 10-" -> Set of 1-based positions
function parseRange(text, max) {
  const out = new Set();
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (m) {
      const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : max;
      for (let i = Math.max(1, a); i <= Math.min(max, b); i++) out.add(i);
    } else if (/^\d+$/.test(part) && +part >= 1 && +part <= max) {
      out.add(+part);
    } else {
      throw new Error(`"${part}" isn't a page or range`);
    }
  }
  return out;
}

$('selAll').addEventListener('click', () => { pages.forEach((p) => (p.selected = true)); renderPages(); });
$('selNone').addEventListener('click', () => { pages.forEach((p) => (p.selected = false)); renderPages(); });
function selectRange() {
  try {
    const set = parseRange($('range').value, pages.length);
    pages.forEach((p, i) => (p.selected = set.has(i + 1)));
    renderPages();
    setStatus(`Selected ${plural(set.size, 'page')} (numbers are positions in the grid).`);
  } catch (e) {
    setStatus(e.message, true);
  }
}
$('selRange').addEventListener('click', selectRange);
$('range').addEventListener('keydown', (e) => { if (e.key === 'Enter') selectRange(); });
$('clear').addEventListener('click', () => {
  pages = []; pdfs = new Map();
  renderPdfs(); renderPages();
  setStatus('Cleared. Press Scan to start again.');
});

// ---------- full-size preview ----------
function openPreview(i) {
  if (!pages.length) return;
  previewIndex = (i + pages.length) % pages.length;
  const p = pages[previewIndex];
  $('previewImg').src = p.data || p.url;
  $('previewImg').style.transform = rotateCss(p.rotate);
  $('previewLabel').textContent = `${previewIndex + 1} / ${pages.length}${p.selected ? '' : ' (skipped)'}`;
  $('preview').hidden = false;
}
function closePreview() { $('preview').hidden = true; previewIndex = -1; }
$('prevPage').addEventListener('click', () => openPreview(previewIndex - 1));
$('nextPage').addEventListener('click', () => openPreview(previewIndex + 1));
$('closePreview').addEventListener('click', closePreview);
$('preview').addEventListener('click', (e) => { if (e.target.id === 'preview') closePreview(); });
document.addEventListener('keydown', (e) => {
  if ($('preview').hidden) return;
  if (e.key === 'Escape') closePreview();
  else if (e.key === 'ArrowLeft') openPreview(previewIndex - 1);
  else if (e.key === 'ArrowRight') openPreview(previewIndex + 1);
  else if (e.key === ' ') { e.preventDefault(); pages[previewIndex].selected = !pages[previewIndex].selected; renderPages(); openPreview(previewIndex); }
});

// ---------- building the PDF ----------
async function fetchImageBlob(p) {
  if (p.data) return dataUrlToBlob(p.data);
  if (p.url.startsWith('data:')) return dataUrlToBlob(p.url);
  try {
    const res = await fetch(p.url, { credentials: 'include' });
    if (res.ok) {
      const blob = await res.blob();
      if (blob.size) return blob;
    }
  } catch {}
  // Fall back to fetching from inside the page (uses its cookies and referrer).
  return fetchInFrame(p.tabId, p.frameId, p.url);
}

async function decode(blob) {
  try {
    return await createImageBitmap(blob);
  } catch {
    // createImageBitmap can't read SVG; an <img> can.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

const MAX_SIDE = 8000; // keep canvases within browser limits

// Bounding box of the non-white content, with a small margin.
function contentBox(d, w, h) {
  const px = d.data;
  const lum = (i) => px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
  // Paper colour = bright end of the histogram; anything clearly darker is content.
  // This copes with grey or yellowed scans, not just pure white.
  const hist = new Uint32Array(256);
  let samples = 0;
  for (let i = 0; i < px.length; i += 4 * 7) { hist[lum(i) | 0]++; samples++; }
  let paper = 255, acc = 0;
  while (paper > 0 && (acc += hist[paper]) < samples * 0.3) paper--;
  const cutoff = Math.min(235, paper - 30);
  const dark = (i) => lum(i) < cutoff;
  const rowHas = (y) => { for (let x = 0, i = y * w * 4; x < w; x += 2, i += 8) if (dark(i)) return true; return false; };
  const colHas = (x, y0, y1) => { for (let y = y0; y <= y1; y += 2) if (dark((y * w + x) * 4)) return true; return false; };
  let top = 0, bottom = h - 1;
  while (top < h && !rowHas(top)) top++;
  if (top >= h) return null; // blank page
  while (bottom > top && !rowHas(bottom)) bottom--;
  let left = 0, right = w - 1;
  while (left < w && !colHas(left, top, bottom)) left++;
  while (right > left && !colHas(right, top, bottom)) right--;
  const m = Math.round(Math.max(w, h) * 0.02);
  return {
    x: Math.max(0, left - m), y: Math.max(0, top - m),
    w: Math.min(w, right + m + 1) - Math.max(0, left - m),
    h: Math.min(h, bottom + m + 1) - Math.max(0, top - m),
  };
}

// Stretch levels so the darkest 1% becomes black and the lightest 1% white.
function autoLevels(d) {
  const px = d.data, hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) hist[(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0]++;
  const total = px.length / 4;
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < total * 0.01) lo++;
  acc = 0;
  while (hi > 0 && (acc += hist[hi]) < total * 0.01) hi--;
  if (hi - lo < 10) return;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
  for (let i = 0; i < px.length; i += 4) { px[i] = lut[px[i]]; px[i + 1] = lut[px[i + 1]]; px[i + 2] = lut[px[i + 2]]; }
}

// Grayscale, or crisp black & white using Otsu's threshold.
function toGray(d, bw) {
  const px = d.data, hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
    px[i] = px[i + 1] = px[i + 2] = g;
    hist[g]++;
  }
  if (!bw) return;
  const total = px.length / 4;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = px[i] > threshold ? 255 : 0;
}

async function toJpeg(blob, page, look) {
  const src = await decode(blob);
  let w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  if (!w || !h) throw new Error('empty image');
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  w = Math.round(w * s); h = Math.round(h * s);
  const sideways = page.rotate % 180 !== 0;
  let canvas = document.createElement('canvas');
  canvas.width = sideways ? h : w;
  canvas.height = sideways ? w : h;
  let ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; // transparent areas become white paper
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((page.rotate * Math.PI) / 180);
  ctx.drawImage(src, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (src.close) src.close();

  if (look.trim || look.enhance || look.colorMode !== 'color') {
    let d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (look.trim) {
      const box = contentBox(d, canvas.width, canvas.height);
      if (box && (box.w < canvas.width || box.h < canvas.height)) {
        d = ctx.getImageData(box.x, box.y, box.w, box.h);
        canvas = document.createElement('canvas');
        canvas.width = box.w; canvas.height = box.h;
        ctx = canvas.getContext('2d');
      }
    }
    if (look.enhance || look.colorMode === 'bw') autoLevels(d);
    if (look.colorMode !== 'color') toGray(d, look.colorMode === 'bw');
    ctx.putImageData(d, 0, 0);
  }

  const out = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', look.quality));
  return { blob: out, jpeg: new Uint8Array(await out.arrayBuffer()), width: canvas.width, height: canvas.height };
}

// Runs fn over items with a limited number in flight, keeping results in order.
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

async function buildPdf() {
  const selected = pages.filter((p) => p.selected);
  if (!selected.length || busy) return;
  saveSettings();
  setBusy(true);
  const bar = $('progress');
  bar.hidden = false;
  const look = {
    quality: parseFloat($('quality').value) || 0.95,
    colorMode: $('colorMode').value,
    enhance: $('enhance').checked,
    trim: $('trim').checked,
  };
  const useOcr = $('ocr').checked;
  const t0 = performance.now();
  // Each page counts once for the image and, with OCR, once for reading its text.
  const steps = selected.length * (useOcr ? 2 : 1);
  bar.max = steps;
  bar.value = 0;
  let done = 0, read = 0, words = 0;
  const failed = [];
  const tick = () => {
    bar.value = done + read;
    setStatus(useOcr
      ? `Preparing pages ${done}/${selected.length} · reading text ${read}/${selected.length}…`
      : `Adding page ${done}/${selected.length}…`);
  };
  try {
    if (useOcr) {
      setStatus('Starting the text reader (OCR)…');
      try {
        await Ocr.start($('ocrLang').value);
      } catch (e) {
        throw new Error(`could not start OCR for this language (${e.message || e}). Check your connection, or turn OCR off.`);
      }
    }
    tick();
    // Pages are fetched and processed a few at a time, while OCR workers read finished pages in parallel.
    const limit = useOcr ? Ocr.workerCount() + 2 : 4;
    const out = await runPool(selected, limit, async (p, i) => {
      let page;
      try {
        page = await toJpeg(await fetchImageBlob(p), p, look);
      } catch {
        failed.push(i + 1);
        done++; read++; tick();
        return null;
      }
      done++; tick();
      if (useOcr) {
        try {
          page.words = await Ocr.recognize(page.blob, page.width, page.height);
          words += page.words.length;
        } catch { page.words = []; }
        read++; tick();
      }
      delete page.blob;
      return page;
    });
    const good = out.filter(Boolean);
    if (!good.length) throw new Error('none of the pages could be loaded');
    setStatus('Writing the PDF…');
    const pdf = await PdfBuilder.build(good, { title: $('fileName').value, pageSize: $('pageSize').value });
    const fname = sanitizeName($('fileName').value) + '.pdf';
    const url = URL.createObjectURL(pdf);
    await download(url, fname);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    let msg = `Saved ${fname}: ${plural(good.length, 'page')}, ${(pdf.size / 1048576).toFixed(1)} MB, in ${secs} s.`;
    if (useOcr) msg += words ? `\nSearchable: ${words.toLocaleString()} words recognised.` : '\nOCR found no readable text.';
    if (failed.length) msg += `\nSkipped page(s) ${failed.sort((a, b) => a - b).join(', ')}: could not load the image.`;
    setStatus(msg, failed.length > 0);
  } catch (e) {
    setStatus('Could not build the PDF: ' + e.message, true);
  } finally {
    bar.hidden = true;
    setBusy(false);
  }
}

$('scan').addEventListener('click', () => scan(false));
$('scanAdd').addEventListener('click', () => scan(true));
$('stop').addEventListener('click', stopScan);
$('build').addEventListener('click', buildPdf);

loadSettings();
renderPages();
