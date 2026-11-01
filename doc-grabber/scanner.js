// Injected into every frame of the active tab. Finds PDF files and
// scanned-page images (img, canvas, svg <image>, CSS backgrounds).
// Safe to inject more than once: it only defines itself the first time.
(() => {
  if (window.__docGrabber) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- helpers ----------
  function absUrl(u) {
    try { return new URL(u, location.href).href; } catch { return null; }
  }

  function looksLikePdf(u) {
    if (!u) return false;
    if (/^data:application\/pdf/i.test(u)) return true;
    try {
      const url = new URL(u, location.href);
      return /\.pdf$/i.test(url.pathname);
    } catch { return false; }
  }

  // Viewer URLs that wrap a PDF: pdf.js "viewer.html?file=…", Google viewer "?url=…".
  function wrappedPdf(u) {
    try {
      const url = new URL(u, location.href);
      for (const key of ['file', 'url', 'src', 'pdf', 'doc']) {
        const v = url.searchParams.get(key);
        if (v && looksLikePdf(v)) return absUrl(v);
      }
    } catch {}
    return null;
  }

  // Every element, including those inside open shadow roots.
  function allElements(root = document) {
    const out = [];
    const walk = (node) => {
      for (const el of node.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return out;
  }

  // Position in the scrolled content, so pages sort correctly even after the
  // page or an inner viewer has been scrolled.
  function contentPos(el) {
    const r = el.getBoundingClientRect();
    let y = r.top + window.scrollY;
    let x = r.left + window.scrollX;
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      y += p.scrollTop; x += p.scrollLeft;
      p = p.parentElement;
    }
    return { x, y };
  }

  function pageNumberOf(el) {
    const host = el.closest('[data-page-number],[data-page],[data-page-index],[data-pageno],[aria-label]');
    if (!host) return null;
    for (const a of ['data-page-number', 'data-page', 'data-pageno']) {
      const v = parseInt(host.getAttribute(a), 10);
      if (Number.isFinite(v)) return v;
    }
    const idx = parseInt(host.getAttribute('data-page-index'), 10);
    if (Number.isFinite(idx)) return idx + 1;
    const m = /page\s*(\d+)/i.exec(host.getAttribute('aria-label') || '');
    return m ? parseInt(m[1], 10) : null;
  }

  function hashStr(s) {
    // Cheap hash over a sample of the string; enough to dedupe canvas snapshots.
    let h = 2166136261;
    const step = Math.max(1, Math.floor(s.length / 4000));
    for (let i = 0; i < s.length; i += step) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  function snapshot(source, w, h, quality) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    return c.toDataURL('image/jpeg', quality); // throws if the source is cross-origin
  }

  // ---------- state accumulated across scroll steps ----------
  let pdfs, images, tainted;
  function reset() { pdfs = new Map(); images = new Map(); tainted = 0; }
  reset();

  function addPdf(url, label, source) {
    const u = absUrl(url);
    if (!u || pdfs.has(u)) return;
    pdfs.set(u, { url: u, label: (label || '').trim().slice(0, 140), source });
  }

  function addImage(key, item) {
    const prev = images.get(key);
    // Keep the larger render if a viewer re-draws the same page at higher resolution.
    if (prev && prev.width * prev.height >= item.width * item.height) return;
    images.set(key, item);
  }

  // ---------- one pass over the current DOM ----------
  function collect(opts) {
    const minW = opts.minWidth, minH = opts.minHeight;

    if (document.contentType === 'application/pdf') addPdf(location.href, document.title, 'page');
    const selfWrapped = wrappedPdf(location.href);
    if (selfWrapped) addPdf(selfWrapped, 'Document in viewer', 'viewer');

    const els = allElements();
    for (const el of els) {
      const tag = el.tagName;

      // --- PDF files ---
      if (tag === 'EMBED' || tag === 'OBJECT' || tag === 'IFRAME' || tag === 'FRAME') {
        const src = el.getAttribute('src') || el.getAttribute('data') || '';
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (src && (type === 'application/pdf' || looksLikePdf(src))) addPdf(src, el.title || 'Embedded PDF', 'embed');
        else if (src) { const w = wrappedPdf(src); if (w) addPdf(w, 'Document in viewer', 'viewer'); }
        continue;
      }
      if (tag === 'A' && el.hasAttribute('href')) {
        const href = el.getAttribute('href');
        if (looksLikePdf(href) || /pdf/i.test(el.getAttribute('type') || '')) addPdf(href, el.textContent || el.title, 'link');
        else { const w = wrappedPdf(href); if (w) addPdf(w, el.textContent, 'link'); }
        continue;
      }

      // --- page images ---
      if (tag === 'IMG') {
        if (!el.complete || el.naturalWidth < minW || el.naturalHeight < minH) continue;
        const src = el.currentSrc || el.src;
        if (!src) continue;
        const item = {
          kind: 'img', key: src, url: src, width: el.naturalWidth, height: el.naturalHeight,
          ...contentPos(el), page: pageNumberOf(el),
        };
        // blob: URLs only live in this page, so capture their pixels now.
        if (src.startsWith('blob:')) {
          try { item.data = snapshot(el, el.naturalWidth, el.naturalHeight, opts.quality); item.url = null; }
          catch { tainted++; continue; }
        }
        addImage(src, item);
        continue;
      }

      if (tag === 'CANVAS') {
        if (el.width < minW || el.height < minH) continue;
        let data;
        try { data = snapshot(el, el.width, el.height, opts.quality); }
        catch { tainted++; continue; }
        const page = pageNumberOf(el);
        const pos = contentPos(el);
        // Viewers often recycle canvases; key on page number when we have one.
        const key = page != null ? `canvas#p${page}` : `canvas#${hashStr(data)}`;
        addImage(key, { kind: 'canvas', key, data, width: el.width, height: el.height, ...pos, page });
        continue;
      }

      if (tag === 'image' || tag === 'IMAGE') { // SVG <image>
        const href = el.getAttribute('href') || el.getAttribute('xlink:href');
        const r = el.getBoundingClientRect();
        if (!href || r.width < minW / 3 || r.height < minH / 3) continue;
        const u = absUrl(href);
        if (u) addImage(u, { kind: 'svg', key: u, url: u, width: 0, height: 0, ...contentPos(el), page: pageNumberOf(el), checkSize: true });
        continue;
      }

      // CSS background images on large boxes.
      if (el.offsetWidth >= minW / 3 && el.offsetHeight >= minH / 3) {
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none') continue;
        const m = /url\(["']?(.*?)["']?\)/.exec(bg);
        const u = m && absUrl(m[1]);
        if (u && !u.startsWith('data:image/svg')) {
          addImage(u, { kind: 'bg', key: u, url: u, width: 0, height: 0, ...contentPos(el), page: pageNumberOf(el), checkSize: true });
        }
      }
    }
  }

  // ---------- auto-scroll so lazy viewers load (and render) every page ----------
  function findScrollers() {
    const list = [];
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight > root.clientHeight + 100) list.push(root);
    let best = null, bestArea = 0;
    for (const el of allElements()) {
      if (el.clientHeight < 200 || el.scrollHeight <= el.clientHeight + 100) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    if (best) list.push(best);
    return list;
  }

  async function scrollThrough(scroller, opts, shouldStop) {
    const start = scroller.scrollTop;
    scroller.scrollTop = 0;
    await sleep(opts.delay);
    for (let i = 0; i < 2000 && !shouldStop(); i++) {
      collect(opts);
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      if (atEnd) {
        await sleep(opts.delay); // give infinite-scroll viewers a chance to append more
        collect(opts);
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
      }
      scroller.scrollTop += Math.max(100, scroller.clientHeight * 0.8);
      await sleep(opts.delay);
    }
    collect(opts);
    scroller.scrollTop = start;
  }

  let stopFlag = false;

  async function scan(options) {
    const opts = { minWidth: 300, minHeight: 300, autoScroll: true, delay: 500, quality: 0.92, ...options };
    stopFlag = false;
    reset();
    collect(opts);
    if (opts.autoScroll) {
      for (const s of findScrollers()) {
        if (stopFlag) break;
        await scrollThrough(s, opts, () => stopFlag);
      }
    }
    return {
      frameUrl: location.href,
      title: document.title,
      pdfs: [...pdfs.values()],
      images: [...images.values()].sort((a, b) => (a.y - b.y) || (a.x - b.x)),
      tainted,
    };
  }

  // Fallback for images the extension could not fetch directly (needs page cookies/referrer).
  async function fetchAsDataUrl(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  window.__docGrabber = { scan, stop: () => { stopFlag = true; }, fetchAsDataUrl };
})();
