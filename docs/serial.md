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
is that a tab talks to the one port it was given — or one the device itself has
proven is the same board — and asks before that changes.

## The transport under the ports

Everything in this document is written in Web Serial's vocabulary — a port with
`readable`, `writable`, `setSignals`, and `connect`/`disconnect` events — and one
of two browser interfaces supplies it. `chooseSerial()` picks at load, and
nothing above it can tell which was picked.

**Web Serial** (`navigator.serial`) is the desktop one, and the only one that
reaches a board through a **USB-to-serial bridge chip**: a bridge speaks a vendor
protocol that belongs to the operating system's driver, and a page has no way to
speak it.

**WebUSB** (`navigator.usb`) is what Android implements for a USB peripheral. It
hands a page raw endpoints, so a page can itself drive a port that is plain
USB CDC-ACM (Communications Device Class, Abstract Control Model) — which is what
an ESP32 with native USB presents on both of its transports: the USB-Serial-JTAG
controller, and the CDC ports `usb cdc` moves the console to.
[`vendor/web-serial-polyfill.js`](../flashmon/vendor/web-serial-polyfill.js)
turns those endpoints into a `SerialPort`, and `usbSerial()` in `flashmon.js`
supplies what the polyfill leaves out.

Android is the reason the choice exists. Chrome there does expose
`navigator.serial`, but it enumerates Bluetooth serial ports only: the chooser
opens with a board plugged into the phone and lists nothing. So on Android the
page goes to WebUSB — at the cost of the bridge-chip boards, which are absent
from the chooser rather than broken in it. `?serial=native` / `?serial=usb`
forces one road for a load.

### What the adapter adds

