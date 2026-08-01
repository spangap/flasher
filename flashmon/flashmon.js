// flashmon — browser firmware flasher / serial monitor.
//
// Connecting only opens the port: the device is not touched, not reset, and the
// monitor shows whatever it is already doing. Identifying the board is a
// separate, deliberate act — the green "Detect Hardware" button, which probes
// the chip and RAM-loads the peripheral detector (no flash write) and folds its
// findings into the monitor banner. A board also identifies itself for free when
// the running firmware logs its `build: invocation` line, which names the
// hw-<straddle> it was compiled for.
//
// Once the board is known and the catalogue (flashmon.yaml → builds/<name>.zip,
// or the generic fallback) holds a newer image for it, that same green slot
// becomes "Flash <project> to <device>"; pressing it unzips that image in the
// browser and flashes every segment at its offset over Web Serial (vendored
// esptool-js), then drops back into the monitor and resets the device so its
// boot log streams live.
//
// The catalogue and the UI brand come from flashmon.yaml (or a gitignored
// flashmon.local.yaml, preferred when present), fetched at boot.
//
// No CDN, no build step — these files can be served from anywhere static.

import { ESPLoader, Transport } from './vendor/esptool-bundle.js';
import { Terminal } from './vendor/xterm.js';
import { FitAddon } from './vendor/xterm-addon-fit.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const bar = $('bar');
const barfill = $('barfill');

const params = new URLSearchParams(location.search);

// Filled from flashmon.yaml at boot. `project` brands the UI; `builds` is the
// catalogue of entries (each a `name` matched against the detected hw-<board>,
// plus the `version` — a build datetime — `make` stamped its image with). `slug`
// is the project name reduced for filenames.
let PROJECT = 'flashmon';
let BUILDS = [];
let BUILD_NAMES = [];
let SLUG = 'flashmon';
// Default device hostname (a DNS/mDNS label): the project name, lowercased and
// reduced to the legal charset. Set once the config loads.
let HOSTNAME_DEFAULT = 'flashmon';
// The image resolved for the connected board, if any: { url, label, name }.
// Set when the flash button is shown; read by its click handler.
let pendingFlash = null;
// True while a detection run owns the port (monitor torn down, ROM loader busy):
// keeps the Detect Hardware button off the screen and the run non-reentrant.
let detecting = false;
// The user-state partition a detection run read off the attached chip —
// { addr, size } — or null while the chip has not been probed (or has no store
// yet). Only a detection run knows this: the boot log never states it. A flash
// whose write reaches into it wipes the device's own data, which is what the
// state-warning dialog is for.
let statePart = null;
// Resolves the open state-warning dialog (see confirmStateOverlap), or null when
// none is up.
let stateWarnClose = null;

// Default line settings. The device console runs at 115200/N/8/1 (ESP-IDF
// default); ?monitor_baud= overrides the baud for firmware that logs elsewhere.
const DEFAULT_CFG = {
  baudRate: parseInt(params.get('monitor_baud'), 10) || 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtCfg(c) {
  const p = c.parity === 'even' ? 'E' : c.parity === 'odd' ? 'O' : 'N';
  return `${c.baudRate} ${p} ${c.dataBits} ${c.stopBits}`;
}

function log(msg, cls) {
  logEl.hidden = false;
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// Window/tab title and the top `<h1>`. `host` is the device's real hostname once
// it has been seen in the serial log, else null. Until then both read plain
// "FlashMon - <project>" / "<project>"; once seen, the hostname leads:
// "<hostname> - FlashMon - <project>" / "<hostname> - <project>".
function setMonTitle(host) {
  document.title = host ? `${host} - FlashMon - ${PROJECT}` : `FlashMon - ${PROJECT}`;
  $('title').textContent = host ? `${host} - ${PROJECT}` : PROJECT;
}

// esptool-js writes its own progress/log through this terminal adapter.
const terminal = {
  clean() { logEl.textContent = ''; },
  writeLine(data) { log(data); },
  write(data) {
    if (logEl.lastChild) logEl.lastChild.textContent += data;
    else log(data);
    logEl.scrollTop = logEl.scrollHeight;
  },
};

// A terminal adapter that records esptool-js's info lines (its writeLine calls —
// chip revision, description, features incl. embedded flash/PSRAM, crystal, MAC,
// flash ID). Connection noise goes through write() and is not recorded. Pass a
// `tee` to also forward everything on to another adapter (e.g. the flash log).
function captureTerminal(tee) {
  const lines = [];
  return {
    lines,
    clean() { if (tee) tee.clean(); },
    writeLine(s) { lines.push(String(s)); if (tee) tee.writeLine(s); },
    write(s) { if (tee) tee.write(s); },
  };
}

// Read everything esptool-js can learn about the chip on `loader`: main() logs
// the chip, features (embedded flash/PSRAM), crystal, MAC and flash ID;
// detectFlashSize() adds the flash size.
async function gatherChipInfo(loader) {
  await loader.main();
  try { await loader.detectFlashSize(); } catch (_) { /* leave flash size out */ }
}

// Keep only the chip-fact lines from esptool-js's captured output, dropping its
// procedural chatter (banner, port info, stub upload, baudrate switch, hints).
const INFO_PREFIXES = [
  'Chip Revision:', 'Chip is ', 'Features:', 'Crystal is ', 'MAC:',
  'Flash ID:', 'Auto-detected Flash size:',
];
function chipInfoLines(lines) {
  return lines.filter((l) => INFO_PREFIXES.some((p) => l.startsWith(p)));
}

// Best-effort ESP32 detection: bounce into the ROM loader, read everything, then
// let go. Returns the info lines, or null if nothing answers (not an ESP32, or a
// board without the auto-reset wiring). Leaves the chip in the ROM loader; the
// caller resets it back into the app.
async function probeChip(port) {
  // A freshly (re)opened native-USB port sometimes misses the first ROM sync, so
  // the probe — and with it the reset + peripheral detection it gates — would be
  // skipped for a device that's actually there. Retry once before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    const cap = captureTerminal();
    const transport = new Transport(port, false);
    try {
      await gatherChipInfo(new ESPLoader({ transport, baudrate: 460800, terminal: cap }));
      return chipInfoLines(cap.lines);
    } catch (_) {
      /* first miss: settle briefly and try again; second miss: not an ESP */
    } finally {
      try { await transport.disconnect(); } catch (_) { /* already gone */ }
    }
    if (attempt === 0) await sleep(200);
  }
  return null;
}

// ── peripheral detection (RAM-loaded, non-destructive) ──────────────────────
// Parse an ESP32 firmware image into its RAM segments + entry point. Layout: an
// 8-byte header (magic 0xE9, seg count, flash mode/size, 4-byte entry) then a
// 16-byte extended header, then each segment = 4-byte load addr + 4-byte length
// + data.
function parseEspImage(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint8(0) !== 0xe9) throw new Error('detector image has bad magic');
  const segCount = dv.getUint8(1);
  const entry = dv.getUint32(4, true);
  let off = 24;                                     // 8-byte header + 16-byte ext header
  const segments = [];
  for (let i = 0; i < segCount; i++) {
    const addr = dv.getUint32(off, true);
    const len = dv.getUint32(off + 4, true);
    segments.push({ addr, data: bytes.slice(off + 8, off + 8 + len) });
    off += 8 + len;
  }
  return { entry, segments };
}

// Fetch the detector image and load it into SRAM over the ROM loader (the same
// MEM_BEGIN/MEM_DATA/MEM_END path esptool's own stub uses), then jump to it —
// nothing is written to flash. The detector probes the boards in turn, stops at
// the first it identifies, prints its per-peripheral lines plus a
// DETECTED: hw-<board> line and a SPANGAP-DETECT-END sentinel, then idles; we
// capture that output over the serial port (it never streams to the terminal)
// and return the peripheral + DETECTED: lines. The caller then resets the chip
// back into its real firmware.
async function runDetection(port) {
  const res = await fetch('detect/spangap_detect.bin', { cache: 'no-store' });
  if (!res.ok) throw new Error(`detector image missing (HTTP ${res.status})`);
  const { entry, segments } = parseEspImage(new Uint8Array(await res.arrayBuffer()));
  const total = segments.reduce((n, s) => n + s.data.length, 0);
  let sent = 0;

  const transport = new Transport(port, false);
  try {
    const loader = new ESPLoader({ transport, baudrate: 460800, terminal: captureTerminal() });
    await loader.detectChip();                      // ROM loader (no stub)
    try { await loader.changeBaud(); } catch (_) { /* stay at ROM baud */ }
    for (const seg of segments) {
      const blocks = Math.ceil(seg.data.length / loader.ESP_RAM_BLOCK);
      await loader.memBegin(seg.data.length, blocks, loader.ESP_RAM_BLOCK, seg.addr);
      for (let i = 0; i < blocks; i++) {
        await loader.memBlock(seg.data.slice(i * loader.ESP_RAM_BLOCK, (i + 1) * loader.ESP_RAM_BLOCK), i);
        sent += Math.min(loader.ESP_RAM_BLOCK, seg.data.length - i * loader.ESP_RAM_BLOCK);
        $('intro-hint').textContent = `Uploading detector… ${Math.round((sent / total) * 100)}%`;
      }
    }
    // Jump to the detector. It may start running (and stop answering the ROM
    // protocol) before the command is acked, so a timeout here is expected.
    try { await loader.memFinish(entry); } catch (_) { /* jumped */ }
  } finally {
    try { await transport.disconnect(); } catch (_) { /* already gone */ }
  }

  $('intro-hint').textContent = 'Detecting peripherals…';
  return await captureDetection(port);
}

// Read the running detector's one-shot serial output at the console baud, until
// its end sentinel or a timeout, and return just the DETECTED: lines.
async function captureDetection(port) {
  await port.open({ baudRate: DEFAULT_CFG.baudRate });
  const reader = port.readable.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const timer = setTimeout(() => { reader.cancel().catch(() => {}); }, 8000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buf += dec.decode(value, { stream: true });
      if (buf.includes('SPANGAP-DETECT-END')) break;
    }
  } catch (_) {
    /* cancelled by the timeout */
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch (_) { /* */ }
    try { await port.close(); } catch (_) { /* */ }
  }
  // Whitelist: the detector prefixes every intentional line with "DETECT: ".
  // Keep only those, strip the prefix, and drop the end sentinel.
  return buf.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.startsWith('DETECT:'))
    .map((l) => l.slice('DETECT:'.length).replace(/^ /, ''))
    .filter((l) => l !== 'SPANGAP-DETECT-END');
}

// ── serial monitor ────────────────────────────────────────────────────────
// The monitor renders the port with the same xterm.js the device web-UI uses.
// Its port stays the same across line-setting changes; only the byte streams are
// torn down and re-opened, so the terminal buffer survives a reconfigure.
let monitor = null;

// A port that has just been opened delivers whatever the device buffered while
// nobody was attached, and that backlog begins wherever the ring happened to
// wrap — mid-word, or mid-escape-sequence, which is how a raw "[0;90m" ends up
// on screen. Discard until a line boundary, the way any terminal joining a
// stream part-way should. Bounded both ways so a device that simply never sends
// a newline is not silenced.
function trimToLineStart(m, buf) {
  const s = m.lineSync;
  s.bytes += buf.length;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a && buf[i] !== 0x0d) continue;
    s.pending = false;
    let start = i + 1;
    while (start < buf.length && (buf[start] === 0x0a || buf[start] === 0x0d)) start++;
    return buf.subarray(start);
  }
  if (s.bytes > 4096 || Date.now() - s.since > 2000) { s.pending = false; return buf; }
  return null;   // still inside the partial line
}

// Bring a freshly opened port to a known state before anything reaches the
// terminal. The device buffers output while nobody holds the port, so the first
// thing a new session would otherwise see is history — starting wherever the
// ring happened to wrap. A carriage return makes the console speak, which
// flushes what it was holding; that whole exchange happens muted and is thrown
// away, and only then does a second return produce the greeting the user sees.
async function syncConsole(m) {
  const CR = () => new Uint8Array([0x0d]);
  const wasMuted = m.muted;
  m.muted = true;                       // the reader drops everything meanwhile
  try {
    await m.writer.write(CR());
    await sleep(100);
  } catch (_) { /* port went away mid-handshake */ }
  // The mute window has already discarded the partial opening line, so the
  // byte-level trim has nothing left to do and would only eat the greeting.
  if (m.lineSync) m.lineSync.pending = false;
  m.muted = wasMuted;
  if (!wasMuted) { try { await m.writer.write(CR()); } catch (_) { /* gone */ } }
}

// Ask the console to say where it is. The firmware answers a bare CR with the
// transport it is running on ("Spangap console on serial jtag" / "… cdc 0"),
// which is the only thing that confirms the port just opened is the console and
// not the device's second CDC port. Nothing is muted around it: a port that has
// just come back may be mid-boot-log, and that is precisely what must survive.
async function pokeConsole(m) {
  try { await m.writer.write(new Uint8Array([0x0d])); } catch (_) { /* port went away */ }
}

// Emit one of flashmon's own "-- … --" notices, with exactly one empty line
// above and below and never two. Neither can be written literally at each site:
// the device leaves the cursor wherever its last write ended — mid-prompt, as
// often as not — so a bare writeln lands on that line, and a blank written
// unconditionally doubles up whenever notices arrive back to back. So the
// terminal is asked where the cursor is, and whether a blank is already there.
function note(target, text) {
  const t = (target && target.term) || target;
  if (!t) return;
  // Finish a partial line first: the device leaves the cursor wherever its last
  // write ended — mid-prompt, as often as not — and a bare writeln would land
  // on it, running the notice onto the end of whatever was there.
  let atLineStart = true;
  try { atLineStart = t.buffer.active.cursorX === 0; } catch (_) { atLineStart = false; }
  if (!atLineStart) t.write('\r\n');
  // One blank above, and none below. The blank below is left to whatever comes
  // next to provide: the next notice opens with one, and the firmware's own
  // messages lead with a newline. Writing one here as well is what put two
  // empty lines above every "Spangap console on serial …".
  t.writeln('');
  t.writeln(text);
}

// Detach the reader/writer and close the port (leaving the terminal intact).
async function detachStreams(m) {
  if (m.reader) { try { await m.reader.cancel(); } catch (_) { /* gone */ } m.reader = null; }
  if (m.writer) { try { await m.writer.abort(); } catch (_) { /* gone */ } m.writer = null; }
  // Only close a port that still has a device behind it. With the device gone
  // the OS handle is already dead — close() has nothing to release, and on a
  // vanished port it is one of Web Serial's known hang spots, which would wedge
  // every caller that awaits this (the detect and flash flows among them).
  if (m.port.connected !== false) { try { await m.port.close(); } catch (_) { /* already closed */ } }
}

