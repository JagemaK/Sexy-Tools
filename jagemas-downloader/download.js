/* Jagema's Downloader: HLS stream downloader page. */
'use strict';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SOURCE = params.get('url') || '';
const REFERER = params.get('referer') || '';
const MODE = params.get('mode') || 'hls'; // 'file': a single video file the browser download couldn't fetch
const FILE_EXT = (params.get('ext') || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4';
const WORKERS = 6;
const RETRIES = 4;

let master = null;        // parsed master playlist (if any)
let directMedia = null;   // parsed media playlist when SOURCE is not a master
let job = null;
let savedDownloadId = null;
let settings = { saveAs: false };
const refererHosts = new Set();

/* ---------------- helpers ---------------- */

function send(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (r && r.error) throw new Error(r.error);
    return r;
  });
}

async function allowHost(url) {
  if (!REFERER) return;
  let host;
  try { host = new URL(url).host; } catch (e) { return; }
  if (refererHosts.has(host)) return;
  refererHosts.add(host);
  await send({ type: 'setReferer', url, referer: REFERER }).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, opts = {}, ms = 30000, outerSignal) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort();
    outerSignal.addEventListener('abort', onAbort);
  }
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, Object.assign({ credentials: 'include', signal: ctrl.signal }, opts));
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${shortUrl(url)}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    return { res, buf };
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
  }
}

async function fetchText(url) {
  await allowHost(url);
  const { res, buf } = await fetchWithTimeout(url);
  return { text: new TextDecoder().decode(buf), finalUrl: res.url || url };
}

async function loadPlaylist(url) {
  const { text, finalUrl } = await fetchText(url);
  const pl = JD.parseM3U8(text, finalUrl);
  pl.url = url;
  pl.raw = text;
  return pl;
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    const name = x.pathname.split('/').pop();
    return x.host + '/…/' + name;
  } catch (e) {
    return u;
  }
}

function showError(text) {
  const e = $('error');
  e.textContent = text;
  e.hidden = false;
}

function chip(text, cls) {
  const s = document.createElement('span');
  s.className = 'chip' + (cls ? ' ' + cls : '');
  s.textContent = text;
  return s;
}

function variantLabel(v) {
  const parts = [];
  parts.push(JD.qualityLabel(v.height) || (v.bandwidth ? 'Stream' : 'Default'));
  if (v.width && v.height) parts.push(`${v.width}×${v.height}`);
  if (v.frameRate && v.frameRate > 31) parts.push(Math.round(v.frameRate) + 'fps');
  if (v.bandwidth) parts.push((v.bandwidth / 1e6).toFixed(v.bandwidth < 1e6 ? 2 : 1) + ' Mbps');
  const c = v.codecs.toLowerCase();
  if (c.includes('hvc1') || c.includes('hev1')) parts.push('HEVC');
  else if (c.includes('av01')) parts.push('AV1');
  return parts.join(' · ');
}

/* ---------------- setup ---------------- */

