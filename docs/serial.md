# Holding the serial session

How flashmon keeps one monitor session alive while the device underneath it
comes, goes, and changes what it looks like on the USB bus. This is the
reference behind the console-handover and reconnect code in
[`../flashmon/flashmon.js`](../flashmon/flashmon.js) (search `console handover`)
and its dialogs in [`index.html`](../flashmon/index.html). It is a
**browser-only** concern — `flashmon.py` talks to a device node through
pyserial and simply re-opens it by name.

The device is not a fixed thing on the bus. Its CLI can move the console between
two entirely different USB devices (`usb cdc` / `usb jtag`), an unplug mints a
fresh `SerialPort` object for what a person would call the same board, and Web
Serial keeps permission grants that may or may not still open and delivers
`connect`/`disconnect` events in whatever order the operating system felt like.
Everything below turns that into one continuous terminal — under one rule, which
is that a tab talks to the one port it was given and asks before that changes.

## A session per port, one terminal

`makeSession(port, term, resizeObserver, muted)` builds one port's worth of
state: the reader/writer pair, the line parser, the setup coordinator, and the
flash-offer bookkeeping. The **terminal and its resize observer are passed in,
not owned**, so a second session can be built that renders into the terminal the
first one was already using — which is what makes a console move look like one
uninterrupted scrollback rather than a new window.

`monitor` is the session that owns the screen and receives typed input.
`priorSession` is the session a handover moved *away* from: its streams stay up
and keep rendering into the same terminal until the device finally drops that
port, so the outgoing transport's last words are not lost. It is never a target
for keystrokes, and `closeMonitor()` tears it down first — it renders into a
terminal that is about to be disposed, so it cannot outlive it.

## Opening a port cleanly

A port nobody was holding has a **backlog**: the device kept writing into its
ring buffer, and that buffer begins wherever the ring happened to wrap — mid
word, or mid escape sequence, which is how a raw `[0;90m` ends up on screen.

Two mechanisms deal with it, and only on a genuinely fresh open of a device
left running (`attachStreams(m, 'sync')`, used by `openMonitor` when it is not
about to reset):

- `syncConsole(m)` writes a carriage return **muted**, waits ~100 ms, and throws
  the whole exchange away. The firmware answers any bare CR, which flushes what
  it was holding; a second CR then produces the greeting the user actually sees.
- `trimToLineStart(m, buf)` is the byte-level backstop: discard until the first
  newline, the way any terminal joining a stream part-way should. It is bounded
  both ways (4 KB, or 2 s) so a device that simply never sends a newline is not
  silenced.

A session that opens **in order to reset** the device (`attachStreams(m,
'quiet')`, used by `openMonitor` whenever `doReset`) does neither, and writes
nothing at all. The reset is its own flush — the boot log that follows starts at
a line boundary — and a byte written before it cannot be answered: the chip is
in the ROM loader, or running the RAM-loaded detector, and neither reads the
console. It is not lost either. The USB-Serial-JTAG controller is not reset with
the rest of the chip, so the byte is still queued when the real firmware comes
up and reaches it as a keystroke, which opens a CLI session over the boot log
the reset was issued to capture. This is what put a stray character at a prompt
after every hardware detection.

A **reattach** (`attachStreams(m)`, the `poke` default) does neither. The bytes
arriving just after a port comes back are as often a boot log — from a device
that reset or was power-cycled — as they are stale, and nothing in the stream
can tell those apart. A reattach keeps everything and only pokes the console
(`pokeConsole`, a bare CR), because the firmware's answer names the transport it
is running on (`Spangap console on serial jtag` / `… cdc 0`) and that is the one
thing that confirms the port just opened really is the console.

### Notices

Every message flashmon writes into the terminal itself goes through
`note(target, text)` in the `-- … --` form. It cannot be a plain `writeln`: the
device leaves the cursor wherever its last write ended — mid-prompt, as often as
not — so a bare write lands on that line, and a blank written unconditionally at
each site doubles up whenever notices arrive back to back. `note()` asks the
terminal where the cursor is, finishes a partial line if needed, and writes
exactly one blank above and none below.

## Only ports this tab was given

