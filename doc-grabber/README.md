# Jagema's Doc Grabber (Chrome / Edge extension)

Finds PDFs and scanned document pages on any webpage and downloads them as one complete PDF file.

## Install
**From the zip:** download `jagemas-doc-grabber.zip` from the repo root, unzip it, then follow the steps below and pick the unzipped `jagemas-doc-grabber` folder.

1. Go to `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder (`doc-grabber`, or `jagemas-doc-grabber` from the zip).
3. Pin the extension so its red icon shows in the toolbar.

## Use
1. Open the page with the document and click the **Jagema's Doc Grabber** icon (or press **Alt+Shift+D**). A side panel opens.
2. Click **Scan this page**. With **Auto-scroll** on (the default), it scrolls through the page and any
   document viewer inside it, so viewers that load pages one at a time load every page. Leave the tab in front until it finishes.
3. The results:
   - **PDF files**: real PDFs on the page (embedded viewers, pdf.js `?file=` viewers, and links to `.pdf` files).
     **Download** saves the original file.
   - **Scanned pages**: page images found on the page (`<img>`, `<canvas>` pages drawn by viewers, SVG images and CSS backgrounds).
     Click a thumbnail to leave it out, and drag thumbnails to change the order.
4. Set the file name, page size (*Match image*, *A4*, *Letter*) and quality, then click **Download … as PDF**.
   With **Searchable text (OCR)** on (the default), the PDF gets an invisible text layer. You can then search it (Ctrl+F),
   select text and copy it, just like a normal PDF.

## Searchable PDFs (OCR)
- OCR runs entirely in your browser with the bundled Tesseract engine. Nothing is uploaded.
- English is built in. Other languages (Spanish, French, German, Portuguese, Italian, Dutch, Russian, Arabic, Hindi,
  Chinese, Japanese) download their language data once (2–10 MB), then work offline.
- It reads several pages at once, one per CPU core pair. Expect about 1–2 s per page on a typical laptop.
- It works best on clear scans. *Auto-enhance contrast* or *Black & white* can help with faint or grey pages.

## Extra features
- **+ Scan & add**: scan another tab and add its pages to the list, to combine several documents into one PDF.
- **Look**: *Color*, *Grayscale*, or *Black & white (document)* for crisp, small, photocopy-style pages. The thumbnails preview the look.
- **Auto-enhance contrast**: brightens dull or grey scans so the paper is white and the text is dark.
- **Trim white margins**: crops empty borders around each page. It also works on grey or yellowed paper.
- **Rotate**: hover a thumbnail and click ↻ to turn that page 90°.
- **Preview**: double-click a thumbnail for a full-size view. Use ← → to flip through pages, Space to skip or keep a page, and Esc to close.
- **Page range**: type `1-5, 8, 12-` and press **Select** to pick pages by their position in the grid.
- **Download all**: saves every PDF file found at once.
- **Clear**: removes everything to start over.
- **Keyboard shortcut**: Alt+Shift+D opens the panel. You can change it at `chrome://extensions/shortcuts`.

## Scan options
- **Scan speed**:
  - *Fast* (recommended): moves on as soon as the page stops changing, rather than waiting a fixed time.
  - *Turbo*: quickest, but it can miss pages on slow viewers that don't number their pages.
  - *Careful*: for very slow sites.

  After scrolling, the scanner goes back to any numbered page it didn't capture and waits for it. If a page still
  never appeared, the status line names it.
- **Ignore images smaller than**: skips icons and logos. Lower it if the document's pages are small images.

## Troubleshooting
- **Pages missing?** The status line lists pages the viewer never showed. Switch *Scan speed* to *Careful* and scan again,
  or scroll to those pages yourself and press **+ Scan & add**.
- **Duplicate pages?** Click the extra thumbnail to skip it.

## Limits
- Some sites draw pages on a canvas protected against copying. Those pages can't be captured, and the status line says how many.
- Only use it on documents you're allowed to download.

## Files
| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3; opens the side panel on toolbar click |
| `background.js` | Sets the side panel to open on icon click |
| `scanner.js` | Injected into every frame; finds PDFs and page images, auto-scrolls |
| `panel.html/.css/.js` | Side panel UI, image fetching, JPEG conversion, downloads |
| `pdf-builder.js` | Small built-in PDF writer: one JPEG per page plus an invisible OCR text layer |
| `ocr.js` | Runs Tesseract OCR workers in parallel and returns word positions |
| `lib/tesseract/` | Tesseract.js 6 (Apache-2.0): engine, WebAssembly cores and English language data |