async function init() {
  const stored = await chrome.storage.local.get(['saveAs']);
  settings.saveAs = !!stored.saveAs;

  $('filename').value = params.get('title') || JD.fileNameFromUrl(SOURCE) || 'video';
  $('src').textContent = SOURCE;
  document.title = ($('filename').value || 'Stream') + ' – Jagema’s Downloader';

  $('start').addEventListener('click', start);
  $('cancel').addEventListener('click', () => job && job.cancel());
  $('stopLive').addEventListener('click', () => job && job.stopLive());
  $('closeTab').addEventListener('click', () => window.close());
  $('showFile').addEventListener('click', () => savedDownloadId !== null && chrome.downloads.show(savedDownloadId));
  $('quality').addEventListener('change', onQualityChange);
  window.addEventListener('beforeunload', (e) => {
    if (job && job.running) { e.preventDefault(); e.returnValue = ''; }
  });

  if (!SOURCE) {
    $('loading').hidden = true;
    showError('No stream address was given.');
    return;
  }
  if (MODE === 'file') return startFile();

  try {
    const pl = await loadPlaylist(SOURCE);
    if (/#EXT-X-SESSION-KEY:[^\n]*METHOD=SAMPLE-AES/i.test(pl.raw)) throw new Error('DRM');
    if (pl.type === 'master') {
      master = pl;
      if (!pl.variants.length) throw new Error('This playlist lists no streams.');
      const sel = $('quality');
      pl.variants.forEach((v, i) => {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = variantLabel(v);
        sel.append(o);
      });
      $('qualityField').hidden = pl.variants.length < 2;
    } else {
      directMedia = pl;
    }
    await onQualityChange();
    $('loading').hidden = true;
    $('options').hidden = false;
  } catch (e) {
    $('loading').hidden = true;
    showError(e.message === 'DRM'
      ? 'This stream is DRM protected (encrypted with a licence key), so it can’t be saved.'
      : 'Could not read the stream: ' + e.message);
  }
}

function selectedVariant() {
  return master ? master.variants[Number($('quality').value) || 0] : null;
}

function audioChoices(v) {
  if (!master || !v || !v.audioGroup) return [];
  return master.audio.filter((a) => a.groupId === v.audioGroup && a.url);
}

async function onQualityChange() {
  const v = selectedVariant();
  const audios = audioChoices(v);
  const asel = $('audio');
  const prevName = asel.selectedOptions[0] ? asel.selectedOptions[0].textContent : '';
  asel.replaceChildren();
  audios.forEach((a, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = (a.name || a.language || 'Audio ' + (i + 1)) + (a.language && a.name !== a.language ? ` (${a.language})` : '');
    asel.append(o);
  });
  const def = audios.findIndex((a) => a.name === prevName);
  asel.value = String(def >= 0 ? def : Math.max(0, audios.findIndex((a) => a.isDefault)));
  $('audioField').hidden = audios.length < 2;

  const facts = $('facts');
  facts.replaceChildren(chip('Loading details…'));
  try {
    const media = v ? await loadPlaylist(v.url) : directMedia;
    facts.replaceChildren();
    if (!media.endList) facts.append(chip('LIVE', 'live'));
    if (media.duration && media.endList) facts.append(chip(JD.formatDuration(media.duration)));
    facts.append(chip(media.segments.length + ' pieces'));
    if (v && v.bandwidth && media.duration && media.endList) {
      facts.append(chip('≈ ' + JD.formatBytes((v.bandwidth / 8) * media.duration)));
    }
    if (media.encrypted) facts.append(chip('AES-128 encrypted (supported)'));
    if (audios.length) facts.append(chip('separate audio, merged automatically'));
    $('start').textContent = media.endList ? 'Download' : 'Start recording';
    if (media.unsupportedEncryption) {
      $('start').disabled = true;
      showError('This stream is DRM protected (' + media.unsupportedEncryption + '), so it can’t be saved.');
    }
  } catch (e) {
    facts.replaceChildren(chip('Could not read this quality: ' + e.message));
  }
}

/* ---------------- download engine ---------------- */

class Track {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.segments = [];   // segment descriptors in order
    this.data = [];       // downloaded bytes, by index
    this.maps = new Map(); // init segment key -> bytes
    this.lastSeq = -1;
    this.failed = 0;
  }

  addSegments(pl) {
    const added = [];
    for (const s of pl.segments) {
      if (s.seq <= this.lastSeq) continue;
      this.lastSeq = s.seq;
      s.index = this.segments.length;
      s.mapKey = s.map ? s.map.url + '|' + (s.map.range ? s.map.range.offset : '') : '';
      this.segments.push(s);
      added.push(s);
    }
    return added;
  }
}

class Job {
  constructor(tracks, live, targetDuration) {
    this.tracks = tracks;
    this.live = live;
    this.targetDuration = targetDuration || 6;
    this.queue = [];
    this.total = 0;
    this.done = 0;
    this.bytes = 0;
    this.recorded = 0;
    this.addingDone = !live;
    this.cancelled = false;
    this.running = true;
    this.abort = new AbortController();
    this.keys = new Map();
    this.speedSamples = [];
    this.started = Date.now();
  }

  enqueue(track, segs) {
    for (const s of segs) this.queue.push({ track, seg: s });
    this.total += segs.length;
  }

  cancel() {
    this.cancelled = true;
    this.addingDone = true;
    this.abort.abort();
  }

  stopLive() {
    this.addingDone = true;
    $('stopLive').disabled = true;
    $('phase').textContent = 'Finishing the last pieces…';
  }

