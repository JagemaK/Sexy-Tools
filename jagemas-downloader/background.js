/* Jagema's Downloader: background service worker.
 * Watches network traffic for video/audio files and stream playlists, per tab,
 * and performs the downloads the popup asks for. */
importScripts('common.js');

const MAX_ITEMS_PER_TAB = 300;
const SMALL_BYTES = 200 * 1024; // files smaller than this are hidden by default (ads, previews)
const WATCH_TYPES = ['media', 'xmlhttprequest', 'other', 'object'];

/* ---------------- per-tab store (memory + storage.session) ---------------- */

const store = new Map(); // tabId -> Map(url -> item)
let loaded = null;
const saveTimers = new Map();

function load() {
  if (!loaded) {
    loaded = chrome.storage.session.get(null).then((all) => {
      for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith('tab:')) continue;
        const tabId = Number(k.slice(4));
        if (!store.has(tabId)) store.set(tabId, new Map(v.map((it) => [it.url, it])));
      }
    }).catch(() => {});
  }
  return loaded;
}

function scheduleSave(tabId) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(tabId, setTimeout(() => {
    saveTimers.delete(tabId);
    const m = store.get(tabId);
    if (m && m.size) chrome.storage.session.set({ ['tab:' + tabId]: [...m.values()] }).catch(() => {});
    else chrome.storage.session.remove('tab:' + tabId).catch(() => {});
  }, 400));
}

function isSmall(it) {
  return (it.kind === 'video' || it.kind === 'audio') && it.size > 0 && it.size < SMALL_BYTES;
}

function updateBadge(tabId) {
  const m = store.get(tabId);
  const n = m ? [...m.values()].filter((it) => !isSmall(it) && !it.childOfMaster).length : 0;
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c3aed' }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ tabId, color: '#ffffff' })?.catch?.(() => {});
  chrome.action.setBadgeText({ tabId, text: n ? (n > 99 ? '99+' : String(n)) : '' }).catch(() => {});
}

function clearTab(tabId) {
  store.delete(tabId);
  chrome.storage.session.remove('tab:' + tabId).catch(() => {});
  updateBadge(tabId);
}

async function addItem(tabId, item) {
  await load();
  let m = store.get(tabId);
  if (!m) { m = new Map(); store.set(tabId, m); }
  const prev = m.get(item.url);
  if (prev) {
    // Keep the largest size we have seen (range requests report partial lengths).
    if (item.size > (prev.size || 0)) prev.size = item.size;
    if (!prev.contentType && item.contentType) prev.contentType = item.contentType;
    prev.lastSeen = Date.now();
  } else {
    if (m.size >= MAX_ITEMS_PER_TAB) m.delete(m.keys().next().value);
    item.firstSeen = item.lastSeen = Date.now();
    m.set(item.url, item);
    if (item.kind === 'hls') linkPlaylists(tabId, item).catch(() => {});
  }
  scheduleSave(tabId);
  updateBadge(tabId);
}

/* A player usually loads a master playlist, then one of its quality playlists.
 * Mark the quality playlists so the badge counts each stream once. */
async function linkPlaylists(tabId, item) {
  if (item.referer) await setReferer(item.url, item.referer);
  const res = await fetch(item.url, { credentials: 'include' });
  if (!res.ok) return;
  const text = await res.text();
  if (text.length > 2_000_000) return;
  const pl = JD.parseM3U8(text, res.url || item.url);
  const m = store.get(tabId);
  if (!m || !m.has(item.url)) return;
  if (pl.type === 'master') {
    item.isMaster = true;
    item.variants = pl.variants.length;
    item.maxHeight = pl.variants[0] ? pl.variants[0].height : 0;
    const children = new Set([...pl.variants.map((v) => v.url), ...pl.audio.map((a) => a.url), ...pl.subtitles.map((s) => s.url)]);
    for (const it of m.values()) if (children.has(it.url)) it.childOfMaster = item.url;
    item.childUrls = [...children].slice(0, 100);
  } else {
    item.duration = pl.duration;
    item.live = !pl.endList;
    if (pl.unsupportedEncryption) item.drm = true;
    for (const it of m.values()) if (it.isMaster && it.childUrls && it.childUrls.includes(item.url)) item.childOfMaster = it.url;
  }
  scheduleSave(tabId);
  updateBadge(tabId);
}

/* ---------------- network sniffing ---------------- */

const referers = new Map(); // requestId -> Referer header the page sent

chrome.webRequest.onSendHeaders.addListener((d) => {
  if (d.tabId < 0) return;
  const h = d.requestHeaders && d.requestHeaders.find((x) => x.name.toLowerCase() === 'referer');
  if (h && h.value) {
    referers.set(d.requestId, h.value);
    if (referers.size > 5000) referers.delete(referers.keys().next().value);
  }
}, { urls: ['<all_urls>'], types: WATCH_TYPES }, ['requestHeaders', 'extraHeaders']);

