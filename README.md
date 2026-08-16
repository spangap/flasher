# flashmon

A tiny, static, browser-based firmware **flasher + serial monitor** for spangap
devices. Point a Chromium browser at it, plug in a device over USB, and it drops
into an interactive serial monitor without touching the device, asks it which
board it is, and offers the right firmware image to flash — no install, no
toolchain.

It brands itself from the catalogue it serves (`builds/<catalogue>/builds.yaml`),
so a deployment reads as its own product (e.g. **Reticulous**) rather than
"flashmon".

## Layout

The page and the images it offers are **two sibling directories**, and the page
reaches the catalogue at the relative `../builds/<catalogue>/`. That holds in a
deployment and under `spangap dev` alike, so there is no base URL to configure.

```
<workspace>/
  flashmon/                     ← this repo
    builds.yaml.example         ← template catalogue config (checked in)
    flashmon/                   ← everything served to the browser (the web root)
      index.html
      flashmon.js
      flashmon.py               ← single-file terminal flasher (for non-browser users)
      <project>-flashmon        ← branded copy of flashmon.py (gitignored artifact)
      detect/spangap_detect.bin ← the peripheral detector (checked in)
      devices/                  ← board photos for the device window (optional)
      vendor/                   ← esptool-js, JSZip, xterm.js, web-serial-polyfill
                                  (no runtime CDN)
    esp-idf/                    ← source of the detector (NOT served)
      Makefile                  ← `make` builds + stages ../flashmon/detect/…
      main/detect.c, …
    docs/detect.md              ← how each peripheral is identified (NOT served)
    docs/serial.md              ← how the monitor session survives the device
                                  re-enumerating or moving its console (NOT served)
    docs/fnb58.md               ← how the FNB58 current graph works (NOT served)
  builds/                       ← the catalogues (untracked; `spangap make-builds`)
    index.html                  ← the catalogues, minus any marked `.unlisted`;
                                  the Build selector's options
    stable/                     ← the catalogue in force until something names
                                  another; see "Which catalogue" below
      builds.yaml               ← the brand + what to compile
      index.html                ← the images that exist, and at which stamp
      timestamp                 ← the newest stamp here; polled by the page
      <slug>_<board>_<stamp>.zip
      <slug>_generic_<stamp>.zip  ← fallback for a board without its own image
```

Serve **`flashmon/flashmon/`** and **`builds/`** as siblings from anywhere static
— GitHub Pages, an S3 bucket, `python3 -m http.server`, the device's own web
server. Reaching a USB device from a page needs a **secure context**, so serve
over HTTPS (or `http://localhost`) — a phone on the LAN has no localhost
exemption, so testing from one means real HTTPS.

`<host>/flashmon` works with or without the trailing slash. Without it the
document's base is the parent directory, which would send every relative URL in
the page one level too high; most servers redirect a directory URL onto its slash
and settle it, and the page pins its own base for the servers that don't.

Deploying is copying both directories to the server (e.g. `rsync` them) — so the
**untracked generated artifacts** ride along and get served even though they
aren't tracked: the whole `builds/` tree, and the branded `<project>-flashmon`
script. Run `spangap make-builds` (below) before deploying so they're present.

Under `spangap dev` neither is copied anywhere: the dev server mounts both
straight out of the workspace, at the same two paths.

## What it does when you connect

The page shows its title (**`<project> Flasher`**) and goes straight to the
serial port picker on your first click/keypress (the browser only lets the
chooser open in response to a user gesture; it never silently reuses a
remembered device). Once you pick a device it opens the port, shows the **serial
monitor** — and the device **says which board it is**, unasked.

```
browser -> device   <CR>                        (the console sync it already sends)
device  -> browser  Spangap console on serial jtag. Start typing to enter CLI
device  -> browser  build: hw hw-lilygo-tdeck
device  -> browser  build: catalogue stable
device  -> browser  build: datetime 20260814130700
```

That is the whole identification, and nothing was interrogated to get it.
Opening the port already sends the console a bare CR — that is how flashmon
confirms the port it opened is the console at all — and spangap answers it by
restating who it is: the same three lines it printed at boot. flashmon's ordinary
log parser reads them.

