# Jagema's Downloader (Chrome extension)

Finds the videos on any web page and downloads them: plain video files (MP4, WebM, MOV, MKV…),
audio files, and HLS streams (`.m3u8`), which it saves as a single MP4.

## Install (Chrome, Edge, Brave)
1. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `jagemas-downloader` folder.
3. Pin the extension from the puzzle-piece menu so the icon is always visible.

## Use
1. Open a page with a video. **Press play** for a second or two: many sites only load the video once it plays.
2. The icon shows a number when videos are found. Click it.
3. Each video is listed with its quality, length and size. Press **Download**.
   - **Video files** go straight to your Downloads folder.
   - **HLS streams** open a download page: pick the quality (and audio language if there is a choice),
     then press **Download**. Keep that tab open until it says **Saved**.
   - **Live streams** show **Start recording**. Press **Stop & save** when you have what you need.
4. **Copy link** copies the video address; **Open** opens it in a new tab.

Footer options: **Show small files** (hidden by default: ads, previews, thumbnails under 200 KB),
**Ask where to save**, and **Clear list**.

## What it handles
- Videos the page shows (`<video>`, `<audio>`, `<source>`, share tags, schema.org data, links to video files),
  including inside frames.
- Videos the page loads over the network, picked up as they load (by file type and by content type).
- HLS: quality selection, AES-128 encrypted streams, byte-range playlists, MPEG-TS pieces (converted to MP4)
  and fMP4/CMAF pieces, separate audio tracks (merged into the same MP4), and live recording.
- Sites that only serve videos to their own pages: requests are sent with the page as Referer.
  If a site still refuses the normal browser download, the file is fetched through the extension instead
  and a progress page opens.

## What it can't do
- **DRM-protected video** (Netflix, Disney+, Prime Video, Spotify and similar) can't be saved. The extension says so
  when it sees a DRM stream.
- **DASH streams** (`.mpd`) are listed, but only the link can be copied for now.
- Sites that build the video from small pieces inside the player (`blob:` sources with no `.m3u8`), such as YouTube,
  show a note instead of a download button.
- Streams are put together in memory, so a very long, high-quality stream needs a lot of free RAM.

Only download videos you have the right to save.

## Files
| File | What it does |
| --- | --- |
| `manifest.json` | Extension settings and permissions |
| `background.js` | Watches network traffic per tab, counts videos on the icon, sets the Referer for downloads, starts downloads |
| `scanner.js` | Run in the page (all frames) when the popup opens; lists the videos the page shows |
| `popup.html/.css/.js` | The list you see when you click the icon |
| `download.html/.css/.js` | Stream downloader page (HLS) and fallback file downloader |
| `mp4.js` | Splits and merges fragmented MP4 (joins separate video and audio tracks) |
| `common.js` | Shared helpers: file type detection, HLS playlist parser, formatting |
| `lib/mux.min.js` | [mux.js](https://github.com/videojs/mux.js) 6.3.0 (Apache-2.0), converts MPEG-TS to MP4 |