**A tab opens the ports a chooser pick handed it, and no others, ever.**
`pickedPorts` is that list, `pinnedPort` is whichever of them currently carries
the session, and `pinPort()` — the only writer of either — is called from
exactly three places: the opening `connect()`, `repickPort()` behind the
**Reconnect** dialog and the **Re-select port** button, and a console move. All
three are a `requestPort()` pick, which is to say a person pointing at an entry
in the browser's chooser. `isOurs(p)` is `pickedPorts.includes(p)`, plain object
identity, and it is the whole of the test the `connect` handler applies.

This is not conservatism, it is the only correct answer available. `getInfo()`
exposes `usbVendorId` and `usbProductId` and nothing else: no serial number, no
device path. Three identical boards on a desk are therefore *one* identity to
this page, and a tab that infers "my port came back" from a matching identity is
guessing between them. It guesses wrong regularly, and when it does, two tabs
have quietly traded consoles — the same three boards, the same three tabs, the
wrong pairing, with nothing on screen to say so.

### Two, and why two

`PICKED_MAX = 2`, because a device presents this tab at most two consoles: the
USB-Serial-JTAG one it boots on, and the CDC one `usb cdc` moves it to. A third
pick is a replacement for one of those, so the oldest entry goes.

Owning both is what makes a console move ordinary rather than an event. Once the
tab has been pointed at the CDC console port a single time, that port is in the
list — so every later `usb cdc` is just "one of our ports turned up", opened by
the rescan with no dialog at all, and `usb jtag` is the same in reverse.
`reclaimPort` re-pins to whichever answered.

### Departure is not evidence

Ports go away constantly: every reset, every reflash, every `usb cdc`. Almost
all of them come straight back. So a `disconnect` raises **nothing** — the
session is marked `gone`, the rescan starts retrying, and that is all.

Two things can end an outage differently. The device **announcing a transport
switch** (`offerConsoleHandover` / `offerConsoleReturn`, driven by the log lines
`USB JTAG serial port going away` and `USB CDC ports going away`) is the one
signal that a port is gone for good rather than blinking — and even then the ask
is deferred 3 s and skipped entirely if recovery already landed on one of the
tab's ports. Failing that, ~30 s of nothing reveals the amber **Re-select port**
button in the monitor's action row, which waits to be clicked. Neither path ever
adopts anything; both end in a pick.

