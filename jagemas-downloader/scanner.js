/* Injected into every frame of the page when the popup opens.
 * Collects the videos the page itself shows; the value of the last expression
 * is returned to the popup. */
(() => {
  const found = new Map();
  let streamingPlayers = 0;

  const abs = (u) => {
    try { return new URL(u, document.baseURI).href; } catch (e) { return ''; }
  };

  function add(url, extra) {
    url = abs(url);
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
    const prev = found.get(url) || {};
    found.set(url, Object.assign({ url, source: 'page', frameUrl: location.href }, prev, extra));
  }

  function nearbyTitle(el) {
    const t = el.getAttribute('title') || el.getAttribute('aria-label') || el.dataset.title || '';
    if (t) return t;
    const fig = el.closest('figure');
    const cap = fig && fig.querySelector('figcaption');
    return cap ? cap.textContent.trim().slice(0, 150) : '';
  }

  for (const el of document.querySelectorAll('video, audio')) {
    const isVideo = el.tagName === 'VIDEO';
    const info = {
      tag: el.tagName.toLowerCase(),
      width: isVideo ? el.videoWidth || 0 : 0,
      height: isVideo ? el.videoHeight || 0 : 0,
      duration: isFinite(el.duration) ? el.duration : 0,
      poster: isVideo && el.poster ? abs(el.poster) : '',
      title: nearbyTitle(el),
      playing: !el.paused
    };
    const src = el.currentSrc || el.src;
    if (src && src.startsWith('blob:')) streamingPlayers++;
    else if (src) add(src, info);
    for (const s of el.querySelectorAll('source[src]')) {
      add(s.getAttribute('src'), Object.assign({}, info, { declaredType: s.type || '' }));
    }
  }

  // Social-share tags often point straight at the file.
  for (const m of document.querySelectorAll(
    'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"], meta[itemprop="contentUrl"]'
  )) {
    if (m.content) add(m.content, { tag: 'meta' });
  }

  // schema.org VideoObject
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        if (o['@type'] === 'VideoObject' && o.contentUrl) {
          add(o.contentUrl, { tag: 'ld+json', title: o.name || '', poster: Array.isArray(o.thumbnailUrl) ? o.thumbnailUrl[0] : (o.thumbnailUrl || '') });
        }
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(s.textContent));
    } catch (e) { /* not JSON */ }
  }

  // Plain links to video files.
  for (const a of document.querySelectorAll('a[href]')) {
    if (/\.(mp4|m4v|webm|mov|mkv|avi|flv|ogv|wmv|m3u8|mpd|mp3|m4a)(\?|#|$)/i.test(a.getAttribute('href'))) {
      add(a.href, { tag: 'a', title: (a.textContent || '').trim().slice(0, 150) });
    }
  }

  for (const e of document.querySelectorAll('embed[src], object[data]')) {
    add(e.getAttribute('src') || e.getAttribute('data'), { tag: e.tagName.toLowerCase() });
  }

  return { items: [...found.values()], streamingPlayers, frameUrl: location.href, title: document.title };
})();
