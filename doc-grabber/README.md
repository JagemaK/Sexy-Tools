# Doc Grabber (Chrome / Edge extension)

Finds PDFs and scanned document pages on any webpage and downloads them as one complete PDF file.

## Install
1. Go to `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `doc-grabber` folder.
3. Pin the extension so its red icon shows in the toolbar.

## Use
1. Open the page with the document and click the **Doc Grabber** icon. A side panel opens.
2. Click **Scan this page**. With **Auto-scroll** on (the default), it scrolls through the page and any
   document viewer inside it, so viewers that load pages one at a time load every page. Leave the tab in front until it finishes.
3. The results:
   - **PDF files**: real PDFs on the page (embedded viewers, pdf.js `?file=` viewers, and links to `.pdf` files).
     **Download** saves the original file.
   - **Scanned pages**: page images found on the page (`<img>`, `<canvas>` pages drawn by viewers, SVG images and CSS backgrounds).
     Click a thumbnail to leave it out, and drag thumbnails to change the order.
4. Set the file name, page size (*Match image*, *A4*, *Letter*) and quality, then click **Download … as PDF**.

## Scan options
- **Wait per scroll step**: raise it (for example to 1000–1500 ms) on slow sites if pages are missing.
- **Ignore images smaller than**: skips icons and logos. Lower it if the document's pages are small images.

## Limits
- Some sites draw pages on a canvas protected against copying. Those pages can't be captured, and the status line says how many.
- Text in scanned pages is saved as an image (the PDF is not searchable).
- Only use it on documents you're allowed to download.

## Files
| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3; opens the side panel on toolbar click |
| `background.js` | Sets the side panel to open on icon click |
| `scanner.js` | Injected into every frame; finds PDFs and page images, auto-scrolls |
| `panel.html/.css/.js` | Side panel UI, image fetching, JPEG conversion, downloads |
| `pdf-builder.js` | Small built-in PDF writer (one JPEG per page, no external libraries) |
