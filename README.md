# flashmon

A tiny, static, browser-based firmware **flasher + serial monitor** for spangap
devices. Point a Chromium browser at it, plug in a device over USB, and it drops
into an interactive serial monitor without touching the device; one button then
identifies the board and offers the right firmware image to flash — no install,
no toolchain.

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
    devices/                  ← board photos for the device box (optional)
    vendor/                   ← esptool-js, JSZip, xterm.js (no runtime CDN)
    builds/
      Makefile                ← `make` builds every image in flashmon.yaml
      hw-<board>.zip          ← one ready-to-flash image per supported board
      generic.zip             ← fallback image for any board without its own
  esp-idf/                    ← source of the detector (NOT served)
    Makefile                  ← `make` builds + stages ../flashmon/detect/…
    main/detect.c, …
  docs/detect.md              ← how each peripheral is identified (NOT served)
  docs/serial.md              ← how the monitor session survives the device
                                re-enumerating or moving its console (NOT served)
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
remembered device). Once you pick a device it opens the port, shows the **serial
monitor**, and immediately **resets the device and identifies it** — the same
detection run the *Detect Hardware* button performs, described below. What it
found is then shown in the **device box** over the terminal: the board and its
photo, the chip facts, the peripherals, where the device keeps its own data, and
which firmware it is running. **OK** dismisses it and leaves the monitor in its
normal state — including the green *Flash* button, if the catalogue has something
newer than what the device already runs.

Add **`?noreset`** to the URL to keep the device untouched: the port is opened
and the monitor watches, the device is not probed and not reset, whatever it is
doing keeps running, and identifying the board waits for the button (or for the
boot log to say it). Reach for it when the device is doing something you don't
want interrupted.

Everything past that is board-specific, so it waits until the board is known. The
board is identified either way round:

- **From the log, for free.** spangap-core logs `build: invocation spangap build
  … --with spangap/hw-<board>` on boot — the `spangap build` command the running
  image was compiled with. The `hw-<board>` in it names the board, so a device
  that boots (or is reset) while the monitor is open identifies itself with no
  probe at all.
- **From the hardware.** This is the run that fires on connect, and a green
  **Detect Hardware** button repeats it on demand — it sits where the flash
  button goes (left of *Open Device UI* and *Reset*), and appears whenever the
  board is still unknown (after a `?noreset` connect, or a run that found
  nothing). It **probes** the chip over the ROM loader (esptool-js — chip, revision, features,
  flash size), **RAM-loads the peripheral detector**
  (`detect/spangap_detect.bin`) into SRAM and jumps to it (**no flash write**),
  captures its one-shot findings into the cyan banner (which board, which
  peripherals), then **resets** the device back into its real firmware. See
  [`esp-idf/`](esp-idf) and [`docs/detect.md`](docs/detect.md). This reads the
  actual hardware, so it outranks the log's claim about the image.

Once the board is known, that same green slot turns into **Flash `<project>` to
`<board>`** if the catalogue holds a newer image for it. Pressing it downloads
that image behind a progress box over the terminal (bytes fetched of the
`Content-Length`, then the unpack), unzips it in the browser (JSZip), flashes
every image at its offset over Web Serial, then reopens the monitor and resets
into the freshly-flashed firmware. The download happens with the monitor still up
and the device still running, so a fetch that fails costs the session nothing.

### How an image is matched

The board is named `hw-<straddle>` (e.g. `hw-lilygo-tdeck`) whichever way it was
identified. The button looks for `builds/hw-<straddle>.zip`, trying successively
shorter prefixes (so an unlisted `hw-foo-bar-baz` falls back to a listed
`hw-foo-bar` image), and finally `builds/generic.zip`. If none is published, or
the published image is no newer than the running firmware's build stamp, no flash
button appears — you still get the monitor.

### When flashing would erase the device's data

A **Detect Hardware** run also reports the device's `state` partition — the
LittleFS store holding its settings, keys and files (see
[`docs/detect.md`](docs/detect.md)). Before writing anything, the flash compares
the image's own offsets against it: flash erases in 4 KB sectors, so an image is
counted as reaching into the store if the sectors it erases touch it at all. The
margin is real — a current tdeck image ends its last segment exactly at the
`0x800000` store boundary — so a firmware that grows, or a device whose store sits
lower, lands inside it.