An ordinary reset costs none of this. Neither `spangap flash`'s reset nor the
detection run's re-enumerates the device, because the USB-Serial-JTAG controller
is not reset with the chip (see
[spangap-core's usb-console](../../spangap-core/docs/usb-console.md)). The port
object survives and the session simply reattaches.

## Losing a port, and getting it back

`disconnect` marks the session `gone`, drops the device's buttons, says which
transport went (`portLabel`), and tears the dead streams down — for **this tab's
port**, and for the port a handover moved away from (`priorSession`). Every other
`disconnect` on the machine is another board and is dropped without a word.

`connect` reclaims the port if it is ours and the session is detached. "Detached"
is ground truth — `gone || !reader` — not the `gone` flag alone, which has
repeatedly gone stale when a `disconnect` was missed, presenting as a
live-looking session that is mute and deaf until the page is reloaded.

`reclaimPort(p, attempts)` retries `open()` over the dead session, because a port
rarely accepts one the instant it appears. On success it says
`-- <transport> came back --`, restores the green slot, and runs `verifyAlive`.
On failure it reports the reason once per distinct error — the loop below retries
every 800 ms and a repeating line is noise — and hands over to the rescan.

`verifyAlive(m)` proves the port actually carries the console. `attachStreams`
pokes it with a CR and the firmware always answers one, so a port that stays
byte-silent is not slow, it is dead: opened mid-enumeration, or on a device node
the operating system is still tearing down. It asks a second time before
touching anything (a device mid-boot answers late, and a close/reopen right then
is a window in which its answer is dropped), then closes and reopens up to twice
more, narrating each attempt. Failure is not fatal: the session stays attached,
because a device that was merely busy delivers when it gets around to it.

### The rescan loop

Events cannot drive recovery on their own: an arrival that lands while the
session still looks live is refused, and that one-shot event is spent.

`scheduleRescan()` polls ground truth instead, every 800 ms: session dead and one
of `pickedPorts` attached → reopen it, one attempt per tick (a stale handle does
not fail transiently — it fails, it's dead). It rotates over the tab's ports,
pinned first, since after a move it is the other one that answers. The candidate
list is those ports and nothing else; the loop never goes looking.

It backs off after ~16 s (one try in six thereafter) but never stops, so a board
that returns on the same object is picked up for free however long it took. At
~30 s it calls `offerRepick()` once, which reveals the **Re-select port** button
and says so in the stream. **The loop raises no dialog** — see "departure is not
evidence" above.

## Console handover

The device's CLI can move its console between the USB-Serial-JTAG controller and
a TinyUSB composite device presenting two CDC (Communications Device Class)
serial ports. It announces the move in the log a moment before it happens, and
the parser watches for both directions.

### Onto CDC — `USB JTAG serial port going away`

This announcement is one of only two things in flashmon that may pop a picker,
because it is one of only two signals that a port has gone for good rather than
blinking. Even so it defers to recovery first.

`offerConsoleHandover()` sets `awaitingCdc` and waits 3 s. Meanwhile the rescan
is running — the disconnect that follows the announcement starts it, and it is
deliberately *not* held off during a move: if this tab already owns the CDC
console port, the loop opens it the moment it enumerates and the move completes
in silence. Only if the session is still detached at the 3 s mark does the
**Console moving to a new port** dialog go up.

So the ask is for the *first* move only, or after a re-pick pushed the CDC port
out of the pair. Its OK does the asking: `requestPort()` filtered to the
composite device, so the chooser offers its two ports and nothing else. The
dialog says to pick the first, which is the console — they share a vendor/product
id and `getInfo()` exposes nothing to tell them apart, so the person picking is
the only one who can. A pick that lands on the silent one is caught by
`verifyAlive`, which says so.

What must never happen is adopting a CDC port on a *grant* alone. The
composite's two interfaces are indistinguishable from each other and from
another board's, so that is a coin toss, and losing it is precisely the
swapped-console failure this design exists to remove. A grant says this origin
may open a port; it says nothing about which device it is for.

`adoptConsolePort(port)` opens what was picked, re-checks `monitor` before
committing (it awaits, and a reclaim of the outgoing port can have completed in
that gap — overwriting a proven-live session is exactly how a console that had
already come back got thrown away), then **pins** the new port, makes the
outgoing session `priorSession`, re-evaluates the flash offer, and runs
`verifyAlive`.

### Back onto USB-Serial-JTAG — `USB CDC ports going away`

`offerConsoleReturn()` is the mirror image, and the second of the two places
allowed to ask. Same shape: wait 3 s, and if the session recovered on its own —
which it does whenever the tab already owns the JTAG port — say nothing. Only a
tab that does not own it, one opened straight onto CDC or whose JTAG port aged
out of the pair, reaches the **Reconnect to the device** dialog. The same check
covers a switch the firmware announced but never carried out: the CDC session is
still running, so nothing interrupts it.

### One driver at a time

`adopting` (a console move is opening its port) holds the rescan and the connect
handler off, so both are not opening the same handle with the loser reading
`The port is already open`. `awaitingCdc` no longer holds anything off — under
the pinning rule the rescan can only reach the tab's own ports, and reaching them
during a move is the point.

## The notice vocabulary

Everything flashmon prints about the port, in the order a session tends to meet
them. `<transport>` is `JTAG serial port`, `CDC serial port`, or a plain
`Serial port` when the identity says neither.

| Notice | Means |
|---|---|
| `-- <transport> gone --` | This tab's port left the bus. |
| `-- previous <transport> gone --` | The port a handover moved away from, finally going. Expected, not a loss. |
| `-- <transport> came back --` | Reattached and streaming again. |
| `-- following the <transport> already present --` | The rescan is retrying one of the tab's ports. Once per outage. |
| `-- <transport> reopen failed (…); retrying in background --` | The port is listed but will not open yet. Once per distinct reason. |
| `-- still no port; use "Re-select port" if it came back as a new one --` | ~30 s of nothing; the amber button is now showing. No dialog, and the loop keeps trying. |
| `-- <transport> is silent, reopening… --` | `verifyAlive` got no answer to its poke and is cycling the port. |
| `-- no response; leaving the port open --` | It never answered, and the session stays attached anyway. |
| `-- could not open the new port: … --` | A console move's picked port would not open. |
| `-- console already recovered; move abandoned --` | A reclaim won the race while a console move was opening its port. |
| `-- Serial stuck after RNG init; …  --` | The separate RNG-init watchdog, not the port machinery. |
