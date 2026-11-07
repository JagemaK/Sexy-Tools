/* Shared helpers for Jagema's Downloader (background, popup and download page). */
(function (root) {
  'use strict';

  const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'flv', 'ogv', '3gp', 'wmv', 'mpeg', 'mpg'];
  const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba'];
  // Pieces of a stream. They are useless on their own, so they are never listed.
  const SEGMENT_EXT = ['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'fmp4', 'vtt', 'webvtt'];

  const CT_MAP = {
    'application/vnd.apple.mpegurl': 'hls',
    'application/x-mpegurl': 'hls',
    'audio/mpegurl': 'hls',
    'audio/x-mpegurl': 'hls',
    'application/dash+xml': 'dash',
    'video/vnd.mpeg.dash.mpd': 'dash'
  };

  const CT_EXT = {
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
    'video/x-flv': 'flv', 'video/ogg': 'ogv', 'video/3gpp': '3gp', 'video/x-msvideo': 'avi',
    'video/x-ms-wmv': 'wmv', 'video/mpeg': 'mpg', 'video/x-m4v': 'm4v',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg',
    'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/webm': 'weba'
  };

  function urlExt(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Decide what a URL is. Returns {kind, ext} or null.
   * kind: 'video' | 'audio' | 'hls' | 'dash'
   */
  function classify(url, contentType) {
    if (!url || /^(data|blob|chrome|chrome-extension|about|javascript):/i.test(url)) return null;
    const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
    const ext = urlExt(url);

    if (SEGMENT_EXT.includes(ext) || ct === 'video/mp2t' || ct === 'video/iso.segment' || ct === 'text/vtt') return null;
    if (ext === 'm3u8' || (ext === 'm3u' && ct.includes('mpegurl')) || CT_MAP[ct] === 'hls') return { kind: 'hls', ext: 'm3u8' };
    if (ext === 'mpd' || CT_MAP[ct] === 'dash') return { kind: 'dash', ext: 'mpd' };
    if (VIDEO_EXT.includes(ext)) return { kind: 'video', ext };
    if (AUDIO_EXT.includes(ext)) return { kind: 'audio', ext };
    if (ct.startsWith('video/')) return { kind: 'video', ext: CT_EXT[ct] || 'mp4' };
    if (ct.startsWith('audio/')) return { kind: 'audio', ext: CT_EXT[ct] || 'mp3' };
    return null;
  }

  function sanitizeFilename(name, fallback) {
    let s = String(name || '')
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*~]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, '');
    if (!s) s = fallback || 'video';
    if (s.length > 120) s = s.slice(0, 120).trim();
    // Windows reserved names
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
    return s;
  }

  function fileNameFromUrl(url) {
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      return last.replace(/\.[a-z0-9]{2,5}$/i, '');
    } catch (e) {
      return '';
    }
  }

  function formatBytes(n) {
    if (!n || n < 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)) + ' ' + u[i];
  }

  function formatDuration(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  function qualityLabel(height) {
    if (!height) return '';
    if (height >= 2160) return '4K';
    if (height >= 1440) return '1440p';
    return height + 'p';
  }

  /* ---------------- HLS playlist parsing ---------------- */

  function parseAttrs(str) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) {
      let v = m[2];
      if (v.startsWith('"')) v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  }

  function parseByteRange(str, prevEnd) {
    const [len, off] = String(str).split('@');
    const length = parseInt(len, 10);
    const offset = off !== undefined ? parseInt(off, 10) : (prevEnd || 0);
    return { offset, length };
  }

  /**
   * Parse an M3U8 playlist. Returns
   *  { type: 'master', variants: [...], audio: [...], subtitles: [...] }
   *  { type: 'media', segments: [...], targetDuration, mediaSequence, endList, duration, encrypted }
   */
  function parseM3U8(text, baseUrl) {
    if (!/^﻿?#EXTM3U/.test(text.trim())) throw new Error('Not an HLS playlist');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const abs = (u) => new URL(u, baseUrl).href;

    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
      const variants = [];
      const audio = [];
      const subtitles = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('#EXT-X-STREAM-INF:')) {
          const a = parseAttrs(l.slice(18));
          let j = i + 1;
          while (j < lines.length && lines[j].startsWith('#')) j++;
          if (j >= lines.length) break;
          const [w, h] = (a.RESOLUTION || '').split('x').map((n) => parseInt(n, 10));
          variants.push({
            url: abs(lines[j]),
            bandwidth: parseInt(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || '0', 10),
            width: w || 0,
            height: h || 0,
            codecs: a.CODECS || '',
            frameRate: parseFloat(a['FRAME-RATE'] || '0') || 0,
            audioGroup: a.AUDIO || ''
          });
          i = j;
        } else if (l.startsWith('#EXT-X-MEDIA:')) {
          const a = parseAttrs(l.slice(13));
          const entry = {
            type: a.TYPE,
            groupId: a['GROUP-ID'] || '',
            name: a.NAME || a.LANGUAGE || '',
            language: a.LANGUAGE || '',
            isDefault: a.DEFAULT === 'YES',
            url: a.URI ? abs(a.URI) : ''
          };
          if (a.TYPE === 'AUDIO') audio.push(entry);
          else if (a.TYPE === 'SUBTITLES') subtitles.push(entry);
        }
      }
      variants.sort((x, y) => (y.height - x.height) || (y.bandwidth - x.bandwidth));
      return { type: 'master', variants, audio, subtitles };
    }

    const segments = [];
    let targetDuration = 0;
    let mediaSequence = 0;
    let endList = false;
    let key = null;
    let map = null;
    let pendingDuration = 0;
    let pendingRange = null;
    let lastRangeEnd = 0;
    let lastRangeUrl = '';
    let encrypted = false;
    let unsupportedEncryption = '';

    for (const l of lines) {
      if (l.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = parseFloat(l.slice(22)) || 0;
      else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = parseInt(l.slice(22), 10) || 0;
      else if (l.startsWith('#EXT-X-ENDLIST')) endList = true;
      else if (l.startsWith('#EXTINF:')) pendingDuration = parseFloat(l.slice(8)) || 0;
      else if (l.startsWith('#EXT-X-BYTERANGE:')) pendingRange = l.slice(17);
      else if (l.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(l.slice(11));
        const method = (a.METHOD || 'NONE').toUpperCase();
        if (method === 'NONE') key = null;
        else if (method === 'AES-128') {
          key = { method, url: abs(a.URI), iv: a.IV || null };
          encrypted = true;
        } else {
          unsupportedEncryption = method;
          key = { method, url: a.URI ? abs(a.URI) : '', iv: a.IV || null };
        }
      } else if (l.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(l.slice(11));
        map = { url: abs(a.URI), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
      } else if (!l.startsWith('#')) {
        const url = abs(l);
        let range = null;
        if (pendingRange) {
          range = parseByteRange(pendingRange, url === lastRangeUrl ? lastRangeEnd : 0);
          lastRangeEnd = range.offset + range.length;
          lastRangeUrl = url;
        }
        segments.push({
          url,
          duration: pendingDuration,
          range,
          key,
          map,
          seq: mediaSequence + segments.length
        });
        pendingDuration = 0;
        pendingRange = null;
      }
    }
    const duration = segments.reduce((s, x) => s + x.duration, 0);
    return { type: 'media', segments, targetDuration, mediaSequence, endList, duration, encrypted, unsupportedEncryption };
  }

  root.JD = {
    classify,
    urlExt,
    sanitizeFilename,
    fileNameFromUrl,
    formatBytes,
    formatDuration,
    qualityLabel,
    parseM3U8,
    parseAttrs
  };
})(typeof self !== 'undefined' ? self : this);