The board in `build: hw` is not a claim about the image. It is what the board
straddle's own `detect_hw()` read off the hardware at the top of that boot,
checked against the board the image was built for — spangap halts rather than run
on a board it does not recognise (see [`docs/detect.md`](docs/detect.md)). So it
is exactly what a detection run would find, arriving for free.

**Why the device volunteers it rather than answering a query.** A boot happens
once and almost nobody watches it. A device that announced itself only then, to
an empty room, forced every tool that turned up later to interrogate it — over a
side-channel that has to be probed for, may not be armed, and cannot be relied on
in the moment a port opens. Saying it again to whoever shows up costs three lines
and removes that channel entirely.

Only a device that says **nothing** gets probed: firmware too old to answer a CR
with its identity, or none at all. Then the connect falls back to the detection
run below.

What is known either way is shown in the **device window** over the terminal: the
board and its photo, where the device keeps its own data, which firmware it is
running, and what the catalogue has for it — plus the chip facts and peripherals
when a detection run read them. The catalogue part arrives a few seconds later
with the device's build stamp, and the window repaints around it; the flash is
offered **in the same window**, under the facts it follows from.

Tick **No reset** in the settings panel (the gear, top right) to stop before the
fallback probe: the port is opened, the monitor watches, the device is asked
(which costs it nothing) and never reset. Reach for it when the device is doing
something you don't want interrupted.

### Reading the board off the chip

**Detect hardware**, in the settings panel, is the run for a device that cannot
answer for itself. It **probes** the chip over the ROM loader (esptool-js — chip,
revision, features, flash size), **RAM-loads the detector**
(`detect/spangap_detect.bin`) into SRAM and jumps to it (**no flash write**),
captures which board and which peripherals it found, then **resets** the device
back into its real firmware. The detector is every board straddle's own
`detect_hw()`, copied in and run in turn — the same function the firmware uses to
confirm itself. See [`esp-idf/`](esp-idf) and [`docs/detect.md`](docs/detect.md).

It also reports the device's **state partition**, which the firmware never states
and which the flash-overlap warning below needs.

Once the board is known, whatever the catalogue holds for it is **offered in the
device window**, and that window is the only place a flash is started from —
there is no flash button parked at the top of the screen. The facts already on
it *are* the decision (which board, which image, which catalogue, the stamp it
runs against the stamp on offer), so the offer is a green **Flash** under them
rather than a second dialog restating them.

An image that is **not** an upgrade is offered too, since a re-flash of what is
already there — or a step back to an older build, or a switch to another
catalogue — is a thing you do on a bench. It just says so: an amber warning names
which of the two it is (same build, or older than what runs), and the button
reads **Flash anyway**.

The window opens **once per published image**: when a connect settles, and again
when a build lands while the page is open — that second one with whatever facts
are to hand, which after a *No reset* connect is the board and stamp off the boot
log and no chip probe. If it is already up when the offer resolves, nothing
moves: the button simply appears under what you are reading. *Not now* is a full
answer until the next image. With **Auto-flash** ticked in the settings panel a
**newer** image doesn't wait to be asked about at all — it starts flashing
itself, once per image, which is what makes a tab left open on a bench keep a
board current.
Auto-flash never fires on an image that isn't newer; walking a device backwards
is always a deliberate click.

Going ahead downloads that image behind a progress box over the terminal (bytes
fetched of the `Content-Length`, then the unpack), unzips it in the browser
(JSZip), flashes every image at its offset over Web Serial, then reopens the
monitor and resets into the freshly-flashed firmware. The download happens with
the monitor still up and the device still running, so a fetch that fails costs
the session nothing.

### Which catalogue

Images come from one catalogue at a time, and four things get a say — each
outranking the one before it:

1. **`stable`**, when nothing else has anything to say.
2. **The attached device.** spangap-core logs `build: catalogue <name>` on boot —
   the catalogue the running image was published from (`sys.build.catalogue`,
   baked in by `spangap make-builds`). The page moves there, so a board flashed
   from `dev` is compared against `dev` and not against a `stable` series it has
   nothing to do with. Stamps from two catalogues are unrelated numbers, so an
   image from a catalogue the device didn't come from is always offered, never
   called "newer".