When it does, a **warning dialog** names the store (address and size) and the
range the image writes inside it, and offers **Cancel** or **Erase and flash**.
The image is fetched and checked while the monitor is still open and the device
still running, so cancelling costs the session nothing — nothing has been written,
and the monitor carries on. Without a detection run there is nothing to compare
against and no warning is raised, since the boot log never states where the store
is. `flashmon.py` makes the same check and asks the same question on the terminal.

### Flashing survives a background tab

A flash — download, write and the monitor re-open that follows — and a detect run
keep going at full speed while their tab is hidden: switch tabs, minimise the
window, walk away. That takes work, because Chrome
throttles `setTimeout` in a hidden tab to one call per second, and to about one
per minute once it has been hidden five minutes; esptool-js waits for every
serial response by polling its receive buffer on a 1 ms timer, so an unaided
flash would crawl and then die on its own command timeouts. For the length of a
run, flashmon routes the global `setTimeout` through a dedicated worker — worker
timers are exempt from the throttling — and puts the native one back afterwards.
It is the browser's own throttling that is sidestepped, not the machine's: a
laptop that suspends still suspends the flash.

## The monitor

A fullscreen xterm.js terminal, fully interactive — keystrokes are sent to the
device, so its serial line switches to the interactive CLI. Controls float over
it:

- **Detect Hardware** (green, left) — identify the board (see above). Shown while
  the board is unknown; it costs the device a reset.
- **Flash `<project>` to `<board>`** (green, same slot) — flash the matched image
  (see above). Replaces *Detect Hardware* once the board is known and a newer
  image is available for it.
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
  the running average and clears the buffer (back to auto) on click. Current is
  kept at the meter's full 0.01 mA resolution; readouts below 20 mA show one
  decimal. It never grabs the meter on its own — only your click opens the panel,
  which pops the HID chooser to pick the meter, every time: a grant is never
  reused, and one left over from an earlier session is revoked rather than
  silently opened. These units are fragile: they have no stop command and
  **freeze if the connection is closed while their internal FIFO is full** (a
  documented FNIRSI quirk), which then crashes the next session — so on
  disconnect flashmon **drains the FIFO** (keeps reading ~1 s with the keepalive
  stopped) before closing, backed by a short settle cooldown during which the
  FNB58 button is hidden. One shared LocalSettings timestamp drives that cooldown
  and also keeps two tabs off the same meter. If a meter does freeze anyway,
  unplug/replug it. See [`docs/fnb58.md`](docs/fnb58.md) for the HID protocol and
  rendering. Browser only — `flashmon.py` has no equivalent.

A fresh device (no admin password, or falling back to its own AP) is walked
through a one-time setup: a password dialog, then a WiFi-connect dialog.

Those commands go out over the **framed console channel** on firmware that
offers it — announced by the `serial: framed rpc v1` marker at boot, or
established by a single recoverable probe when this session attached too late to
see it (see [framed-rpc.md](../spangap-core/docs/framed-rpc.md)). Framed, they
are never
echoed, never enter the device's line editor and never flip its console into CLI
mode, so setup can't collide with whatever you are typing and each command is
answered rather than hoped for — the terminal shows `-- setup sent --`, not a
replayed transcript of the commands. Without the marker they are typed at the
console in one batch, exactly as before.

Which dialogs open is still decided from the boot log here; only the sending is
framed. `flashmon.py` pulls that state with queries too.

### A tab only ever opens ports you picked

**A browser tab opens the ports you handed it in the chooser, and no others.**
It never reaches for one you did not pick. That matters as soon as there is more
than one board on the desk, because a page cannot tell them apart — Web Serial
gives it the USB vendor and product ids and nothing else, so three identical
boards are one identity, and a tab that goes looking for "a port that looks like
mine" is picking at random among them. Getting that wrong swaps two tabs'
consoles with nothing on screen to say so.

A tab keeps **at most two** of them, which is all a device can present it: the
USB-Serial-JTAG port it boots on, and the two-port CDC device `usb cdc` moves it
to. A third pick replaces the oldest.

The session outlives the port under it. A device powered off, reset, or reflashed
keeps its port: the stream notes `-- <transport> gone --`, a background loop
retries the tab's own ports, and reconnecting says `-- <transport> came back --`
into the same scrollback. **A port going away never pops a dialog** — ports go
away on every reset and almost always come straight back, so interrupting you
would be wrong far more often than right.

Two things end an outage differently:

