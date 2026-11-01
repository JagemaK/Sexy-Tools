// Minimal PDF writer: one JPEG image per page (DCTDecode), no dependencies.
// pages: [{ jpeg: Uint8Array, width, height }]  (pixel size of the JPEG)
// options.pageSize: 'fit' | 'a4' | 'letter'
const PdfBuilder = (() => {
  const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
  const enc = new TextEncoder();
  const n2 = (v) => (Math.round(v * 100) / 100).toString();

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

  function pdfDate(d = new Date()) {
    const p = (x) => String(x).padStart(2, '0');
    return `(D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z)`;
  }

  function pageBox(img, pageSize) {
    if (pageSize === 'fit') {
      const W = SIZES.a4[0];
      return { W, H: W * (img.height / img.width), x: 0, y: 0, w: W, h: W * (img.height / img.width) };
    }
    let [W, H] = SIZES[pageSize] || SIZES.a4;
    if (img.width > img.height) [W, H] = [H, W]; // landscape scans get landscape pages
    const s = Math.min(W / img.width, H / img.height);
    const w = img.width * s, h = img.height * s;
    return { W, H, x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  function build(pages, { title = 'Document', pageSize = 'fit' } = {}) {
    if (!pages.length) throw new Error('No pages to write');
    const chunks = [];
    const offsets = [];
    let offset = 0;
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

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment

    const pageObj = (i) => 4 + i * 3;
    const kids = pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
    obj(3, `<< /Title ${pdfText(title)} /Producer (Jagema's Doc Grabber) /CreationDate ${pdfDate()} >>`);

    pages.forEach((img, i) => {
      const p = pageObj(i), c = p + 1, im = p + 2;
      const b = pageBox(img, pageSize);
      obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(b.W)} ${n2(b.H)}] ` +
        `/Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${c} 0 R >>`);
      const content = `q ${n2(b.w)} 0 0 ${n2(b.h)} ${n2(b.x)} ${n2(b.y)} cm /Im0 Do Q`;
      obj(c, `<< /Length ${enc.encode(content).length} >>\nstream\n`, content, '\nendstream');
      obj(im, `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`,
        img.jpeg, '\nendstream');
    });

    const count = 3 + pages.length * 3;
    const xref = offset;
    let table = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size ${count + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    return new Blob(chunks, { type: 'application/pdf' });
  }

  return { build };
})();

if (typeof module !== 'undefined') module.exports = PdfBuilder;