  async getKey(k) {
    if (!this.keys.has(k.url)) {
      this.keys.set(k.url, (async () => {
        await allowHost(k.url);
        const { buf } = await fetchWithTimeout(k.url, {}, 30000, this.abort.signal);
        if (buf.length !== 16) throw new Error('The stream’s decryption key is not usable.');
        return crypto.subtle.importKey('raw', buf, 'AES-CBC', false, ['decrypt']);
      })());
    }
    return this.keys.get(k.url);
  }

  async fetchPiece(url, range) {
    await allowHost(url);
    const opts = {};
    if (range) opts.headers = { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` };
    let lastErr;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (this.cancelled) throw new Error('cancelled');
      try {
        const { res, buf } = await fetchWithTimeout(url, opts, 45000, this.abort.signal);
        if (range && res.status === 200 && buf.length > range.length) {
          return buf.subarray(range.offset, range.offset + range.length);
        }
        return buf;
      } catch (e) {
        lastErr = e;
        if (this.cancelled) throw e;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  async decrypt(seg, buf) {
    if (!seg.key || seg.key.method !== 'AES-128') return buf;
    const key = await this.getKey(seg.key);
    let iv = new Uint8Array(16);
    if (seg.key.iv) {
      const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
      for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    } else {
      let n = seg.seq;
      for (let i = 15; i >= 8 && n > 0; i--) { iv[i] = n % 256; n = Math.floor(n / 256); }
    }
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, buf));
  }

  async worker() {
    while (!this.cancelled) {
      const task = this.queue.shift();
      if (!task) {
        if (this.addingDone) return;
        await sleep(300);
        continue;
      }
      const { track, seg } = task;
      try {
        if (seg.mapKey && !track.maps.has(seg.mapKey)) {
          track.maps.set(seg.mapKey, null);
          track.maps.set(seg.mapKey, await this.fetchPiece(seg.map.url, seg.map.range));
        }
        const raw = await this.fetchPiece(seg.url, seg.range);
        const buf = await this.decrypt(seg, raw);
        track.data[seg.index] = buf;
        this.bytes += buf.length;
        this.speedSamples.push([Date.now(), buf.length]);
        if (track === this.tracks[0]) this.recorded += seg.duration || 0;
      } catch (e) {
        if (this.cancelled) return;
        track.failed++;
        console.warn('Piece failed', seg.url, e);
      }
      this.done++;
      updateProgress();
    }
  }

  async refreshLive() {
    while (!this.addingDone) {
      await sleep(Math.max(2000, (this.targetDuration * 1000) / 2));
      if (this.addingDone) break;
      for (const t of this.tracks) {
        try {
          const pl = await loadPlaylist(t.url);
          this.enqueue(t, t.addSegments(pl));
          if (pl.endList && t === this.tracks[0]) this.addingDone = true;
        } catch (e) {
          console.warn('Live refresh failed', e);
        }
      }
      updateProgress();
    }
  }

  async run() {
    const workers = [];
    for (let i = 0; i < WORKERS; i++) workers.push(this.worker());
    if (this.live) workers.push(this.refreshLive());
    await Promise.all(workers);
    this.running = false;
  }

  speed() {
    const now = Date.now();
    this.speedSamples = this.speedSamples.filter(([t]) => now - t < 4000);
    const b = this.speedSamples.reduce((n, [, x]) => n + x, 0);
    const span = Math.min(4, (now - this.started) / 1000) || 1;
    return b / span;
  }
}

let lastUiUpdate = 0;
function updateProgress(force) {
  if (!job) return;
  const now = Date.now();
  if (!force && now - lastUiUpdate < 200) return;
  lastUiUpdate = now;
  const speed = job.speed();
  const fill = $('fill');
  if (job instanceof FileJob) {
    const elapsed = (now - job.started) / 1000;
    if (job.total) {
      fill.classList.remove('indeterminate');
      const pct = (job.received / job.total) * 100;
      fill.style.width = pct.toFixed(1) + '%';
      $('pct').textContent = Math.floor(pct) + '%';
    } else {
      fill.classList.add('indeterminate');
      $('pct').textContent = JD.formatBytes(job.received) || '0 B';
    }
    const eta = job.total && job.received ? (elapsed / job.received) * (job.total - job.received) : 0;
    $('detail').textContent = [
      job.total ? `${JD.formatBytes(job.received) || '0 B'} of ${JD.formatBytes(job.total)}` : '',
      speed ? JD.formatBytes(speed) + '/s' : '',
      eta > 1 ? JD.formatDuration(eta) + ' left' : ''
    ].filter(Boolean).join(' · ');
    return;
  }
  if (job.live && !job.addingDone) {
    fill.classList.add('indeterminate');
    $('pct').textContent = '● Recording ' + (JD.formatDuration(job.recorded) || '0:00');
    $('detail').textContent = `${JD.formatBytes(job.bytes) || '0 B'} · ${JD.formatBytes(speed) || '0 B'}/s`;
  } else {
    fill.classList.remove('indeterminate');
    const pct = job.total ? (job.done / job.total) * 100 : 0;
    fill.style.width = pct.toFixed(1) + '%';
    $('pct').textContent = Math.floor(pct) + '%';
    const left = job.total - job.done;
    const elapsed = (now - job.started) / 1000;
    const eta = job.done > 3 ? (elapsed / job.done) * left : 0;
    $('detail').textContent = [
      `${job.done} / ${job.total} pieces`,
      JD.formatBytes(job.bytes),
      speed ? JD.formatBytes(speed) + '/s' : '',
      eta && left ? JD.formatDuration(eta) + ' left' : ''
    ].filter(Boolean).join(' · ');
  }
}

/* ---------------- single file (fallback for refused browser downloads) ---------------- */

class FileJob {
  constructor(url) {
    this.url = url;
    this.parts = [];
    this.received = 0;
    this.total = 0;
    this.type = '';
    this.cancelled = false;
    this.running = true;
    this.abort = new AbortController();
    this.speedSamples = [];
    this.started = Date.now();
  }

  cancel() {
    this.cancelled = true;
    this.abort.abort();
  }

  async run() {
    await allowHost(this.url);
    let attempt = 0;
    for (;;) {
      try {
        const headers = this.received ? { Range: `bytes=${this.received}-` } : {};
        const res = await fetch(this.url, { credentials: 'include', headers, signal: this.abort.signal });
        if (!res.ok) throw new Error(`The site refused the download (HTTP ${res.status}).`);
        if (this.received && res.status !== 206) { this.parts = []; this.received = 0; } // no resume support
        if (!this.total) {
          const cr = (res.headers.get('content-range') || '').match(/\/(\d+)/);
          this.total = cr ? parseInt(cr[1], 10) : parseInt(res.headers.get('content-length') || '0', 10);
        }
        this.type = this.type || (res.headers.get('content-type') || '').split(';')[0];
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.parts.push(value);
          this.received += value.length;
          this.speedSamples.push([Date.now(), value.length]);
          updateProgress();
        }
        if (this.total && this.received < this.total) throw new Error('The connection closed early.');
        this.running = false;
        return;
      } catch (e) {
        if (this.cancelled) throw new Error('cancelled');
        if (++attempt > RETRIES || /refused/.test(e.message)) { this.running = false; throw e; }
        await sleep(1000 * 2 ** attempt);
      }
    }
  }
}
FileJob.prototype.speed = Job.prototype.speed;

async function startFile() {
  $('ext').textContent = '.' + FILE_EXT;
  $('loading').hidden = true;
  $('progress').hidden = false;
  $('filename').disabled = true;
  $('phase').textContent = 'The site blocked the normal download, so it is being fetched through the extension…';
  job = new FileJob(SOURCE);
  updateProgress(true);
  try {
    await job.run();
    updateProgress(true);
    $('cancel').hidden = true;
    $('phase').textContent = 'Saving…';
    const name = JD.sanitizeFilename($('filename').value, 'video') + '.' + FILE_EXT;
    const r = await saveFile({ parts: job.parts, name, type: job.type || 'application/octet-stream' });
    job.parts = [];
    savedDownloadId = r.id;
    $('progress').hidden = true;
    $('done').hidden = false;
    $('doneText').textContent = name + ' · ' + JD.formatBytes(r.size);
  } catch (e) {
    $('progress').hidden = true;
    showError(e.message === 'cancelled' ? 'Download cancelled.' : e.message);
  } finally {
    job.running = false;
  }
}

/* ---------------- output ---------------- */

function detectFormat(track) {
  if (track.segments.some((s) => s.map)) return 'fmp4';
  const first = track.data.find(Boolean);
  if (!first || first.length < 4) return 'unknown';
  if (first[0] === 0x47 && (first.length < 189 || first[188] === 0x47)) return 'ts';
  if ((first[0] === 0x49 && first[1] === 0x44 && first[2] === 0x33) || (first[0] === 0xff && (first[1] & 0xf6) === 0xf0)) return 'aac';
  if (MP4.looksLikeMp4(first)) return 'fmp4';
  return 'unknown';
}

/** Turn MPEG-TS / AAC pieces into fragmented MP4 using mux.js. */
function transmux(track) {
  const tm = new muxjs.mp4.Transmuxer({ remux: true, keepOriginalTimestamps: false });
  let init = null;
  const units = [];
  tm.on('data', (ev) => {
    if (ev.initSegment && (!init || ev.initSegment.length > init.length)) init = ev.initSegment;
    if (ev.data && ev.data.length) units.push(...MP4.splitFragments(ev.data));
  });
  for (let i = 0; i < track.data.length; i++) {
    const d = track.data[i];
    if (!d) continue;
    tm.push(d);
    tm.flush();
  }
  if (!init || !units.length) throw new Error('Could not convert the stream to MP4');
  return { init, units };
}

function fmp4Track(track) {
  const firstMap = [...track.maps.values()].find(Boolean);
  if (!firstMap) {
    // Self-contained MP4 pieces (each with its own moov): use the first as init.
    const first = track.data.find(Boolean);
    const moovEnd = MP4.boxes(first).filter((b) => b.type === 'ftyp' || b.type === 'moov').reduce((n, b) => Math.max(n, b.end), 0);
    if (!moovEnd) throw new Error('Unknown stream format');
    return { init: first.subarray(0, moovEnd), units: track.data.filter(Boolean).flatMap((d) => MP4.splitFragments(d)) };
  }
  return { init: firstMap, units: track.data.filter(Boolean).flatMap((d) => MP4.splitFragments(d)) };
}

/** Plain joined pieces (for a single fMP4 track, keeps init changes mid-stream). */
function joinRaw(track) {
  const parts = [];
  let currentMap = null;
  track.segments.forEach((s, i) => {
    const d = track.data[i];
    if (!d) return;
    if (s.mapKey && s.mapKey !== currentMap) {
      const m = track.maps.get(s.mapKey);
      if (m) parts.push(m);
      currentMap = s.mapKey;
    }
    parts.push(d);
  });
  return parts;
}

function asMp4(track) {
  const fmt = detectFormat(track);
  if (fmt === 'ts' || fmt === 'aac') return transmux(track);
  if (fmt === 'fmp4') return fmp4Track(track);
  throw new Error('Unknown stream format');
}

async function buildFiles(video, audio) {
  const base = JD.sanitizeFilename($('filename').value, 'video');
  const vfmt = detectFormat(video);

  // Single track, already MP4: just join the pieces.
  if (!audio && vfmt === 'fmp4') {
    return [{ parts: joinRaw(video), name: base + '.mp4', type: 'video/mp4' }];
  }

  try {
    $('phase').textContent = vfmt === 'ts' ? 'Converting to MP4…' : 'Joining pieces…';
    await sleep(30);
    const v = asMp4(video);
    if (audio && !MP4.hasAudio(v.init)) {
      $('phase').textContent = 'Adding the audio track…';
      await sleep(30);
      const a = asMp4(audio);
      return [{ parts: MP4.merge(v, a), name: base + '.mp4', type: 'video/mp4' }];
    }
    MP4.renumber(v.units);
    const onlyAudio = !Array.from(MP4.trackInfo(v.init).values()).some((t) => t.handler === 'vide');
    return [{ parts: [v.init, ...v.units], name: base + (onlyAudio ? '.m4a' : '.mp4'), type: onlyAudio ? 'audio/mp4' : 'video/mp4' }];
  } catch (e) {
    console.warn('MP4 conversion failed, saving the original format', e);
    // Fall back to the stream's own format (plays in VLC and most players).
    const files = [];
    const ext = vfmt === 'ts' ? '.ts' : vfmt === 'aac' ? '.aac' : '.mp4';
    if (video.data.some(Boolean)) files.push({ parts: joinRaw(video), name: base + ext, type: 'video/mp2t' });
    if (audio && audio.data.some(Boolean)) {
      const afmt = detectFormat(audio);
      files.push({ parts: joinRaw(audio), name: base + ' (audio)' + (afmt === 'ts' ? '.ts' : afmt === 'aac' ? '.aac' : '.m4a'), type: 'application/octet-stream' });
    }
    if (!files.length) throw e;
    files.note = 'Saved in the stream’s original format (it plays in VLC).';
    return files;
  }
}

function saveFile(file) {
  return new Promise((resolve, reject) => {
    const blob = new Blob(file.parts, { type: file.type });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: file.name, saveAs: settings.saveAs, conflictAction: 'uniquify' }, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        // An unusual character in the name: retry with a plain one.
        chrome.downloads.download({ url, filename: 'video' + file.name.slice(file.name.lastIndexOf('.')), saveAs: settings.saveAs, conflictAction: 'uniquify' }, (id2) => {
          if (chrome.runtime.lastError || id2 === undefined) {
            reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Download was refused'));
          } else watch(id2);
        });
        return;
      }
      watch(id);
    });
    function watch(id) {
      const listener = (d) => {
        if (d.id !== id || !d.state) return;
        if (d.state.current === 'complete' || d.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(listener);
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          if (d.state.current === 'complete') resolve({ id, size: blob.size });
          else reject(new Error('The save was interrupted' + (d.error && d.error.current ? ' (' + d.error.current + ')' : '')));
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    }
  });
}

/* ---------------- start ---------------- */

async function start() {
  $('error').hidden = true;
  $('start').disabled = true;
  try {
    const v = selectedVariant();
    const videoPl = await loadPlaylist(v ? v.url : SOURCE);
    if (videoPl.unsupportedEncryption) throw new Error('This stream is DRM protected, so it can’t be saved.');
    if (!videoPl.segments.length) throw new Error('The stream has no pieces to download.');

    const tracks = [new Track('video', videoPl.url)];
    const audios = audioChoices(v);
    let audioPl = null;
    if (audios.length) {
      const a = audios[Number($('audio').value) || 0];
      audioPl = await loadPlaylist(a.url);
      if (audioPl.unsupportedEncryption) throw new Error('This stream is DRM protected, so it can’t be saved.');
      tracks.push(new Track('audio', a.url));
    }

    const live = !videoPl.endList;
    job = new Job(tracks, live, videoPl.targetDuration);
    job.enqueue(tracks[0], tracks[0].addSegments(videoPl));
    if (audioPl) job.enqueue(tracks[1], tracks[1].addSegments(audioPl));

    $('options').hidden = true;
    $('progress').hidden = false;
    $('filename').disabled = true;
    $('stopLive').hidden = !live;
    $('phase').textContent = live ? 'Recording the live stream. Press “Stop & save” when you have what you need.' : 'Downloading…';
    updateProgress(true);

    await job.run();
    updateProgress(true);

    if (job.cancelled) {
      $('progress').hidden = true;
      $('options').hidden = false;
      $('start').disabled = false;
      $('filename').disabled = false;
      showError('Download cancelled.');
      job = null;
      return;
    }

    const failed = tracks.reduce((n, t) => n + t.failed, 0);
    const got = tracks.reduce((n, t) => n + t.data.filter(Boolean).length, 0);
    if (!got) throw new Error('None of the pieces could be downloaded. The site may block downloads from outside its player.');
    if (failed > Math.max(2, job.total * 0.1)) {
      throw new Error(`${failed} of ${job.total} pieces failed to download. Try again, or pick a lower quality.`);
    }

    $('cancel').hidden = true;
    $('stopLive').hidden = true;
    const files = await buildFiles(tracks[0], tracks[1]);
    $('phase').textContent = 'Saving…';
    const results = [];
    for (const f of files) results.push(await saveFile(f));
    savedDownloadId = results[0].id;

    $('progress').hidden = true;
    $('done').hidden = false;
    const total = results.reduce((n, r) => n + r.size, 0);
    $('doneText').textContent = files.map((f) => f.name).join(' + ') + ' · ' + JD.formatBytes(total) +
      (failed ? ` · ${failed} piece(s) were missing` : '') + (files.note ? ' · ' + files.note : '');
  } catch (e) {
    console.error(e);
    $('progress').hidden = true;
    $('options').hidden = false;
    $('start').disabled = false;
    $('filename').disabled = false;
    showError(e.message || String(e));
  } finally {
    if (job) job.running = false;
  }
}

init();
