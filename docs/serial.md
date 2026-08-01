# Holding the serial session

How flashmon keeps one monitor session alive while the device underneath it
comes, goes, and changes what it looks like on the USB bus. This is the
reference behind the console-handover and reconnect code in
[`../flashmon/flashmon.js`](../flashmon/flashmon.js) (search `console handover`)
and its dialogs in [`index.html`](../flashmon/index.html). It is a
**browser-only** concern — `flashmon.py` talks to a device node through
pyserial and simply re-opens it by name.

The device is not a fixed thing on the bus. It re-enumerates on every reset, and
its CLI can move the console between two entirely different USB devices
(`usb cdc` / `usb jtag`). Web Serial, meanwhile, hands out a **new `SerialPort`
object** each time, keeps permission grants that may or may not still open, and
delivers `connect`/`disconnect` events in whatever order the operating system
felt like. Everything below exists to turn that into one continuous terminal.

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

Two mechanisms deal with it, and only on a genuinely fresh open
(`attachStreams(m, sync = true)`, used by `openMonitor`):

- `syncConsole(m)` writes a carriage return **muted**, waits ~100 ms, and throws
  the whole exchange away. The firmware answers any bare CR, which flushes what
  it was holding; a second CR then produces the greeting the user actually sees.
- `trimToLineStart(m, buf)` is the byte-level backstop: discard until the first
  newline, the way any terminal joining a stream part-way should. It is bounded
  both ways (4 KB, or 2 s) so a device that simply never sends a newline is not
  silenced.

A **reattach** (`attachStreams(m)` with `sync` false) does neither. The bytes
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

## Identity, not object

Three separate caches, because three different questions get asked.

**`knownIds` — which USB identities are this device?** A console handover
changes the device's vendor/product id pair: the USB-Serial-JTAG controller
(`0x303A:0x1001`) and the TinyUSB composite (`0x303A:0x4002`) are different
devices to the host, and a reset changes it back. `noteDeviceId(port)` records
what it sees and, because the two transports are one physical device, learning
either one adds the other. `isKnownDevice(port)` is what lets a session opened
on CDC accept the JTAG identity the device reboots into.

**`presence` — is this an actual change?** Re-enumeration fires `connect` and
`disconnect` several times each, with fresh objects every time, so neither the
event nor the object identifies a state change. `presence` maps USB identity →
believed-attached, and `presenceChanged(port, here)` returns false for a repeat,
which is then dropped whole: no message, and no second reattach over a session
that already holds the port.

**`heldPorts` — which object for this identity is live?** A re-enumeration mints
a new `SerialPort`; the old one keeps its name, identity, and grant, but not an
openable backing — `open()` on it fails forever. `getPorts()` can hand back
either and cannot be trusted to pick, while the object a `connect` event
delivers is by definition the live one. So every connect event and every
successful open deposits into `heldPorts` (`holdPort`), and every recovery path
prefers it over a `getPorts()` snapshot.

`heldPorts` keys a **list**, not one object per identity: the composite device
presents two CDC ports wearing the same vendor/product id, with nothing in
`getInfo()` to separate them. Collapsing them would hand the console to whichever
interface enumerated last. Order is the only signal there is — the console is
interface 0, so it enumerates, and connects, first. The list is bounded
(`HELD_PER_ID_MAX = 3`, against a hardware maximum of two) so an evening of
switching does not leave the audition wading through a generation per switch;
a `disconnect` drops every cached object for that identity outright.

`forgetPortObject(port)` drops a dead object from that cache. It is deliberately
**not** `port.forget()`: that revokes permission for the underlying port, and a
dead object wears the same identity as the live one, so revoking on its behalf
takes the working console's grant with it. Objects are ours to discard; grants
are the user's.

## Losing a port, and getting it back

`disconnect` marks the session `gone`, drops the device's buttons, says which
transport went (`portLabel`), and tears the dead streams down. The comparison is
by **USB identity, not object** — a device that re-enumerates arrives as a fresh
`SerialPort`, so comparing objects misses the session's own departure and leaves
it marked live forever.

`connect` pins the arriving object into `heldPorts` **before** any dedup or
refusal, then reclaims it if the session is detached. "Detached" is ground truth
— `gone || !reader` — not the `gone` flag alone, which has repeatedly gone stale
when a `disconnect` was missed, presenting as a live-looking session that is
mute and deaf until the page is reloaded.

`reclaimPort(p, attempts)` adopts the (possibly fresh) port object over the dead
session and retries `open()`, because a port rarely accepts one the instant it
appears. On success it says `-- <transport> came back --`, restores the green
slot, and runs `verifyAlive`. On failure it reports the reason once per distinct
error — the loop below retries every 800 ms and a repeating line is noise — and
hands over to the rescan.

`verifyAlive(m)` proves the port actually carries the console. `attachStreams`
pokes it with a CR and the firmware always answers one, so a port that stays
byte-silent is not slow, it is dead: opened mid-enumeration, or on a device node
the operating system is still tearing down. It asks a second time before
touching anything (a device mid-boot answers late, and a close/reopen right then
is a window in which its answer is dropped), then closes and reopens up to twice
more, narrating each attempt. Failure is not fatal: the session stays attached,
because a device that was merely busy delivers when it gets around to it.

