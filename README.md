# 📚 DeKindled (Images fork) — download Kindle Cloud Reader pages as a ZIP

A Chrome extension that captures the page images Amazon's **Kindle Cloud Reader** renders and saves them to a single **ZIP of image files** — one file per page.

> **This is a fork.** The [original DeKindled](https://github.com/dmilin1/inkwell/) captured pages and sent them to the **OpenAI vision API** to rebuild an **EPUB** (markdown → HTML → EPUB). **This fork removes OpenAI and EPUB entirely** and just downloads the raw captured page images. No API key, no network calls to third parties, no conversion — you get a folder of `page-0001.jpg`, `page-0002.jpg`, … inside a ZIP named after the book.

## What changed vs. upstream

| | Upstream DeKindled | This fork |
|---|---|---|
| Output | EPUB (rebuilt from AI transcription) | **ZIP of page images** |
| OpenAI API key | Required | **Not used / removed** |
| Network calls | Sends every page to OpenAI | **None** — everything stays local |
| Capture start | Auto-scans on demand | **Nothing is captured until you click "Start Capture"** |
| UI | Full-screen overlay | **Non-blocking banner** with Start / Stop / Download |
| Amazon domains | `read.amazon.com` only | **All regional domains** (`.co.uk`, `.de`, `.co.jp`, `.fr`, `.ca`, …) |
| Removed | — | `showdown.min.js`, OpenAI options page, EPUB builder |

If you want AI transcription to EPUB, use the original. If you just want the page images, use this fork.

## 🐞 Bugs fixed from the original

Beyond the feature changes, this fork fixes two things that stopped the upstream extension from working properly for me:

- **It only worked on `read.amazon.com`.** The upstream manifest matched only the US domain in its content-script `matches`, `host_permissions`, and `web_accessible_resources`. On any regional store — `read.amazon.co.uk`, `.de`, `.co.jp`, `.fr`, `.ca`, `.com.au`, and the rest — the interceptor was never injected, so nothing was captured and the extension silently appeared to do nothing. This fork registers **all 13 regional `read.amazon.*` domains**.

- **Pages came out incomplete or out of order.** The reader generates a page's image **only the first time that page renders**, and won't regenerate it when you revisit an already-cached page. The upstream auto-scan started capturing from wherever you happened to be, so earlier pages were often missing and the ordering could drift. This fork keeps capture **disarmed until you click Start**, has you position on the first page, then **reloads to force a clean forward render from page one** — so you get every page, in order. (See ["Why it reloads"](#why-it-reloads-and-starts-from-where-you-are) below.)

## 🚀 Install

1. Download the release ZIP (or `git clone` this repo) and unzip it.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the `dekindled` folder.

## 📖 How to capture a book

1. Go to your regional reader — [read.amazon.com](https://read.amazon.com), [read.amazon.co.uk](https://read.amazon.co.uk), etc. — sign in, and open a book.
2. **Turn to the first page you want** using the reader's own controls. Nothing is captured yet.
3. Click the **DeKindled toolbar icon**. A small banner appears at the top of the page.
4. Click **▶ Start Capture**. The page reloads and DeKindled begins turning pages forward on its own, capturing each one. A live count and a **■ Stop** button show in the banner.
5. Let it run to the end of the book, or click **■ Stop** any time to keep only what's captured so far.
6. Click the toolbar icon again and press **⬇ Download Images** to save the ZIP. Use **Clear** to discard the capture and start over.

### Why it reloads and starts from where you are

The reader only generates a page's image **the first time that page renders**, and won't regenerate it when you revisit a cached page. Reloading forces a fresh render of your current page onward while the capture is armed — which is why you position yourself on the first page **before** starting, rather than letting the extension seek backwards.

## ⚠️ Notes

- Capture is **forward-only** and relies on the page images the reader loads. Don't switch display settings or navigate manually mid-capture or pages may land out of order — use **Clear** and restart if that happens.
- Keep the tab focused and in the foreground while it scans.
- This is for **your own purchased books**, so you can read them on any device or app you choose. Buy your books and support the authors.

## 🛠️ How it works

- **`inject.js`** (content script, `document_start`) injects the interceptor into the page's main world and bridges messages to the background worker.
- **`interceptor.js`** overrides `URL.createObjectURL()` and reads each page blob to base64 *before the reader revokes it* — but only while capture is armed. After a "Start Capture" reload it auto-drives the reader forward (synthetic arrow-key navigation) to the end, showing a Stop button.
- **`viewer-inject.js`** is the non-blocking control banner (Start / Stop / Download / Clear).
- **`background.js`** collects the captured pages in chunks and bundles them into a ZIP via `zip-utils.js`, then triggers the download. No external services.

### File structure
- `manifest.json` — extension configuration
- `background.js` — service worker; builds and downloads the ZIP
- `inject.js` — content-script injector + message bridge
- `interceptor.js` — blob interception + auto page-turning capture driver
- `viewer-inject.js` — non-blocking control banner
- `zip-utils.js` — minimal ZIP writer

## 🙏 Credits

Fork of [DeKindled](https://github.com/dmilin1/inkwell/) by dmilin1. This fork strips the OpenAI/EPUB pipeline down to a local image export.

## 📄 License

MIT. See `LICENSE`.