// Open the port at m.cfg and pump it both ways: bytes → xterm, keystrokes → port.
//
// `sync` runs the opening handshake muted, discarding the first ~100 ms. That is
// right exactly once — on a port nobody was holding, whose backlog starts
// wherever the device's ring happened to wrap. It is wrong everywhere else, and
// not by a margin: the bytes arriving just after a port comes back are as often
// a boot log, from a device that reset or was power-cycled, as they are stale.
// Nothing here can tell those apart — same bytes, same position — so a reattach
// keeps everything and leaves it to the device not to replay its own history.
async function attachStreams(m, sync = false) {
  await m.port.open(m.cfg);
  holdPort(m.port);              // it opened — the live object for its identity
  m.lineSync = sync ? { pending: true, bytes: 0, since: Date.now() } : null;
  m.reader = m.port.readable.getReader();
  m.writer = m.port.writable.getWriter();

  const reader = m.reader;   // capture: m.reader is swapped out on reconfigure
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        // Muted until the first reset is issued, so only post-reset output shows.
        if (value && !m.muted) {
          m.rxSeq++;                 // any byte activity (watched by the stuck watchdog)
          if (!$('stuck-overlay').hidden) $('stuck-overlay').hidden = true;  // device came back
          // Activity counts above even while the opening partial line is being
          // dropped; only what reaches the terminal and the parser is trimmed.
          const out = m.lineSync && m.lineSync.pending ? trimToLineStart(m, value) : value;
          if (!out || out.length === 0) continue;
          m.term.write(out);         // xterm decodes as UTF-8
          m.rngJustArmed = false;
          feedNetParser(m, out);     // watch the boot log for WiFi state lines
          // If the RNG-stuck watchdog was armed by an EARLIER chunk and more
          // output has now arrived, the device kept going — it wasn't stuck.
          if (m.rngArmed && !m.rngJustArmed) { clearTimeout(m.rngTimer); m.rngArmed = false; }
        }
      }
    } catch (_) {
      /* cancel() during detach lands here — expected */
    } finally {
      try { reader.releaseLock(); } catch (_) { /* */ }
    }
  })();

  // Either way the console is asked to identify itself; `sync` only decides
  // whether the exchange runs muted, discarding what the port was holding.
  if (sync) await syncConsole(m);
  else      await pokeConsole(m);
}

async function closeMonitor() {
  if (!monitor) return;
  const m = monitor;
  monitor = null;
  // A handover's outgoing session renders into the terminal disposed below, so
  // it cannot outlive it.
  if (priorSession) { const old = priorSession; priorSession = null; await detachStreams(old); }
  clearTimeout(m.rngTimer);
  clearTimeout(m.versionTimer);
  await detachStreams(m);
  m.resizeObserver.disconnect();
  m.term.dispose();
  setMonTitle(null);   // back to the flasher landing: drop the device hostname
}

// Hard-reset into the app: assert RTS (EN low = reset), hold, then release. DTR
// stays low so GPIO0 is high and the chip boots the firmware, not the ROM stub.
async function resetDevice(port) {
  await port.setSignals({ dataTerminalReady: false, requestToSend: true });
  await sleep(100);
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
}

// Open the fullscreen monitor on a (closed) port. `banner` (an array of chip-info
// lines, printed first) is followed by a blank line; doReset then resets the chip
// once the terminal is listening so the boot log that follows is captured.
// One port's worth of session state. The terminal and its resize observer are
// passed in rather than owned, so a handover can build a second session that
// renders into the terminal the first one was already using.
function makeSession(port, term, resizeObserver, muted) {
  return { port, term, resizeObserver, cfg: { ...DEFAULT_CFG }, reader: null, writer: null,
           gone: false, reattaching: false, muted,
           lineBuf: '', decoder: new TextDecoder(), aps: new Map(), hostname: HOSTNAME_DEFAULT,
           // Setup coordinator: password dialog → wifi dialog → one batched send.
           needPasswd: false, passwdResolved: false, newPasswd: null, passwdOpen: false,
           wifiNeeded: false, wifiResolved: false, wifiCfg: null, wifiOpen: false,
           connectedSeen: false, setupSent: false, hostnameQueried: false,
           // Flash offer: the identified board and the running firmware's build
           // stamp (from its boot log), which gate whether a newer image is offered.
           // hwDetected records that the board came from a detection run (which
           // reads the hardware), so the boot log's weaker claim can't overwrite it.
           // versionSettled goes true once the stamp arrives or the grace expires,
           // so an up-to-date device never flashes the button on the way there.
           hw: null, hwDetected: false, deviceVersion: null, versionSettled: false, versionTimer: null,
           rxSeq: 0, rngArmed: false, rngJustArmed: false, rngTimer: null, rngRecovering: false };
}

// The port a console handover moved away from. Its streams stay up and keep
// rendering into the shared terminal until the device drops it, so the last
// words of the outgoing port are not lost. Never the target of typed input.
let priorSession = null;

// The composite device the firmware presents while running two CDC ports.
// Espressif's shared VID; the PID is TinyUSB's class-derived one, 0x4000 with
// the CDC count in the low bits.
const CDC_FILTER = { usbVendorId: 0x303A, usbProductId: 0x4002 };

// The USB-Serial-JTAG controller, the device's other console transport.
const JTAG_ID = { usbVendorId: 0x303A, usbProductId: 0x1001 };

// Name the transport a port belongs to. During a console move two devices are
// in play and "Serial port gone" leaves the reader guessing which one it means.
function portLabel(port) {
  try {
    const { usbVendorId: vid, usbProductId: pid } = port.getInfo();
    if (vid === JTAG_ID.usbVendorId && pid === JTAG_ID.usbProductId) return 'JTAG serial port';
    if (vid === CDC_FILTER.usbVendorId && pid === CDC_FILTER.usbProductId) return 'CDC serial port';
  } catch (_) { /* info unavailable */ }
  return 'Serial port';
}

// Every USB identity this one physical device has enumerated under. A console
// handover changes it — the USB-Serial-JTAG controller and the TinyUSB
// composite are different devices to the host — and a reset changes it back, so
// matching a returning port against the current session alone loses it.
let knownIds = [];

function noteDeviceId(port) {
  try {
    const { usbVendorId: vid, usbProductId: pid } = port.getInfo();
    if (vid == null || pid == null) return;
    const add = (v, p2) => {
      if (!knownIds.some((k) => k.vid === v && k.pid === p2)) knownIds.push({ vid: v, pid: p2 });
    };
    add(vid, pid);
    // The two transports are one device: a console switch swaps between them,
    // and a reset out of CDC mode comes back as the JTAG controller. Learning
    // one means the other must be followed too — a session opened straight on
    // CDC would otherwise refuse the JTAG identity the device reboots into.
    if (vid === JTAG_ID.usbVendorId && pid === JTAG_ID.usbProductId)
      add(CDC_FILTER.usbVendorId, CDC_FILTER.usbProductId);
    if (vid === CDC_FILTER.usbVendorId && pid === CDC_FILTER.usbProductId)
      add(JTAG_ID.usbVendorId, JTAG_ID.usbProductId);
  } catch (_) { /* info unavailable */ }
}

function isKnownDevice(port) {
  if (!knownIds.length) return true;      // nothing learned yet — accept
  try {
    const { usbVendorId: vid, usbProductId: pid } = port.getInfo();
    if (vid == null || pid == null) return true;
    return knownIds.some((k) => k.vid === vid && k.pid === pid);
  } catch (_) { return true; }
}

