/* Jagema's Downloader: popup. */
'use strict';

const SMALL_BYTES = 200 * 1024;
const $ = (id) => document.getElementById(id);

let tab = null;
let pageResults = [];       // scanner results from every frame
let netItems = [];          // items the background saw on the network
const extraInfo = new Map(); // url -> info we looked up here (size, playlist details)
const lookups = new Set();
let settings = { showSmall: false, saveAs: false };
let lastSignature = '';

function send(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (r && r.error) throw new Error(r.error);
    return r;
  });
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ---------------- gathering ---------------- */

async function scanPage() {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['scanner.js']
    });
    pageResults = res.map((r) => r.result).filter(Boolean);
  } catch (e) {
    pageResults = [];
  }
}

async function loadNetwork() {
  try {
    const r = await send({ type: 'getMedia', tabId: tab.id });
    netItems = r.items || [];
  } catch (e) {
    netItems = [];
  }
}

function mergedItems() {
  const map = new Map();
  for (const it of netItems) map.set(it.url, Object.assign({}, it));

  for (const frame of pageResults) {
    for (const p of frame.items) {
      let info = JD.classify(p.url, p.declaredType);
      if (!info) {
        // <video src="/stream?id=1"> with no extension: it is still a video.
        if (p.tag === 'video' || p.tag === 'meta' || p.tag === 'ld+json') info = { kind: 'video', ext: 'mp4' };
        else if (p.tag === 'audio') info = { kind: 'audio', ext: 'mp3' };
        else continue;
      }
      const prev = map.get(p.url);
      const merged = Object.assign({ url: p.url, kind: info.kind, ext: info.ext, referer: p.frameUrl, size: 0 }, prev || {});
      for (const k of ['width', 'height', 'duration', 'poster', 'title', 'playing', 'tag']) {
        if (p[k] && !merged[k]) merged[k] = p[k];
      }
      merged.onPage = true;
      map.set(p.url, merged);
    }
  }

  for (const [url, extra] of extraInfo) {
    const it = map.get(url);
    if (it) Object.assign(it, extra, { size: Math.max(it.size || 0, extra.size || 0) });
  }

  // Hide quality playlists whose master playlist is listed.
  const masters = [...map.values()].filter((it) => it.isMaster && it.childUrls);
  for (const m of masters) for (const u of m.childUrls) {
    const child = map.get(u);
    if (child) child.childOfMaster = m.url;
  }
  let list = [...map.values()].filter((it) => !(it.childOfMaster && map.has(it.childOfMaster)));

  if (!settings.showSmall) list = list.filter((it) => !isSmall(it));

  const rank = (it) => (it.playing ? 0 : 10) + (it.kind === 'hls' || it.kind === 'dash' ? 0 : it.kind === 'video' ? 1 : 3);
  list.sort((a, b) => rank(a) - rank(b) || (b.size || 0) - (a.size || 0) || (a.firstSeen || 0) - (b.firstSeen || 0));
  return list;
}

function isSmall(it) {
  return (it.kind === 'video' || it.kind === 'audio') && it.size > 0 && it.size < SMALL_BYTES;
}

/* Look up details we don't have yet: file sizes and stream playlist info. */
function lookUpDetails(list) {
  for (const it of list) {
    if (lookups.has(it.url)) continue;
    if (it.kind === 'hls' && !it.isMaster && !it.duration) {
      lookups.add(it.url);
      inspectPlaylist(it).catch(() => {});
    } else if ((it.kind === 'video' || it.kind === 'audio') && !it.size) {
      lookups.add(it.url);
      fetchSize(it).catch(() => {});
    }
  }
}

async function withReferer(it) {
  if (it.referer) await send({ type: 'setReferer', url: it.url, referer: it.referer }).catch(() => {});
}

async function fetchSize(it) {
  await withReferer(it);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    let res = await fetch(it.url, { method: 'HEAD', credentials: 'include', signal: ctrl.signal });
    let size = parseInt(res.headers.get('content-length') || '0', 10);
    if (!res.ok || !size) {
      res = await fetch(it.url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', signal: ctrl.signal });
      const m = (res.headers.get('content-range') || '').match(/\/(\d+)/);
      size = m ? parseInt(m[1], 10) : 0;
      ctrl.abort();
    }
    if (size) {
      extraInfo.set(it.url, Object.assign(extraInfo.get(it.url) || {}, { size }));
      render();
    }
  } finally {
    clearTimeout(timer);
  }
}

