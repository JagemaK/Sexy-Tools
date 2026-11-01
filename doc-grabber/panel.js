const $ = (id) => document.getElementById(id);

const DEFAULTS = { autoScroll: true, delay: 500, minSize: 300, pageSize: 'fit', quality: '0.95', saveAs: false };

let scanTabId = null;  // tab the current results came from
let pages = [];        // [{ id, frameId, url, data, width, height, page, selected, checkSize }]
let busy = false;

// ---------- settings ----------
async function loadSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $('autoScroll').checked = s.autoScroll;
  $('delay').value = s.delay;
  $('minSize').value = s.minSize;
  $('pageSize').value = s.pageSize;
  $('quality').value = s.quality;
  $('saveAs').checked = s.saveAs;
}
function saveSettings() {
  chrome.storage.local.set({
    autoScroll: $('autoScroll').checked,
    delay: +$('delay').value || DEFAULTS.delay,
    minSize: +$('minSize').value || DEFAULTS.minSize,
    pageSize: $('pageSize').value,
    quality: $('quality').value,
    saveAs: $('saveAs').checked,
  });
}
for (const id of ['autoScroll', 'delay', 'minSize', 'pageSize', 'quality', 'saveAs']) {
  $(id).addEventListener('change', saveSettings);
}

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

function setBusy(on) {
  busy = on;
  $('scan').disabled = on;
  $('build').disabled = on;
}

// ---------- utilities ----------
function sanitizeName(name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || 'document';
}

function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (/\.pdf$/i.test(last)) return sanitizeName(last.replace(/\.pdf$/i, '')) + '.pdf';
  } catch {}
  return null;
}

function isPdfUrl(url) {
  try { return /\.pdf$/i.test(new URL(url).pathname); } catch { return false; }
}

function hostOf(url) {
  try { return new URL(url).host || url.slice(0, 40); } catch { return ''; }
}

async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

async function download(url, filename) {
  await chrome.downloads.download({ url, filename, saveAs: $('saveAs').checked, conflictAction: 'uniquify' });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---------- scanning ----------
async function scan() {
  if (busy) return;
  const tab = await getActiveTab();
  if (!tab || !/^(https?|file):/.test(tab.url || '')) {
    setStatus('This page can\'t be scanned. Open a normal web page (http/https) and try again.', true);
    return;
  }
  saveSettings();
  setBusy(true);
  $('stop').hidden = false;
  scanTabId = tab.id;
  const min = +$('minSize').value || DEFAULTS.minSize;
  const opts = {
    autoScroll: $('autoScroll').checked,
    delay: +$('delay').value || DEFAULTS.delay,
    minWidth: min,
    minHeight: min,
    quality: 0.95,
  };
  setStatus(opts.autoScroll ? 'Scanning… scrolling through the page to load every page.\nKeep this tab in front until it finishes.' : 'Scanning…');

  const pdfs = new Map();
  pages = [];
  let tainted = 0;
  let title = tab.title || '';

  if (isPdfUrl(tab.url)) pdfs.set(tab.url, { url: tab.url, label: tab.title, source: 'page', frameId: 0 });

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['scanner.js'] });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (o) => window.__docGrabber && window.__docGrabber.scan(o),
      args: [opts],
    });
    let id = 0;
    for (const { frameId, result } of results) {
      if (!result) continue;
      if (frameId === 0 && result.title) title = result.title;
      tainted += result.tainted;
      for (const p of result.pdfs) if (!pdfs.has(p.url)) pdfs.set(p.url, { ...p, frameId });
      for (const img of result.images) pages.push({ ...img, id: ++id, frameId, selected: true });
    }
  } catch (e) {
    // Chrome's built-in PDF viewer and some protected pages refuse script injection.
    if (!pdfs.size) {
      setStatus('Could not scan this page: ' + e.message, true);
      setBusy(false);
      $('stop').hidden = true;
      return;
    }
  }

  $('fileName').value = sanitizeName(title);
  renderPdfs([...pdfs.values()]);
  renderPages();

  const parts = [];
  parts.push(`${pdfs.size} PDF file${pdfs.size === 1 ? '' : 's'}`);
  parts.push(`${pages.length} page image${pages.length === 1 ? '' : 's'}`);
  let msg = `Found ${parts.join(' and ')}.`;
  if (tainted) msg += `\n${tainted} canvas page(s) were blocked by the site and could not be captured.`;
  if (!pdfs.size && !pages.length) msg += '\nTry lowering "Ignore images smaller than", or scroll the document once and scan again.';
  setStatus(msg);
  setBusy(false);
  $('stop').hidden = true;
}

async function stopScan() {
  if (scanTabId == null) return;
  await chrome.scripting.executeScript({
    target: { tabId: scanTabId, allFrames: true },
    func: () => window.__docGrabber && window.__docGrabber.stop(),
  }).catch(() => {});
}