3. **`?build=<name>`** in the URL, which pins the choice for that load.
4. **The Build selector** in the settings panel. Its options are the catalogues
   `builds/index.html` lists, plus the one in force and the one the device named
   — either can be `.unlisted`. **- other -** takes a name that is served but
   listed nowhere. Picking one pins it: the next device's own catalogue no longer
   moves the page.

Switching catalogue re-reads everything, re-brands the page from the new
catalogue's `project:`, and offers what the new catalogue holds for the attached
board.

### How an image is matched

The board is named `hw-<straddle>` (e.g. `hw-lilygo-tdeck`) whichever way it was
identified. The catalogue's `index.html` says which images exist and at which
stamp, so the page looks up `hw-<straddle>` there, trying successively shorter
prefixes (so an unlisted `hw-foo-bar-baz` falls back to a listed `hw-foo-bar`
image), and finally `generic`. If none is published there is nothing to offer —
you still get the monitor.

The catalogue is re-read while the page is open: every 15 s it fetches
`timestamp` (one small request), and only when that value moves does it re-read
`index.html` and re-evaluate the offer. So an image published from a build run
next to it is picked up within seconds, with no reload and no polling of anything
large.

### When flashing would erase the device's data

A **Detect hardware** run also reports the device's `state` partition — the
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

- **Open Device UI** (blue) — appears once the device reports it joined WiFi;
  opens `<hostname>.local` (then the IP) in a new tab.
- **Reset** (red) — hard-resets the attached device on demand.

Neither flashing nor identifying is among them. The flash is offered in the
device window (above), beside the stamps the decision rests on; identifying is a
settings-panel action, because a running device answers for free and the run is
only for the ones that cannot.

**One terminal in the container, always.** A monitor that throws part-way
through opening has already put its terminal on screen, and every caller answers
a failed open by opening again — so a failed open takes its own terminal down
with it. Two terminals in one container is two cursors and two hidden input
boxes, with the keystrokes going to whichever was built last.

### On a touch screen

The characters a soft keyboard produces reach a page through composition events
that a hidden textarea sitting at a terminal cursor was never really built for,
and a console nobody can type into is not a console. So a touch screen gets a
**line of input of its own** under the terminal: type a line, Enter sends it with
a carriage return, and the terminal above shows the device's echo. **`^C`** sits
beside it, because a soft keyboard has no way to produce one and a CLI that
cannot be interrupted is a CLI you can get stuck in.

Focusing the terminal raises the on-screen keyboard, so on a coarse pointer the
terminal is focused by a **tap on it** and by nothing else — never by the page
deciding a session is ready. On any device, a dialog on screen both blocks a
focus and takes one back: the terminal is behind it, and a terminal holding the
focus is a keyboard covering the dialog that just opened.

The keyboard shrinks the visual viewport and leaves the layout one alone, so a
fixed full-height element keeps its full height *behind* the keyboard — and the
bottom of a terminal is the part being read. Everything fixed to the window is
sized or offset to the visual viewport instead (`--vv-top` / `--vv-height`,
tracked from script): the monitor, the dialogs, the gear and its panel. The
terminal reflows to fewer rows with its last line just above the keyboard, a
dialog re-centres in the band that is left, and the gear stays beside the action
buttons rather than scrolling off while they stay put. A refit that loses rows
keeps the bottom on screen, unless the session was scrolled back to read
something older.

Everything else lives behind the **gear** (top right, a white-on-black button the
same height as the ones beside it, on screen from the first paint — these matter
before a port is picked as much as during a session):

- **Re-select port** — for a board that came back as a *different* port to the
  browser. Always there; nothing has to go wrong for it to appear.
- **Detect hardware** — reset the device and read the board off the chip
  (above). Disabled with no port to run it on, and for the length of a run.
- **Build** — which catalogue images come from (see *Which catalogue* above).
  Not stored by *Set as defaults*: it follows the attached device until you pick
  one, and a pick holds for the rest of the session.
