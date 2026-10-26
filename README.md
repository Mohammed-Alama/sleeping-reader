# Sleep PDF

A tiny local PDF reader made for reading in bed: pages sit side by side, fill the
screen height, and drift past at a very slow, smooth speed. No clicking, no page
turns — just read until you fall asleep.

## Start it

```bash
npm install
npm run dev
```

Then open <http://127.0.0.1:5173>.

Or double-click **Sleep PDF.command** (it installs dependencies the first time,
starts the server, and opens your browser).

The dev server needs to stay running while you read. Closing the Terminal window
stops it.

## Read PDFs from Google Drive on an iPad

The reader is a web page, so the iPad can use the Mac's copy over Wi-Fi. No app
install, and no download to the iPad's storage:

1. Put the iPad on the same Wi-Fi network as the Mac and keep the Mac awake.
2. On the iPad, open Safari and go to `http://<mac-ip>:5173` (find the Mac's IP
   in System Settings → Wi-Fi, or run `ipconfig getifaddr en0`). The dev server is
   already on the LAN when started with `npm run dev`.
3. Tap **Choose a PDF**, then **Browse** → **Google Drive** → pick the PDF. Safari
   streams it straight into the reader; there is no file saved in Files or
   Downloads. The PDF and your page position stay cached in the browser, so it
   resumes offline afterwards.
4. If **Google Drive** is not listed in Files: open the **Files** app, tap
   **Browse**, tap the **•••** button, choose **Edit**, and turn on **Google
   Drive**. It needs the Google Drive app installed and signed in.
5. Tap **Share → Add to Home Screen** for a full-screen, no-browser-chrome
   reader.

Notes: plain `http://` on the LAN means the screen wake lock is unavailable on
iPadOS, so set **Auto-Lock → Never** (Settings → Display & Brightness) while
reading. For a quick read with no auto-scroll, the Google Drive app's own PDF
viewer also opens files without downloading.

## Read a PDF

- Click **Choose a PDF**, press `O`, or drop a file anywhere on the page.
- The reader remembers the last PDF, the exact position, speed, dim level, and
  rotation, so reopening the tab resumes where you stopped.
- **Click a page** or press `Space` to start / pause the drift.
- Press `F` for fullscreen, get comfortable, and let it scroll.
- The screen wake lock keeps the Mac display awake while it is playing, so it
  does not dim mid-page (as long as the lid is open).

## Controls

| Control | What it does |
| --- | --- |
| `Space` / click page | Play or pause |
| `↑` `↓` | Speed up / slow down |
| `←` `→` | Jump back / forward one screen |
| `R` | Rotate pages 90° (sideways reading). `Shift` `R` rotates back the other way. |
| `D` | Flip the drift direction. |
| `G` or click the page count | Jump to a specific page. |
| `N` | Warm light on / off |
| `F` | Fullscreen |
| `O` | Open another PDF |
| Drag & drop | Open a PDF |

**Speed** is measured in pixels per second. 10–15 px/s is a comfortable
drifting pace; use 30–50 px/s if you read faster.

**Rotation:** keep pressing `R` to cycle 90° → 180° → 270° → upright. At 90° the
page is turned sideways so you can lie on your side with the Mac.

**Direction:** by default the pages drift right and the next page enters from the
left. Press `D` (or the ↔ button) to make them drift left with the next page
entering from the right. Your choice is remembered.

**Dim** darkens the pages (up to 90%) and **warm light** adds a paper-warm tint,
for reading with the lights off without a bright white screen.

## Build a static copy

```bash
npm run build
npm run preview
```

The built files live in `dist/`. It is a static site, so it can be served from any
local web server. (A server is needed because browsers block PDF workers and
IndexedDB on `file://` pages.)

## Notes

- Everything stays on your Mac. PDFs are stored in the browser's IndexedDB only
  to resume the last book; there is no network upload.
- Works best in Chrome, Safari, or Edge on macOS.
- `scripts/verify.mjs` is a headless Chrome smoke test: start the dev server,
  then run `node scripts/verify.mjs` (Chrome must be installed).