The polyfill mints a fresh `SerialPort` on every call, and everything under
[Only ports this tab was given](#only-ports-this-tab-was-given) rests on object
identity, so `usbSerial()` wraps each `USBDevice` exactly once and every path
hands back that one wrapper. It also carries the two things the session loop
reads and the polyfill does not have:

- **`connect` / `disconnect`**, translated from the WebUSB events of the same
  names, carrying the tab's own port object as `e.port`. A device with no CDC-ACM
  interface raises nothing — it is not a port.
- **`connected`**, set false the moment a device is seen leaving and before the
  event is dispatched, because `detachStreams` reads it to decide whether a close
  has anything to release.
- **A close that ends with the device closed**, which is what releases the
  claimed interfaces. The polyfill finishes its close by dropping DTR and RTS,
  and that control transfer throws against a device that has just left the bus —
  which here is the ordinary case, since every teardown follows a reset: the
  detector run and the flash both hand back a rebooting chip. Left alone, the
  throw skips the device close under it, the interfaces stay claimed, and the
  next open fails on `claimInterface` — flashing succeeds and the console after
  it never opens again.
- **An open that survives one leaked claim**, closing the device outright and
  asking once more, since nothing above the transport can act on a stale claim.
- **An open that puts the control lines where the desktop puts them.** DTR and
  RTS are not decoration on a chip whose native USB wires them to its own reset
  and boot-mode logic. Of the four states, `(DTR 1, RTS 0)` — the polyfill's own
  choice — is half of the auto-reset sequence, the half that holds the boot pin
  down; `(0, 0)` is an idle line that jogs nothing but also tells the device no
  host is there, and a console that answers only a host it can see stays silent
  to that one; `(1, 1)` is what Web Serial does on the desktop, which is the
  configuration this page is known to work in. So both are asserted, in **one**
  control transfer — the pair is what the chip's logic reads, and stepping
  through a corner of the square on the way would be the reset the open is
  promising not to do. `?signals=none` leaves them down, for comparing the two
  against real hardware.
- **Endpoint resync on open.** Every bulk endpoint carries a one-bit sequence
  number (DATA0/DATA1) both ends must agree on. A receiver that sees the wrong
  one ACKs the packet — the sender counts it delivered — and silently discards
  it as a retransmission, so one direction of the port stops carrying data with
  every counter on both sides reading healthy. The ends drift whenever endpoint
  state moves without a bus event the other side can see: interfaces claimed
  and released around a detect run or a flash, a chip that resets without
  re-enumerating (USB-Serial-JTAG rides through chip reset). A kernel serial
  driver never meets this because it holds one continuous view of the endpoint
  from plug to unplug — and this page is the driver here, so its open does what
  a driver's open does: `CLEAR_FEATURE(ENDPOINT_HALT)` on both endpoints,
  resetting the toggle to DATA0 on device and host alike. Every control
  request the open path makes is raced against a deadline — one that has not
  answered in 1.5 s is not going to, and an awaited request that never settles
  is worse than one that fails: no catch fires, and the page sits on "Opening
  serial monitor…" forever with nothing to show. A hang is recorded in the
  readout by name (`clearHalt: no completion in 1500 ms`) and the open
  proceeds without it. A silently one-way
  port — a console mute mid-boot-log, a keyboard the firmware never hears,
  while every transfer reports success — is this fault, and nothing else looks
  like it. It is also why a flash can succeed over a link whose console is
  dead: the loader protocol retries and re-syncs at every step, and a console
  stream retries nothing.
- **The byte streams themselves.** `readable` and `writable` are built here over
  `transferIn` / `transferOut` rather than taken from the polyfill, so both
  directions are one transfer in flight and every failure is a rejection with
  the endpoint status in it. The endpoints are named in the monitor's opening
  banner (`CDC iface 1, in EP2, out EP1`): a console that answers nothing looks
  the same whether the device is quiet or the page is on the wrong pipe, and
  that line is what tells them apart.

### One packet per read

A bulk IN transfer ends when the requested length is reached or a **short
packet** arrives, and not otherwise. Ask for several packets' worth and a device
that stops talking on a packet boundary leaves the transfer open: everything
already received sits in the host, undelivered, until the device speaks again.

The USB-Serial-JTAG controller's transmit FIFO is one packet deep, so a packet
boundary is exactly where its bursts end. That reads as a console that prints a
screenful and stops, a CR whose answer never arrives — so every session probes a
board that would have told it what it is — and a keystroke whose echo appears
only when the next one is typed.

So a read asks for exactly one packet, which is the only length that always
completes. It costs a round trip per 64 bytes; a boot log arrives in a few
hundred transfers and a console never notices.

### Eight of them at once

One transfer at a time is not slow, it is **lossy**. Between a transfer
completing and its replacement being posted sits everything the page does with
the bytes — the frame sniffer, the log parser, the terminal, a repaint — and for
that whole window the endpoint has nowhere to put anything. A device talking
faster than the page can turn transfers around fills its one-packet FIFO and
drops the rest.

This is the buffering an operating system would have done. A serial port on the
desktop is drained by a kernel driver that keeps its own transfers queued and
hands the page a tty's worth of bytes; over raw WebUSB there is no driver, and
the only buffer between the device and this script is the transfers this script
has posted. Eight are kept outstanding, so the endpoint stays stocked while the
page is busy with the last chunk.

Transfers on one endpoint complete in the order they were posted, so a queue of
them is still a byte stream: post at the tail, take from the head.

A queue has to be told when it is over. A transfer posted before a teardown
still completes after it, and the pull sitting on that transfer wakes into a
stream that no longer exists — where an enqueue throws. That is an **ordinary
end**, not a failure, and reporting it as a USB read error puts a failure that
never happened at the top of the diagnosis while burying the one that did. So
the read stream carries a `finished` flag, set by its cancel and by the port's
close, and a pull that wakes to find it set stops without a word.

The symptom of getting this wrong is a boot log that arrives as its first page
and then nothing — not because the stream died, but because the device gave up
on the rest of it.

### The wire test — `?usbprobe=1`

A console that says nothing back has three causes and they are identical from
the terminal: the byte never left, the byte left and the device had nothing to
say, or the device answered and something between the endpoint and the screen
ate it. A dozen layers sit in that gap — streams, session, frame sniffer, log
parser, terminal — and each of them could be the one at fault.

`?usbprobe=1` turns the Start button into a test that has none of them. It picks
a port, opens it, and then, with its own hands: **listens first**, writes one
carriage return straight to the OUT endpoint, listens again, and prints the
endpoint numbers, every read's status and byte count, the write's status and
byte count, and whatever came back as text. It closes the port and stops.

The listen before the write is what makes it more than an echo test. A running
board that has been left alone is quiet there; **bytes before anything is asked
of it are a board the open disturbed**, and early-boot text says so outright.

It keeps **one** transfer posted across the whole run rather than a fresh one per
wait. Giving up on a wait does not unpost a transfer, and a posted transfer will
take the next packet the device sends — so a probe that abandoned one would eat
the answer the next phase is listening for and report a silence it caused itself.

Whatever it reports is true of the wire, so it splits the question in one run:

- **`wrote CR → threw`, or a status other than `ok`** — the write is the fault,
  and the message says why.
- **`wrote CR → status ok`, then `nothing in 700 ms`** — the byte left and the
  device did not answer it. The fault is past the wire: which pipe, or what the
  firmware does with a bare CR on it.
- **`wrote CR → status ok` and bytes back** — the wire is whole and the answer
  is being lost above the transport.

A device that re-enumerates under a **new** `USBDevice` costs the pairing: the
port returns as a stranger and the session recovers through **Re-select port**,
the same path that covers every other way a port comes back unrecognisable.

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
is running on (`Spangap console on JTAG/serial.` / `… USB/CDC 0.`) and that is the one
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

**A tab opens the ports a chooser pick handed it — plus a returning port that
has proven, in the device's own words, that it is the same board.**
`pickedPorts` is that list, `pinnedPort` is whichever of them currently carries
the session, and `pinPort()` — the only writer of either — is called from
exactly four places: the opening `connect()`, `repickPort()` behind the
**Reconnect** dialog and the **Re-select port** button, a console move — each
of those a `requestPort()` pick, which is to say a person pointing at an entry
in the browser's chooser — and the verified adoption of a returning board (see
[A board that returns as a stranger](#a-board-that-returns-as-a-stranger)),
which rests on the device naming itself over the wire. `isOurs(p)` is
`pickedPorts.includes(p)`, plain object identity, and it is the whole of the
test the `connect` handler applies before reclaiming a port directly.

Nothing is ever opened on a guess, and that is not conservatism, it is the only
correct answer available. `getInfo()` exposes `usbVendorId` and `usbProductId`
and nothing else: no serial number, no device path. Three identical boards on a
desk are therefore *one* identity to this page, and a tab that infers "my port
came back" from a matching identity alone is guessing between them. It guesses
wrong regularly, and when it does, two tabs have quietly traded consoles — the
same three boards, the same three tabs, the wrong pairing, with nothing on
screen to say so.

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
adopts anything; both end in a pick. The one silent way back besides the rescan
is the verified adoption below — and it ends in the device's own proof rather
than a pick.

An ordinary reset costs none of this. Neither `spangap flash`'s reset nor the
detection run's re-enumerates the device, because the USB-Serial-JTAG controller
is not reset with the chip (see
[spangap-core's usb-console](../../spangap-core/docs/usb-console.md)). The port
object survives and the session simply reattaches.

## Losing the streams, not the port

A port's `readable` and `writable` are **one-shot**: a single failed transfer
errors the stream for good, and the port builds a fresh pair only when asked
again. The device is fine, the port is still there, and the session is neither
`gone` nor detached — so none of the machinery below is reached.

Left alone this presents as a session that is alive on screen and deaf and mute
in fact: no device output, and typing that goes nowhere. Worse, it is silent at
both ends — the reader loop simply ends, and a write rejects into a `catch` that
was written for a port that went away.

`restreamAfterDrop(m, err)` is what turns that into a recovery. Two places
notice, because a stream dies between transfers as readily as during one:

- **The reader loop**, when it ends while the session still holds its reader.
  `detachStreams` clears `m.reader` *before* cancelling, so an ordinary teardown
  and a stream that died on its own are told apart by that one field.
- **`writer.closed`**, which is where a write-side error always surfaces —
  the rejection often lands on a later write than the one that failed, or on no
  write at all, when nothing more is typed.

Either way the drop is said out loud (`-- serial stream dropped: … --`) and the
streams are rebuilt over the same port, reattaching with `poke` rather than
`sync`: the device kept running through this, and its output is mid-flow, which
is exactly what the sync handshake would discard.

What cannot be rebuilt is a stream over a port that has actually gone, and the
budget tells the two apart: four drops with no bytes in between hands the
session to the port-level recovery below, which can ask for a new port. Bytes
arriving clear the run, so a session that drops once an hour never reaches it.

A reset is the common trigger — every transfer in flight when the chip resets
fails — which is why this is felt most as "the reset worked but the boot log
never came".

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
list is those ports and nothing else; the loop never goes looking. When none of
them is even on the bus, a tick instead re-offers any queued returning port to
the verified adoption below — an arrival can land before the disconnect that
frees the session to act on it, and the one-shot connect event is spent by then.

It backs off after ~16 s (one try in six thereafter) but never stops, so a board
that returns on the same object is picked up for free however long it took. At
~30 s it calls `offerRepick()` once, which reveals the **Re-select port** button
and says so in the stream. **The loop raises no dialog** — see "departure is not
evidence" above.

### A board that returns as a stranger

A board that actually left the bus — an unplug, a `usb down`, a long power loss
— re-enumerates, and comes back as a **fresh `SerialPort` object**: the same
grant (the browser keeps wired-port grants across a replug when the device's
USB descriptors carry a unique serial number, and both console transports do —
the USB-Serial-JTAG ROM reports the chip's MAC, the CDC composite a MAC-derived
string), but an object the rescan's identity test has never seen. The tab gets
it back without a pick by making the device prove who it is:

```
Board   → Browser : re-enumerates; the grant matches → no chooser
Browser → every tab : connect(port)        (grants are origin-wide, so is the event)
Tab     → sibling tabs : claim(vid:pid, when I lost mine)   (BroadcastChannel)
Tabs    :           most recent loss probes first; ties break on tab id
Tab     → Board   : open(), one bare CR
Board   → Tab     : dev a1b2c3, host …, fw …  (the greeting's identity line)
match   →           adopt: replace the dead twin in pickedPorts, pin, reclaim
mismatch→           close, broadcast it (the owner may be waiting), leave the port
```

The connect event is not the only way in: while the session is bereft — no
picked port even on the bus — each rescan tick also sweeps `getPorts()` and
feeds matching grants to the same queue, so a port whose one-shot event fired
before the session could hear it (or never fired) is still found. The sweep
answers "what is granted", though, not "what arrived" — so it is filtered
against a baseline snapshotted at the moment of loss: a granted port already
listed then is another board that was on the desk all along, not a return, and
probing it would be noise at best. Only ports that appear after the loss are
candidates (a connect event is an arrival by definition and overrides the
baseline). The grant is the boundary either way: a port the browser quietly
un-granted appears in no event and no sweep, and only a pick can bring it
back.

The probe cleans up exactly what it caused, no more: each CR it wrote earns
one greeting, so before closing it reads until that many greeting terminators
have passed (deadline-capped — a CR the firmware never read has no greeting to
wait for). Anything else in the stream is the device's own output, not the
probe's to eat — a console logging continuously never goes quiet, so silence
is no yardstick — and it reappears as ordinary backlog for the session that
reclaims the port. Left unread, the surplus greetings would print above the
real one.

The probe is patient where it should be and bounded where it must be. Its
open() gets the same 8×300 ms retries as `reclaimPort` — a port rarely accepts
an open the instant it appears — and a port that will not open at all is
retried for ~10 rounds (the OS may still be building the device node; another
tab may be mid-probe) before it is retired. A port that *opens* but answers
nothing identifiable across a ~4 s window of repeated CRs gets three rounds. A
port whose device left mid-probe burns no budget at all: a bus still bouncing
after re-enumeration retires that object without a word and the successor
object gets its own probes. Retirement is terminal per port object, its
epitaph said once — the sweep re-encounters the same object every tick, and
without a terminal state each encounter would re-print it. The whole probe
lifecycle is diagnostics, not session narration: the terminal shows only what
the session did (`gone`, `came back`), and every probe decision — arrival,
decline and why, outcome, epitaph — goes to the browser console (`adopt: …`),
so a return that goes nowhere is diagnosable rather than silent.

Nothing in the probe may wedge: every teardown await is deadline-bounded and
its close is skipped for a vanished device (Web Serial's known hang spot),
because a probe that never returns would stick the `negotiating` latch and
with it every recovery path. And a person at the chooser outranks all of it —
**Re-select port** halts new probes, waits out (bounded) one in flight, and
then reclaims the pick.

`pairedUnit` is the anchor: the `dev <id>` field the parser takes off the
greeting (or off the boot log's own `dev` line), held per tab and **cleared on
every chooser pick** — identity is always re-learned from the wire, never
carried over a pick. A tab that never saw the field (firmware without it, or a
board that never spoke) has nothing to verify against and never probes; it
keeps today's behaviour, the rescan and **Re-select port**.

### The roster, and the startup lobby

Every identified node also lands in the **roster** (`localStorage`, so
origin-wide and persistent): dev id → hostname, the USB identities its
transports wear, when it was last seen. It is bookkeeping, never proof — a
grant has no page-visible identity, so nothing is ever opened as a session on
the roster's word alone.

What it buys is the **startup lobby**, the page's one front door (only the
`?usbprobe=1` wire test keeps the plain Start button): on load the roster's
nodes are shown by hostname instead of a chooser. The rows are verified live
with the same identity probe adoption uses — walk `getPorts()` (gesture-free),
probe each present port whose USB identity the roster knows, read
`dev …, host …` off the greeting, close — and only a row that answered becomes
clickable; the click connects to that port with no chooser. Ports the roster
has never seen are not probed at all, so a serial device this origin granted
for some other purpose is never poked. An empty roster reads "No known devices
found". **Other device…** is the plain chooser, and the only road for a
stranger. A failed connect returns to the lobby, which re-probes — a node
taken between probe and click comes back labeled busy rather than ready.

Busy is known two ways, cheap one first. A tab holding a console **stamps a
heartbeat** (`localStorage`, dev id → timestamp + tab id, every 2 s on
worker-held ticks so a hidden tab's stamp stays fresh; dropped on release and
on unload, and ignored once stale, so a crashed tab's board is fair game
within seconds). A stamped node is labeled "in use in another tab" without its
port ever being touched, and keys worn only by stamped nodes are skipped by
the probe sweep. A port that refuses to open *without* a stamp — some other
program's, usually — is the probe-discovered fallback.

What makes this safe where grant-matching alone would not be:

- **Adoption is on proof, never on arrival.** The only thing ever written to an
  unverified port is one carriage return, which a spangap console answers and
  ignores.
- **`open()` is exclusive browser-wide.** A port some tab already holds cannot
  be probed at all — the open fails. Only unclaimed ports are ever up for
  grabs, and the loser of a racing open just waits its turn. The recency
  negotiation orders the probes; exclusivity is what makes a steal impossible.
- **A wrong guess is said out loud and self-corrects.** A mismatch closes the
  port and broadcasts, so the tab whose board it is retries at once; the probe
  budget (three per port object) keeps a port that never answers from being
  pestered forever.

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

A verified adoption shows in the stream only as its `came back` — the probes'
comings and goings (arrival, decline and why, probe outcome, a board that never
announced a `dev` id) are diagnostics, written to the browser console with an
`adopt:` prefix.