async function openMonitor(port, doReset, banner) {
  $('monitor').hidden = false;

  const term = new Terminal({
    fontSize: 12,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    theme: { background: '#000000', foreground: '#e0e0e0' },
    cursorBlink: true,
    scrollback: 10000,
    convertEol: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open($('monitor-term'));
  fit.fit();
  // The monospace cell size isn't known until the font loads; an early fit
  // over-counts rows so the content overflows. Re-fit once the font is ready
  // (and after a tick, as a backstop), and focus so keystrokes reach xterm.
  if (document.fonts?.ready) document.fonts.ready.then(() => fit.fit());
  setTimeout(() => { fit.fit(); term.focus(); }, 50);
  const resizeObserver = new ResizeObserver(() => fit.fit());
  resizeObserver.observe($('monitor-term'));

  // Drop incoming bytes until the first reset (below); a plain terminal with no
  // reset shows everything from the start.
  monitor = makeSession(port, term, resizeObserver, doReset);
  knownIds = [];              // a fresh session: forget the previous device
  presence.clear();
  noteDeviceId(port);
  presence.set(idKey(port), true);
  $('monitor-baud').textContent = fmtCfg(monitor.cfg);
  setMonTitle(null);   // new session: no hostname until the device logs one

  // Forward keystrokes to the current writer. The device's serial line stays in
  // log mode until it receives input, then switches to the interactive CLI.
  const encoder = new TextEncoder();
  term.onData((data) => {
    const w = monitor && monitor.writer;
    if (w) w.write(encoder.encode(data)).catch(() => { /* port gone */ });
  });

  await attachStreams(monitor, true);   // fresh port: discard the wrapped backlog

  if (banner && banner.length) {
    for (const line of banner) term.writeln(`\x1b[36m${line}\x1b[0m`);
    term.writeln('');
  }
  if (doReset) {
    await resetDevice(port);
    monitor.muted = false;   // from here on, show the device's post-reset output
  }
}

// Re-open the port with new line settings, keeping the same terminal + buffer.
async function applyCfg() {
  if (!monitor) return;
  const cfg = {
    baudRate: parseInt($('cfg-baud').value, 10) || 115200,
    dataBits: parseInt($('cfg-data').value, 10) || 8,
    stopBits: parseInt($('cfg-stop').value, 10) || 1,
    parity: $('cfg-parity').value || 'none',
  };
  closeCfg();
  monitor.cfg = cfg;
  try {
    await detachStreams(monitor);
    await attachStreams(monitor);
    $('monitor-baud').textContent = fmtCfg(cfg);
    monitor.term.writeln(`\r\n\x1b[36m── serial ${fmtCfg(cfg)} ──\x1b[0m`);
  } catch (e) {
    monitor.term.writeln(`\r\n\x1b[31m── reconfigure failed: ${e && e.message ? e.message : e} ──\x1b[0m`);
  }
  monitor.term.focus();
}

// ── monitor UI wiring ───────────────────────────────────────────────────────
$('monitor-reset').addEventListener('click', async () => {
  if (!monitor) return;
  const { port, term } = monitor;
  // A reset reboots the device, so the whole setup flow (password dialog, wifi
  // dialog, button + info dialog) should run afresh.
  hideOpenUi();
  uiInfoShown = false;
  closeDialogs(monitor);   // clear any dialog that's up (info / choice / stuck / setup)
  resetSetup(monitor);
  // Print the label first — resetDevice holds the line for ~100 ms and the boot
  // log starts streaming during that window, so writing it after would interleave.
  note(term, '\x1b[31m-- Reset pressed --\x1b[0m');
  try {
    await resetDevice(port);
  } catch (e) {
    note(term, `\x1b[31m-- reset failed: ${e && e.message ? e.message : e} --\x1b[0m`);
  }
  term.scrollToBottom();   // snap to the bottom so the boot log scrolls into view
  term.focus();            // so the next Enter goes to the device, not this button
});

function openCfg() { $('serial-cfg').hidden = false; $('cfg-overlay').hidden = false; }
function closeCfg() { $('serial-cfg').hidden = true; $('cfg-overlay').hidden = true; }

$('monitor-baud').addEventListener('click', () => {
  if ($('serial-cfg').hidden) openCfg(); else closeCfg();
});
$('cfg-overlay').addEventListener('click', closeCfg);
$('cfg-apply').addEventListener('click', applyCfg);

// ── FNB58 USB power meter (WebHID) ──────────────────────────────────────────
// A FNIRSI FNB58/FNB48 is a USB-HID device (not a serial port), so it rides
// WebHID alongside the device's Web Serial monitor in this same tab. We open it,
// kick the vendor stream with three 64-byte 0xaa commands, and each 64-byte
// input report carries four 15-byte samples (voltage u32 LE, current u32 LE,
// /100000 → volts/amps). At ~100 samples/s we ring-buffer each reading with its
// arrival timestamp (up to 5 minutes) and paint a scrolling bar graph across the
// top of the monitor.
const FNB58_MAX_SEC = 300;                     // keep at most 5 minutes of samples
const FNB58_CAP = 100 * FNB58_MAX_SEC;         // ring size at the nominal ~100 Hz
const FNB58_WINDOWS = [10, 30, 60, 180, 300];  // selectable display spans (seconds)
const FNB58_FILTERS = [{ vendorId: 0x2e3c }, { vendorId: 0x0483 }];
const isFnb58 = (d) => FNB58_FILTERS.some((f) => f.vendorId === d.vendorId);
// These meters have NO stop command and freeze if the connection is closed while
// their internal FIFO still holds data (a documented FNIRSI quirk) — a frozen meter
// then crashes the next session, and because the freeze is in the meter's USB stack
// it survives a Chrome restart and an FNB power-cycle; only a replug (or long wait)
// clears it. The cure (mirroring baryluk's logger) is to DRAIN before closing: stop
// the keepalive, keep reading for FNB58_DRAIN_MS so the browser empties the FIFO,
// then close (fnbTeardown). Backing that up, a shared LocalSettings timestamp marks
// when the meter was last active (refreshed every 5 s while streaming and stamped
// again at disconnect) and imposes a short settle cooldown before the label returns;
// that same stamp keeps two tabs off the meter at once — while one streams it stays
// fresh, so other tabs stay dark.
const FNB58_ACTIVE_KEY = 'flashmon.fnb58LastData';  // LocalSettings: epoch ms the meter was last active
const FNB58_COOLDOWN_MS = 3000;                      // brief settle before the label returns (backup to the drain)
const FNB58_DATA_WAIT_MS = 1500;                    // how long one open attempt gets to yield valid data
const FNB58_LOSS_MS = 3000;                          // no data for this long → the stream stalled
const FNB58_RETRY_MS = 250;                          // pause between clean open retries
const FNB58_PROBE_MS = 400;                          // listen this long for an already-running stream before init
const FNB58_DRAIN_MS = 1000;                         // keep reading (keepalive off) before close, to empty the meter's FIFO
// Per-column band shades, bottom→top: the sustained floor (0→min) brightest, then
// the spread up to the mean, then the peak (avg→max) darkest; above max is the
// panel background, drawn per column so each frame overdraws the last (no clear).
const FNB_MIN_COL = '#56d364';   // 0 → min
const FNB_AVG_COL = '#2ea043';   // min → avg
const FNB_MAX_COL = '#166b2c';   // avg → max
const FNB_BG_COL  = '#0d1117';   // max → top (matches #fnb58-panel background)

// ma/ts: parallel rings of current (mA) and arrival time (ms, performance.now).
// wpos/len: ring write head + fill. winSel: index into FNB58_WINDOWS when the
// user has pinned a span, else null (auto: smallest window that holds every
// sample). shownWin: the span the pills currently reflect, so we only touch the
// DOM when it changes.
const fnb = { device: null, refreshTimer: null, raf: 0,
  ma: new Float32Array(FNB58_CAP), ts: new Float64Array(FNB58_CAP),
  wpos: 0, len: 0, winSel: null, shownWin: -1, shownAuto: false,
  // lastData: performance.now() of the newest valid report (0 = none yet). Drives
  // the stall watchdog and the LocalSettings active stamp. connecting/recovering/
  // stopping guard the open, auto-recover, and teardown flows so they never overlap.
  lastData: 0, connecting: false, recovering: false, stopping: false };

// A vendor command is 64 bytes: 0xaa, type byte, 61 zeros, trailing checksum.
function fnbCmd(type, csum) { const p = new Uint8Array(64); p[0] = 0xaa; p[1] = type; p[63] = csum; return p; }

function fnbPush(mA, t) {
  fnb.ma[fnb.wpos] = mA;
  fnb.ts[fnb.wpos] = t;
  fnb.wpos = (fnb.wpos + 1) % FNB58_CAP;
  if (fnb.len < FNB58_CAP) fnb.len++;
}
// Empty the buffer and hand the window back to auto (→ smallest span, 10 s).
function fnbClear() { fnb.wpos = 0; fnb.len = 0; fnb.winSel = null; }
// Ring index of the k-th oldest stored sample (k = 0 → oldest, len-1 → newest).
function fnbIdx(k) { return (fnb.wpos - fnb.len + k + FNB58_CAP * 2) % FNB58_CAP; }
// Timestamp span of the buffer in seconds (0 with fewer than two samples).
function fnbSpanSec() {
  if (fnb.len < 2) return 0;
  return (fnb.ts[fnbIdx(fnb.len - 1)] - fnb.ts[fnbIdx(0)]) / 1000;
}
// Active display span: the pinned window, or the smallest that holds the buffer.
function fnbWindowSec() {
  if (fnb.winSel != null) return FNB58_WINDOWS[fnb.winSel];
  const span = fnbSpanSec();
  return FNB58_WINDOWS.find((w) => span <= w) || FNB58_WINDOWS[FNB58_WINDOWS.length - 1];
}

// Place the peak pill against its column (frac = 0..1 across the graph), to the
// right of it, flipping left only when it would overflow — mirrors the web UI.
function placeFnbPeak(frac) {
  const el = $('fnb58-peak');
  const gw = el.parentElement.clientWidth;
  const peakX = frac * gw, gap = 3;
  if (peakX + gap + el.offsetWidth <= gw) { el.style.left = `${peakX + gap}px`; el.style.right = 'auto'; }
  else { el.style.right = `${Math.max(0, gw - peakX + gap)}px`; el.style.left = 'auto'; }
}

function onFnb58Report(e) {
  const d = e.data;                            // DataView, report id stripped
  if (d.byteLength < 62 || d.getUint8(0) !== 0xaa || d.getUint8(1) !== 0x04) return;
  // One arrival stamp for the report; the four readings within it fall in the
  // same ~10 ms and get resolved by the per-pixel averaging at draw time.
  const t = performance.now();
  fnb.lastData = t;                              // valid report → the stream is alive
  for (let i = 0; i < 4; i++) {
    const o = 2 + i * 15;
    // Current is a u32 in units of 1e-5 A (0.01 mA resolution); keep it as a float
    // (raw/100 mA), not rounded, so the sub-mA detail survives to the readout.
    fnbPush(d.getUint32(o + 4, true) / 100, t);
  }
}

// Short pill label for a window span: "10s", "30s", "1m", "3m", "5m".
function fnbFmtWin(sec) { return sec < 60 ? `${sec}s` : `${sec / 60}m`; }

// Format a current/average reading in mA. Below 20 mA one decimal shows the
// sub-mA detail that matters at low draw; at 20 mA and up a whole number reads
// cleaner and the tenths are noise.
function fnbFmtMa(v) { return (v < 20 ? v.toFixed(1) : v.toFixed(0)) + ' mA'; }

// Build the window pills once, when the meter opens. Clicking a pill pins that
// span; clicking the pinned one again hands the window back to auto.
function fnbBuildPills() {
  const row = $('fnb58-controls');
  const now = $('fnb58-now');                   // live readout lives in this bar; keep it
  row.querySelectorAll('.fnb58-pill').forEach((b) => b.remove());
  FNB58_WINDOWS.forEach((sec, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fnb58-pill';
    b.textContent = fnbFmtWin(sec);
    b.dataset.i = i;
    b.addEventListener('click', () => {
      fnb.winSel = (fnb.winSel === i) ? null : i;
      fnb.shownWin = -1;                        // force fnbSyncPills to repaint
    });
    row.insertBefore(b, now);                   // pills left, the now readout stays right
  });
  fnb.shownWin = -1;
}

// Reflect the active span on the pills: the current window is highlighted —
// solid when pinned, dashed while auto-tracking the buffer (the dashed border is
// the only "auto" signal we need; no separate tag).
function fnbSyncPills(winSec) {
  const auto = fnb.winSel == null;
  if (fnb.shownWin === winSec && fnb.shownAuto === auto) return;
  fnb.shownWin = winSec; fnb.shownAuto = auto;
  const row = $('fnb58-controls');
  row.querySelectorAll('.fnb58-pill').forEach((b) => {
    const active = FNB58_WINDOWS[+b.dataset.i] === winSec;
    b.classList.toggle('on', active && !auto);
    b.classList.toggle('auto', active && auto);
  });
}

// Relative time label for the axis: "now", "−45s", or "−3:20" past a minute.
function fnbFmtAgo(sec) {
  if (sec <= 0.5) return 'now';
  if (sec < 60) return `−${Math.round(sec)}s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return s ? `−${m}:${String(s).padStart(2, '0')}` : `−${m}:00`;
}

// Paint the axis labels under the graph: a handful of evenly spaced marks from
// the window's left edge (oldest) to "now" at the right.
function fnbRenderTimes(winSec) {
  const row = $('fnb58-times');
  const n = 5;
  if (row.childElementCount !== n) {
    row.textContent = '';
    for (let i = 0; i < n; i++) row.appendChild(document.createElement('span'));
  }
  for (let i = 0; i < n; i++)
    row.children[i].textContent = fnbFmtAgo(winSec * (1 - i / (n - 1)));
}

function fnbRender() {
  const cv = $('fnb58-canvas');
  const wrap = cv.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // No clearRect: the draw loop paints every column full-height (bands + the
  // background remainder above max), so each frame fully overdraws the previous
  // one. Clearing first is what let the graph flash to blank between frames.

  const winSec = fnbWindowSec();
  fnbSyncPills(winSec);
  fnbRenderTimes(winSec);

  // One column per pixel. The right edge is the newest sample's time; each
  // column averages every reading whose timestamp lands in its dt-wide slice.
  // Averaging (not max) keeps a single spike from inflating a whole pixel, and
  // anchoring by time — not sample index — is what stops the scroll shimmering.
  const cols = Math.max(1, Math.floor(w));
  const dt = (winSec * 1000) / cols;           // ms of history per pixel column
  const tEnd = fnb.len ? fnb.ts[fnbIdx(fnb.len - 1)] : 0;
  // Bin on an ABSOLUTE dt grid (floor(t/dt)), not relative to the moving newest
  // sample: a reading then keeps its column until real time crosses a whole dt,
  // so the graph steps exactly one pixel at a time. Relative binning re-slices
  // every frame — a stationary peak shimmers between adjacent columns, and that
  // sub-pixel jitter is what makes equal peaks trade the label.
  const lastBin = Math.floor(tEnd / dt);
  const firstBin = lastBin - cols + 1;
  const sum = new Float64Array(cols);
  const cnt = new Uint32Array(cols);
  const mn = new Float64Array(cols).fill(Infinity);
  const mx = new Float64Array(cols).fill(-Infinity);
  let avgSum = 0;
  for (let k = 0; k < fnb.len; k++) {
    const r = fnbIdx(k);
    const v = fnb.ma[r];
    avgSum += v;                                // avg spans the whole buffer
    const col = Math.floor(fnb.ts[r] / dt) - firstBin;
    if (col < 0 || col >= cols) continue;
    sum[col] += v; cnt[col]++;
    if (v < mn[col]) mn[col] = v;
    if (v > mx[col]) mx[col] = v;
  }

  // Per column: min / avg / max, or NaN where no sample landed. Interior gaps get
  // all three linearly interpolated from their nearest filled neighbours; runs
  // with no data (left of the oldest sample, or a stall) stay NaN → drawn as
  // background, so the graph still fills from the right.
  const aMin = new Float64Array(cols);
  const aAvg = new Float64Array(cols);
  const aMax = new Float64Array(cols);
  let prev = -1;
  for (let c = 0; c < cols; c++) {
    if (cnt[c]) {
      aMin[c] = mn[c]; aAvg[c] = sum[c] / cnt[c]; aMax[c] = mx[c];
      if (prev >= 0 && c - prev > 1) {
        const span = c - prev;
        for (let j = prev + 1; j < c; j++) {
          const f = (j - prev) / span;
          aMin[j] = aMin[prev] + (aMin[c] - aMin[prev]) * f;
          aAvg[j] = aAvg[prev] + (aAvg[c] - aAvg[prev]) * f;
          aMax[j] = aMax[prev] + (aMax[c] - aMax[prev]) * f;
        }
      }
      prev = c;
    } else {
      aMin[c] = aAvg[c] = aMax[c] = NaN;
    }
  }

  // Peak label tracks the drawn MAX, so the pill always lands on a bar that
  // actually reaches it. Column = most-recent one whose max rounds to the peak
  // integer — a stable tie-break so equal-height peaks don't trade the pill (and
  // three don't cycle): the shown mA decides, not a hair of sub-mA jitter.
  let peak = 0;
  for (let c = 0; c < cols; c++)
    if (!Number.isNaN(aMax[c]) && aMax[c] > peak) peak = aMax[c];
  const niceMax = Math.max(10, Math.ceil(peak / 10) * 10);
  const peakR = Math.round(peak);
  let peakCol = -1;
  for (let c = 0; c < cols; c++)
    if (!Number.isNaN(aMax[c]) && aMax[c] > 0 && Math.round(aMax[c]) === peakR) peakCol = c;

  // Draw each column full-height: background remainder on top, then the three
  // stacked bands (avg→max darkest, min→avg, 0→min brightest). Painting every
  // column — including empty ones as solid background — fully overdraws the frame.
  const scale = (h - 2) / niceMax;               // px per mA (2px headroom at the top)
  for (let c = 0; c < cols; c++) {
    if (Number.isNaN(aAvg[c])) {                 // no data here → all background
      ctx.fillStyle = FNB_BG_COL; ctx.fillRect(c, 0, 1, h);
      continue;
    }
    const yMax = h - Math.max(0, aMax[c]) * scale;
    const yAvg = h - Math.max(0, aAvg[c]) * scale;
    const yMin = h - Math.max(0, aMin[c]) * scale;
    ctx.fillStyle = FNB_BG_COL;  ctx.fillRect(c, 0,    1, yMax);         // max → top
    ctx.fillStyle = FNB_MAX_COL; ctx.fillRect(c, yMax, 1, yAvg - yMax);  // avg → max
    ctx.fillStyle = FNB_AVG_COL; ctx.fillRect(c, yAvg, 1, yMin - yAvg);  // min → avg
    ctx.fillStyle = FNB_MIN_COL; ctx.fillRect(c, yMin, 1, h - yMin);     // 0 → min
  }

  const pill = $('fnb58-peak');
  if (peakCol >= 0) {
    pill.textContent = fnbFmtMa(peak);
    pill.hidden = false;
    placeFnbPeak((peakCol + 0.5) / cols);
  } else {
    pill.hidden = true;
  }

  const now = fnb.len ? fnb.ma[fnbIdx(fnb.len - 1)] : null;
  $('fnb58-now').textContent = now != null ? fnbFmtMa(now) : '—';
  const avg = fnb.len ? avgSum / fnb.len : null;
  const sec = fnbSpanSec();
  $('fnb58-avg-val').textContent = avg != null ? fnbFmtMa(avg) : '— mA';
  $('fnb58-avg-win').textContent = avg != null ? `last ${Math.round(sec)} s` : 'last — s';
}

function fnbLoop() {
  if ($('fnb58-panel').hidden) return;
  fnbRender();
  fnb.raf = requestAnimationFrame(fnbLoop);
}

// Stamp "the meter was active just now" into shared LocalSettings. Written every
// 5 s while streaming and once more at disconnect, so the cooldown always runs a
// full FNB58_COOLDOWN_MS from the last real activity.
function fnbMarkActive() { try { localStorage.setItem(FNB58_ACTIVE_KEY, String(Date.now())); } catch (_) {} }
// How long ago (ms) the meter was last active, per the shared stamp — Infinity if
// never. Ours or another tab's, it's the same physical meter needing the same idle.
function fnbActiveAgo() {
  try {
    const v = localStorage.getItem(FNB58_ACTIVE_KEY);
    if (!v) return Infinity;
    return Date.now() - parseInt(v, 10);
  } catch (_) { return Infinity; }
}
// Still cooling down: the meter was active within FNB58_COOLDOWN_MS, so reopening
// it now would re-init a not-yet-idle unit and crash it. Blocks the open and hides
// the label until it clears. (True only when WE aren't the one holding it.)
function fnbCoolingDown() { return fnbActiveAgo() < FNB58_COOLDOWN_MS; }

// Bind a present meter and start its stream: open a CLEAN handle (close any stale
// one this tab still holds first, so our open() is never a second connect on top
// of our own leftover), wire the report handler, arm the 1 Hz keep-alive + stall
// watchdog, then start the stream ONLY if it isn't already running. Does not decide
// success — the caller waits for valid data (fnbAwaitData).
async function fnbBind(device, allowInit) {
  if (device.opened) { try { await device.close(); } catch (_) {} }   // never stack a second open
  await device.open();
  fnb.device = device;
  fnb.lastData = 0;
  fnbClear();
  fnbBuildPills();
  device.addEventListener('inputreport', onFnb58Report);
  clearInterval(fnb.refreshTimer);
  fnb.refreshTimer = setInterval(fnbTick, 1000);
  // Closing our USB handle doesn't stop the meter — it keeps streaming on its own —
  // so a reopened unit is usually already sending data. Re-sending the start
  // sequence to a live meter is exactly what crashes its firmware. Listen briefly
  // first; only kick the stream if it stays silent (a fresh/idle meter). The stall
  // recovery passes allowInit=false: it only re-latches a stream that's still
  // running, never re-inits (a truly stopped meter must idle out the cooldown first).
  await sleep(FNB58_PROBE_MS);
  if (allowInit && !fnb.lastData) {
    try {                                      // kick the stream (some units auto-stream)
      await device.sendReport(0, fnbCmd(0x81, 0x8e));
      await device.sendReport(0, fnbCmd(0x82, 0x96));
      await device.sendReport(0, fnbCmd(0x82, 0x96));
    } catch (_) { /* keep going; the keep-alive may still start it */ }
  }
}

// 1 Hz while bound: hold the stream open, and if valid data has dried up for
// FNB58_LOSS_MS the stream stalled — actively recover (close and recycle our own
// handle once, else disconnect). We never sit on a silently-open, data-less meter.
function fnbTick() {
  if (!fnb.device) return;
  fnb.device.sendReport(0, fnbCmd(0x83, 0x9e)).catch(() => {});
  if (!fnb.recovering && fnb.lastData && performance.now() - fnb.lastData > FNB58_LOSS_MS)
    fnbAutoRecover();
}

// Reveal the graph panel and light the label — called once a bound meter yields data.
function fnbShowPanel() {
  fnbMarkActive();
  $('fnb58-panel').hidden = false;
  $('monitor').classList.add('fnb58-open');     // slide the terminal + actions clear
  $('monitor-fnb58').classList.add('on');
  cancelAnimationFrame(fnb.raf);
  fnbLoop();
}

// Detach the meter (streams + timers) without touching the panel, and AWAIT the
// close so the OS handle is truly released before anything opens it again — an
// un-awaited close is exactly what lets the next open() land as a second connect.
async function fnbUnbind() {
  clearInterval(fnb.refreshTimer); fnb.refreshTimer = null;
  const d = fnb.device;
  fnb.device = null;                            // clear first so fnbTick stops acting on it
  fnb.lastData = 0;
  if (d) {
    try { d.removeEventListener('inputreport', onFnb58Report); } catch (_) {}
    try { await d.close(); } catch (_) {}
  }
}

// Close every granted meter handle this tab still holds — belt-and-suspenders
// before a connect, so no leftover open() from a prior session is live when we
// open a fresh one. (close() only reaches this tab's own handles.)
async function fnbCloseGranted() {
  let devices = [];
  try { devices = (await navigator.hid.getDevices()).filter(isFnb58); } catch (_) { return; }
  for (const d of devices) if (d.opened) { try { await d.close(); } catch (_) {} }
}

// Wait up to FNB58_DATA_WAIT_MS for the just-bound meter to deliver a valid
// report. A stale or wedged unit opens but never streams, so "opened" is not
// "working" — actual data is the only proof.
async function fnbAwaitData(ms) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (fnb.lastData) return true;
    await sleep(120);
  }
  return !!fnb.lastData;
}

// Bind a candidate and confirm it streams, up to `tries` clean open→wait→close
// cycles (each close awaited before the next open — never overlapping handles).
// `allowInit` (default true) lets a fresh/idle meter be kicked into streaming; the
// stall recovery passes false to only re-latch an already-running stream. On success
// reveal the panel; on failure nothing is left open. Returns whether it's now live.
async function fnbTryDevice(device, tries, allowInit = true) {
  for (let a = 0; a < tries; a++) {
    try { await fnbBind(device, allowInit); }
    catch (_) { await fnbUnbind(); if (a + 1 < tries) await sleep(FNB58_RETRY_MS); continue; }
    if (await fnbAwaitData(FNB58_DATA_WAIT_MS)) { fnbShowPanel(); return true; }
    await fnbUnbind();
    if (a + 1 < tries) await sleep(FNB58_RETRY_MS);
  }
  return false;
}

// Try each already-granted meter; stream the first that yields data (with retries).
async function fnbTryGranted(tries) {
  let devices = [];
  try { devices = (await navigator.hid.getDevices()).filter(isFnb58); } catch (_) { return false; }
  for (const d of devices) if (await fnbTryDevice(d, tries)) return true;
  return false;
}

function fnbShowTrouble() {
  showInfo('FNB58', '<p>Couldn’t get a reading from the FNB58. These meters can freeze if a ' +
    'session ends abruptly — the surest fix is to <b>unplug the FNB58 and plug it back in</b>, ' +
    'then click <b>FNB58</b> again.</p>');
}

// Connect the meter — only ever from the user clicking the FNB58 label. Opening
// the panel is always a deliberate act; nothing connects on its own. First honour
// the cooldown (a recently-active meter isn't idle enough to re-init — that's the
// crash), then reuse an existing grant silently; if that yields no data it re-asks
// the HID chooser; if that too yields nothing, it points the user at a power-cycle.
async function fnbConnect() {
  if (!('hid' in navigator)) {
    showInfo('FNB58', '<p>This browser has no WebHID support. Use Chrome or Edge, served over HTTPS (or localhost).</p>');
    return;
  }
  if (fnb.connecting || fnb.recovering || fnb.stopping || fnb.device) return;
  if (fnbCoolingDown()) {                          // meter not idle yet — reopening now would crash it
    const wait = Math.ceil((FNB58_COOLDOWN_MS - fnbActiveAgo()) / 1000);
    showInfo('FNB58', `<p>The FNB58 was just in use and needs a moment to settle — reopening it too soon crashes it. ` +
      `Give it about <b>${wait}s</b> (the FNB58 button comes back on its own), then click again.</p>`);
    return;
  }
  fnb.connecting = true;
  try {
    await fnbCloseGranted();                        // drop any stale handle this tab still holds
    // Grant phase is a SINGLE lean attempt: the common reconnect streams within a
    // few hundred ms, and staying lean here keeps the click's ~5 s transient
    // activation alive for the requestDevice() fallback below. The chooser device
    // then gets the generous retries (no activation clock once it's picked).
    if (await fnbTryGranted(1)) return;
    let device = null;
    try { device = (await navigator.hid.requestDevice({ filters: FNB58_FILTERS })).filter(isFnb58)[0]; }
    catch (_) { /* chooser dismissed */ }
    if (device && await fnbTryDevice(device, 3)) return;
    fnbShowTrouble();
  } finally {
    fnb.connecting = false;
  }
}

// The stream stalled (no valid data for FNB58_LOSS_MS). Actively let go: close our
// own handle, then try ONE clean recycle to re-latch a still-running stream WITHOUT
// re-initing (sequential — never an overlapping open, and never a re-init that could
// crash a meter that has actually stopped). If nothing comes back, disconnect for
// real; the cooldown then holds reconnect off until the meter has idled.
async function fnbAutoRecover() {
  if (fnb.recovering || fnb.connecting || !fnb.device) return;
  fnb.recovering = true;
  const device = fnb.device;
  try {
    if (monitor) { try { monitor.term.writeln('\x1b[33m-- FNB58 stream stalled; reconnecting… --\x1b[0m'); } catch (_) {} }
    await fnbUnbind();                             // release our handle before touching it again
    await sleep(FNB58_RETRY_MS);
    if (await fnbTryDevice(device, 1, false)) return;   // re-latch a live stream (no re-init)
    await fnbTeardown();                           // gone quiet → disconnect; cooldown gates the reopen
    if (monitor) { try { monitor.term.writeln('\x1b[31m-- FNB58 disconnected (no data) --\x1b[0m'); } catch (_) {} }
  } finally {
    fnb.recovering = false;
  }
}

// Full teardown of the panel + HID session. The FNIRSI meters have no stop command
// and FREEZE if you close while their internal FIFO is full (a documented quirk),
// which is what crashes the next session — so first stop the keepalive and keep the
// device open a moment (FNB58_DRAIN_MS) with reports still being consumed, letting
// the browser empty that FIFO, THEN close. Hides the button at once and stamps the
// meter active so a brief cooldown backs up the drain.
async function fnbTeardown() {
  cancelAnimationFrame(fnb.raf); fnb.raf = 0;
  clearInterval(fnb.refreshTimer); fnb.refreshTimer = null;   // stop the keepalive FIRST
  $('fnb58-panel').hidden = true;
  $('monitor').classList.remove('fnb58-open');
  $('monitor-fnb58').classList.remove('on');
  $('monitor-fnb58').hidden = true;            // hide the button immediately (no 5 s poll lag)
  if (fnb.device) await sleep(FNB58_DRAIN_MS); // drain: browser keeps reading the endpoint until we close
  await fnbUnbind();                           // awaited: the handle is fully released on return
  fnbMarkActive();                             // start the settle cooldown from now
  fnbPollStatus();                             // reconcile the label state right away
}

// User/idle disconnect, serialized via fnb.stopping so a fast reconnect click can't
// race the in-flight close.
async function stopFnb58() {
  if (fnb.stopping) return;
  fnb.stopping = true;
  try { await fnbTeardown(); } finally { fnb.stopping = false; }
}

// Every 5 s: while streaming, keep the shared active stamp fresh (holds the label on
// and keeps other tabs off the meter). Otherwise show the FNB58 label only once the
// cooldown has elapsed — a recently-active meter can't be reopened without crashing,
// so hide the button until it's safe. This is the "keep checking every 5 s".
function fnbPollStatus() {
  const btn = $('monitor-fnb58');
  if (fnb.device) {
    btn.hidden = false;
    if (fnb.lastData && performance.now() - fnb.lastData < 7000) fnbMarkActive();
  } else {
    btn.hidden = fnbCoolingDown();
  }
}

// Close the meter when the tab is navigated away or closed: stamp it active (so a
// reload can't reopen inside the cooldown) and best-effort close the HID session.
function fnbCleanup() {
  if (fnb.device) { fnbMarkActive(); try { fnb.device.close(); } catch (_) {} }
}
window.addEventListener('pagehide', fnbCleanup);
window.addEventListener('beforeunload', fnbCleanup);

// The button toggles: connect (grant → chooser) when idle, clean disconnect when
// streaming. Awaiting stopFnb58 (with its fnb.stopping guard) serializes a fast
// disconnect→reconnect so the second click can't race the in-flight close.
$('monitor-fnb58').addEventListener('click', async () => {
  if (fnb.connecting || fnb.recovering || fnb.stopping) return;
  if (fnb.device) { await stopFnb58(); return; }
  fnbConnect();
});
// Clear the buffer and restart: the average empties and the window auto-tracks
// from scratch (back to the smallest span).
$('fnb58-avg').addEventListener('click', () => { fnbClear(); });
if ('hid' in navigator)
  navigator.hid.addEventListener('disconnect', (e) => { if (e.device === fnb.device) stopFnb58(); });

// ── WiFi connect helper ─────────────────────────────────────────────────────
// The device logs its WiFi progress over serial. We tail that log to:
//   • collect the scanned access points (`scan found "<ssid>" …`),
//   • pop the connect dialog when it gives up and starts its own AP
//     (`AP ssid=… ip=…`), and
//   • learn its address once it associates (`Connected "<ssid>" ip … dns …
//     host <hostname>`) — the hostname drives the Open Device UI target.
// Device log lines look like: `<ts> I [net] <message>`.

// Feed a raw serial chunk through a line splitter; hand each full line to the
// net-log matcher. The decoder is streaming, so a chunk split mid-UTF-8 or
// mid-line is stitched back together across reads.
function feedNetParser(m, chunk) {
  m.lineBuf += m.decoder.decode(chunk, { stream: true });
  let nl;
  while ((nl = m.lineBuf.indexOf('\n')) >= 0) {
    // Strip ANSI escapes before matching: device log lines are colorized, and a
    // trailing reset (\x1b[0m) would otherwise glue onto the last \S+ token on a
    // line (e.g. the hostname → "…[0m.local"). The terminal still gets the raw,
    // colored bytes; only this parser copy is cleaned.
    const line = m.lineBuf.slice(0, nl).replace(/\r$/, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    m.lineBuf = m.lineBuf.slice(nl + 1);
    // This bootloader line marks a fresh boot. Two jobs: (1) the device
    // sometimes wedges right here (stuck serial port) — arm a watchdog that
    // recovers on 2 s of silence; (2) a boot invalidates the previous session,
    // so drop the "Open Device UI" button and restart the setup flow.
    // The console is about to move to a different USB device — offer to follow
    // it. Only from the session that is currently taking input; the outgoing
    // port of an earlier handover must not raise it again.
    if (m === monitor && line.includes('USB JTAG serial port going away')) {
      try { offerConsoleHandover(); } catch (_) { /* keep the monitor alive */ }
    }
    // The reverse move. The JTAG port that appears may have no grant in this
    // session (grants are swept at load), and an ungranted port is invisible —
    // no connect event, absent from getPorts() — so without this the rescan
    // spins over an empty candidate list forever and nothing ever asks.
    if (m === monitor && line.includes('USB CDC ports going away')) {
      try { offerConsoleReturn(); } catch (_) { /* keep the monitor alive */ }
    }
    if (line.includes('Disabling RNG early entropy source')) {
      armRngWatchdog(m);
      hideOpenUi();
      uiInfoShown = false;
      $('info-overlay').hidden = true;
      resetSetup(m);
    }
    // A parse/UI error must never break the byte stream the user is watching.
    try { handleNetLine(m, line); } catch (_) { /* keep the monitor alive */ }
  }
  // Guard against a never-terminated line growing without bound.
  if (m.lineBuf.length > 4096) m.lineBuf = m.lineBuf.slice(-1024);
}

// Arm the "stuck after RNG init" watchdog: fire onRngStuck after 2 s unless more
// output arrives first (the reader loop disarms it on the next chunk). rngJustArmed
// tells that loop this same chunk armed it, so its own trailing bytes don't count
// as "output resumed".
function armRngWatchdog(m) {
  if (m.rngRecovering) return;
  m.rngArmed = true;
  m.rngJustArmed = true;
  clearTimeout(m.rngTimer);
  m.rngTimer = setTimeout(() => { onRngStuck(m); }, 2000);
}

// Recover from the stuck serial port: close it, wait 1 s, reopen. If output
// resumes, we're good; if it stays silent, the device itself is wedged — ask the
// user to reset it.
async function onRngStuck(m) {
  if (monitor !== m || m.gone || m.rngRecovering) return;
  m.rngArmed = false;
  m.rngRecovering = true;
  note(m, '\x1b[33m-- Serial stuck after RNG init; closing and reopening the port… --\x1b[0m');
  try {
    await detachStreams(m);
    await sleep(1000);
    if (monitor !== m) return;
    await attachStreams(m);
  } catch (_) {
    /* reopen failed — treated as "still stuck" below */
  }
  // Did reopening get the bytes flowing again? Watch for any activity.
  const seq0 = m.rxSeq;
  for (let waited = 0; waited < 3000 && m.rxSeq === seq0; waited += 150) await sleep(150);
  m.rngRecovering = false;
  if (monitor !== m) return;
  if (m.rxSeq === seq0) {
    $('stuck-overlay').hidden = false;   // still dead → the device needs a manual reset
  } else {
    note(m, '\x1b[32m-- Serial resumed. --\x1b[0m');
  }
}

function handleNetLine(m, line) {
  // `build: invocation spangap build <buildable> --with spangap/hw-<board> …` —
  // the `spangap build` command that produced the running image, logged on boot.
  // The hw-<straddle> in it names the board the firmware was compiled for, which
  // identifies the device just as a detection run does — for free, without
  // resetting anything. It is a claim about the image, not a reading of the
  // hardware, so a real detection run (hwDetected) outranks it.
  let mm = line.match(/build: invocation\b.*?\b(hw-[a-z0-9-]+)/);
  if (mm) {
    if (m === monitor && !m.hwDetected) armFlashGrace(mm[1], false);
    return;
  }
  // `build: datetime <YYYYMMDDhhmmss>` — the running firmware's catalogue build
  // stamp (spangap-core logs it on boot). Remember it and re-evaluate the flash
  // offer: we only offer an image the catalogue stamps NEWER than what's running.
  mm = line.match(/build: datetime (\d{14})/);
  if (mm) {
    m.deviceVersion = mm[1];
    m.versionSettled = true;
    clearTimeout(m.versionTimer);
    if (m === monitor) refreshFlashOffer();
    return;
  }
  // `scan found "<ssid>" -NNdBm[ open]` — the SSID runs from the first quote to
  // the last quote before the RSSI, so an SSID containing a quote survives.
  mm = line.match(/scan found "(.*)" (-?\d+)dBm(.*)$/);
  if (mm) {
    const ssid = mm[1];
    const open = /\bopen\b/.test(mm[3]);
    if (ssid) m.aps.set(ssid, { ssid, open });
    return;
  }
  // `No device password set` — the device has no admin password. Kick off the
  // setup flow (password dialog first, then wifi if needed).
  if (line.includes('No device password set')) {
    if (!m.needPasswd) { m.needPasswd = true; advanceSetup(m); }
    return;
  }
  // `AP ssid=<ssid> ip=<ip>` — the device gave up and started its own AP.
  if (/\bAP ssid=\S+ ip=\S+/.test(line)) {
    if (!m.wifiNeeded) { m.wifiNeeded = true; advanceSetup(m); }
    return;
  }
  // `s.net.hostname = <name>` — the reply to our CLI query below (old firmware
  // that doesn't log `host` on the Connected line). Adopt the real name, and
  // refresh the info dialog if it's still up showing the default guess.
  mm = line.match(/^s\.net\.hostname = (\S+)/);
  if (mm) {
    m.hostname = mm[1];
    deviceUiHost = mm[1];
    if (m === monitor) setMonTitle(mm[1]);
    if (!$('info-overlay').hidden)
      showInfo(`Device connected to ${deviceUiSsid || 'WiFi'}`, deviceInfoHtml());
    return;
  }
  // `Connected "<ssid>" ip <ip> dns <dns> host <hostname>` — associated to a
  // real network. `host` names what <hostname>.local resolves to; adopt it so a
  // device that already has a non-default hostname is opened by its real name
  // rather than the default guess. `host` is optional (empty hostname ⇒ absent,
  // and old firmware omits it entirely) — when it's missing, ask the CLI once.
  mm = line.match(/Connected "(.*)" ip (\S+) dns (\S+)(?: host (\S+))?/);
  if (mm) {
    m.connectedSeen = true;
    if (mm[4]) {
      m.hostname = mm[4];            // device reported its actual hostname
      if (m === monitor) setMonTitle(mm[4]);
    } else if (!m.hostnameQueried) {
      m.hostnameQueried = true;      // firmware didn't log it — query it directly
      sendToDevice(m, 'show s.net.hostname\n\n');
    }
    showOpenUi(m, mm[2], mm[1]);     // device online → show the "Open Device UI" button
    advanceSetup(m);                 // network is up → no wifi dialog needed
    return;
  }
}

// Send a CLI line to the device. Trailing `;` tells the serial CLI to run the
// line and drop back to log mode, so the boot log keeps streaming afterwards.
function sendToDevice(m, cmd) {
  if (!m || !m.writer) return;
  m.writer.write(new TextEncoder().encode(cmd)).catch(() => { /* port gone */ });
}

// Quote a CLI argument the way the device's parseArgs expects (double quotes,
// so values with spaces stay one argument).
const cliQuote = (s) => `"${s}"`;


function updateConnectFields() {
  const opt = $('ch-ssid').selectedOptions[0];
  const isOther = !!(opt && opt.dataset.other === '1');
  const isOpen = !isOther && opt && opt.dataset.open === '1';
  $('ch-ssid-other').hidden = !isOther;
  // Open networks need no password; secured ones and "-- other --" do.
  $('ch-pass-wrap').hidden = isOpen;
}

function openConnectDialog(m) {
  m.wifiOpen = true;
  const sel = $('ch-ssid');
  sel.innerHTML = '';
  // Strongest-first is roughly scan order; keep insertion order.
  for (const ap of m.aps.values()) {
    const o = document.createElement('option');
    o.value = ap.ssid;
    o.textContent = ap.open ? `${ap.ssid} (open)` : ap.ssid;
    o.dataset.open = ap.open ? '1' : '0';
    sel.appendChild(o);
  }
  const other = document.createElement('option');
  other.textContent = '-- other --';
  other.dataset.other = '1';
  sel.appendChild(other);

  $('ch-hostname').value = m.hostname || HOSTNAME_DEFAULT;
  $('ch-ssid-custom').value = '';
  $('ch-pass').value = '';
  updateConnectFields();
  $('connect-overlay').hidden = false;
  $('ch-hostname').focus();
}

function closeConnectDialog() { $('connect-overlay').hidden = true; }

$('ch-ssid').addEventListener('change', updateConnectFields);
// Hostnames are DNS/mDNS labels: letters, digits, underscore only, max 16 chars.
const HOSTNAME_RE = /^[A-Za-z0-9_]{1,16}$/;
// Block any insertion that contains an illegal hostname char (typed or pasted)
// before it lands, so nothing happens — the text and caret are untouched.
// Deletions/navigation have null data and pass through. The 16-char cap is the
// input's native maxlength.
$('ch-hostname').addEventListener('beforeinput', (e) => {
  if (e.data && /[^A-Za-z0-9_]/.test(e.data)) e.preventDefault();
});

// Cancelling the wifi box skips wifi but still lets the setup flow finish
// (e.g. set the password). "Connect" records the choice; the batched send
// happens in advanceSetup once every needed dialog is settled.
$('ch-cancel').addEventListener('click', () => {
  const m = monitor;
  closeConnectDialog();
  if (!m) return;
  m.wifiCfg = null;
  m.wifiResolved = true;
  m.wifiOpen = false;
  advanceSetup(m);
});

$('ch-send').addEventListener('click', () => {
  const m = monitor;
  if (!m) { closeConnectDialog(); return; }
  const hostname = ($('ch-hostname').value || HOSTNAME_DEFAULT).trim();
  if (!HOSTNAME_RE.test(hostname)) { $('ch-hostname').focus(); $('ch-hostname').select(); return; }
  const sel = $('ch-ssid');
  const opt = sel.selectedOptions[0];
  const isOther = !!(opt && opt.dataset.other === '1');
  const ssid = (isOther ? $('ch-ssid-custom').value : sel.value).trim();
  if (!ssid) { (isOther ? $('ch-ssid-custom') : sel).focus(); return; }
  const isOpen = !isOther && opt && opt.dataset.open === '1';
  const pass = isOpen ? '' : $('ch-pass').value;

  m.hostname = hostname;
  m.wifiCfg = { hostname, ssid, pass };
  m.wifiResolved = true;
  m.wifiOpen = false;
  closeConnectDialog();
  advanceSetup(m);
});

// ── device setup coordinator ─────────────────────────────────────────────────
// A fresh device can need a password and/or a wifi network. We show the password
// dialog first (on "No device password set"), then the wifi dialog (on the AP
// fallback), and finally send everything the user chose in ONE batch. Cancelling
// either dialog just skips that part and lets the rest proceed.
function resetSetup(m) {
  m.needPasswd = false;
  m.passwdResolved = false;
  m.newPasswd = null;
  m.passwdOpen = false;
  m.wifiNeeded = false;
  m.wifiResolved = false;
  m.wifiCfg = null;
  m.wifiOpen = false;
  m.connectedSeen = false;
  m.setupSent = false;
  m.aps.clear();
  closePasswdDialog();
  closeConnectDialog();
}

// Send whatever the user chose, once, as one batch. Commands are newline-
// separated; `save` persists; the trailing blank line drops the CLI back to log
// mode. The admin password uses `auth passwd admin <pw>` (non-interactive; the
// bare `passwd` command prompts). The password is the rest of the line, so it
// isn't quoted; hostname is [A-Za-z0-9_] only; SSID/password may hold spaces so
// they're quoted.
function sendSetup(m) {
  if (m.setupSent) return;
  let cmd = '';
  if (m.newPasswd) cmd += `auth passwd admin ${m.newPasswd}\n`;
  if (m.wifiCfg) {
    cmd += `hostname ${m.wifiCfg.hostname}\n`;
    cmd += `net add ${cliQuote(m.wifiCfg.ssid)}`;
    if (m.wifiCfg.pass) cmd += ` ${cliQuote(m.wifiCfg.pass)}`;
    cmd += '\n';
  }
  if (!cmd) return;   // user skipped everything
  cmd += 'save\n\n';
  m.setupSent = true;
  sendToDevice(m, cmd);
}

function advanceSetup(m) {
  if (m.setupSent) return;
  // 1. Password dialog first.
  if (m.needPasswd && !m.passwdResolved) {
    if (!m.passwdOpen) openPasswdDialog(m);
    return;
  }
  if (m.passwdOpen) return;   // user still in the password dialog
  // 2. Wifi dialog next, if the device fell back to its own AP.
  if (m.wifiNeeded && !m.wifiResolved) {
    if (!m.wifiOpen) openConnectDialog(m);
    return;
  }
  if (m.wifiOpen) return;     // user still in the wifi dialog
  // 3. Everything settled. Send — but if we don't yet know whether a wifi dialog
  //    is coming (no AP and no connect yet), wait so we can batch it in.
  if (!m.newPasswd && !m.wifiCfg) return;         // nothing chosen
  if (!m.wifiNeeded && !m.connectedSeen) return;  // wifi need still undetermined
  sendSetup(m);
}

// ── device password dialog ───────────────────────────────────────────────────
function openPasswdDialog(m) {
  m.passwdOpen = true;
  $('pw-1').value = '';
  $('pw-2').value = '';
  $('pw-msg').textContent = '';
  $('pw-msg').className = 'pw-msg';
  $('passwd-overlay').hidden = false;
  $('pw-1').focus();
}

function closePasswdDialog() { $('passwd-overlay').hidden = true; }

function pwMsg(text, ok) {
  $('pw-msg').textContent = text;
  $('pw-msg').className = ok ? 'pw-msg ok' : 'pw-msg';
}

// 20 random characters from an unambiguous, CLI-safe set (no spaces/quotes, and
// no look-alikes like l/1/I/O/0).
function genPassword(n) {
  const cs = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';
  const r = new Uint32Array(n);
  crypto.getRandomValues(r);
  let s = '';
  for (let i = 0; i < n; i++) s += cs[r[i] % cs.length];
  return s;
}

$('pw-suggest').addEventListener('click', async () => {
  const pw = genPassword(20);
  $('pw-1').value = pw;
  $('pw-2').value = '';
  try {
    await navigator.clipboard.writeText(pw);
    pwMsg('Generated and copied to clipboard. Paste it into the confirm box and save it somewhere safe.', true);
  } catch (_) {
    pwMsg('Generated (couldn’t copy to clipboard — select and copy it manually).', true);
  }
  $('pw-2').focus();
});

$('pw-ok').addEventListener('click', () => {
  const m = monitor;
  if (!m) { closePasswdDialog(); return; }
  const p1 = $('pw-1').value, p2 = $('pw-2').value;
  // An empty entry just moves on without setting one — not advertised, but not blocked.
  if (!p1) {
    m.newPasswd = null;
    m.passwdResolved = true;
    m.passwdOpen = false;
    closePasswdDialog();
    advanceSetup(m);
    return;
  }
  if (p1 !== p2) { pwMsg('Passwords don’t match.'); $('pw-2').focus(); return; }
  m.newPasswd = p1;
  m.passwdResolved = true;
  m.passwdOpen = false;
  closePasswdDialog();
  advanceSetup(m);
});

// ── open device UI ───────────────────────────────────────────────────────────
// When the device reports it joined a network (Connected), we show the "Open
// Device UI" button (left of Reset) — plus, only if we just provisioned that
// network this session, a one-time info dialog explaining how to reach it. We can't probe
// reachability from a public HTTPS page (Private Network Access blocks it), so
// clicking the button just opens the device in a new tab (a real navigation,
// which ISN'T blocked). It opens <hostname>.local first (the self-signed cert is
// issued for that name); if that didn't work the user clicks again and we ask
// whether to use .local or the IP — a choice they can persist ("don't ask
// again", stored in LocalSettings) so later clicks skip the dialog.
let deviceUiIp = null;
let deviceUiHost = HOSTNAME_DEFAULT;
let deviceUiSsid = '';
let uiPressCount = 0;         // presses since this connection came up
let uiInfoShown = false;      // one-time info dialog shown this session
const UI_TARGET_KEY = 'flashmon.openUiTarget';   // LocalSettings: 'mdns' | 'ip'

function uiUrl(target) {
  return target === 'ip' ? `https://${deviceUiIp}/` : `https://${deviceUiHost}.local/`;
}
function openUiTab(target) { window.open(uiUrl(target), '_blank'); }

// Remembered .local-vs-IP preference, if the user ticked "don't ask again".
function savedUiTarget() {
  try {
    const v = localStorage.getItem(UI_TARGET_KEY);
    return (v === 'mdns' || v === 'ip') ? v : null;
  } catch (_) { return null; }
}
function saveUiTarget(target) {
  try { localStorage.setItem(UI_TARGET_KEY, target); } catch (_) { /* storage blocked */ }
}

function showInfo(title, html) {
  $('info-title').textContent = title;
  $('info-body').innerHTML = html;
  $('info-overlay').hidden = false;
}

// The one-time info dialog's body, built from the current deviceUiHost/Ip so it
// can be re-rendered if the real hostname arrives (via the CLI query) after it's
// first shown with the default guess.
function deviceInfoHtml() {
  return `<p>Open its web UI with the blue <b>Open Device UI</b> button (top right). It opens ` +
    `<b>${deviceUiHost}.local</b> in a new tab. Accept the one-time certificate warning if one ` +
    `shows up. (You may have to click ‘Advanced’ to accept.)</p>` +
    `<p>Your computer must be on the <b>same network</b> as the device (IP ${deviceUiIp}). Guest networks ` +
    `and public WiFi networks sometimes do “AP isolation” a.k.a. “client isolation”, meaning they ` +
    `block device-to-device traffic, so the page might not load from those even though the device ` +
    `is online. Not much we can do about that, sorry.</p>` +
    `<p>Some browsers and operating systems don’t let you connect to <b>.local</b> names unless you ` +
    `grant ‘Local Network Permissions’, and changing that can be harder than it should be. This we ` +
    `can do something about: if it doesn’t connect, come back to this page and click again — the ` +
    `second click lets you try the IP address (${deviceUiIp}) instead.</p>`;
}

function showOpenUi(m, ip, ssid) {
  deviceUiIp = ip;
  deviceUiHost = m.hostname || HOSTNAME_DEFAULT;
  deviceUiSsid = ssid || deviceUiSsid;
  uiPressCount = 0;
  $('open-ui').hidden = false;
  // Explain how to reach the UI only when WE just put the device on this network
  // (m.wifiCfg = the credentials the user entered this session). A device that
  // auto-joined a network it was already provisioned for just gets the button.
  if (!uiInfoShown && m.wifiCfg) {
    uiInfoShown = true;
    showInfo(`Device connected to ${deviceUiSsid || 'WiFi'}`, deviceInfoHtml());
  }
}

function hideOpenUi() {
  deviceUiIp = null;
  uiPressCount = 0;
  $('open-ui').hidden = true;
  closeUiChoice();
}

// Force-dismiss every modal dialog. The floating action buttons (Flash / Open
// Device UI / Reset) sit above the overlay and call this, so one click both
// fires the action AND clears whatever dialog was up — no separate dismiss
// click. Setup-input dialogs (password / wifi), if open, are marked settled so
// the setup coordinator neither re-opens them nor stalls waiting on them.
function closeDialogs(m) {
  $('info-overlay').hidden = true;
  $('stuck-overlay').hidden = true;
  closeUiChoice();
  cancelStateWarn();       // an unanswered warning means: don't flash
  if (m && m.passwdOpen) { m.passwdOpen = false; m.passwdResolved = true; closePasswdDialog(); }
  if (m && m.wifiOpen)   { m.wifiOpen = false;   m.wifiResolved = true;   closeConnectDialog(); }
}

$('open-ui').addEventListener('click', () => {
  closeDialogs(monitor);                          // clear any dialog on the way
  if (deviceUiIp == null) return;
  const saved = savedUiTarget();
  if (saved) { openUiTab(saved); return; }        // remembered choice — no dialog
  uiPressCount++;
  if (uiPressCount === 1) { openUiTab('mdns'); return; }   // first try: the cert name
  openUiChoice();                                 // clicked again → ask which address
});

// ── .local-vs-IP choice dialog ───────────────────────────────────────────────
function openUiChoice() {
  $('uichoice-sub').innerHTML =
    `Opening <b>${deviceUiHost}.local</b> may not have reached the device. Which address should we open?`;
  $('uichoice-mdns').textContent = `${deviceUiHost}.local`;
  $('uichoice-ip').textContent = deviceUiIp;
  $('uichoice-remember').checked = false;
  $('uichoice-overlay').hidden = false;
}
function closeUiChoice() { $('uichoice-overlay').hidden = true; }

function chooseUi(target) {
  if ($('uichoice-remember').checked) saveUiTarget(target);
  closeUiChoice();
  openUiTab(target);
}
$('uichoice-mdns').addEventListener('click', () => chooseUi('mdns'));
$('uichoice-ip').addEventListener('click', () => chooseUi('ip'));
// Click off the dialog (on the backdrop) cancels without opening anything.
$('uichoice-overlay').addEventListener('click', (e) => {
  if (e.target === $('uichoice-overlay')) closeUiChoice();
});

// The info dialog is just info — a click anywhere on it (backdrop or the OK
// button on top) dismisses it, so it never costs an aimed click.
$('info-overlay').addEventListener('click', () => { $('info-overlay').hidden = true; });
$('stuck-ok').addEventListener('click', () => { $('stuck-overlay').hidden = true; });

// ── console handover ──────────────────────────────────────────────────────
// The device logs that it is moving its console to a different USB device. We
// cannot open the chooser from the log line itself — requestPort() needs a live
// user gesture — so the line raises this dialog and its OK does the asking.
// Set from the trigger line until the move resolves. While it is up the connect
// handler must not adopt an arriving port on its own: the device is presenting a
// different transport by design, and treating that as "the old port came back"
// reattaches to the wrong thing and reports a return that never happened.
let awaitingCdc = false;

// Set for the whole of adoptConsolePort. A console move already owns the ports
// it is auditioning, and the rescan must not reach for them meanwhile: both
// would be opening the same handles, and the loser reads "The port is already
// open" — which the audition scores as "did not answer" and the rescan as a
// dead grant. Only one recovery mechanism may hold the wheel at a time, and
// during a move it is the move.
let adopting = false;

// A grant already held for the CDC transport, if the device is presenting it.
// Chrome only reports ports the origin may use, so anything listed here is
// openable without asking again.
// What we believe is currently attached, keyed by USB identity. Re-enumeration
// fires connect and disconnect several times each and hands out fresh SerialPort
// objects, so neither the event nor the object identifies a state change. The
// device presents one instance of each transport; tracking that is what makes a
// repeat a repeat rather than something to act on again.
const presence = new Map();

function idKey(port) {
  try {
    const i = port.getInfo();
    return `${i.usbVendorId}:${i.usbProductId}`;
  } catch (_) { return 'unknown'; }
}

// True when this is a real change. Repeats return false and are dropped whole:
// no message, and no second reattach over a session that already has the port.
function presenceChanged(port, here) {
  const k = idKey(port);
  if (presence.get(k) === here) return false;
  presence.set(k, here);
  return true;
}

// The freshest SerialPort object per USB identity. A re-enumeration mints a
// NEW object; the old one keeps its name, identity, and grant, but not an
// openable backing — open() on it fails "Failed to open serial port" forever.
// getPorts() can hand back either, so it cannot be trusted to pick; the object
// a connect event delivers is by definition the live one. Every connect event
// deposits here, every successful open refreshes, and every recovery path
// checks here before settling for a getPorts() snapshot.
// A LIST per identity, in first-seen order, not one object per identity: the
// composite device presents two CDC ports wearing the same VID/PID, and
// getInfo() exposes nothing to tell them apart. Keeping one slot per identity
// would collapse them — and, since these objects are preferred over a
// getPorts() snapshot, would hand the console over to whichever interface
// enumerated last. Order is the only signal there is: the console is
// interface 0, so it enumerates, and connects, first.
const heldPorts = new Map();
// Bounded, newest last. Every connect event delivers a freshly minted object,
// so an unbounded list grows by one per interface per re-enumeration — a dozen
// entries after an evening of switching, all but the last pair belonging to
// incarnations of the device that no longer exist. Two is the hardware maximum
// (two CDC interfaces); keep a little slack and discard the oldest beyond it.
const HELD_PER_ID_MAX = 3;
function holdPort(port) {
  if (!port) return;
  const k = idKey(port);
  const list = (heldPorts.get(k) || []).filter((x) => x !== port);
  list.push(port);
  while (list.length > HELD_PER_ID_MAX) list.shift();
  heldPorts.set(k, list);
}
function heldList() { return [...heldPorts.values()].flat(); }

// Drop a dead port OBJECT from our cache. Deliberately not forget(): that
// revokes permission for the underlying port, and a dead object wears the same
// identity as the live one, so revoking on its behalf takes the working
// console's grant with it — turning one failed open into a permanent loss of
// access, and a re-pick that mints yet another entry. Objects are ours to
// discard; grants are the user's, cleared in the browser's own settings.
function forgetPortObject(port) {
  const k = idKey(port);
  const rest = (heldPorts.get(k) || []).filter((x) => x !== port);
  if (rest.length) heldPorts.set(k, rest); else heldPorts.delete(k);
}

function isCdcPort(port) {
  try {
    const i = port.getInfo();
    return i.usbVendorId === CDC_FILTER.usbVendorId && i.usbProductId === CDC_FILTER.usbProductId;
  } catch (_) { return false; }
}

function isJtagPort(port) {
  try {
    const i = port.getInfo();
    return i.usbVendorId === JTAG_ID.usbVendorId && i.usbProductId === JTAG_ID.usbProductId;
  } catch (_) { return false; }
}

// Held objects first: after a re-enumeration the getPorts() snapshot may still
// carry the previous incarnation's dead object under the same identity.
async function grantedCdcPorts() {
  let ports = [];
  try { ports = await navigator.serial.getPorts(); } catch (_) { /* held only */ }
  const seen = new Set();
  // Newest first. A re-enumeration invalidates every object that preceded it,
  // so recency is the best available guess at which one is live — and the
  // audition pays ~900 ms for each dud it tries before the console, so guessing
  // well is the difference between an instant move and a visible stall.
  return [...ports.reverse(), ...heldList().reverse()].filter((p) => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return p.connected !== false && isCdcPort(p);
  });
}

function offerConsoleHandover() {
  if (!monitor || awaitingCdc) return;
  awaitingCdc = true;
  // The device has only announced the move; its new ports appear a moment
  // later. Wait for one we are already permitted to open before troubling the
  // user — a second switch in the same session needs no dialog at all.
  let waited = 0;
  const poll = setInterval(async () => {
    if (!awaitingCdc) { clearInterval(poll); return; }
    const found = await grantedCdcPorts();
    if (found.length) {
      clearInterval(poll);
      adoptConsolePort(found);
      return;
    }
    if ((waited += 250) >= 3000) {
      clearInterval(poll);
      // Stop suppressing reattach either way: if no CDC device turned up, the
      // move failed and following the device back is the only way its error
      // message reaches anyone.
      if (awaitingCdc) { awaitingCdc = false; $('cdcmove-overlay').hidden = false; }
    }
  }, 250);
}

// Move the console onto the device's new port, keeping the outgoing session
// rendering into the same terminal until the device drops it.
//
// `cands` may hold both of the composite device's CDC ports — same VID/PID,
// nothing in getInfo() to separate them, and only one is the console; the other
// is silent in both directions, which is indistinguishable from a working
// monitor on an idle device. So let them answer for themselves: attach, poke
// (attachStreams sends a CR, which the firmware always answers), and keep the
// first that produces a byte. Silence is a preference, not a veto — if none
// answers we still take the first, because a silent monitor beats none.
async function adoptConsolePort(cands) {
  if (!monitor) { awaitingCdc = false; return; }
  // Dedup by object: the same port can reach us from both heldPorts and the
  // getPorts() snapshot, and auditioning it twice means opening one we already
  // hold open — "The port is already open", read as a failure to answer.
  const list = [...new Set(Array.isArray(cands) ? cands.filter(Boolean) : [cands])];
  if (!list.length) { awaitingCdc = false; return; }
  const outgoing = monitor;
  adopting = true;                 // holds the rescan off these ports (see below)
  try {

  let chosen = null;
  for (const port of list) {
    // Someone else got there first — a reclaim, or a connect event that landed
    // on a live handle — and that session is real and working. Yield to it: the
    // whole point of this audition is to find a console, and one has been found.
    if (monitor !== outgoing) break;
    let probe = null;
    try {
      probe = makeSession(port, outgoing.term, outgoing.resizeObserver, true);  // muted while auditioning
      await attachStreams(probe);
      probe.muted = false;
      const base = probe.rxSeq;
      for (let waited = 0; waited < 900 && probe.rxSeq === base; waited += 100) await sleep(100);
      if (probe.rxSeq !== base || list.length === 1) { chosen = probe; break; }
      await detachStreams(probe);
      forgetPortObject(port);        // opened but mute: not the console we want
    } catch (e) {
      if (probe) { try { await detachStreams(probe); } catch (_) { /* */ } }
      const msg = e && e.message ? e.message : String(e);
      // A grant that cannot be opened is spent — revoke it, so it is gone from
      // the next audition instead of being waded through again. "Already open"
      // is not that: it is one of our own handles, and must be kept.
      if (!/already open/i.test(msg)) forgetPortObject(port);
      else note(outgoing, `\x1b[90m-- a ${portLabel(port)} is already open here --\x1b[0m`);
    }
  }
  // Re-check before committing: the loop above awaits, and a reclaim can have
  // completed in any of those gaps. Overwriting `monitor` now would replace a
  // proven-live session with an audition also-ran — which is exactly how a
  // console that had come back got thrown away.
  if (monitor !== outgoing) {
    if (chosen) { try { await detachStreams(chosen); } catch (_) { /* */ } }
    note(outgoing, '\x1b[90m-- console already recovered; audition abandoned --\x1b[0m');
    return;
  }

  if (!chosen) {
    // Every candidate opened but stayed mute. Take the first anyway and say so:
    // the session stays usable, and a device that was merely busy delivers when
    // it gets around to it.
    try {
      chosen = makeSession(list[0], outgoing.term, outgoing.resizeObserver, false);
      await attachStreams(chosen);
      note(outgoing, '\x1b[33m-- no port answered; taking the first --\x1b[0m');
    } catch (e) {
      note(outgoing, `\x1b[31m-- could not open the new port: ${e && e.message ? e.message : e} --\x1b[0m`);
      scheduleRescan();
      return;
    }
  }

  const port = chosen.port;
  noteDeviceId(port);                  // the identity to follow from here on
  presence.set(idKey(port), true);     // we hold it; later connects are repeats
  priorSession = outgoing.gone ? null : outgoing;
  monitor = chosen;
  outgoing.term.focus();
  refreshFlashOffer();
  } finally {
    adopting = false;
    awaitingCdc = false;
  }
}

// The cdc→jtag counterpart of offerConsoleHandover. If this session holds a
// grant for the JTAG side, the rescan reclaims it with no ceremony; if not,
// the port is invisible to us and only a chooser pick (a gesture) reaches it —
// raise the reconnect dialog to ask for one.
function offerConsoleReturn() {
  if (!monitor) return;
  let waited = 0;
  const poll = setInterval(async () => {
    if (!monitor) { clearInterval(poll); return; }
    let ports = [];
    try { ports = await navigator.serial.getPorts(); } catch (_) { /* held only */ }
    if ([...heldList(), ...ports].some((x) => x && x.connected !== false && isJtagPort(x))) {
      clearInterval(poll);              // granted and present — the rescan takes it
      return;
    }
    if ((waited += 250) >= 3000) {
      clearInterval(poll);
      // Only if the session actually lost its port — a switch the firmware
      // announced but never carried out leaves the CDC session running, and
      // popping a dialog over a working monitor would be noise.
      if (monitor && (monitor.gone || !monitor.reader)) $('reconnect-overlay').hidden = false;
    }
  }, 250);
}

$('cdcmove-ok').addEventListener('click', async () => {
  $('cdcmove-overlay').hidden = true;
  if (!monitor) return;
  let port;
  try {
    // Filtered to the composite device the firmware presents, so the chooser
    // offers its two ports and nothing else.
    port = await navigator.serial.requestPort({ filters: [CDC_FILTER] });
  } catch (_) {
    awaitingCdc = false;
    return;                                          // chooser dismissed
  }
  await adoptConsolePort(port);
});

// Prove an attached port actually carries the console. attachStreams pokes it
// with a CR, and the firmware always answers one — with its transport hint in
// log mode, with a prompt in CLI mode — so a port that stays byte-silent after
// attach is not slow, it is dead: opened mid-enumeration, or on a device node
// the OS is still tearing down. Close and reopen it a couple of times, saying
// so, rather than presenting a working-looking monitor that never speaks.
async function verifyAlive(m) {
  for (let attempt = 0; ; attempt++) {
    const base = m.rxSeq;
    for (let waited = 0; waited < 1200 && monitor === m && m.rxSeq === base; waited += 100)
      await sleep(100);
    if (monitor !== m) return false;            // superseded — not ours to fix
    if (m.rxSeq !== base) return true;
    if (attempt === 0) {
      // Ask again before touching the port: a device mid-boot or mid-switch
      // answers late, and a close/reopen cycle right now is a window in which
      // its answer — written device-side with a short timeout — gets dropped.
      await pokeConsole(m);
      continue;
    }
    if (attempt >= 2) {
      // Not a death sentence: the session stays attached, and a device that
      // was merely busy delivers when it gets around to it — observed as live
      // logs arriving seconds after this line.
      note(m, '\x1b[33m-- no response; leaving the port open --\x1b[0m');
      return false;
    }
    note(m, `\x1b[90m-- ${portLabel(m.port)} is silent, reopening… --\x1b[0m`);
    try {
      await detachStreams(m);
      await sleep(300);
      if (monitor !== m) return false;
      await attachStreams(m);                   // re-pokes the console on the way up
    } catch (e) {
      note(m, `\x1b[31m-- reopen failed: ${e && e.message ? e.message : e} --\x1b[0m`);
      // The port went away or won't open — the session now has no streams, so
      // hand recovery to the rescan, which reclaims it once it is openable.
      scheduleRescan();
      return false;
    }
  }
}

// Re-open a returning port over the dead session. Shared by the connect event
// and the rescan below, so a port that arrives before its predecessor's death
// is reported gets the same treatment as one that arrives after.
// `attempts` bounds the open retries: alone-in-the-list ports get the full
// patient run (an OS still building the node needs time), but when several
// objects wear one identity the dead twin fails instantly, so short passes
// that rotate quickly find the live one sooner.
let reclaimLastReport = null;   // last failure line printed; cleared on success
async function reclaimPort(p, attempts = 8) {
  monitor.reattaching = true;                 // set synchronously, before any await
  monitor.port = p;                           // adopt the (possibly fresh) port object
  let attached = false;
  let lastErr = null;
  try {
    // The port may not accept open() the instant it appears (or the dead
    // port's close() is still settling), so retry a few times.
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!monitor || (!monitor.gone && monitor.reader)) return;   // resolved elsewhere
      try {
        // Once, not per retry: it releases anything the vanished session left
        // half-open. After a failed open there is nothing open to close.
        if (attempt === 0) { try { await p.close(); } catch (_) { /* wasn't open */ } }
        await attachStreams(monitor);
        monitor.gone = false;
        note(monitor, `\x1b[32m-- ${portLabel(p)} came back --\x1b[0m`);
        monitor.term.focus();
        refreshFlashOffer();   // restore the green slot (detect, or the flash offer)
        attached = true;
        reclaimLastReport = null;   // next outage reports afresh
        return;
      } catch (e) {
        lastErr = e;
        await sleep(300);
      }
    }
    if (monitor && monitor.gone) {
      // Say why: "reopen failed" alone gives nothing to go on, and the reason —
      // usually the OS still building or tearing down the device node — is in
      // the error. Once per distinct reason: the rescan retries this every
      // 800 ms, and a repeating line adds noise, not information.
      const why = lastErr && lastErr.message ? ` (${lastErr.message})` : '';
      const line = `\x1b[31m-- ${portLabel(p)} reopen failed${why}; retrying in background --\x1b[0m`;
      if (line !== reclaimLastReport) { monitor.term.writeln(line); reclaimLastReport = line; }
      scheduleRescan();
    }
  } finally {
    if (monitor) monitor.reattaching = false;
    // After the flag clears, so the verify's own close/reopen can't collide
    // with a concurrent connect event's reclaim.
    if (attached && monitor) verifyAlive(monitor);
  }
}

// Keep looking for a replacement port while the session is dead. Events cannot
// be trusted to drive this: the dead port's disconnect and its replacement's
// connect come from two different USB devices, so the OS orders them freely —
// a connect that lands while the session still looks live (or while a reclaim
// holds the lock) is refused, and that one-shot event is spent. Ground truth
// is polled instead: session dead + granted port attached → reclaim it. The
// loop also outlasts a failed reclaim, because a port can be listed by the
// browser well before the OS lets it open — the announced-then-quiet flag
// keeps the narration to one line per outage rather than one per attempt.
let rescanTimer = null;
function scheduleRescan() {
  if (rescanTimer) return;
  let announced = false;
  let failures = 0;
  let rotate = 0;
  rescanTimer = setInterval(async () => {
    if (!monitor || (!monitor.gone && monitor.reader)) {   // recovered or torn down
      clearInterval(rescanTimer);
      rescanTimer = null;
      $('reconnect-overlay').hidden = true;
      return;
    }
    if (monitor.reattaching) return;          // a reclaim is already running
    // A console move owns the ports it is auditioning; stay off them entirely
    // rather than race it for handles.
    if (adopting || awaitingCdc) return;
    let ports = [];
    try { ports = await navigator.serial.getPorts(); } catch (_) { /* held only */ }
    // Held objects first — a connect event's object outranks the snapshot's,
    // which after a re-enumeration can be the dead previous incarnation. A
    // failed cycle rotates to the next candidate rather than retrying the same
    // object forever: with two objects wearing one identity, only trying both
    // finds the live one.
    const seen = new Set();
    const candidates = [...heldList(), ...ports].filter((x) => {
      if (!x || seen.has(x)) return false;
      seen.add(x);
      return x.connected !== false && isKnownDevice(x) && !(awaitingCdc && isCdcPort(x));
    });
    if (!candidates.length) return;
    const p = candidates[rotate % candidates.length];
    if (!announced) {
      note(monitor, `\x1b[90m-- following the ${portLabel(p)} already present --\x1b[0m`);
      announced = true;
    }
    // One attempt: a stale handle does not fail transiently — it fails, it's
    // dead. (A live port arriving by connect event gets the patient retries in
    // that handler; this loop only ever reaches for remembered handles.)
    await reclaimPort(p, 1);
    if (monitor && !monitor.gone && monitor.reader) { failures = 0; return; }
    rotate++;
    // Every candidate has now failed once — the grant is stale, and nothing
    // reachable through it will ever work. Drop it (a fresh chooser pick mints
    // a fresh one) and ask for that pick. Dropping also quiets this loop: the
    // identity vanishes from every snapshot, so the remaining ticks idle until
    // the pick or a live arrival ends the outage.
    if (++failures >= Math.max(candidates.length, 1)) {
      for (const x of candidates) forgetPortObject(x);
      failures = 0;
      note(monitor, '\x1b[33m-- no remembered port for this device opens; pick it again --\x1b[0m');
      $('reconnect-overlay').hidden = false;
    }
  }, 800);
}

$('reconnect-pick').addEventListener('click', async () => {
  $('reconnect-overlay').hidden = true;
  if (!monitor) return;
  let port;
  try {
    // Offer only identities this device has worn — with a stale twin possibly
    // still listed, the fresh entry is the one the chooser shows as present.
    const filters = knownIds.map((k) => ({ usbVendorId: k.vid, usbProductId: k.pid }));
    port = await navigator.serial.requestPort(filters.length ? { filters } : {});
  } catch (_) {
    return;   // dismissed — the rescan keeps trying and re-raises the dialog
  }
  noteDeviceId(port);
  holdPort(port);
  presence.set(idKey(port), true);
  await reclaimPort(port);
});

// Hold on to the port's permission across physical disconnects: when the device
// is powered off / unplugged, note it in the stream and tear the dead streams
// down; when the device reappears (matched by USB VID/PID, since it may come back
// as a fresh SerialPort object), re-open it and resume.
navigator.serial.addEventListener('disconnect', (e) => {
  const p = e.port || e.target;
  if (!p) return;
  // Every cached object for this identity is now a dead incarnation: the device
  // left the bus, and whatever it presents next comes as freshly minted objects
  // via connect. Dropping them here is what keeps the cache at the two ports
  // that actually exist, instead of accumulating a generation per switch for
  // the audition to wade through.
  heldPorts.delete(idKey(p));
  if (!presenceChanged(p, false)) return;
  // The port a handover moved away from, finally going. Expected, not a loss:
  // say so plainly and let it go rather than holding the grant for a port the
  // device has stopped presenting.
  if (priorSession && idKey(p) === idKey(priorSession.port)) {
    const old = priorSession;
    priorSession = null;
    note(old, `\x1b[36m-- previous ${portLabel(old.port)} gone --\x1b[0m`);
    detachStreams(old);
    return;
  }
  // By USB identity, not object: a device that re-enumerates is handed to us as
  // a fresh SerialPort, so comparing objects misses its own session's departure
  // — leaving the session marked live, never reattached, and its port closed
  // under everything that later tries to use it.
  if (!monitor || idKey(p) !== idKey(monitor.port)) {
    // Not a session's port, or one already accounted for. Still worth saying:
    // during a console move the device presents and withdraws transports on its
    // own schedule, and a silent gap reads as the app having lost track.
    if (monitor) note(monitor, `\x1b[90m-- ${portLabel(p)} gone --\x1b[0m`);
    return;
  }
  monitor.gone = true;
  hideOpenUi();            // the device is gone — drop its buttons
  pendingFlash = null;     // can't flash (or detect on) a gone device
  cancelStateWarn();       // …so a warning waiting on an answer is moot
  $('monitor-flash').hidden = true;
  $('monitor-detect').hidden = true;
  note(monitor, `\x1b[31m-- ${portLabel(p)} gone --\x1b[0m`);
  detachStreams(monitor);
  // The replacement may have connected BEFORE this death was reported — its
  // one-shot connect event refused while the session still looked live. Now
  // that the session is known dead, keep looking for it. Not during a console
  // move: this departure is that move's expected first half, and the arriving
  // transport belongs to the audition, not to a recovery.
  if (!adopting && !awaitingCdc) scheduleRescan();
});

navigator.serial.addEventListener('connect', async (e) => {
  const p = e.port || e.target;
  if (!p) return;
  // Before any dedup or refusal: whatever else happens to this event, its port
  // object is the live one for its identity — pin it, so the rescan reaches
  // for this and not for a dead twin out of getPorts(). This is also how an
  // arrival refused below (session still looks live, reclaim lock held) still
  // ends up adopted: the rescan finds it here once the session's death lands.
  holdPort(p);
  // Re-enumeration fires `connect` several times; the lock keeps a single
  // reattach running so concurrent handlers don't fight over the port.
  // Match against every identity this device has worn, not just the one the
  // dead session held: a reset out of CDC mode brings the device back as the
  // USB-Serial-JTAG controller, which is a different VID/PID entirely.
  if (!presenceChanged(p, true)) return;

  // A CDC arrival during a move belongs to adoptConsolePort; taking it here
  // would grab the wrong port and claim a return that did not happen. Every
  // other arrival is ours to follow — including the device coming back on its
  // old transport after a move failed, whose console carries the reason.
  // Ground truth, not bookkeeping: a session with no reader has no working
  // port, whatever `gone` was left saying. That flag has repeatedly gone stale
  // — a missed disconnect leaves it false — and every time it does, an arriving
  // port is announced and then not taken, which presents as a live-looking
  // session that is mute and deaf until the page is reloaded.
  const detached = monitor && (monitor.gone || !monitor.reader);
  const mine = detached && !monitor.reattaching && isKnownDevice(p)
               && !(awaitingCdc && isCdcPort(p));
  if (!mine) {
    // Announce it anyway. Ports appearing and disappearing is the whole shape
    // of a console move, and hiding the ones we do not act on makes the
    // sequence impossible to follow.
    if (monitor) note(monitor, `\x1b[32m-- ${portLabel(p)} came back --\x1b[0m`);
    return;
  }
  if (awaitingCdc) { awaitingCdc = false; $('cdcmove-overlay').hidden = true; }
  await reclaimPort(p);
});

// Populate the settings box from the defaults (adds the baud as an option if the
// ?monitor_baud= override isn't one of the presets).
function initCfgControls() {
  const b = $('cfg-baud');
  if (![...b.options].some((o) => Number(o.value) === DEFAULT_CFG.baudRate)) {
    const o = document.createElement('option');
    o.textContent = String(DEFAULT_CFG.baudRate);
    b.appendChild(o);
  }
  b.value = String(DEFAULT_CFG.baudRate);
  $('cfg-data').value = String(DEFAULT_CFG.dataBits);
  $('cfg-parity').value = DEFAULT_CFG.parity;
  $('cfg-stop').value = String(DEFAULT_CFG.stopBits);
}

// ── flashing ────────────────────────────────────────────────────────────────
// Download the image zip at `zipURL` (a flasher.zip produced by `spangap
// build`) and unzip it in the browser: the images to write, each at its offset,
// plus the flash settings. Separate from the write, and touching neither the
// device nor the monitor, so the plan's offsets can be weighed against what is
// on the chip (see stateOverlaps) while there is still nothing to undo.
async function loadFlashPlan(zipURL) {
  log(`Downloading ${zipURL}`);
  const res = await fetch(zipURL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`could not fetch ${zipURL} (HTTP ${res.status}) — is the build published?`);
  const zip = await window.JSZip.loadAsync(await res.arrayBuffer());

  const argsFile = zip.file('flasher_args.json');
  if (!argsFile) throw new Error('flasher.zip has no flasher_args.json');
  const fargs = JSON.parse(await argsFile.async('string'));
  const settings = fargs.flash_settings || {};
  const entries = Object.entries(fargs.flash_files || {});
  if (!entries.length) throw new Error('flasher_args.json lists no flash_files');

  // esptool-js (0.6.0) wants each image as a Uint8Array of raw bytes. Passing a
  // binary string makes pako's deflater UTF-8-encode any byte >= 0x80, so the
  // image inflates on-device past its declared size and the stub aborts with
  // ESP_TOO_MUCH_DATA (status 0xC9) partway through the largest image.
  const fileArray = [];
  for (const [offset, fname] of entries) {
    const f = zip.file(fname);
    if (!f) throw new Error(`image "${fname}" missing from flasher.zip`);
    fileArray.push({ data: await f.async('uint8array'), address: parseInt(offset, 16) });
  }
  fileArray.sort((a, b) => a.address - b.address);
  log(`Unpacked ${fileArray.length} image(s).`);
  return { fileArray, settings };
}

// Flash a loaded plan's images at their offsets over Web Serial. Returns the
// chip-info banner lines so the monitor can reprint them.
async function flash(port, plan) {
  const { fileArray, settings } = plan;

  // esptool-js reports progress per image (written/total reset to 0 at each new
  // image), so a naive bar restarts every blob. Fold every image onto one bar:
  // weight each image by its byte size (offsets from the sorted array give the
  // running base) so the fill tracks total bytes written and advances roughly
  // linearly — the app image dominates the sum, which is where the time goes.
  const imageBase = [];
  let flashTotalBytes = 0;
  for (const img of fileArray) {
    imageBase.push(flashTotalBytes);
    flashTotalBytes += img.data.length;
  }

  const transport = new Transport(port, true);
  try {
    // Record the chip info (also shown in the flash log via the tee) so the same
    // detail block can be reprinted at the top of the monitor.
    const cap = captureTerminal(terminal);
    const esploader = new ESPLoader({ transport, baudrate: 460800, terminal: cap });
    await gatherChipInfo(esploader);
    const bannerLines = chipInfoLines(cap.lines);   // chip facts, no stub/baud noise

    bar.style.display = 'block';
    barfill.style.width = '0';
    await esploader.writeFlash({
      fileArray,
      flashSize: settings.flash_size || 'keep',
      flashMode: settings.flash_mode || 'keep',
      flashFreq: settings.flash_freq || 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (idx, written, total) => {
        const frac = total ? written / total : 0;
        const done = imageBase[idx] + frac * fileArray[idx].data.length;
        barfill.style.width = `${Math.round((done / flashTotalBytes) * 100)}%`;
      },
    });
    barfill.style.width = '100%';
    log('Flash complete — opening serial monitor and resetting…', 'ok');
    return bannerLines;
  } finally {
    // Hand the port to the monitor: disconnect() closes it at the flash baud so
    // openMonitor() can reopen it at the console baud.
    try { await transport.disconnect(); } catch (_) { /* already gone */ }
  }
}

// The selected port's USB identity (native-USB S3 = 303A:1001, or a bridge's
// CP2102/CH9102 VID:PID). Shown at the top of the banner. null for non-USB ports.
function usbInfoLine(port) {
  try {
    const i = port.getInfo ? port.getInfo() : {};
    if (i.usbVendorId == null) return null;
    const h = (n) => (n != null ? n.toString(16).toUpperCase().padStart(4, '0') : '????');
    return `USB ${h(i.usbVendorId)}:${h(i.usbProductId)}`;
  } catch (_) {
    return null;
  }
}

// The FNB58 is a composite device: its CDC serial port sits in the Web Serial
// chooser right next to the real board. Opening it as "the device" just yields a
// dead monitor (no ESP to probe, no boot log), so recognise it by VID and steer
// the user to the right port. Its power graph rides WebHID (the FNB58 button),
// never this serial path. Matches the same VIDs as the HID picker.
function isFnb58Port(port) {
  try {
    const i = port.getInfo ? port.getInfo() : {};
    return i.usbVendorId != null && FNB58_FILTERS.some((f) => f.vendorId === i.usbVendorId);
  } catch (_) {
    return false;
  }
}

// ── detector output ─────────────────────────────────────────────────────────
// The detector's `DETECTED: hw-<board>` line, if any (extras in parentheses are
// dropped): the hw-<board> token to match against the catalogue.
function detectedHw(lines) {
  for (const l of lines) {
    const m = l.match(/^DETECTED:\s+(hw-[a-z0-9-]+)/);
    if (m) return m[1];
  }
  return null;
}

// The detector's `DETECTED: spangap state partition at 0x… size 0x…` line, if
// any: where the device keeps its own data (settings, keys, files), as read off
// this chip — { addr, size } — or null if the detector found no store there.
function detectedStatePart(lines) {
  for (const l of lines) {
    const m = l.match(/^DETECTED:\s+spangap state partition at 0x([0-9a-f]+) size 0x([0-9a-f]+)/i);
    if (m) {
      const addr = parseInt(m[1], 16);
      const size = parseInt(m[2], 16);
      if (size > 0) return { addr, size };
    }
  }
  return null;
}

// ── state-partition warning ─────────────────────────────────────────────────
// Flash erases whole sectors, so a write erases from the start of the sector its
// first byte lands in through the end of the sector its last byte lands in — one
// byte past a boundary costs the whole next sector.
const SECTOR = 0x1000;

// The images in `fileArray` whose erase range reaches into `state`, each as the
// range it erases. Empty when the write leaves the state store alone — and when
// nothing is known about the store, since an unprobed chip is no evidence of a
// clash.
function stateOverlaps(fileArray, state) {
  if (!state) return [];
  const stateEnd = state.addr + state.size;
  const out = [];
  for (const img of fileArray) {
    const from = Math.floor(img.address / SECTOR) * SECTOR;
    const to = Math.ceil((img.address + img.data.length) / SECTOR) * SECTOR;
    if (from < stateEnd && to > state.addr) out.push({ from, to });
  }
  return out;
}

// Byte counts the way flash layouts are read: whole MB/KB where they divide.
function fmtBytes(n) {
  for (const [unit, div] of [['MB', 1024 * 1024], ['KB', 1024]]) {
    if (n >= div) {
      const v = n / div;
      return `${Number.isInteger(v) ? v : v.toFixed(1)} ${unit}`;
    }
  }
  return `${n} bytes`;
}

// Raise the warning for a flash that would write into the state store, and
// resolve to the user's choice: true to go ahead and erase it, false to cancel.
// Nothing has been written (or even torn down) at this point, so a cancel simply
// returns to the running monitor. Dismissals from elsewhere — the backdrop,
// closeDialogs(), the device going away — come back as a cancel through
// `stateWarnClose`, so the flash flow is never left waiting on a dialog that is
// no longer on screen.
function confirmStateOverlap(state, hits) {
  const hex = (n) => `0x${n.toString(16)}`;
  const stateEnd = state.addr + state.size;
  const ranges = hits
    .map((h) => `${hex(Math.max(h.from, state.addr))}–${hex(Math.min(h.to, stateEnd))}`)
    .join(', ');
  $('statewarn-sub').innerHTML =
    `Hardware detection found this device&rsquo;s state partition at <b>${hex(state.addr)}</b> ` +
    `(${fmtBytes(state.size)}) — where it keeps its settings, keys and stored files.`;
  $('statewarn-body').innerHTML =
    `<p>The image for this board writes <b>${ranges}</b>, inside that partition. Flashing it ` +
    `erases what is there: the device comes back up as if factory-fresh and has to be set up ` +
    `again (password, WiFi, identity keys).</p>` +
    `<p>Cancel to leave the device exactly as it is — nothing has been written yet.</p>`;
  $('statewarn-overlay').hidden = false;
  return new Promise((resolve) => {
    const done = (go) => {
      stateWarnClose = null;
      $('statewarn-overlay').hidden = true;
      $('statewarn-go').removeEventListener('click', onGo);
      $('statewarn-cancel').removeEventListener('click', onCancel);
      $('statewarn-overlay').removeEventListener('click', onBackdrop);
      resolve(go);
    };
    const onGo = () => done(true);
    const onCancel = () => done(false);
    // Click off the dialog (on the backdrop) cancels, like the other choices.
    const onBackdrop = (e) => { if (e.target === $('statewarn-overlay')) done(false); };
    $('statewarn-go').addEventListener('click', onGo);
    $('statewarn-cancel').addEventListener('click', onCancel);
    $('statewarn-overlay').addEventListener('click', onBackdrop);
    stateWarnClose = done;
  });
}

// Take an open state warning off the screen as a cancel.
function cancelStateWarn() { if (stateWarnClose) stateWarnClose(false); }

// ── build catalogue ─────────────────────────────────────────────────────────
// Image names to try for a detected board, most-specific first: the exact name,
// then successively shorter hw- prefixes (so an unlisted hw-foo-bar-baz falls to
// a listed hw-foo-bar image), then `generic`. Only names present in the catalogue
// are returned.
function buildCandidates(hw) {
  const names = new Set(BUILD_NAMES);
  const out = [];
  let n = hw;
  while (n && n.startsWith('hw-') && n.length > 3) {
    if (names.has(n)) out.push(n);
    const i = n.lastIndexOf('-');
    if (i <= 2) break;                  // 'hw-' — don't strip the prefix itself
    n = n.slice(0, i);
  }
  if (names.has('generic')) out.push('generic');
  return out;
}

function projectSlug(project) {
  return (project || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'flashmon';
}

// A build's zip path: a build `make` has stamped carries its own `version:` (the
// build datetime) and is named <slug>_<name>_<version>.zip; an unstamped one is
// plain <name>.zip.
function buildRel(name) {
  const ver = (BUILDS.find((b) => b.name === name) || {}).version;
  return ver ? `builds/${SLUG}_${name}_${ver}.zip` : `builds/${name}.zip`;
}

// The URL of a published image for `name` (versioned first, plain fallback), or
// null if none is there.
async function findBuildUrl(name) {
  for (const url of [buildRel(name), `builds/${name}.zip`]) {
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (res.ok) return url;
    } catch (_) { /* try the next */ }
  }
  return null;
}

// Is the catalogue's image for `name` newer than what's running? Both stamps are
// YYYYMMDDhhmmss, which sorts lexicographically. We offer a flash UNLESS we know the
// device is already at or past the catalogue's stamp — an unknown device stamp (old
// firmware, or a non-catalogue image) or an unstamped catalogue entry stays offerable.
function catalogueNewer(name, deviceVersion) {
  const cv = (BUILDS.find((b) => b.name === name) || {}).version || '';
  if (!cv || !deviceVersion) return true;
  return cv > deviceVersion;
}

// Record the identified board on the live monitor and arm the grace window: the
// firmware logs its build stamp a moment after the reset (and immediately after
// the invocation line the board can come from), so hold the offer until that
// lands (or the window expires), then evaluate. `fromDetector` marks a board read
// off the hardware by a detection run, which the boot log may not overwrite.
function armFlashGrace(hw, fromDetector) {
  if (!monitor) return;
  const m = monitor;
  m.hw = hw;
  m.hwDetected = !!fromDetector && !!hw;
  m.deviceVersion = null;
  m.versionSettled = false;
  clearTimeout(m.versionTimer);
  m.versionTimer = setTimeout(() => {
    if (monitor === m) { m.versionSettled = true; refreshFlashOffer(); }
  }, 4000);
  refreshFlashOffer();
}

// Resolve the identified board to the best available image and show the flash
// button — but only when that image is newer than the running firmware. Reactive:
// re-run whenever the board, the device's build stamp, or the catalogue changes. A
// board-specific image names the device in the button; the generic fallback says so.
//
// The green slot falls back to "Detect Hardware" while the board is unknown —
// nothing can be resolved until either the boot log or a detection run names it.
async function refreshFlashOffer() {
  const m = monitor;
  pendingFlash = null;
  $('monitor-flash').hidden = true;
  $('monitor-detect').hidden = !m || !!m.hw || detecting;
  if (!m || !m.hw) return;
  // Hold off until the device's stamp has had a chance to arrive, so a current
  // device doesn't briefly show (and let you click) a pointless re-flash.
  if (!m.versionSettled && m.deviceVersion === null) return;
  for (const name of buildCandidates(m.hw)) {
    const url = await findBuildUrl(name);
    if (!url) continue;
    if (monitor !== m) return;                          // superseded mid-HEAD
    if (!catalogueNewer(name, m.deviceVersion)) return; // device already current
    const device = m.hw.replace(/^hw-/, '');
    const label = name === 'generic'
      ? `Flash ${PROJECT} (generic build)`
      : `Flash ${PROJECT} to ${device}`;
    pendingFlash = { url, name, label };
    $('monitor-flash').textContent = label;
    $('monitor-flash').hidden = false;
    return;
  }
}

// Flash the pending image, then reopen the monitor and reset into it. The image
// is fetched and weighed against the chip first, while the monitor is still up
// and the device untouched — a download that fails, or a warning the user
// declines, costs the session nothing. Only past that does the monitor come down
// and the write run from the intro screen (its log + progress bar), so the flow
// mirrors a fresh flash: flash → openMonitor(reset).
async function runPendingFlash() {
  if (!monitor || !pendingFlash) return;
  const m = monitor;
  const { url } = pendingFlash;
  const port = m.port;
  const hw = m.hw;                            // carry the board across the re-open
  const hwDetected = m.hwDetected;            // …and how we came to know it
  closeDialogs(m);                            // clear any dialog on the way out
  bar.style.display = 'none';
  barfill.style.width = '0';
  logEl.textContent = '';
  logEl.hidden = true;
  $('intro-hint').textContent = '';

  // Fetch and unpack with the monitor still up and the device still running: the
  // image's own offsets are the only way to tell whether the write reaches into
  // the device's state store, and if it does the answer may be "don't" — which
  // has to leave the session exactly as it was.
  let plan;
  note(m, '\x1b[36m-- fetching firmware image --\x1b[0m');
  try {
    plan = await loadFlashPlan(url);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    log(`Error: ${msg}`, 'err');
    note(m, `\x1b[31m-- flash aborted: ${msg} --\x1b[0m`);
    return;
  }
  if (monitor !== m) return;                  // session replaced while downloading
  const hits = stateOverlaps(plan.fileArray, statePart);
  if (hits.length && !(await confirmStateOverlap(statePart, hits))) {
    if (monitor === m) note(m, '\x1b[33m-- flash cancelled; the device was not touched --\x1b[0m');
    return;
  }
  if (monitor !== m) return;                  // …or while the warning was up

  await closeMonitor();
  $('monitor').hidden = true;                 // reveal the intro screen behind it
  try {
    let banner = await flash(port, plan);
    const usb = usbInfoLine(port);
    if (usb) banner = [usb, ...(banner || [])];
    await openMonitor(port, true, banner);   // reset into the freshly-flashed firmware
    armFlashGrace(hw, hwDetected);            // re-arm: the new build should read as current
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    log(`Error: ${msg}`, 'err');
    // Flashing may have left the port closed; drop back to a plain monitor so
    // the user can retry or reset manually.
    try { await openMonitor(port, false, [`Flash failed: ${msg}`]); } catch (_) { /* */ }
  }
}

$('monitor-flash').addEventListener('click', runPendingFlash);

// ── hardware detection ──────────────────────────────────────────────────────
// Identify the board on demand, from the monitor's green slot. Probing needs the
// ROM loader, which means resetting the device and owning the port alone, so the
// monitor is torn down for the run and reopened after — the same shape as an
// in-monitor flash, minus the write. Runs on the intro screen so the detector's
// upload progress is visible, and ends by resetting into the real firmware.
async function runDetect() {
  if (!monitor || detecting) return;
  detecting = true;
  const port = monitor.port;
  closeDialogs(monitor);                    // clear any dialog on the way out
  await closeMonitor();
  $('monitor').hidden = true;               // reveal the intro screen behind it
  $('monitor-detect').hidden = true;
  bar.style.display = 'none';
  barfill.style.width = '0';
  logEl.textContent = '';
  logEl.hidden = true;
  $('intro-hint').textContent = 'Probing device…';

  // Probe for the chip banner, then RAM-load the peripheral detector (no flash
  // write) and capture its findings. A non-ESP device just gets the plain
  // terminal back.
  let info = null;
  let hw = null;
  let banner;
  try {
    info = await probeChip(port);
    if (info) {
      const detected = await runDetection(port);
      hw = detectedHw(detected);
      // What the run read off the flash outranks whatever a previous one did —
      // including "no state store", which is a real answer (a never-booted chip).
      // A run that captured nothing at all is no answer, so it changes nothing.
      if (detected.length) statePart = detectedStatePart(detected);
      banner = detected.length ? [...info, '', ...detected] : info;
    } else {
      banner = ['No ESP32 detected.'];
    }
  } catch (e) {
    banner = [`Detection failed: ${e && e.message ? e.message : e}`];
  }
  const usb = usbInfoLine(port);
  if (usb) banner = [usb, ...banner];
  // Reset back into the real firmware (this wipes the RAM detector) whenever the
  // ROM loader answered — the chip is sitting in it and would stay there.
  try {
    await openMonitor(port, !!info, banner);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    log(`Error: ${msg}`, 'err');
    // Detection may have left the port closed; drop back to a plain monitor so
    // the user can retry or reset manually.
    try { await openMonitor(port, false, [`Detection failed: ${msg}`]); } catch (_) { /* */ }
  } finally {
    detecting = false;   // before the offer refresh, so an empty result re-offers detection
  }
  // Record what we learned (nothing, on a failed run — which puts the Detect
  // Hardware button back) and offer a flash only if a newer build is published.
  armFlashGrace(hw, true);
}

$('monitor-detect').addEventListener('click', runDetect);

let connecting = false;

// Pop the serial chooser and open the monitor on the port — nothing more. The
// device is not probed and not reset: it keeps doing whatever it was doing, and
// the monitor just watches. Identifying the board (which costs a reset) waits for
// the Detect Hardware button, or for the firmware's own `build: invocation` line.
// requestPort() is called first, while the user gesture is fresh, before any long
// await.
async function connect() {
  if (connecting || monitor) return;
  connecting = true;
  statePart = null;                  // a fresh pick may be a different chip

  $('start').hidden = true;          // the action is underway — drop the CTA
  bar.style.display = 'none';
  barfill.style.width = '0';
  logEl.textContent = '';
  logEl.hidden = true;
  $('intro-hint').textContent = 'Opening serial monitor…';
  try {
    const port = await navigator.serial.requestPort();
    if (isFnb58Port(port)) {
      $('intro-hint').innerHTML =
        '<span class="err">That looks like the FNB58 power meter, not your device. ' +
        'Pick your device&rsquo;s serial port instead — then use the FNB58 button in ' +
        'the monitor to graph the meter.</span>';
      $('start').hidden = false;      // let them re-pick; finally{} clears `connecting`
      return;
    }
    const banner = ['Monitoring only — the device has not been reset.',
                    'Press “Detect Hardware” to identify the board (that resets it).'];
    const usb = usbInfoLine(port);
    await openMonitor(port, false, usb ? [usb, ...banner] : banner);
    refreshFlashOffer();   // board unknown → the green slot offers detection
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    $('intro-hint').innerHTML = `<span class="err">${msg}</span>`;
    $('start').hidden = false;       // let them try again
  } finally {
    connecting = false;
  }
}

// ── config ────────────────────────────────────────────────────────────────
// Minimal YAML for our shape: `project: <name>` and a `builds:` list whose
// entries each carry a `name:`. We only need the project brand and the image
// names; the invocations are for `make` in builds/, not the browser.
function parseConfig(text) {
  const cfg = { project: 'flashmon', builds: [] };
  let inBuilds = false;
  let cur = null;
  const set = (obj, kv) => {
    const i = kv.indexOf(':');
    if (i < 0) return;
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k === 'name' || k === 'version') obj[k] = v;
  };
  const top = (st, key) => st.slice(st.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
  for (const raw of text.split('\n')) {
    const st = raw.replace(/#.*$/, '').trim();   // our values carry no '#'
    if (!st) continue;
    if (/^project\s*:/.test(st)) { cfg.project = top(st); inBuilds = false; continue; }
    if (/^builds\s*:/.test(st)) { inBuilds = true; continue; }
    if (!inBuilds) continue;
    if (st.startsWith('- ')) { cur = {}; cfg.builds.push(cur); set(cur, st.slice(2).trim()); continue; }
    if (cur) set(cur, st);
  }
  return cfg;
}

// Prefer a gitignored flashmon.local.yaml (local deployment override) over the
// checked-in flashmon.yaml. Missing/broken config falls back to defaults.
async function loadConfig() {
  for (const f of ['flashmon.local.yaml', 'flashmon.yaml']) {
    try {
      const res = await fetch(f, { cache: 'no-store' });
      if (res.ok) return parseConfig(await res.text());
    } catch (_) { /* try the next */ }
  }
  return { project: 'flashmon', builds: [] };
}

// ── boot ──────────────────────────────────────────────────────────────────
async function boot() {
  const cfg = await loadConfig();
  PROJECT = cfg.project || 'flashmon';
  SLUG = projectSlug(PROJECT);
  BUILDS = cfg.builds;
  BUILD_NAMES = cfg.builds.map((b) => b.name).filter(Boolean);
  HOSTNAME_DEFAULT = (PROJECT.toLowerCase().replace(/[^a-z0-9_]/g, '') || 'flashmon').slice(0, 16);

  // Re-read the catalogue once a minute so a build published while the page is
  // open becomes available without a reload; re-evaluate the live flash offer
  // against the refreshed stamps. Branding (project/slug) is left as booted.
  setInterval(async () => {
    const c = await loadConfig();
    BUILDS = c.builds;
    BUILD_NAMES = c.builds.map((b) => b.name).filter(Boolean);
    if (monitor) refreshFlashOffer();
  }, 60000);

  setMonTitle(null);
  $('monitor-baud').textContent = fmtCfg(DEFAULT_CFG);
  $('ch-hostname').value = HOSTNAME_DEFAULT;
  initCfgControls();

  if (!('serial' in navigator)) {
    $('intro-hint').innerHTML = 'This page needs a <b>Chromium-based browser</b> to work, for now — '
      + 'desktop <b>Chrome</b>, <b>Edge</b>, <b>Brave</b>, or <b>Opera</b>. This browser can’t talk to '
      + 'the device over USB.';
    return;
  }

  // Always open the chooser on the Start click. Web Serial exposes only USB
  // VID/PID, so a remembered grant can't be told apart from a same-model board on
  // a different port — silently reusing it would land on the wrong device. The
  // chooser also gives the port a moment to settle, so probe → reset → detect
  // runs cleanly every time.
  $('start').textContent = 'Click here to select the serial port your device is connected to.';
  $('start').hidden = false;
  $('start').addEventListener('click', () => connect());

  // The FNB58 graph never opens on its own — only the user clicking the FNB58
  // label connects it. A 5 s poll keeps the shared active stamp fresh while
  // streaming and the label in step with the settle cooldown (hidden until the
  // meter has idled long enough to be safely reopened).
  fnbPollStatus();
  setInterval(fnbPollStatus, 5000);
}

boot();
