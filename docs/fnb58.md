# FNB58 current graph

How flashmon graphs live current draw from a FNIRSI FNB58/FNB48 USB power meter
while the serial monitor runs. This is the reference behind the FNB58 code in
[`../flashmon/flashmon.js`](../flashmon/flashmon.js) (search `FNB58`) and its
markup/styles in [`index.html`](../flashmon/index.html). It is a **browser-only**
feature — `flashmon.py` has no equivalent, because it rides WebHID.

The meter is a USB **HID** device, not a serial port, so it opens over
**WebHID** in the same tab as the device's Web Serial monitor. The two live
side by side: the graph panel pins across the top of the monitor and the
terminal slides down to clear it.

## The HID stream

On open we kick the vendor stream with three 64-byte reports (`0xaa`, a type
byte, 61 zeros, a trailing checksum): `0x81`/`0x8e`, then `0x82`/`0x96` twice.
Some units auto-stream; for the rest a 1 Hz keep-alive (`0x83`/`0x9e`) holds it
open.

Each input report is 64 bytes (report id stripped) and carries **four 15-byte
samples**. A report is ours when byte 0 is `0xaa` and byte 1 is `0x04`. Within a
sample, voltage is a little-endian `u32` at offset 0 and **current a
little-endian `u32` at offset +4**, both `/100000` to reach volts/amps; we keep
current only, as **mA** (`raw / 100`). The meter streams at roughly **100 Hz**
(four samples per ~40 ms report), but nothing downstream trusts that rate — see
timestamps below.

## Storage: a timestamped ring, 5 minutes

Readings land in two parallel rings, `fnb.ma` (mA, `Float32`) and `fnb.ts`
(arrival time in ms from `performance.now()`, `Float64`), sized for **5 minutes**
at the nominal 100 Hz (`FNB58_CAP = 100 * 300`). All four readings in a report
share one arrival stamp — they fall inside the same ~10 ms and the draw-time
averaging resolves them.

Storing a **timestamp per sample**, rather than assuming a fixed rate and
indexing by sample count, is what makes the display honest and smooth: the graph
is drawn against real elapsed time, so a slow or bursty stream doesn't stretch or
shimmer the history.

## Display window: pills, with an auto default

A row of pills above the graph selects the visible span: **10s, 30s, 1m, 3m,
5m** (`FNB58_WINDOWS`, seconds). Selection has two modes:

- **Auto** (default, `fnb.winSel == null`): the window is the *smallest span that
  still holds every stored sample* — `FNB58_WINDOWS.find(w => bufferSpan <= w)`.
  So the graph opens at 10s and steps up to 30s, 1m, … only as history
  accumulates past each threshold. The auto-picked pill is highlighted with a
  **dashed** border to signal it will move on its own.
- **Pinned**: clicking a pill fixes that span (solid highlight). Clicking the
  pinned pill again hands the window back to auto.

**Clearing resets to auto.** The average box (left) clears the whole buffer and
restarts — `fnb.len` drops to 0 and `fnb.winSel` returns to `null` — so an empty
buffer auto-selects 10s again. The average box shows the mean over the whole
stored buffer and the span it currently covers (`last <n> s`), capped at 5 min.

## Drawing: one averaged, interpolated column per pixel

The naive graph — fold the ring into pixel columns and take the **max** per
column — is wrong two ways: many samples share a pixel so a single spike makes
the whole column read too high, and folding by sample index makes columns
reshuffle as the ring shifts, so the graph **shimmers** as it scrolls.

Instead, each frame builds a per-pixel table keyed by **time**:

1. The right edge is the newest sample's timestamp `tEnd`; the left edge is
   `tEnd − window`. Each of the `cols` pixel columns owns a `dt = window / cols`
   wide time slice.
2. One pass over the buffer buckets every reading whose timestamp lands in the
   window into its column, accumulating **sum and count**. (The same pass sums the
   whole buffer for the average box.)
3. Each column's value is its **mean** (`sum / count`) — averaging, not max, so a
   lone spike is diluted by the ~20 neighbours sharing its 200 ms-wide pixel at
   the 10s window rather than inflating it.
4. Columns with no sample are **NaN** and get **linearly interpolated** from their
   nearest filled neighbours on each side. Only *interior* gaps are filled; the
   empty run to the **left of the oldest sample stays blank**, so the graph fills
   from the right instead of stretching a thin history across the whole width.

Bars are drawn from the averaged/interpolated values, scaled to a "nice" max
rounded up to the next 10 mA. The **peak pill** is taken from the *averaged*
columns too (not raw samples), placed against its column and flipped left only
when it would overflow the right edge. The live **now** readout in the top bar is
the newest raw sample.

Because the table is rebuilt against `tEnd` every frame, the same wall-clock
instant maps to the same column from frame to frame — that time-anchoring, plus
per-pixel averaging, is what removes the shimmer.

## Time axis

A row under the graph shows five evenly spaced labels from the left edge to
`now` at the right, formatted relative: `now`, `−45s`, or `−3:20` past a minute
(`fnbFmtAgo`). They track the active window, so pinning a wider span relabels the
axis.

## Device match

WebHID filters on vendor id `0x2e3c` (FNIRSI) or `0x0483` (ST, used by some
units). A prior grant persists per-origin and is reused silently; only a
first-time connect pops the chooser (behind an opt-in dialog, since WebHID needs
a user gesture). Unplugging the meter tears the graph down via the WebHID
`disconnect` event.

## Not the device's serial port

The FNB58 is a **composite** USB device: alongside the HID interface it exposes a
CDC **serial port**, which appears in the Web Serial chooser right next to the
board. Picking it as "the device" opens a dead monitor — there's no ESP to probe,
so `probeChip()` returns null and you land in a bare terminal with only a Reset
button (no Flash / Open-UI), and a replug can't reopen the meter's CDC cleanly
(`-- serial port came back but reopen failed --`).

`isFnb58Port(port)` guards against this, matching `port.getInfo().usbVendorId`
against the same vendor ids as the HID picker (`0x2e3c` / `0x0483`):

- `connect()` rejects a chosen FNB58 serial port up front with a hint to pick the
  device's port instead, rather than opening the dead monitor.
- `findRememberedPort()` filters FNB58 ports out, so the silent reconnect-on-load
  never targets the meter either.

The graph only ever reaches the meter over WebHID (the FNB58 button); the meter's
serial port is never the right pick here. (A genuinely non-ESP board still gets the
normal "No ESP32 detected" plain terminal — only the FNB58's own port is special-cased.)