### The rescan loop

Events cannot drive recovery on their own. The dead port's `disconnect` and its
replacement's `connect` come from two different USB devices, so the operating
system orders them freely — an arrival that lands while the session still looks
live is refused, and that one-shot event is spent.

`scheduleRescan()` polls ground truth instead, every 800 ms: session dead plus a
granted port attached → reclaim it. It prefers held objects over the `getPorts()`
snapshot, **rotates** through candidates rather than retrying one object forever
(with two objects wearing one identity, only trying both finds the live one), and
gives each a single attempt — a stale handle does not fail transiently.

When every candidate has failed once, the grants reachable from here are spent.
The loop drops the cached objects and raises the **Reconnect to the device**
dialog: only a fresh pick from the chooser replaces them, and `requestPort()`
needs a user gesture, so the ask has to come from a button. The chooser is
filtered to the identities this device has worn, so the entry the browser shows
as present is the one on offer. Dismissing it is fine — the loop keeps trying
and re-raises it.

## Console handover

The device's CLI can move its console between the USB-Serial-JTAG controller and
a TinyUSB composite device presenting two CDC (Communications Device Class)
serial ports. It announces the move in the log a moment before it happens, and
the parser watches for both directions.

### Onto CDC — `USB JTAG serial port going away`

`offerConsoleHandover()` sets `awaitingCdc` and polls for up to 3 s for a CDC
port this origin is already permitted to open (`grantedCdcPorts`, newest object
first, since a re-enumeration invalidates everything that preceded it). If one
turns up, the move happens silently — a second switch in the same session needs
no dialog at all. If none does, the **Console moving to a new port** dialog goes
up, and its OK does the asking: `requestPort()` filtered to the composite device,
so the chooser offers its two ports and nothing else.

`adoptConsolePort(cands)` then has to work out **which** of those two ports is
the console. They share a vendor/product id, `getInfo()` exposes nothing to tell
them apart, and the non-console one is silent in both directions — which is
indistinguishable from a working monitor on an idle device. So they audition:
attach muted, un-mute, poke, and wait ~900 ms for any byte. The first that
answers is kept; the rest are detached and dropped from the cache. Silence is a
preference, not a veto — if none answers the first is taken anyway, with a
notice, because a silent monitor beats none.

Two things guard the audition. A candidate that throws `already open` is one of
**our own** handles and must be kept, unlike a grant that genuinely cannot be
opened. And `monitor` is re-checked before committing, because every step above
awaits and a reclaim can have completed in any of those gaps — overwriting a
proven-live session with an audition also-ran is exactly how a console that had
already come back got thrown away.

On commit, the new identity is learned, the outgoing session becomes
`priorSession`, and the flash offer is re-evaluated.

### Back onto USB-Serial-JTAG — `USB CDC ports going away`

`offerConsoleReturn()` is the mirror image, and needs a dialog for a different
reason: the JTAG port that appears may have **no grant in this session** (grants
are swept at load), and an ungranted port is invisible — no connect event, absent
from `getPorts()`. Without the dialog the rescan would spin over an empty
candidate list forever. So it polls for a granted, present JTAG port; if one
exists the rescan reclaims it with no ceremony, and if none has appeared within
3 s the **Reconnect to the device** dialog asks for a pick — but only if the
session actually lost its port, since a switch the firmware announced but never
carried out leaves the CDC session running and a dialog over a working monitor is
just noise.

### One driver at a time

`awaitingCdc` (a move is expected) and `adopting` (a move is auditioning ports)
both hold the rescan and the connect handler off the ports involved. Otherwise
both would be opening the same handles, and the loser reads `The port is already
open` — which the audition scores as "did not answer" and the rescan as a dead
grant. During a move, the move has the wheel; the departure that starts it is
that move's expected first half, not an outage to recover from.

## The notice vocabulary

Everything flashmon prints about the port, in the order a session tends to meet
them. `<transport>` is `JTAG serial port`, `CDC serial port`, or a plain
`Serial port` when the identity says neither.

| Notice | Means |
|---|---|
| `-- <transport> gone --` | The session's port left the bus. Grey rather than red when it was not the session's own port — during a move the device presents and withdraws transports on its own schedule. |
| `-- previous <transport> gone --` | The port a handover moved away from, finally going. Expected, not a loss. |
| `-- <transport> came back --` | Reattached and streaming again. |
| `-- following the <transport> already present --` | The rescan found a granted port and is trying it. Once per outage. |
| `-- <transport> reopen failed (…); retrying in background --` | The grant is listed but will not open yet. Once per distinct reason. |
| `-- no remembered port for this device opens; pick it again --` | Every grant is spent; the reconnect dialog follows. |
| `-- <transport> is silent, reopening… --` | `verifyAlive` got no answer to its poke and is cycling the port. |
| `-- no response; leaving the port open --` | It never answered, and the session stays attached anyway. |
| `-- a <transport> is already open here --` | An audition candidate is one of our own handles. |
| `-- no port answered; taking the first --` | Neither CDC port spoke; the first was adopted regardless. |
| `-- console already recovered; audition abandoned --` | A reclaim won the race while the audition was running. |
| `-- Serial stuck after RNG init; …  --` | The separate RNG-init watchdog, not the port machinery. |
