# spangap/flasher

A tiny, static, browser-based firmware flasher for spangap devices. Point a
Chromium browser at it, pick a build, and it flashes over USB via Web Serial —
no install, no toolchain.

It is deliberately just a handful of files that can be served from **anywhere
static** (GitHub Pages, an S3 bucket, `python3 -m http.server`, the device's own
web server): `index.html`, `flasher.js`, `builds-repo.txt`, and `vendor/`.

## How it resolves a build

`https://…/flasher/?build=tdeck`

1. Reads `builds-repo.txt` → the builds-repo **root URL** (first non-comment line).
2. Downloads `<root>/main/tdeck.zip` — a `flasher.zip` produced by `spangap build`
   and published by `spangap make-builds` (see the `*-builds` repos).
3. Unzips it in the browser (JSZip), reads `flasher_args.json` for the
   offset→image map and flash settings.
4. Flashes every image at its offset over Web Serial (esptool-js), then resets.

## Deploying

- Edit **`builds-repo.txt`** to point at the builds repo you want this flasher to
  serve (e.g. `reticulous/reticulous-builds` or `spangap/spangap-builds`). The
  builds repo must be **public** so the browser can fetch its zips.
- Serve the folder over **HTTPS** (or `http://localhost`) — Web Serial requires a
  secure context.
- Link users straight to a build: `.../flasher/?build=tdeck`.

## Vendored dependencies (no runtime CDN)

Everything runs from `vendor/` — nothing is fetched from a third-party CDN at
runtime. Pinned versions are in `vendor/VERSIONS.txt`:

- `esptool-bundle.js` — [esptool-js](https://github.com/espressif/esptool-js)
  (self-contained ESM bundle; pako inlined).
- `jszip.min.js` — [JSZip](https://github.com/Stuk/jszip).

To update, re-fetch the pinned files and bump `VERSIONS.txt`.

## Browser support

Web Serial is Chromium-only (Chrome, Edge, Opera, Brave) on desktop. Firefox and
Safari don't support it.