// ---------- PDF list ----------
function renderPdfs(list) {
  $('pdfSection').hidden = !list.length;
  $('pdfCount').textContent = list.length;
  const ul = $('pdfList');
  ul.replaceChildren();
  // Embedded/viewer PDFs first, then plain links.
  const rank = { page: 0, embed: 1, viewer: 1, link: 2 };
  list.sort((a, b) => (rank[a.source] ?? 3) - (rank[b.source] ?? 3));
  for (const p of list) {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    const fname = fileNameFromUrl(p.url) || sanitizeName(p.label) + '.pdf';
    name.textContent = p.label && p.source === 'link' ? p.label : fname;
    name.title = p.url;
    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = `${p.source === 'link' ? 'Link' : 'On page'} · ${hostOf(p.url)}`;
    meta.append(name, src);
    const btn = document.createElement('button');
    btn.textContent = 'Download';
    btn.addEventListener('click', () => downloadPdf(p, fname, btn));
    li.append(meta, btn);
    ul.append(li);
  }
}

async function downloadPdf(p, fname, btn) {
  btn.disabled = true;
  try {
    if (p.url.startsWith('blob:')) {
      // blob: URLs belong to the page, so read the bytes from inside it.
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: scanTabId, frameIds: [p.frameId] },
        func: (u) => window.__docGrabber.fetchAsDataUrl(u),
        args: [p.url],
      });
      const url = URL.createObjectURL(await dataUrlToBlob(result));
      await download(url, fname);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } else {
      await download(p.url, fname);
    }
    setStatus(`Downloading ${fname}`);
  } catch (e) {
    setStatus('Download failed: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- page grid ----------
let dragId = null;

function renderPages() {
  $('pageSection').hidden = !pages.length;
  const grid = $('grid');
  grid.replaceChildren();
  let n = 0;
  for (const p of pages) {
    const el = document.createElement('div');
    el.className = 'thumb' + (p.selected ? ' selected' : '');
    el.draggable = true;
    el.dataset.id = p.id;
    el.title = p.page ? `Page ${p.page}` : (p.url || 'Captured page');

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = p.data || p.url;
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
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = p.width ? `${p.width}×${p.height}` : '';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = p.selected;
    box.tabIndex = -1;

    el.append(img, num, size, box);
    el.addEventListener('click', () => { p.selected = !p.selected; renderPages(); });
    el.addEventListener('dragstart', () => { dragId = p.id; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-target'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      if (dragId == null || dragId === p.id) return;
      const from = pages.findIndex((x) => x.id === dragId);
      const [moved] = pages.splice(from, 1);
      pages.splice(pages.findIndex((x) => x.id === p.id), 0, moved);
      renderPages();
    });
    grid.append(el);
  }
  const sel = pages.filter((p) => p.selected).length;
  $('pageCount').textContent = `${sel}/${pages.length}`;
  $('build').textContent = sel ? `Download ${sel} page${sel === 1 ? '' : 's'} as PDF` : 'Select pages to download';
  $('build').disabled = busy || !sel;
}

$('selAll').addEventListener('click', () => { pages.forEach((p) => (p.selected = true)); renderPages(); });
$('selNone').addEventListener('click', () => { pages.forEach((p) => (p.selected = false)); renderPages(); });

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
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: scanTabId, frameIds: [p.frameId] },
    func: (u) => window.__docGrabber.fetchAsDataUrl(u),
    args: [p.url],
  });
  return dataUrlToBlob(result);
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

async function toJpeg(blob, quality) {
  const src = await decode(blob);
  let w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  if (!w || !h) throw new Error('empty image');
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  w = Math.round(w * s); h = Math.round(h * s);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent areas become white paper
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  const out = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  return { jpeg: new Uint8Array(await out.arrayBuffer()), width: w, height: h };
}

async function buildPdf() {
  const selected = pages.filter((p) => p.selected);
  if (!selected.length || busy) return;
  saveSettings();
  setBusy(true);
  const bar = $('progress');
  bar.hidden = false;
  bar.max = selected.length;
  bar.value = 0;
  const quality = parseFloat($('quality').value) || 0.95;
  const out = [];
  const failed = [];
  try {
    for (let i = 0; i < selected.length; i++) {
      setStatus(`Adding page ${i + 1} of ${selected.length}…`);
      try {
        out.push(await toJpeg(await fetchImageBlob(selected[i]), quality));
      } catch (e) {
        failed.push(i + 1);
      }
      bar.value = i + 1;
    }
    if (!out.length) throw new Error('none of the pages could be loaded');
    const pdf = PdfBuilder.build(out, { title: $('fileName').value, pageSize: $('pageSize').value });
    const fname = sanitizeName($('fileName').value) + '.pdf';
    const url = URL.createObjectURL(pdf);
    await download(url, fname);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    let msg = `Saved ${fname} — ${out.length} page${out.length === 1 ? '' : 's'}, ${(pdf.size / 1048576).toFixed(1)} MB.`;
    if (failed.length) msg += `\nSkipped page(s) ${failed.join(', ')}: could not load the image.`;
    setStatus(msg, failed.length > 0);
  } catch (e) {
    setStatus('Could not build the PDF: ' + e.message, true);
  } finally {
    bar.hidden = true;
    setBusy(false);
    renderPages();
  }
}

$('scan').addEventListener('click', scan);
$('stop').addEventListener('click', stopScan);
$('build').addEventListener('click', buildPdf);

loadSettings();