async function inspectPlaylist(it) {
  await withReferer(it);
  const res = await fetch(it.url, { credentials: 'include' });
  if (!res.ok) return;
  const pl = JD.parseM3U8(await res.text(), res.url || it.url);
  const info = {};
  if (pl.type === 'master') {
    info.isMaster = true;
    info.variants = pl.variants.length;
    info.maxHeight = pl.variants[0] ? pl.variants[0].height : 0;
    info.childUrls = [...pl.variants.map((v) => v.url), ...pl.audio.map((a) => a.url), ...pl.subtitles.map((s) => s.url)];
  } else {
    info.duration = pl.duration;
    info.live = !pl.endList;
    if (pl.unsupportedEncryption) info.drm = true;
  }
  extraInfo.set(it.url, Object.assign(extraInfo.get(it.url) || {}, info));
  render();
}

/* ---------------- rendering ---------------- */

const KIND_LABEL = { hls: 'HLS', dash: 'DASH' };

function displayTitle(it, index) {
  const base = it.title || (tab && tab.title) || JD.fileNameFromUrl(it.url) || 'Video';
  return index > 0 && !it.title ? `${base} (${index + 1})` : base;
}

function suggestedFilename(it, index) {
  const q = JD.qualityLabel(it.height || it.maxHeight);
  const name = JD.sanitizeFilename(displayTitle(it, index) + (q ? ' ' + q : ''), JD.fileNameFromUrl(it.url) || 'video');
  return `${name}.${it.ext || 'mp4'}`;
}

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}

function card(it, index) {
  const label = KIND_LABEL[it.kind] || (it.ext || it.kind).toUpperCase();
  const thumb = el('div', { class: 'thumb' });
  if (it.poster) {
    const img = el('img', { src: it.poster, alt: '' });
    img.addEventListener('error', () => img.remove());
    thumb.append(img);
  } else {
    thumb.append(el('span', { style: 'font-size:20px' }, it.kind === 'audio' ? '♪' : '▶'));
  }
  thumb.append(el('span', { class: 'kind' }, label));

  const chips = [];
  if (it.live) chips.push(el('span', { class: 'chip live' }, 'LIVE'));
  if (it.playing) chips.push(el('span', { class: 'chip hot' }, 'Playing'));
  const q = JD.qualityLabel(it.height || it.maxHeight);
  if (q) chips.push(el('span', { class: 'chip hot' }, it.isMaster ? `up to ${q}` : q));
  if (it.isMaster && it.variants > 1) chips.push(el('span', { class: 'chip' }, `${it.variants} qualities`));
  if (it.duration) chips.push(el('span', { class: 'chip' }, JD.formatDuration(it.duration)));
  if (it.size && it.kind !== 'hls' && it.kind !== 'dash') chips.push(el('span', { class: 'chip' }, JD.formatBytes(it.size)));
  if (it.drm) chips.push(el('span', { class: 'chip' }, 'DRM protected'));

  const dl = el('button', { class: 'btn', onclick: () => download(it, index, dl) },
    it.kind === 'hls' ? 'Download…' : 'Download');
  if (it.kind === 'dash' || it.drm) {
    dl.disabled = true;
    dl.title = it.drm ? 'This stream is DRM protected and cannot be saved.' : 'DASH streams can’t be saved yet. Copy the link to use it in another tool.';
  }

  return el('div', { class: 'card' },
    thumb,
    el('div', { class: 'body' },
      el('div', { class: 'title', title: displayTitle(it, index) }, displayTitle(it, index)),
      chips.length ? el('div', { class: 'meta' }, chips) : null,
      el('div', { class: 'url', title: it.url }, it.url),
      el('div', { class: 'actions' },
        dl,
        el('button', { class: 'btn ghost', title: 'Copy the link', onclick: () => copy(it.url) }, 'Copy link'),
        el('button', { class: 'btn ghost', title: 'Open in a new tab', onclick: () => chrome.tabs.create({ url: it.url, active: false }) }, 'Open')
      )
    )
  );
}

