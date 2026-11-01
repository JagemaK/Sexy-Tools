// Injected into every frame of the active tab. Finds PDF files and
// scanned-page images (img, canvas, svg <image>, CSS backgrounds).
// Safe to inject more than once: it only defines itself the first time.
(() => {
  if (window.__docGrabber) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // How long to wait for the page to settle after each scroll step.
  //   min:   always wait at least this long
  //   quiet: proceed once the DOM has been quiet this long (and visible images loaded)
  //   max:   never wait longer than this
  //   step:  scroll distance as a fraction of the viewport
  const SPEEDS = {
    turbo:    { min: 50,  quiet: 120, max: 1000, step: 0.95, retryMax: 2500 },
    fast:     { min: 80,  quiet: 200, max: 1500, step: 0.9,  retryMax: 3500 },
    careful:  { min: 400, quiet: 700, max: 5000, step: 0.5,  retryMax: 9000 },
  };

  // ---------- helpers ----------
  function absUrl(u) {
    try { return new URL(u, location.href).href; } catch { return null; }
  }

  function looksLikePdf(u) {
    if (!u) return false;
    if (/^data:application\/pdf/i.test(u)) return true;
    try { return /\.pdf$/i.test(new URL(u, location.href).pathname); } catch { return false; }
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

  // ---------- page numbers ----------
  // Only trust a page number when the element carrying it is clearly ONE page:
  // page-sized and holding a single page image. A number on a shared wrapper
  // ("current page", "Page 1 of 59" toolbars) would otherwise give every page
  // the same identity and pages would overwrite each other.
  const PAGE_ATTRS = ['data-page-number', 'data-page', 'data-pageno', 'data-page-index'];
  const PAGE_SELECTOR = PAGE_ATTRS.map((a) => `[${a}]`).join(',') + ',[aria-label^="page" i]';
  let activeScroller = null; // the element being auto-scrolled (never itself a page)

  function attrPageNumber(el) {
    for (const a of PAGE_ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const v = parseInt(el.getAttribute(a), 10);
      if (Number.isFinite(v)) return a === 'data-page-index' ? v + 1 : v;
    }
    const m = /^\s*page\s*(\d+)\s*$/i.exec(el.getAttribute('aria-label') || '');
    return m ? parseInt(m[1], 10) : null;
  }

  function isSinglePageBox(host, minW, minH) {
    const h = host.getBoundingClientRect().height;
    if (h < minH / 4 || h > Math.max(6000, innerHeight * 4)) return false;
    let media = 0;
    for (const m of host.querySelectorAll('canvas, img')) {
      const w = m.tagName === 'CANVAS' ? m.width : m.naturalWidth;
      const hh = m.tagName === 'CANVAS' ? m.height : m.naturalHeight;
      if (w >= minW / 2 && hh >= minH / 2 && ++media > 1) return false;
    }
    return true;
  }

  function pageNumberOf(el, opts) {
    let p = el; // the image itself may carry the number
    for (let depth = 0; p && depth < 9; depth++, p = p.parentElement) {
      const n = attrPageNumber(p);
      if (n == null) continue;
      if (activeScroller && p.contains(activeScroller)) return null; // a wrapper around the viewer
      return isSinglePageBox(p, opts.minWidth, opts.minHeight) ? n : null;
    }
    return null;
  }

  // ---------- pixel capture ----------
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { willReadFrequently: true });

  // Exact hash of the rendered pixels. Same page rendered twice -> same hash;
  // two different pages -> different hashes. Much cheaper than JPEG-encoding.
  function drawAndHash(source, w, h) {
    scratch.width = w; scratch.height = h;
    sctx.fillStyle = '#fff';
    sctx.fillRect(0, 0, w, h);
    sctx.drawImage(source, 0, 0, w, h);
    const px = new Uint32Array(sctx.getImageData(0, 0, w, h).data.buffer); // throws if cross-origin
    let h1 = 2166136261, h2 = 0x9e3779b9;
    for (let i = 0; i < px.length; i++) {
      h1 = Math.imul(h1 ^ px[i], 16777619);
      h2 = Math.imul(h2 ^ px[i], 2246822507) + i;
    }
    return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}x${w}x${h}`;
  }

  // ---------- state accumulated across scroll steps ----------
  let pdfs, images, byHash, byPage, placeholders, tainted, progress, seenEls;
  function reset() {
    pdfs = new Map();
    images = new Map();      // key -> item
    byHash = new Set();      // pixel hashes already captured
    byPage = new Map();      // page number -> key
    placeholders = new Map(); // page number -> page box element (loaded or not)
    tainted = 0;
    progress = { phase: 'scanning', pct: 0, found: 0 };
    seenEls = new WeakMap();
  }
  reset();

  function addPdf(url, label, source) {
    const u = absUrl(url);
    if (!u || pdfs.has(u)) return;
    pdfs.set(u, { url: u, label: (label || '').trim().slice(0, 140), source });
  }

  // Tiny thumbnail per element: if an element still looks exactly as it did on the
  // previous scroll step, skip the full-resolution hash entirely.
  const mini = document.createElement('canvas');
  mini.width = 32; mini.height = 42;
  const mctx = mini.getContext('2d', { willReadFrequently: true });
  // (seenEls is declared with the scan state and cleared on every scan)
  function unchanged(el, w, h) {
    let sig;
    try {
      mctx.clearRect(0, 0, 32, 42);
      mctx.drawImage(el, 0, 0, 32, 42);
      const d = new Uint32Array(mctx.getImageData(0, 0, 32, 42).data.buffer);
      let s = 2166136261;
      for (let i = 0; i < d.length; i++) s = Math.imul(s ^ d[i], 16777619);
      sig = `${s}:${w}x${h}:${el.currentSrc || ''}`;
    } catch { return false; }
    if (seenEls.get(el) === sig) return true;
    seenEls.set(el, sig);
    return false;
  }

  // Captures a canvas or blob image if its pixels are new.
  function capturePixels(el, kind, w, h, opts) {
    if (unchanged(el, w, h)) return;
    let hash;
    try { hash = drawAndHash(el, w, h); } catch { tainted++; return; }
    if (byHash.has(hash)) return; // already have exactly this page
    const page = pageNumberOf(el, opts);
    const data = scratch.toDataURL('image/jpeg', opts.quality);
    const item = { kind, key: 'px:' + hash, data, width: w, height: h, ...contentPos(el), page };
    const oldKey = page != null ? byPage.get(page) : null;
    const old = oldKey && images.get(oldKey);
    // Same page re-rendered in the same spot (e.g. first captured mid-render): keep the newer one.
    // Anything else is a different page and is kept alongside.
    if (old && Math.abs(old.y - item.y) < 40 && Math.abs(old.x - item.x) < 40) {
      if (old.width * old.height > w * h) return;
      images.delete(oldKey);
    }
    byHash.add(hash);
    if (page != null) byPage.set(page, item.key);
    images.set(item.key, item);
  }

  function addUrlImage(key, item) {
    const prev = images.get(key);
    if (prev && prev.width * prev.height >= item.width * item.height) return;
    if (item.page != null) {
      const oldKey = byPage.get(item.page);
      if (oldKey && oldKey !== key && images.has(oldKey)) return; // that page is already captured
      byPage.set(item.page, key);
    }
    images.set(key, item);
  }

  // ---------- one pass over the current DOM ----------
  function collect(opts) {
    const minW = opts.minWidth, minH = opts.minHeight;

    if (document.contentType === 'application/pdf') addPdf(location.href, document.title, 'page');
    const selfWrapped = wrappedPdf(location.href);
    if (selfWrapped) addPdf(selfWrapped, 'Document in viewer', 'viewer');

    for (const el of allElements()) {
      const tag = el.tagName;

      // Page boxes (rendered or still empty), for the "missing pages" retry pass.
      const n = attrPageNumber(el);
      // Leaf boxes only: a wrapper holding other numbered boxes is not a page.
      if (n != null && !el.querySelector(PAGE_SELECTOR) && !el.contains(activeScroller) &&
          isSinglePageBox(el, minW, minH)) placeholders.set(n, el);

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
        // blob:/data: images only live in this page: capture their pixels now.
        if (src.startsWith('blob:') || src.startsWith('data:')) {
          capturePixels(el, 'img', el.naturalWidth, el.naturalHeight, opts);
        } else {
          addUrlImage(src, {
            kind: 'img', key: src, url: src, width: el.naturalWidth, height: el.naturalHeight,
            ...contentPos(el), page: pageNumberOf(el, opts),
          });
        }
        continue;
      }

      if (tag === 'CANVAS') {
        if (el.width >= minW && el.height >= minH) capturePixels(el, 'canvas', el.width, el.height, opts);
        continue;
      }

      if (tag === 'image' || tag === 'IMAGE') { // SVG <image>
        const href = el.getAttribute('href') || el.getAttribute('xlink:href');
        const r = el.getBoundingClientRect();
        if (!href || r.width < minW / 3 || r.height < minH / 3) continue;
        const u = absUrl(href);
        if (u) addUrlImage(u, { kind: 'svg', key: u, url: u, width: 0, height: 0, ...contentPos(el), page: pageNumberOf(el, opts), checkSize: true });
        continue;
      }

      // CSS background images on large boxes.
      if (el.offsetWidth >= minW / 3 && el.offsetHeight >= minH / 3) {
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none') continue;
        const m = /url\(["']?(.*?)["']?\)/.exec(bg);
        const u = m && absUrl(m[1]);
        if (u && !u.startsWith('data:image/svg')) {
          addUrlImage(u, { kind: 'bg', key: u, url: u, width: 0, height: 0, ...contentPos(el), page: pageNumberOf(el, opts), checkSize: true });
        }
      }
    }
    progress.found = images.size;
  }

  // ---------- waiting for the page to settle ----------
  function visibleImagesPending() {
    for (const img of document.images) {
      if (img.complete) continue;
      const r = img.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight && r.width > 50) return true;
    }
    return false;
  }

  // Waits until the DOM stops changing and visible images have loaded,
  // instead of a fixed delay: fast on quick sites, patient on slow ones.
  async function settle(speed, maxOverride) {
    const max = maxOverride || speed.max;
    const start = performance.now();
    let last = start;
    const bump = () => { last = performance.now(); };
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'width', 'height'] });
    document.addEventListener('load', bump, true);
    try {
      for (;;) {
        await sleep(40);
        const now = performance.now();
        if (now - start >= max) break;
        if (now - start >= speed.min && now - last >= speed.quiet && !visibleImagesPending()) break;
      }
    } finally {
      mo.disconnect();
      document.removeEventListener('load', bump, true);
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

  let stopFlag = false;

  async function scrollThrough(scroller, opts, speed, part, parts) {
    activeScroller = scroller;
    scroller.scrollTop = 0;
    await settle(speed);
    for (let i = 0; i < 5000 && !stopFlag; i++) {
      collect(opts);
      const range = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      progress.pct = Math.round(((part + Math.min(1, scroller.scrollTop / range)) / parts) * 100);
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
        await settle(speed); // give infinite-scroll viewers a chance to append more
        collect(opts);
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
      }
      scroller.scrollTop += Math.max(100, scroller.clientHeight * speed.step);
      await settle(speed);
    }
    collect(opts);
  }

  function missingPages() {
    // Only meaningful when the viewer really numbers its pages one by one.
    if (placeholders.size < 3) return [];
    const have = new Set();
    for (const it of images.values()) if (it.page != null) have.add(it.page);
    return [...placeholders.keys()].filter((n) => !have.has(n)).sort((a, b) => a - b);
  }

  // Revisit numbered pages the first pass missed, waiting longer on each.
  async function retryMissing(opts, speed) {
    const missing = missingPages().slice(0, 200);
    for (let i = 0; i < missing.length && !stopFlag; i++) {
      const n = missing[i];
      progress.phase = `rechecking page ${n}`;
      let el = placeholders.get(n);
      if (!el || !el.isConnected) {
        el = document.querySelector(PAGE_ATTRS.map((a) => `[${a}="${a === 'data-page-index' ? n - 1 : n}"]`).join(',')) ||
             document.querySelector(`[aria-label="Page ${n}" i]`);
      }
      if (!el) continue;
      el.scrollIntoView({ block: 'center' });
      const deadline = performance.now() + speed.retryMax;
      while (performance.now() < deadline && !stopFlag) {
        await settle(speed, 800);
        collect(opts);
        if (!missingPages().includes(n)) break;
      }
    }
  }

  async function scan(options) {
    const opts = { minWidth: 300, minHeight: 300, autoScroll: true, speed: 'fast', quality: 0.92, ...options };
    const speed = SPEEDS[opts.speed] || SPEEDS.fast;
    stopFlag = false;
    reset();
    const scrollers = opts.autoScroll ? findScrollers() : [];
    activeScroller = scrollers[scrollers.length - 1] || null;
    collect(opts);
    if (opts.autoScroll) {
      const saved = scrollers.map((s) => s.scrollTop);
      for (let i = 0; i < scrollers.length && !stopFlag; i++) {
        await scrollThrough(scrollers[i], opts, speed, i, scrollers.length);
      }
      await retryMissing(opts, speed);
      scrollers.forEach((s, i) => { s.scrollTop = saved[i]; });
    }
    progress.phase = 'done';
    return {
      frameUrl: location.href,
      title: document.title,
      pdfs: [...pdfs.values()],
      images: [...images.values()].sort((a, b) => (a.y - b.y) || (a.x - b.x)),
      missing: missingPages(),
      tainted,
      stopped: stopFlag,
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

  window.__docGrabber = {
    scan,
    stop: () => { stopFlag = true; },
    progress: () => progress,
    fetchAsDataUrl,
  };
})();
