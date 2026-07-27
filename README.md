# flashmon

A tiny, static, browser-based firmware **flasher + serial monitor** for spangap
devices. Point a Chromium browser at it, plug in a device over USB, and it
probes the chip, auto-detects the board, offers the right firmware image to
flash, and drops into an interactive serial monitor — no install, no toolchain.

It brands itself from a config file (`flashmon/flashmon.yaml`), so a deployment
reads as its own product (e.g. **Reticulous**) rather than "flashmon".

## Layout

```
flashmon/                     ← this repo
  flashmon/                   ← everything served to the browser (the web root)
    index.html
    flashmon.js
    flashmon.py               ← single-file terminal flasher (for non-browser users)
    <project>-flashmon        ← branded copy of flashmon.py `make` writes: deployment
                                URL baked in (gitignored generated artifact)
    flashmon.yaml.example     ← template config (checked in); copy → flashmon.yaml
    flashmon.yaml             ← your config: project brand + catalogue (gitignored)
    detect/spangap_detect.bin ← the peripheral detector (checked in)
    vendor/                   ← esptool-js, JSZip, xterm.js (no runtime CDN)
    builds/
      Makefile                ← `make` builds every image in flashmon.yaml
      hw-<board>.zip          ← one ready-to-flash image per supported board
      generic.zip             ← fallback image for any board without its own
  esp-idf/                    ← source of the detector (NOT served)
    Makefile                  ← `make` builds + stages ../flashmon/detect/…
    main/detect.c, …
  docs/detect.md              ← how each peripheral is identified (NOT served)
  docs/fnb58.md               ← how the FNB58 current graph works (NOT served)
```

Serve the **`flashmon/`** subdirectory (the web root) from anywhere static —
GitHub Pages, an S3 bucket, `python3 -m http.server`, the device's own web
server. Web Serial needs a **secure context**, so serve over HTTPS (or
`http://localhost`).

Deploying is just copying that whole web root to the server (e.g. `rsync` the
`flashmon/flashmon/` directory) — so the **gitignored generated artifacts** ride
along and get served even though they aren't tracked: the branded
`<project>-flashmon` script, `builds/*.zip`, and `offline-installer/`. Run a full
`make` (below) before deploying so they're present.

## What it does when you connect

The page shows its title (**`<project> Flasher`**) and goes straight to the
serial port picker on your first click/keypress (the browser only lets the
chooser open in response to a user gesture; it never silently reuses a
remembered device). Once you pick a device it:

1. **Probes** the chip over the ROM loader (esptool-js) — chip, revision,
   features, flash size — for the monitor banner.
2. **RAM-loads the peripheral detector** (`detect/spangap_detect.bin`) into SRAM
   and jumps to it — **no flash write** — captures its one-shot findings, and
   folds them into the cyan banner (which board, which peripherals). See
   [`esp-idf/`](esp-idf) and [`docs/detect.md`](docs/detect.md).
3. **Resets** the device into its real firmware and opens the **serial monitor**
   on it, so the boot log streams live.
4. **Offers the matching image.** If the detected board has an image in the
   catalogue, a green **Flash `<project>` to `<board>`** button appears (left of
   *Open Device UI* and *Reset*). Pressing it downloads that image, unzips it in
   the browser (JSZip), flashes every image at its offset over Web Serial, then
   reopens the monitor and resets into the freshly-flashed firmware.

### How an image is matched

The detector reports the board as `hw-<straddle>` (e.g. `hw-lilygo-tdeck`). The
button looks for `builds/hw-<straddle>.zip`, trying successively shorter
prefixes (so an unlisted `hw-foo-bar-baz` falls back to a listed `hw-foo-bar`
image), and finally `builds/generic.zip`. If none is published, no flash button appears
— you still get the monitor.

## The monitor

A fullscreen xterm.js terminal, fully interactive — keystrokes are sent to the
device, so its serial line switches to the interactive CLI. Controls float over
it:

- **Flash `<project>` to `<board>`** (green, left) — flash the matched image (see
  above). Only shown when an image is available for the detected board.
- **Open Device UI** (blue) — appears once the device reports it joined WiFi;
  opens `<hostname>.local` (then the IP) in a new tab.
- **Reset** (red, top-right) — hard-resets the attached device on demand.
- **Line settings** (bottom-right, e.g. `115200 N 8 1`) — click to change baud,
  data bits, parity, and stop bits; the port re-opens with the new settings and
  the terminal buffer is kept. Defaults to 115200 N 8 1 (`?monitor_baud=<n>`
  sets the initial baud).
- **FNB58 current graph** (bottom-right, above the line settings) — if you have a
  FNIRSI FNB58/FNB48 USB power meter inline on the device's power, click to graph
  its current draw live across the top of the monitor. It rides **WebHID**
  alongside the serial monitor in the same tab. A row of pills picks the visible
  span (10s / 30s / 1m / 3m / 5m); left unpinned it auto-tracks the smallest span
  that holds all captured samples, starting at 10s. The graph averages and
  interpolates one column per screen pixel (not per sample) so a shared-pixel
  spike doesn't read too high and scrolling doesn't shimmer; the left box shows
  the running average and clears the buffer (back to auto) on click. See
  [`docs/fnb58.md`](docs/fnb58.md) for the HID protocol and rendering. Browser
  only — `flashmon.py` has no equivalent.