- **Line settings** (baud, data bits, parity, stop bits) — *Apply* re-opens the
  port with them and keeps the terminal buffer. Defaults to 115200 N 8 1
  (`?monitor_baud=<n>` sets the initial baud). Hidden entirely when the port is
  the chip's own USB (vendor `0x303A` — USB-Serial-JTAG or a native CDC
  console), where the console rides USB packets and the line rate is a number
  nobody reads.
- **No reset** — open the monitor without resetting or identifying (above).
- **Auto-flash** — flash a newer image for the attached board as soon as one is
  published, without asking in the device window (above). Newer only.
- **Delete stored wifi and node passwords** — forget the setup answers this
  browser was told to reuse (above), so the next fresh device is asked again.
  Disabled while nothing is stored, so the button also says whether this browser
  is holding any.
- **Set as defaults** — store the panel's current state, so the page loads with
  it next time. Until it's pressed, a change applies to this tab only.
- **FNB58 current graph** — if you have a
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

### Setting up a fresh device

A fresh device — no admin password, or falling back to its own AP — is walked
through a one-time setup: a **password**, a **hostname**, a **WiFi network**,
then (where the device has them to give) the **LoRa radio** and a **name on the
mesh**. Each is settled before the next opens, and everything chosen goes to the
device in one batch at the end. Every dialog can be skipped; the rest still runs.

The last two have no boot line to watch — "this radio was never given a
frequency" and "there is no identity yet" are states, not events — so they are
asked for over the framed channel once the earlier questions are settled:
`show s.lora.0.enable`, `show s.lora.0.frequency`, `show s.lora.0.SUPE.enable`,
`show s.lxmf.id.0.label`, `show s.lxmf.version`. One key per query, never a
subtree: a reply frame is length-counted while the device's log echo reaches the
same wire on its own path, so a log line that lands inside a frame is
unrecoverable for this side — and the wider the frame, the wider that window.
A `(no matches)` reply is how an absent straddle, an absent key and an unset
value stay distinguishable with no new firmware verb. Firmware that doesn't
speak frames is left alone: it can't be asked, so it isn't guessed at and
neither dialog opens.

