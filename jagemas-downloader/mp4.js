/* Minimal fragmented-MP4 tools: split fragments, and merge a video-only and an
 * audio-only fragmented MP4 into one file with both tracks. */
(function (root) {
  'use strict';

  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts', 'dinf']);

  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function setU32(b, o, v) { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
  function type(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

  /** Top-level (or child) boxes of b between start and end. */
  function boxes(b, start = 0, end = b.length) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      let header = 8;
      if (size === 1) {
        size = u32(b, o + 8) * 2 ** 32 + u32(b, o + 12);
        header = 16;
      } else if (size === 0) {
        size = end - o;
      }
      if (size < header || o + size > end) break;
      out.push({ type: type(b, o + 4), start: o, size, header, end: o + size });
      o += size;
    }
    return out;
  }

  function children(b, box) { return boxes(b, box.start + box.header, box.end); }

  function find(b, box, path) {
    let cur = [box];
    for (const t of path) {
      const next = [];
      for (const c of cur) for (const k of children(b, c)) if (k.type === t) next.push(k);
      cur = next;
    }
    return cur;
  }

  function looksLikeMp4(b) {
    if (b.length < 8) return false;
    const t = type(b, 4);
    return ['ftyp', 'styp', 'moof', 'moov', 'sidx', 'emsg', 'prft', 'free', 'mdat'].includes(t);
  }

  function box(typ, ...parts) {
    const len = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    setU32(out, 0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = typ.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function concat(parts) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  /** Split media data into units of one moof plus the mdat(s) after it. */
  function splitFragments(b) {
    const units = [];
    let cur = null;
    for (const bx of boxes(b)) {
      if (bx.type === 'moof') {
        if (cur) units.push(cur);
        cur = [bx];
      } else if (bx.type === 'mdat' && cur) {
        cur.push(bx);
      }
      // styp, sidx, prft, emsg, free: not needed in a saved file
    }
    if (cur) units.push(cur);
    return units.map((u) => b.subarray(u[0].start, u[u.length - 1].end));
  }

  /** Track info from an init segment: id -> {timescale, handler} */
  function trackInfo(init) {
    const info = new Map();
    for (const moov of boxes(init).filter((x) => x.type === 'moov')) {
      for (const trak of find(init, moov, ['trak'])) {
        const tkhd = find(init, trak, ['tkhd'])[0];
        const mdhd = find(init, trak, ['mdia', 'mdhd'])[0];
        const hdlr = find(init, trak, ['mdia', 'hdlr'])[0];
        if (!tkhd || !mdhd) continue;
        const tp = tkhd.start + tkhd.header;
        const id = u32(init, tp + (init[tp] === 1 ? 20 : 12));
        const mp = mdhd.start + mdhd.header;
        const timescale = u32(init, mp + (init[mp] === 1 ? 20 : 12));
        const handler = hdlr ? type(init, hdlr.start + hdlr.header + 8) : '';
        info.set(id, { timescale, handler });
      }
    }
    return info;
  }

  function hasAudio(init) {
    return [...trackInfo(init).values()].some((t) => t.handler === 'soun');
  }

  /** Decode time (seconds) of the first track fragment in a unit. */
  function unitTime(unit, tracks) {
    const moof = boxes(unit).find((x) => x.type === 'moof');
    if (!moof) return 0;
    const traf = find(unit, moof, ['traf'])[0];
    if (!traf) return 0;
    const tfhd = find(unit, traf, ['tfhd'])[0];
    const tfdt = find(unit, traf, ['tfdt'])[0];
    if (!tfhd || !tfdt) return 0;
    const id = u32(unit, tfhd.start + tfhd.header + 4);
    const p = tfdt.start + tfdt.header;
    const t = unit[p] === 1 ? u32(unit, p + 4) * 2 ** 32 + u32(unit, p + 8) : u32(unit, p + 4);
    const ts = (tracks.get(id) || {}).timescale || 90000;
    return t / ts;
  }

  /**
   * Merge two fragmented MP4 streams (e.g. HLS video + separate audio).
   * a/b: { init: Uint8Array, units: Uint8Array[] }. Returns an array of parts.
   */
  function merge(a, bTrack) {
    const ia = a.init;
    const ib = bTrack.init;
    const aTop = boxes(ia);
    const ftyp = aTop.find((x) => x.type === 'ftyp');
    const moovA = aTop.find((x) => x.type === 'moov');
    const moovB = boxes(ib).find((x) => x.type === 'moov');
    if (!moovA || !moovB) throw new Error('Missing moov box');

    const tracksA = trackInfo(ia);
    const tracksB = trackInfo(ib);
    let nextId = Math.max(0, ...tracksA.keys()) + 1;
    const remap = new Map();
    for (const id of tracksB.keys()) remap.set(id, nextId++);

    const patchTkhd = (bytes, trak) => {
      const copy = bytes.slice(trak.start, trak.end);
      const tkhd = find(copy, { start: 0, header: 8, end: copy.length }, ['tkhd'])[0];
      const tp = tkhd.start + tkhd.header;
      const off = tp + (copy[tp] === 1 ? 20 : 12);
      setU32(copy, off, remap.get(u32(copy, off)) || u32(copy, off));
      return copy;
    };

    const moovParts = [];
    const mvexParts = [];
    for (const c of children(ia, moovA)) {
      if (c.type === 'mvex') {
        for (const m of children(ia, c)) mvexParts.push(ia.slice(m.start, m.end));
      } else if (c.type === 'mvhd') {
        const mv = ia.slice(c.start, c.end);
        setU32(mv, mv.length - 4, nextId); // next_track_ID is the last field
        moovParts.push(mv);
      } else {
        moovParts.push(ia.slice(c.start, c.end));
      }
    }
    for (const c of children(ib, moovB)) {
      if (c.type === 'trak') moovParts.push(patchTkhd(ib, c));
      else if (c.type === 'mvex') {
        for (const m of children(ib, c)) {
          const copy = ib.slice(m.start, m.end);
          if (m.type === 'trex') setU32(copy, 12, remap.get(u32(copy, 12)) || u32(copy, 12));
          if (m.type !== 'mehd') mvexParts.push(copy);
        }
      }
    }
    moovParts.push(box('mvex', ...mvexParts));
    const moov = box('moov', ...moovParts);

    // Re-number the audio fragments' track IDs (in place: sizes don't change).
    for (const u of bTrack.units) {
      for (const moof of boxes(u).filter((x) => x.type === 'moof')) {
        for (const traf of find(u, moof, ['traf'])) {
          const tfhd = find(u, traf, ['tfhd'])[0];
          if (!tfhd) continue;
          const off = tfhd.start + tfhd.header + 4;
          setU32(u, off, remap.get(u32(u, off)) || u32(u, off));
        }
      }
    }

    // Interleave by time so players can read the file from start to end.
    const tracksMerged = new Map([...tracksA, ...[...tracksB].map(([id, t]) => [remap.get(id), t])]);
    const ua = a.units.map((u) => ({ u, t: unitTime(u, tracksMerged) }));
    const ub = bTrack.units.map((u) => ({ u, t: unitTime(u, tracksMerged) }));
    const out = [ftyp ? ia.slice(ftyp.start, ftyp.end) : box('ftyp', new Uint8Array([105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 105, 115, 111, 50, 97, 118, 99, 49, 109, 112, 52, 49])), moov];
    let i = 0;
    let j = 0;
    while (i < ua.length || j < ub.length) {
      if (j >= ub.length || (i < ua.length && ua[i].t <= ub[j].t)) out.push(ua[i++].u);
      else out.push(ub[j++].u);
    }
    renumber(out.slice(2));
    return out;
  }

  /** Give every moof a fresh, increasing sequence number. */
  function renumber(units) {
    let seq = 1;
    for (const u of units) {
      for (const moof of boxes(u).filter((x) => x.type === 'moof')) {
        const mfhd = find(u, moof, ['mfhd'])[0];
        if (mfhd) setU32(u, mfhd.start + mfhd.header + 4, seq++);
      }
    }
  }

  root.MP4 = { boxes, splitFragments, merge, hasAudio, trackInfo, looksLikeMp4, concat, renumber };
})(typeof self !== 'undefined' ? self : this);