A fresh device (no admin password, or falling back to its own AP) is walked
through a one-time setup: a password dialog, then a WiFi-connect dialog, sent to
the device's CLI in one batch.

If the device is powered off or unplugged, the port's permission is retained:
the stream notes `-- Serial port gone --`, and when it reappears (matched by USB
VID/PID) it reconnects automatically with `-- Serial port came back --`.

## The terminal flasher — `flashmon.py`

For people who can't run a Chromium browser, `flashmon.py` does the same flow
from a plain terminal: pick a port, probe the chip, RAM-load the detector, flash
the matching image, then open a full-screen serial monitor. It reads the same
`flashmon.yaml` + `builds/` + `detect/` the browser does — either from a served
deployment or from a local flashmon folder:

```sh
./flashmon.py --url https://<host>/flashmon/   # a served deployment
./flashmon.py --dir flashmon                    # a local flashmon/ folder
```

`make` also writes a **branded** copy of it next to it, named for the project —
`<project>-flashmon` (e.g. `reticulous-flashmon`). It's the identical script with
the deployment's `url:` baked into its `PROJECT_URL`, so a downloaded copy runs
with **no arguments** and already knows where to fetch its config and images.
That branded script is what you serve for a one-line `curl`-and-run, and it's the
entry point inside the offline `<project>-flashmon.zip` bundle (where it finds its
config/images/tool-wheels alongside itself and runs fully offline). Like the
images, it's a gitignored generated artifact (`*-flashmon`), not tracked source.

## Configuration — `flashmon/flashmon.yaml`

flashmon is a **generic installer**: it ships no committed config, so anyone can
run it and brand it as their own. To make it yours, copy the template and edit
it — every `.yaml` here is **gitignored**, so your config never lands upstream:

```sh
cp flashmon/flashmon.yaml.example flashmon/flashmon.yaml   # then edit it
```

The page fetches it at boot; it sets the **brand** and the **catalogue**:

```yaml
project: Reticulous              # shown in the title, the flash button, the
                                 # default device hostname
builds:
  - name: hw-lilygo-tdeck        # matched against the detected hw-<straddle>
    invocation: reticulous/reticulous --with spangap/hw-lilygo-tdeck
  - name: generic                # fallback for any board without its own image
    invocation: reticulous/reticulous
```

Each entry names an image and gives the `spangap build` invocation that produces
it. A `flashmon/flashmon.local.yaml` (also gitignored) is preferred over
`flashmon.yaml` when present, for a per-machine override without touching your
own file.

## Producing the images — `flashmon/builds/`

From inside the spangap workspace this repo is checked out in:

```sh
cd flashmon/builds && make                             # every image + branded script + offline bundle
cd flashmon/builds && make images                      # every image, no bundle
cd flashmon/builds && make images BUILD=hw-lilygo-tdeck # rebuild just one image (an image name)
```

`make` runs `make-builds.py` (a directory up), which builds each catalogue entry
in the spangap container via `spangap build` (no local ESP-IDF needed), writes each
`flasher.zip` to `builds/<slug>_<name>_<datetime>.zip`, and records that datetime as
the entry's `version:` in `flashmon.yaml` — so the flasher fetches exactly what's on
disk, and a subset rebuild re-stamps only the images it rebuilt. The offline bundle
covers the whole catalogue, so it only comes from a full `make` (a `BUILD=` subset is
refused). The zips are **gitignored build artifacts** (only `builds/Makefile` is
tracked) — produce them here before you serve or deploy the page (see the CI
workflow, which builds them and uploads them as a downloadable artifact).

`make` also packages a self-contained **offline installer** — the flasher, images and
flashing tools bundled into one cross-platform zip (for people who can't use a
Chromium browser) — into `offline-installer/`, alongside a small `index.html` that
offers it for download. `make-zip` rebuilds that directory each run and swaps it in
wholesale, so only the latest bundle is kept; serve it at `/offline-installer/`. It's
a gitignored build artifact.

## Producing the detector — `esp-idf/`

The peripheral detector is a small ESP32-S3 RAM app. Rebuild it after changing
`esp-idf/main/detect.c`:

```sh
cd esp-idf && make              # builds in the container, stages ../flashmon/detect/…
```

By default the compile runs in the spangap container (`spangap detect-build`),
so **no local ESP-IDF is needed**. `make LOCAL=1` uses an ESP-IDF already on
your PATH. The `esp-idf/build/` directory is **not** checked in; the staged
`flashmon/detect/spangap_detect.bin` is. See [`esp-idf/README.md`](esp-idf/README.md).

## Vendored dependencies (no runtime CDN)

Everything runs from `flashmon/vendor/` — nothing is fetched from a third-party
CDN at runtime. Pinned versions are in `vendor/VERSIONS.txt`:

- `esptool-bundle.js` — [esptool-js](https://github.com/espressif/esptool-js)
  (self-contained ESM bundle; pako inlined).
- `jszip.min.js` — [JSZip](https://github.com/Stuk/jszip).
- `xterm.js` + `xterm.css` + `xterm-addon-fit.js` —
  [xterm.js](https://github.com/xtermjs/xterm.js) (the serial monitor).

To update, re-fetch the pinned files and bump `VERSIONS.txt`.

## Browser support

Web Serial is Chromium-only (Chrome, Edge, Opera, Brave) on desktop. Firefox and
Safari don't support it. The FNB58 current graph needs **WebHID**, same
Chromium-only story; where it's missing the feature just stays off and the rest
of the monitor works.