- The device **says** it is moving its console (`usb cdc` / `usb jtag`, which
  swap it between two different USB devices). That is the one departure known
  not to be a blip. flashmon still gives recovery three seconds first — if the
  tab already holds the port being moved *to*, the move completes in silence —
  and only then shows **Console moving to a new port**, whose chooser is
  filtered to the new device's two ports. Take the **first**; that is the
  console. So you are asked on the first move only; every one after that is
  free, in both directions.
- Half a minute of nothing at all, usually because the board was unplugged and
  replugged and is now a *different* port to the browser. An amber **Re-select
  port** button appears in the monitor and waits — no modal, and the loop keeps
  trying the old port in the background in case it simply comes back.

See [`docs/serial.md`](docs/serial.md) for the full mechanism and the notice
vocabulary.

Nothing here can name the board for you: the readable string the chooser shows
(`USB JTAG/serial debug unit`, `FNB-58`) comes from the device's own USB
descriptors and is never handed to the page. On USB-Serial-JTAG that string is
fixed in the ESP32-S3's ROM. A device switched to CDC advertises its **hostname**
there instead — see
[spangap-core's usb-console](../spangap-core/docs/usb-console.md). Once a session
is open, the hostname in the monitor's title bar is what identifies the board.

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

### How it learns about the device

`flashmon.py` **asks** the device rather than scraping its boot log. Firmware
that supports it prints one marker line very early in boot —
`serial: framed rpc v1` — after which flashmon runs ordinary CLI commands over a
framed side-channel on the same console port and reads exactly their output:
`show sys.build` for the running image's identity, `show sys.flash` for the
board's real flash geometry, `auth -O` for the password state, `net -O` for the
WiFi state and IP, `net scan -O` for the networks in range. Provisioning goes out the same way, so it can't collide with someone
typing at the CLI and each command has a reply to confirm against. The frames
are swallowed out of the byte stream, so the log and the interactive CLI look
exactly as they always did. The wire format is
[spangap-core/docs/framed-rpc.md](../spangap-core/docs/framed-rpc.md), the
`key=value` replies are
[onboarding-output.md](../spangap-core/docs/onboarding-output.md).

Attaching to an already-running device misses the marker, so before it first
needs frames flashmon probes once; the probe is answered on firmware that speaks
them and undone with a Ctrl-C on firmware that doesn't. If neither the marker
nor the probe lands, flashmon knows nothing about the device beyond what esptool
read off the chip. It stays a monitor and a
flasher: it still offers an image (an unknown build has nothing to compare
against), and there is nothing to set up, because a device old enough not to
speak frames has long since been through setup. What such a device costs is its
web-UI address — F8 opens the default `<project>.local` rather than its real
hostname, until it is flashed and reboots. Nothing is inferred from log text, so
nothing can be inferred wrongly.

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
    image: devices/hw-lilygo-tdeck.jpg   # optional: photo for the device box
    invocation: reticulous/reticulous --with spangap/hw-lilygo-tdeck
  - name: generic                # fallback for any board without its own image
    invocation: reticulous/reticulous
```

Each entry names an image and gives the `spangap build` invocation that produces
it. A `flashmon/flashmon.local.yaml` (also gitignored) is preferred over
`flashmon.yaml` when present, for a per-machine override without touching your
own file.

`image:` is the board's **photo**, shown in the device box when a detection run
identifies that board — a path in the web root (`devices/<board>.jpg` by
convention; see [`flashmon/devices/`](flashmon/devices)), never a remote URL,
since nothing here loads from a CDN. It is optional both ways: an entry without
one, a board with no catalogue entry at all, or a file that 404s just leaves the
box text-only.

`make` fills in three more fields per entry, which you never hand-edit:
`version:` (the run stamp), `flash_floor_kb:` (the minimum chip size the image
needs) and `image_bytes:` (what it writes). The entry's `name:` is also its
**distribution identity** — the device reports it back as `sys.build.dist`, so a
re-flash offer means "same dist, newer stamp". That is why identity lives in
`name` and ordering in `version`: `name` is free-format, so a board can have
several entries differing in what is left out to fit its flash, while `version`
is a sortable stamp that answers whether something newer exists. The floor is
what lets flashmon say an image won't fit a board *before* downloading it.

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
disk, and a subset rebuild re-stamps only the images it rebuilt. It also exports
the entry's name as `SPANGAP_BUILD_DIST` (which the image reports back as
`sys.build.dist`) and records the fit numbers `flash_floor_kb:` and
`image_bytes:`, read out of the `sdkconfig` and `flasher.zip` that build just
produced — no `spangap build` change, just a read of config the build already
wrote. The offline bundle
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
