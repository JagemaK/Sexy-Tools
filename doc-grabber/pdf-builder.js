// Small PDF writer: one JPEG image per page (DCTDecode), plus an optional
// invisible OCR text layer so the PDF is searchable and text can be copied.
//
// pages: [{ jpeg: Uint8Array, width, height,          // pixel size of the JPEG
//           words?: [{ text, x0, y0, x1, y1, base }] }] // OCR boxes in JPEG pixels
// options.pageSize: 'fit' | 'a4' | 'letter'
//
// The text layer uses the same technique as Tesseract's own PDF renderer: a
// "glyphless" TrueType font (no visible shapes) addressed by Unicode code
// points through Identity-H, with a ToUnicode map, drawn in render mode 3
// (invisible). That works for any language, not just Latin text.
const PdfBuilder = (() => {
  const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
  const enc = new TextEncoder();
  const n2 = (v) => (Math.round(v * 100) / 100).toString();

  // GlyphLessFont from the Tesseract OCR project (pdf.ttf, Apache License 2.0).
  const GLYPHLESS_TTF_B64 =
    'AAEAAAAKAIAAAwAgT1MvMlbeyJQAAAEoAAAAYGNtYXAACgA0AAABkAAAAB5nbHlmFSJBJAAAAbgAAAAYaGVhZAt48WUAAACsAAAANmhoZWEMAgQC' +
    'AAAA5AAAACRobXR4BAAAAAAAAYgAAAAIbG9jYQAMAAAAAAGwAAAABm1heHAABAAFAAABCAAAACBuYW1l8usW2gAAAdAAAABLcG9zdAABAAEAAAIc' +
    'AAAAIAABAAAAAQAAsJRxEF8PPPUEBwgAAAAAAM+a/G4AAAAA1MOn8gAAAAAEAAgAAAAAEAACAAAAAAAAAAEAAAgA//8AAAQAAAAAAAQAAAEAAAAA' +
    'AAAAAAAAAAAAAAACAAEAAAACAAQAAQAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAwAAAZAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAQABAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAR09PRwBAAAAAAAAB//8AAAABAAGAAAAAAAAAAAAAAAAAAAABAAAAAAAABAAAAAAAAAIAAQAAAAAAFAADAAAAAAAU' +
    'AAYACgAAAAAAAAAAAAAAAAAMAAAAAQAAAAAEAAgAAAMAADEhESEEAPwACAAAAAADACoAAAADAAAABQAWAAAAAQAAAAAABQALABYAAwABBAkABQAW' +
    'AAAAVgBlAHIAcwBpAG8AbgAgADEALgAwVmVyc2lvbiAxLjAAAAEAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAA=';

  const TO_UNICODE_CMAP = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfrange
<0000> <FFFF> <0000>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // PDF text string as UTF-16BE hex, so any title characters survive.
  function pdfText(s) {
    let hex = 'FEFF';
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      const units = cp > 0xffff
        ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)]
        : [cp];
      for (const u of units) hex += u.toString(16).padStart(4, '0').toUpperCase();
    }
    return `<${hex}>`;
  }

  // Identity-H codes for the glyphless font: one 2-byte code per character (BMP only).
  function cidHex(text) {
    let hex = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      hex += (cp > 0xffff ? 0xfffd : cp).toString(16).padStart(4, '0');
    }
    return hex;
  }

  function pdfDate(d = new Date()) {
    const p = (x) => String(x).padStart(2, '0');
    return `(D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z)`;
  }

  function pageBox(img, pageSize) {
    if (pageSize === 'fit') {
      const W = SIZES.a4[0];
      const H = W * (img.height / img.width);
      return { W, H, x: 0, y: 0, w: W, h: H };
    }
    let [W, H] = SIZES[pageSize] || SIZES.a4;
    if (img.width > img.height) [W, H] = [H, W]; // landscape scans get landscape pages
    const s = Math.min(W / img.width, H / img.height);
    const w = img.width * s, h = img.height * s;
    return { W, H, x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  // Invisible text drawing every OCR word exactly over its image.
  function textLayer(img, b) {
    if (!img.words || !img.words.length) return '';
    const sx = b.w / img.width, sy = b.h / img.height;
    const ops = ['BT', '3 Tr'];
    for (const wd of img.words) {
      const text = wd.text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const chars = [...text].length;
      const base = wd.base ?? wd.y1;
      const fs = Math.max(1, (base - wd.y0) * sy); // from the baseline up to the top of the line
      const width = Math.max(0.5, (wd.x1 - wd.x0) * sx);
      const tz = (100 * width) / (chars * 0.5 * fs); // glyphs are 0.5 em wide
      const x = b.x + wd.x0 * sx;
      const y = b.y + (img.height - base) * sy;
      // The trailing space spills into the gap after the word, so copied text has spaces.
      ops.push(`/F1 ${n2(fs)} Tf ${n2(tz)} Tz 1 0 0 1 ${n2(x)} ${n2(y)} Tm <${cidHex(text + (wd.last ? '' : ' '))}> Tj`);
    }
    ops.push('ET');
    return ops.join('\n');
  }

  async function build(pages, { title = 'Document', pageSize = 'fit' } = {}) {
    if (!pages.length) throw new Error('No pages to write');
    const chunks = [];
    const offsets = [];
    let offset = 0;
    let nextObj = 1;
    const alloc = () => nextObj++;
    const push = (d) => {
      const b = typeof d === 'string' ? enc.encode(d) : d;
      chunks.push(b);
      offset += b.length;
    };
    const obj = (num, ...parts) => {
      offsets[num] = offset;
      push(`${num} 0 obj\n`);
      parts.forEach(push);
      push('\nendobj\n');
    };
    const stream = async (num, dict, bytes, compress = true) => {
      const data = compress ? await deflate(bytes) : bytes;
      obj(num, `<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${data.length} >>\nstream\n`, data, '\nendstream');
    };

    const catalog = alloc(), pagesRoot = alloc(), info = alloc();
    const hasText = pages.some((p) => p.words && p.words.length);
    const font = hasText ? alloc() : 0;
    const pageNums = pages.map(() => ({ page: alloc(), content: alloc(), image: alloc() }));

    push('%PDF-1.5\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment
    obj(catalog, `<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`);
    obj(pagesRoot, `<< /Type /Pages /Kids [${pageNums.map((p) => `${p.page} 0 R`).join(' ')}] /Count ${pages.length} >>`);
    obj(info, `<< /Title ${pdfText(title)} /Producer (Jagema's Doc Grabber) /CreationDate ${pdfDate()} >>`);

    if (hasText) {
      const cidFont = alloc(), descriptor = alloc(), fontFile = alloc(), toUnicode = alloc(), cidToGid = alloc();
      obj(font, `<< /Type /Font /Subtype /Type0 /BaseFont /GlyphLessFont /Encoding /Identity-H ` +
        `/DescendantFonts [${cidFont} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
      obj(cidFont, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /GlyphLessFont ` +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
        `/FontDescriptor ${descriptor} 0 R /CIDToGIDMap ${cidToGid} 0 R /DW 500 >>`);
      obj(descriptor, `<< /Type /FontDescriptor /FontName /GlyphLessFont /Flags 5 /FontBBox [0 0 500 1000] ` +
        `/ItalicAngle 0 /Ascent 1000 /Descent 0 /CapHeight 1000 /StemV 80 /FontFile2 ${fontFile} 0 R >>`);
      const ttf = b64ToBytes(GLYPHLESS_TTF_B64);
      await stream(fontFile, `/Length1 ${ttf.length}`, ttf);
      await stream(toUnicode, '', enc.encode(TO_UNICODE_CMAP));
      const map = new Uint8Array(65536 * 2); // every character -> glyph 1
      for (let i = 1; i < map.length; i += 2) map[i] = 1;
      await stream(cidToGid, '', map);
    }

    for (let i = 0; i < pages.length; i++) {
      const img = pages[i], n = pageNums[i];
      const b = pageBox(img, pageSize);
      const fontRes = img.words && img.words.length ? ` /Font << /F1 ${font} 0 R >>` : '';
      obj(n.page, `<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 ${n2(b.W)} ${n2(b.H)}] ` +
        `/Resources << /XObject << /Im0 ${n.image} 0 R >>${fontRes} >> /Contents ${n.content} 0 R >>`);
      const content = `q ${n2(b.w)} 0 0 ${n2(b.h)} ${n2(b.x)} ${n2(b.y)} cm /Im0 Do Q\n` + textLayer(img, b);
      await stream(n.content, '', enc.encode(content));
      obj(n.image, `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`,
        img.jpeg, '\nendstream');
    }

    const count = nextObj - 1;
    const xref = offset;
    let table = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size ${count + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    return new Blob(chunks, { type: 'application/pdf' });
  }

  return { build };
})();

if (typeof module !== 'undefined') module.exports = PdfBuilder;