function forget(d) { referers.delete(d.requestId); }
chrome.webRequest.onCompleted.addListener(forget, { urls: ['<all_urls>'], types: WATCH_TYPES });
chrome.webRequest.onErrorOccurred.addListener(forget, { urls: ['<all_urls>'], types: WATCH_TYPES });

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0) return;
  if (d.statusCode >= 300) return;
  const headers = {};
  for (const h of d.responseHeaders || []) headers[h.name.toLowerCase()] = h.value || '';
  const ct = headers['content-type'] || '';
  const info = JD.classify(d.url, ct);
  if (!info) return;

  let size = 0;
  const cr = headers['content-range'];
  const total = cr && cr.match(/\/(\d+)\s*$/);
  if (total) size = parseInt(total[1], 10);
  else if (headers['content-length'] && d.statusCode === 200) size = parseInt(headers['content-length'], 10) || 0;

  const referer = referers.get(d.requestId) || (d.initiator ? d.initiator + '/' : '');
  addItem(d.tabId, {
    url: d.url,
    kind: info.kind,
    ext: info.ext,
    contentType: ct.split(';')[0].trim(),
    size,
    referer,
    source: 'network'
  });
}, { urls: ['<all_urls>'], types: WATCH_TYPES }, ['responseHeaders']);

// A new page in the tab: start a fresh list.
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId >= 0 && d.frameId === 0) clearTab(d.tabId);
}, { urls: ['<all_urls>'], types: ['main_frame'] });

chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId));

/* ---------------- Referer / Origin for our own requests ----------------
 * Many video hosts refuse requests that don't come "from" their page.
 * Session rules make our fetches and downloads carry the page's Referer. */

let ruleChain = Promise.resolve();

function setReferer(url, referer) {
  ruleChain = ruleChain.then(() => setRefererNow(url, referer)).catch(() => {});
  return ruleChain;
}

async function setRefererNow(url, referer) {
  let host;
  let origin;
  try {
    host = new URL(url).hostname;
    origin = new URL(referer).origin;
  } catch (e) {
    return;
  }
  if (!host || !origin || origin === 'null') return;
  const { refRules = {} } = await chrome.storage.session.get('refRules');
  let base = refRules[host];
  if (!base) {
    const used = Object.values(refRules);
    base = (used.length ? Math.max(...used) : 0) + 2;
    refRules[host] = base;
    await chrome.storage.session.set({ refRules });
  }
  const headers = (withOrigin) => {
    const h = [{ header: 'referer', operation: 'set', value: referer }];
    if (withOrigin) h.push({ header: 'origin', operation: 'set', value: origin });
    return h;
  };
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [base, base + 1],
    addRules: [
      { // fetches made by the popup and the download page
        id: base,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: headers(true) },
        condition: { requestDomains: [host], initiatorDomains: [chrome.runtime.id] }
      },
      { // browser downloads (they belong to no tab)
        id: base + 1,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: headers(false) },
        condition: { requestDomains: [host], tabIds: [chrome.tabs.TAB_ID_NONE] }
      }
    ]
  });
}

/* ---------------- downloads ---------------- */

const pending = new Map(); // download id -> what we asked for (to retry if the server refuses)

async function startDownload({ url, filename, referer, saveAs, title, ext }) {
  if (referer) await setReferer(url, referer);
  const opts = { url, conflictAction: 'uniquify', saveAs: !!saveAs };
  if (filename) opts.filename = filename;
  let id;
  try {
    id = await chrome.downloads.download(opts);
  } catch (e) {
    if (!opts.filename) throw e;
    delete opts.filename; // an odd character in the name: let Chrome pick one
    id = await chrome.downloads.download(opts);
  }
  pending.set(id, { url, referer, title, ext, filename });
  return id;
}

/* Browser downloads can't carry the page's Referer or Origin. When a site
 * refuses one, fetch the file from an extension page instead (our requests do
 * carry them) and save it from there. */
chrome.downloads.onChanged.addListener(async (delta) => {
  const job = pending.get(delta.id);
  if (!job || !delta.state) return;
  if (delta.state.current === 'complete') { pending.delete(delta.id); return; }
  if (delta.state.current !== 'interrupted') return;
  pending.delete(delta.id);
  const [d] = await chrome.downloads.search({ id: delta.id });
  const err = (d && d.error) || (delta.error && delta.error.current) || '';
  if (!/^(SERVER_|NETWORK_FAILED)/.test(err) || (d && d.bytesReceived > 1024 * 1024)) return;
  chrome.downloads.erase({ id: delta.id }).catch(() => {});
  const q = new URLSearchParams({
    mode: 'file',
    url: job.url,
    title: job.title || (job.filename || '').replace(/\.[a-z0-9]{2,5}$/i, ''),
    ext: job.ext || 'mp4',
    referer: job.referer || ''
  });
  chrome.tabs.create({ url: chrome.runtime.getURL('download.html?' + q.toString()) });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'getMedia': {
        await load();
        const m = store.get(msg.tabId);
        return { items: m ? [...m.values()] : [] };
      }
      case 'clear':
        clearTab(msg.tabId);
        return { ok: true };
      case 'setReferer':
        await setReferer(msg.url, msg.referer);
        return { ok: true };
      case 'download': {
        const id = await startDownload(msg);
        return { ok: true, id };
      }
      default:
        return { error: 'unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) }));
  return true;
});