The **LoRa** dialog is one window: the frequency in MHz (set large — it is the
one value that gets read back and compared against another node's), then
spreading factor, bandwidth and coding rate, which every node on a mesh has to
agree on. **Enable SUPE** appears only on a build that carries SUPE, which the
page knows because the key exists. Its OK is the only thing that switches the
radio on (`s.lora.0.enable`) — a skipped dialog leaves it off rather than on a
frequency nobody confirmed.

Two of those three answers are the same on every node you set up, so either
dialog can be told to keep its answer for the next one:

- **Set this password on all new nodes**, in the password dialog. Every later
  device that reports no admin password gets it without asking, and the dialog
  doesn't open again.
- **Set this wifi password whenever this AP is visible**, in the WiFi dialog.
  The SSID and its password are kept together, and any number of them can be. A
  device that falls back to its own AP is given the first remembered network its
  own scan actually saw — a stored network out of range says nothing about where
  this node belongs — and the dialog doesn't open. When none is in range it
  opens as usual.

Both are held in the browser's LocalSettings for this deployment, and the
settings panel's **Delete stored wifi and node passwords** wipes both. A skipped
dialog is never silent about it: the monitor says which stored answer was used
(`-- using the stored node password --`, `-- using the stored network "…" --`)
before the batch goes out.

The **hostname** is never remembered: it is the one answer that is about this
node, and `<hostname>.local` is how its web UI is reached. That is why it has its
own dialog rather than a field in the WiFi one — with the other two answered from
storage, naming the node is the whole of setting it up, and it still gets asked
when the network beside it doesn't. The **name on the mesh** is the same kind of
answer and is asked last, prefilled from the hostname.

### When the device sets itself up

A build can say it does its own onboarding, and then this page does none. Three
things say it, and any one is enough:

- **The device, on every boot** — `setup: on-device` in the log, which describes
  the build rather than the boot. It arrives during the init walk, so a session
  that watched the boot start has it in hand before the walk ends.
- **The catalogue**, for an image about to be written: an entry marked
  `onboarding: device` (see *Configuration* below) rides into the listing as
  `data-onboarding` on that image's link. Flashing such an image ends this
  session's part in setup before the device has even booted.
- **The device, asked** — `show s.onboard.done`, whose key exists only in a build
  carrying on-device setup. This is the one for a session that attached
  mid-flight and so never saw the marker go by.

**A watched boot waits for `spangap ready` before anything is asked.** The
device's own onboarding registers near the *end* of the init walk while
"No device password set" comes out near the beginning, so acting on the early
line is exactly how a dialog opens ten seconds before the device says it never
needed one. Waiting costs a few seconds of a boot nobody is typing into, and
takes every frame this page sends out of the busiest part of it.

Two surfaces asking for the same password at the same moment is a race whose
winner nobody can predict, and a board with a panel in the operator's hands is
the better of the two. An unmarked image is the flasher's to set up, which is the
safe default: a build that cannot ask for itself and is never asked is a node
nobody set up.

Those commands go out over the **framed console channel** on firmware that
offers it — announced by the `serial: framed rpc v1` marker at boot, or
established by a single recoverable probe when this session attached too late to
see it (see [framed-rpc.md](../spangap-core/docs/framed-rpc.md)). Framed, they
are never
echoed, never enter the device's line editor and never flip its console into CLI
mode, so setup can't collide with whatever you are typing and each command is
answered rather than hoped for — the terminal shows `-- setup sent --`, not a
replayed transcript of the commands. Without the marker they are typed at the
console in one batch.

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

An outage has no timeout, either: the loop holds the port and its grant and keeps
retrying, quietly, for as long as it takes. A board can sit unpowered for an
afternoon and still be the same board when it comes back. One thing ends an
outage differently:

- The device **says** it is moving its console (`usb cdc` / `usb jtag`, which
  swap it between two different USB devices). That is the one departure known
  not to be a blip. flashmon still gives recovery three seconds first — if the
  tab already holds the port being moved *to*, the move completes in silence —
  and only then shows **Console moving to a new port**, whose chooser is
  filtered to the new device's two ports. Take the **first**; that is the
  console. So you are asked on the first move only; every one after that is
  free, in both directions.

The one thing the loop cannot solve on its own is a board that returns as a
*different* port object — nothing about it says it is the same board. **Re-select
port**, in the settings panel, is the answer, and it is on screen the whole time
rather than being announced after some interval that would only ever be a guess.

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
the matching image, then open a full-screen serial monitor.

> `flashmon.py` still expects the catalogue inside the web root
> (`flashmon.yaml` + `builds/`) and reads `flasher_args.json` out of an image
> zip. Both moved — the catalogue to `../builds/<catalogue>/`, the flashing
> instructions to the `<project>.esptool` argfile in the zip — so it needs its
> own pass before it works against a current deployment. The browser flasher is
> unaffected.

It reads the same config + images + `detect/` the browser does — either from a
served deployment or from a local flashmon folder:

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

`flashmon.py make-brand` writes a **branded** copy of it next to it, named for the project —
`<project>-flashmon` (e.g. `reticulous-flashmon`). It's the identical script with
the deployment's `url:` baked into its `PROJECT_URL`, so a downloaded copy runs
with **no arguments** and already knows where to fetch its config and images.
That branded script is what you serve for a one-line `curl`-and-run, and it's the
entry point inside the offline `<project>-flashmon.zip` bundle (where it finds its
config/images/tool-wheels alongside itself and runs fully offline). Like the
images, it's a gitignored generated artifact (`*-flashmon`), not tracked source.

## Configuration — `builds/<catalogue>/builds.yaml`

flashmon is a **generic installer**: it ships no committed config, so anyone can
run it and brand it as their own. Its config lives with the images it describes,
in the untracked `builds/` tree beside this repo — so your config and your
catalogue travel together, and neither lands upstream:

```sh
mkdir -p ../builds/stable
cp builds.yaml.example ../builds/stable/builds.yaml   # then edit it
```

`stable` is the catalogue the page starts on; a device's own
`build: catalogue`, `?build=<name>` and the panel's Build selector each move it
(see *Which catalogue* above), which is how a bleeding-edge or
customer-specific catalogue sits beside the public one on one deployment. A
catalogue directory holding a file named `.unlisted` still builds and is still
reachable by name — it is only left out of `builds/index.html`, and so out of the
selector's list until a device or a hand names it.

The page fetches it at boot; it sets the **brand** and the **catalogue**:

```yaml
project: Reticulous              # shown in the title, the flash offer, the
                                 # default device hostname
builds:
  - name: hw-lilygo-tdeck        # matched against the detected hw-<straddle>
    image: devices/hw-lilygo-tdeck.jpg   # optional: photo for the device window
    onboarding: device           # optional: it has a screen and asks for itself
    invocation: reticulous/reticulous --with spangap/hw-lilygo-tdeck
  - name: generic                # fallback for any board without its own image
    invocation: reticulous/reticulous
```

Each entry names an image and gives the `spangap build` invocation that produces
it.

`onboarding: device` on an entry says that image sets a fresh node up from its
own screen, so the flasher asks for nothing after writing it (above). It reaches
the page through the generated `index.html`, as `data-onboarding` on that image's
link — an attribute rather than a comment, because a comment is only ever *near*
the row it is about while an attribute is part of it: one parser pass reads the
href and the facts together and nothing can separate them.

`image:` is the board's **photo**, shown in the device window when a detection run
identifies that board — a path in the web root (`devices/<board>.jpg` by
convention; see [`flashmon/devices/`](flashmon/devices)), never a remote URL,
since nothing here loads from a CDN. It is optional both ways: an entry without
one, a board with no catalogue entry at all, or a file that 404s just leaves the
box text-only.

Nothing writes this file — it is entirely hand-written. What was built, and when,
is in the `index.html` beside it: the images are named
`<slug>_<name>_<stamp>.zip`, so the listing carries both the identity and the
ordering. The entry's `name:` is the image's **distribution identity** — the
device reports it back as `sys.build.dist`, so a re-flash offer means "same dist,
newer stamp". That is why identity lives in `name` and ordering in the stamp:
`name` is free-format, so a board can have several entries differing in what is
left out to fit its flash, while the stamp answers whether something newer
exists.

## Producing the images — `spangap make-builds`

From inside the spangap workspace this repo is checked out in:

```sh
cd ../builds/stable && spangap make-builds                  # every image in this catalogue
cd ../builds/stable && spangap make-builds hw-lilygo-tdeck  # rebuild just this one
cd ../builds && spangap make-builds                         # every catalogue in the tree
```

It builds each entry in the spangap container via `spangap build` (no local
ESP-IDF needed) and writes each `flasher.zip` to
`<slug>_<name>_<datetime>.zip` in the catalogue directory. Every image of one run
shares that datetime. Two more things go into the build and come back out of the
running device: the entry's name as `SPANGAP_BUILD_DIST` (reported as
`sys.build.dist`) and the catalogue directory's own name as
`SPANGAP_BUILD_CATALOGUE` (reported as `sys.build.catalogue`, and logged on boot
as `build: catalogue <name>`). That second one is how a device tells the flasher
which catalogue it came from, and so which listing its stamp belongs to.

