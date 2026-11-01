// OCR with Tesseract.js, running fully inside the extension (no remote code).
// English ships with the extension; other languages' data (not code) is
// downloaded once from jsDelivr and cached by the browser.
const Ocr = (() => {
  const LANG_CDN = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data';
  const MAX_SIDE = 3500; // larger images are downscaled for OCR only (speed); boxes are scaled back

  let scheduler = null;
  let currentLang = null;
  let starting = null;

  // Several workers read pages in parallel; each one uses a CPU core and ~100 MB.
  const workerCount = () => Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)));

  async function start(lang) {
    if (scheduler && currentLang === lang) return;
    if (starting) await starting.catch(() => {});
    if (scheduler && currentLang === lang) return;
    starting = (async () => {
      await stop();
      const bundled = lang === 'eng';
      const opts = {
        workerPath: chrome.runtime.getURL('lib/tesseract/worker.min.js'),
        corePath: chrome.runtime.getURL('lib/tesseract/core'),
        langPath: bundled ? chrome.runtime.getURL('lib/tesseract/lang') : `${LANG_CDN}/${lang}/4.0.0_best_int`,
        cacheMethod: bundled ? 'none' : 'write',
        workerBlobURL: false,
      };
      const s = Tesseract.createScheduler();
      const workers = await Promise.all(
        Array.from({ length: workerCount() }, () => Tesseract.createWorker(lang, Tesseract.OEM.LSTM_ONLY, opts)));
      workers.forEach((w) => s.addWorker(w));
      scheduler = s;
      currentLang = lang;
    })();
    try { await starting; } finally { starting = null; }
  }

  async function stop() {
    if (scheduler) await scheduler.terminate().catch(() => {});
    scheduler = null;
    currentLang = null;
  }

  async function downscaledJpeg(blob, width, height) {
    const k = MAX_SIDE / Math.max(width, height);
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(Math.round(width * k), Math.round(height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return { blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 }), k };
  }

  // Returns word boxes in the image's pixel coordinates:
  // [{ text, x0, y0, x1, y1, base, last }]  (y0 = top of the line, base = baseline)
  async function recognize(jpegBlob, width, height) {
    let input = jpegBlob, k = 1;
    if (Math.max(width, height) > MAX_SIDE) ({ blob: input, k } = await downscaledJpeg(jpegBlob, width, height));
    const { data } = await scheduler.addJob('recognize', input, {}, { blocks: true, text: false });
    const words = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const lw = (line.words || []).filter((w) => w.text && w.text.trim() && w.confidence > 20);
          lw.forEach((w, i) => {
            const mid = (w.bbox.x0 + w.bbox.x1) / 2;
            const bl = line.baseline;
            let base = w.bbox.y1;
            if (bl && bl.x1 !== bl.x0) base = bl.y0 + ((bl.y1 - bl.y0) * (mid - bl.x0)) / (bl.x1 - bl.x0);
            if (!(base > line.bbox.y0)) base = w.bbox.y1;
            words.push({
              text: w.text,
              x0: w.bbox.x0 / k, x1: w.bbox.x1 / k,
              y0: Math.min(line.bbox.y0, w.bbox.y0) / k,
              y1: w.bbox.y1 / k,
              base: base / k,
              last: i === lw.length - 1,
            });
          });
        }
      }
    }
    return words;
  }

  return { start, stop, recognize, workerCount };
})();