function render() {
  const list = mergedItems();
  // Only redraw when something visible changed, so buttons keep their state.
  const sig = JSON.stringify([settings.showSmall, mergedCount(),
    list.map((it) => [it.url, it.size, it.duration, it.variants, it.playing, it.poster, it.live, it.drm, it.height])]);
  if (sig === lastSignature) return;
  lastSignature = sig;

  const main = $('list');
  main.replaceChildren();
  if (!list.length) {
    const hiddenSmall = !settings.showSmall && mergedCount() > 0;
    main.append(el('div', { class: 'empty' },
      el('div', { class: 'big' }, '🎬'),
      el('strong', {}, 'No videos found yet'),
      hiddenSmall
        ? 'Only small files were found. Tick “Show small files” to see them.'
        : 'Press play on the video, then open this again. Streams are picked up as soon as they start loading.'));
  } else {
    list.forEach((it, i) => main.append(card(it, i)));
  }

  const streaming = pageResults.reduce((n, r) => n + (r.streamingPlayers || 0), 0);
  const hasStream = list.some((it) => it.kind === 'hls' || it.kind === 'dash');
  const notice = $('notice');
  if (streaming && !hasStream && list.length === 0) {
    notice.hidden = false;
    notice.textContent = 'This page streams its video in pieces. Play it for a few seconds; the stream will show up here.';
  } else {
    notice.hidden = true;
  }
  lookUpDetails(list);
}

function mergedCount() {
  return netItems.length + pageResults.reduce((n, r) => n + r.items.length, 0);
}

/* ---------------- actions ---------------- */

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied');
  } catch (e) {
    toast('Could not copy');
  }
}

async function download(it, index, button) {
  if (it.kind === 'hls') {
    const q = new URLSearchParams({
      url: it.url,
      title: JD.sanitizeFilename(displayTitle(it, index), 'video'),
      referer: it.referer || tab.url || ''
    });
    chrome.tabs.create({ url: chrome.runtime.getURL('download.html?' + q.toString()) });
    return;
  }
  button.disabled = true;
  try {
    const filename = suggestedFilename(it, index);
    await send({
      type: 'download',
      url: it.url,
      filename,
      title: filename.replace(/\.[a-z0-9]{2,5}$/i, ''),
      ext: it.ext || 'mp4',
      referer: it.referer || tab.url || '',
      saveAs: settings.saveAs
    });
    button.textContent = 'Started ✓';
    toast('Download started');
  } catch (e) {
    button.disabled = false;
    toast('Download failed: ' + e.message);
  }
}

/* ---------------- start ---------------- */

async function refresh(spin) {
  if (spin) {
    const b = $('refresh');
    b.classList.remove('spin');
    void b.offsetWidth;
    b.classList.add('spin');
  }
  await Promise.all([scanPage(), loadNetwork()]);
  render();
}

async function init() {
  const stored = await chrome.storage.local.get(['showSmall', 'saveAs']);
  settings.showSmall = !!stored.showSmall;
  settings.saveAs = !!stored.saveAs;
  $('showSmall').checked = settings.showSmall;
  $('saveAs').checked = settings.saveAs;

  // ?tab=<id> lets the popup be opened as a page for a given tab (handy for testing).
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  if (forced) tab = await chrome.tabs.get(forced);
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    $('host').textContent = new URL(tab.url).hostname || tab.title || '';
  } catch (e) {
    $('host').textContent = tab ? tab.title : '';
  }

  if (!tab || !/^(https?|file):/i.test(tab.url || '')) {
    $('list').replaceChildren(el('div', { class: 'empty' },
      el('div', { class: 'big' }, '🔒'),
      el('strong', {}, 'Nothing to scan here'),
      'Open a regular web page with a video on it.'));
    return;
  }

  $('showSmall').addEventListener('change', (e) => {
    settings.showSmall = e.target.checked;
    chrome.storage.local.set({ showSmall: settings.showSmall });
    render();
  });
  $('saveAs').addEventListener('change', (e) => {
    settings.saveAs = e.target.checked;
    chrome.storage.local.set({ saveAs: settings.saveAs });
  });
  $('refresh').addEventListener('click', () => refresh(true));
  $('clear').addEventListener('click', async () => {
    await send({ type: 'clear', tabId: tab.id });
    extraInfo.clear();
    lookups.clear();
    await refresh();
    toast('List cleared');
  });

  await refresh();
  // Videos keep loading while the popup is open: pick them up.
  setInterval(async () => {
    await loadNetwork();
    render();
  }, 1500);
  setInterval(async () => {
    await scanPage();
    render();
  }, 5000);
}

init();