Each entry it builds also loses its **older images** — same entry, same
catalogue, earlier stamp. One entry in one catalogue means one image, since the
page only ever offers the newest per name, so the rest are bytes you `rsync` to
the server for nobody. Entries a run didn't build keep theirs.

Two files beside the images are rewritten from what is actually on disk, so a
subset rebuild leaves the images it didn't touch listed exactly as they were:

- **`index.html`** — the listing, and the record of which images exist at which
  stamp. It is what the page reads to decide what to offer, and what a browser
  renders if you point one at the directory.
- **`timestamp`** — the newest stamp present, so the page can poll one tiny file
  instead of re-reading the listing every 15 s.

A run in the tree above the catalogues does every one of them, `.unlisted`
included, then rewrites `builds/index.html`. The first failing build ends the
run: the images built before it keep their fresh stamp, the listing still matches
what is on disk, and the exit status is non-zero.

Every straddle a run compiles has to be **in the workspace already**: cloning one
takes the host's git credentials, which the container has none of. The host half
of `spangap` therefore reads the run's invocations and clones for each of them
before the run itself starts in the container; a target still missing by then
stops the run, named, rather than being fetched.

Everything it writes is untracked — produce it before you serve or deploy the
page (see the CI workflow, which builds the images and uploads them as a
downloadable artifact).

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
- `web-serial-polyfill.js` —
  [web-serial-polyfill](https://github.com/google/web-serial-polyfill), the Web
  Serial interface built on WebUSB (the Android road; see below).

To update, re-fetch the pinned files and bump `VERSIONS.txt`.

## Browser support

Chromium only (Chrome, Edge, Opera, Brave) — Firefox and Safari reach a USB
device from a page by neither road. The FNB58 current graph additionally needs
**WebHID**; where that is missing the feature stays off and the rest of the
monitor works.

Which road the page takes is decided at load and is invisible above the
transport: everything is written against the Web Serial shape.

- **Desktop — Web Serial.** The operating system owns the port and its driver,
  so every board is reachable, bridge chip or not.
- **Android — WebUSB.** Chrome there does expose `navigator.serial`, but it
  enumerates Bluetooth serial ports only: the chooser opens with a board plugged
  into the phone and lists nothing. WebUSB hands the page raw endpoints instead,
  and the polyfill drives the CDC-ACM protocol over them.

The Android road reaches a board whose serial port is **the chip's own USB** —
the USB-Serial-JTAG controller, and the CDC ports `usb cdc` moves the console to.
A board behind a **USB-to-serial bridge chip** (CP2102, CH340, FTDI) is not
offered at all: a bridge speaks a vendor protocol that belongs to a driver, not
to a page. An Android app holding the device also locks the browser out, so
dismiss whatever offers to open when the board is plugged in.

`?serial=native` and `?serial=usb` force one road for a load, which is how the
two are compared on one machine. `?readqueue=N` sets how many bulk IN transfers
are kept posted at once (8 by default), so a transport that misbehaves only when
several are outstanding can be caught against real hardware without a deploy.
`?signals=none` opens the port with DTR and RTS down instead of both asserted. `?usbprobe=1` turns the Start button into a
raw wire test — one carriage return written straight to the endpoint, whatever
comes back printed as counts and text, nothing of the page in between. See
[`docs/serial.md`](docs/serial.md).

`?debug=1` pins a line of counters over the monitor, in its own DOM rather than
the terminal's, because half of what it is for is telling a session that has
stopped receiving from one that is receiving and not showing:

```
usb in 4096B/64 (0.3s ago, 8 posted) out 12B/3 err 0 · loop 4096B/64 (0.3s ago, behind 0.0s) · keys 2/2 · term 53x40 box 372x480 · view 0/0 · hw hw-heltecv4
session live drops 0
first read: A transfer error has occurred.
```

`usb` is what the transport took off the wire, `loop` what the reader loop took
delivery of; the two disagreeing means the stream. Both climbing with nothing on
screen means the terminal — and `term` against `box` says whether it was sized
to the space it has. `keys` is input captured over input the device accepted, so
a keyboard reaching the page but not the wire reads as `7/0`. `first` and `last` are the
transport's failures in its own words — both, because later ones are usually
consequences of the first and the first is the one worth reading. `session` says
which recovery is in play: `gone`, `reattaching`, the RNG watchdog, the
consecutive-drop count, and whether a dialog is up waiting on the answer.

Debug mode also changes behaviour, deliberately:

- **No automatic detection.** A session that probes has already failed at the
  thing a debug session exists to observe — and the run itself destroys the
  evidence, resetting the device and burying the dead console under a fresh
  boot. The settings-panel button still runs one on purpose.
- **One reopen-to-resync per silence stretch.** IN silence with transfers
  posted for `?resync=N` seconds (10 by default) triggers a single reopen,
  re-armed only by bytes actually arriving. Output that resumes after each
  reopen convicts host-side endpoint state; silence that survives it convicts
  the device.
- **Tap-to-copy carries the configuration, the port's own name string, and
  `tail`** — the last bytes heard before the stream went quiet, which names the
  log line a console died on.
