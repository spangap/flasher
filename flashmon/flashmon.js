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

// Bind a listener to an element that may not be in this page. index.html is
// served without the cache-bust the module gets, so a browser can pair a stale
// page with a fresh script: an element added in the same change as its handler
// is then missing, and a throw here — at module scope — would abort the whole
// script and leave nothing but a black screen. boot() says so out loud instead.
function on(id, ev, fn) {
  const el = $(id);
  if (el) el.addEventListener(ev, fn);
  return !!el;
}
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

// Picking a port resets the device and identifies the board straight away. A
// `?noreset` in the query string keeps the old hands-off behaviour: the monitor
// opens on a device that is left running, and identifying it waits for the
// Detect Hardware button.
const AUTO_DETECT = !params.has('noreset');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── timers that keep running in a background tab ────────────────────────────
// Chrome throttles window timers in a hidden tab: a chain of setTimeout calls is
// clamped to one per second, and after five minutes hidden to roughly one per
// minute. esptool-js waits for every serial response by polling its receive
// buffer with `await sleep(1)`, and the reset/upload paths (ours included) are
// built from short sleeps, so a run in a hidden tab crawls and then fails on its
// own command timeouts.
//
// Timers inside a dedicated worker are not throttled, so for the length of a
// port-owning run (flash, detect, and the monitor re-open that follows) the
// global setTimeout is routed through one: the worker holds the timer and posts
// its id back when it fires. Every user of setTimeout is covered, vendored
// esptool-js included, because it resolves the global at call time. Where a
// worker cannot be created the natives simply stay in place.
const nativeSetTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
// Our ids live far above the browser's sequential ones so a clearTimeout can
// tell whose timer it holds, whichever implementation issued it.
const WT_ID_BASE = 1e9;
let wtWorker = null;            // the worker holding the timers, once spawned
let wtSpawned = false;          // spawn is attempted once per page
const wtCallbacks = new Map();  // our timer id → callback
let wtNextId = WT_ID_BASE;
let wtDepth = 0;                // port-owning runs currently asking for them

function wtSpawn() {
  if (wtSpawned) return wtWorker;
  wtSpawned = true;
  const src =
    'const t=new Map();onmessage=(e)=>{const d=e.data;' +
    'if(d.op==="set"){t.set(d.id,setTimeout(()=>{t.delete(d.id);postMessage(d.id);},d.ms));}' +
    'else{const h=t.get(d.id);if(h!==undefined){clearTimeout(h);t.delete(d.id);}}};';
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try {
    wtWorker = new Worker(url);
    wtWorker.onmessage = (e) => {
      const cb = wtCallbacks.get(e.data);
      if (cb) { wtCallbacks.delete(e.data); cb(); }
    };
    wtWorker.onerror = wtFallBack;
  } catch (_) {
    wtWorker = null;            // no worker (CSP, say): keep the window timers
  } finally {
    URL.revokeObjectURL(url);   // the worker keeps its script alive past this
  }
  return wtWorker;
}

// A worker that dies mid-run would take every pending timer with it and hang the
// flash, so give up on it: window timers go back (throttled in a hidden tab, but
// running) and whatever it still owed fires now.
function wtFallBack() {
  wtWorker = null;
  window.setTimeout = nativeSetTimeout;
  const pending = [...wtCallbacks.values()];
  wtCallbacks.clear();
  for (const cb of pending) nativeSetTimeout(cb, 0);
}

function wtSetTimeout(fn, ms, ...args) {
  if (typeof fn !== 'function' || !wtWorker) return nativeSetTimeout(fn, ms, ...args);
  const id = wtNextId++;
  wtCallbacks.set(id, () => fn(...args));
  wtWorker.postMessage({ op: 'set', id, ms: Math.max(0, Number(ms) || 0) });
  return id;
}

function wtClearTimeout(id) {
  if (typeof id === 'number' && id >= WT_ID_BASE) {
    wtCallbacks.delete(id);
    if (wtWorker) wtWorker.postMessage({ op: 'clear', id });
    return;
  }
  nativeClearTimeout(id);
}

// Route window timers through the worker until the returned release is called.
// Nested runs share one installation; the natives go back when the last one
// releases. Call it in a try/finally — leaving the shim installed is harmless
// but pointless.
// A timer armed during a run can be cancelled after it ends (an rpc waiter that
// gets its answer, say), so clearTimeout stays ours for the rest of the page:
// it is a plain passthrough for ids the browser issued, and only it can cancel
// the ones the worker holds.
function useWorkerTimers() {
  if (!wtSpawn()) return () => {};
  let released = false;
  if (wtDepth++ === 0) {
    window.setTimeout = wtSetTimeout;
    window.clearTimeout = wtClearTimeout;
  }
  return () => {
    if (released) return;
    released = true;
    if (--wtDepth === 0) window.setTimeout = nativeSetTimeout;
  };
}

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
// `mode` picks the opening handshake:
//
// - `sync` runs it muted, discarding the first ~100 ms. That is right exactly
//   once — on a port nobody was holding, whose backlog starts wherever the
//   device's ring happened to wrap. It is wrong everywhere else, and not by a
//   margin: the bytes arriving just after a port comes back are as often a boot
//   log, from a device that reset or was power-cycled, as they are stale.
//   Nothing here can tell those apart — same bytes, same position — so a
//   reattach keeps everything and leaves it to the device not to replay its own
//   history.
// - `poke` (the reattach default) writes one bare CR and keeps what comes back.
// - `quiet` writes nothing at all, for a caller that is about to reset the
//   device. A byte written into a chip that is not running its firmware — the
//   ROM loader, or the RAM-loaded detector, neither of which reads the console
//   — is not consumed and not lost either: the USB-Serial-JTAG controller is
//   not reset with the rest of the chip, so it is still queued when the real
//   firmware comes up and is delivered to it as a keystroke, which opens a CLI
//   session over the boot log the reset was issued to capture.
async function attachStreams(m, mode = 'poke') {
  const sync = mode === 'sync';
  await m.port.open(m.cfg);
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
          let out = m.lineSync && m.lineSync.pending ? trimToLineStart(m, value) : value;
          // Frames come out of the byte stream before anything else sees it, so
          // the terminal and the log parser get the stream unchanged.
          if (out && out.length) out = rpcFeed(m, out);
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

  // The console is asked to identify itself, unless a reset is about to make
  // the question moot and the byte that asked it a stray keystroke.
  if (sync) await syncConsole(m);
  else if (mode !== 'quiet') await pokeConsole(m);
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
           rxSeq: 0, rngArmed: false, rngJustArmed: false, rngTimer: null, rngRecovering: false,
           // The framed side-channel (see the RPC section below). Per session,
           // because it is a property of the port: a handover to a new port
           // starts unarmed until that port's device announces the capability.
           rpc: { buf: new Uint8Array(0), held: 0, replies: new Map(), waiters: new Map(),
                  available: false, marker: false, probed: false, chain: Promise.resolve() } };
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

// ── the tab's ports ─────────────────────────────────────────────────────────
// A tab opens the ports it was handed by a chooser pick, and no others, ever.
// Not a preference — the only correct rule available. getInfo() exposes the USB
// vendor and product ids and nothing more: no serial number, no device path. So
// three identical boards on a desk are ONE identity to this page, and a tab that
// infers "my port is back" from a matching identity is choosing among them at
// random. When it chooses wrong, two tabs have quietly traded consoles, with
// nothing on screen to say so. Object identity is the only handle that tells
// this board from its neighbours, and a pick is the only way to establish it.
//
// Two, because a device presents this tab at most two consoles: the
// USB-Serial-JTAG one it boots on, and the CDC one `usb cdc` moves it to. A
// third pick is a replacement, so the oldest goes.
const PICKED_MAX = 2;
let pickedPorts = [];
// The one currently carrying the session. Always a member of pickedPorts.
let pinnedPort = null;

// Take ownership of a picked port and make it the active one. Callers must have
// obtained it from requestPort() — a user gesture is the only unambiguous
// statement of which physical device on the desk this tab is for.
function pinPort(port) {
  if (!port) return null;
  pickedPorts = pickedPorts.filter((p) => p !== port);
  pickedPorts.push(port);
  while (pickedPorts.length > PICKED_MAX) pickedPorts.shift();
  pinnedPort = port;
  return port;
}

// True for a port this tab was given — the pinned one, or the other transport
// it has already been pointed at. The recovery paths open these and nothing else.
const isOurs = (p) => !!p && pickedPorts.includes(p);

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
  $('monitor-baud').textContent = fmtCfg(monitor.cfg);
  $('monitor-repick').hidden = true;   // a fresh session has a working port
  setMonTitle(null);   // new session: no hostname until the device logs one

  // Forward keystrokes to the current writer. The device's serial line stays in
  // log mode until it receives input, then switches to the interactive CLI.
  const encoder = new TextEncoder();
  term.onData((data) => {
    const w = monitor && monitor.writer;
    if (w) w.write(encoder.encode(data)).catch(() => { /* port gone */ });
  });

  // A reset is its own flush — the boot log that follows starts at a line
  // boundary — so the handshake that discards a wrapped backlog is only for the
  // sessions that open on a device left running, and a reset session opens
  // without writing a byte.
  await attachStreams(monitor, doReset ? 'quiet' : 'sync');

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

// Close a handle (if open) and revoke its grant, so navigator.hid.getDevices()
// stops returning it. The meter is never silently reused across sessions — every
// connect goes through the chooser — so once a session ends we drop it entirely.
async function fnbForget(device) {
  if (!device) return;
  try { if (device.opened) await device.close(); } catch (_) {}
  try { await device.forget(); } catch (_) {}
}

// Revoke every FNB58 grant this tab still holds — belt-and-suspenders before a
// connect and on load, so no grant a prior session (or a crash) left behind can
// be silently reused. (getDevices()/forget() only reach this tab's own grants.)
async function fnbForgetGranted() {
  let devices = [];
  try { devices = (await navigator.hid.getDevices()).filter(isFnb58); } catch (_) { return; }
  for (const d of devices) await fnbForget(d);
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

function fnbShowTrouble() {
  showInfo('FNB58', '<p>Couldn’t get a reading from the FNB58. These meters can freeze if a ' +
    'session ends abruptly — the surest fix is to <b>unplug the FNB58 and plug it back in</b>, ' +
    'then click <b>FNB58</b> again.</p>');
}

// Connect the meter — only ever from the user clicking the FNB58 label. Opening
// the panel is always a deliberate act; nothing connects on its own. First honour
// the cooldown (a recently-active meter isn't idle enough to re-init — that's the
// crash), then revoke any leftover grant and always re-ask the HID chooser — the
// grant is never reused silently. If the chosen meter yields nothing, it points
// the user at a power-cycle.
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
    await fnbForgetGranted();                       // revoke any leftover grant — never reuse one silently
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
    if (monitor) { try { note(monitor, '\x1b[33m-- FNB58 stream stalled; reconnecting… --\x1b[0m'); } catch (_) {} }
    await fnbUnbind();                             // release our handle before touching it again
    await sleep(FNB58_RETRY_MS);
    if (await fnbTryDevice(device, 1, false)) return;   // re-latch a live stream (no re-init)
    await fnbTeardown();                           // gone quiet → disconnect; cooldown gates the reopen
    await fnbForget(device);                       // revoke the grant (teardown can't — we already unbound)
    if (monitor) { try { note(monitor, '\x1b[31m-- FNB58 disconnected (no data) --\x1b[0m'); } catch (_) {} }
  } finally {
    fnb.recovering = false;
  }
}

// Full teardown of the panel + HID session. The FNIRSI meters have no stop command
// and FREEZE if you close while their internal FIFO is full (a documented quirk),
// which is what crashes the next session — so first stop the keepalive and keep the
// device open a moment (FNB58_DRAIN_MS) with reports still being consumed, letting
// the browser empty that FIFO, THEN close and forget the grant (reconnect always
// re-prompts). Hides the button at once and stamps the meter active so a brief
// cooldown backs up the drain.
async function fnbTeardown() {
  cancelAnimationFrame(fnb.raf); fnb.raf = 0;
  clearInterval(fnb.refreshTimer); fnb.refreshTimer = null;   // stop the keepalive FIRST
  $('fnb58-panel').hidden = true;
  $('monitor').classList.remove('fnb58-open');
  $('monitor-fnb58').classList.remove('on');
  $('monitor-fnb58').hidden = true;            // hide the button immediately (no 5 s poll lag)
  const dev = fnb.device;
  if (dev) await sleep(FNB58_DRAIN_MS);        // drain: browser keeps reading the endpoint until we close
  await fnbUnbind();                           // awaited: the handle is fully released on return
  await fnbForget(dev);                         // revoke the grant so nothing is remembered past this session
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

// Drop the meter when the tab is navigated away or closed: stamp it active (so a
// reload can't reopen inside the cooldown) and best-effort close + forget the HID
// grant so nothing is remembered. The unload may cut the async forget() short, so
// the boot sweep (fnbForgetGranted) forgets any survivor on the next load.
function fnbCleanup() {
  if (fnb.device) { fnbMarkActive(); fnbForget(fnb.device); fnb.device = null; }
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

// ── framed RPC over the console port ─────────────────────────────────────────
// A framed side-channel multiplexed onto the same console port, over which we
// run an ordinary CLI command and read exactly its output. Frames are never
// echoed, never enter the device's line editor and never flip its console into
// CLI mode — which is what lets provisioning run without colliding with whoever
// is typing, and gives every command sent a reply to confirm against.
//
// The contract (wire format, ids, truncation, the marker) is
// spangap-core/docs/framed-rpc.md. flashmon.py implements the same thing.
//
//     <magic:4> <id:1> <len:2 big-endian> <payload:len>
const RPC_MAGIC = Uint8Array.of(0xf5, 0x53, 0x47, 0x01);   // 0xF5 can't open UTF-8
const RPC_HEADER = RPC_MAGIC.length + 3;
// Printed by the device the moment its sniffer arms, very early in boot. No
// marker, no frame ever leaves here: firmware without the sniffer would take a
// frame as keystrokes typed at the console, opening a CLI session on a device
// that was never going to answer. The capability is advertised, never probed.
const RPC_MARKER = 'serial: framed rpc v1';
// A frame whose remainder never arrives — a corrupt length, or a device that
// reset mid-reply — must not hold the terminal back for as long as it takes
// 64 KB to turn up. Give up on it and resync on the next magic.
const RPC_RESYNC_MS = 2000;

function concatBytes(list) {
  if (list.length === 1) return list[0];
  let n = 0;
  for (const p of list) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of list) { out.set(p, at); at += p.length; }
  return out;
}

function matchesAt(b, i, n) {
  for (let k = 0; k < n; k++) if (b[i + k] !== RPC_MAGIC[k]) return false;
  return true;
}

// Swallow frames out of a raw serial chunk; return the bytes that were not
// frame, for the terminal and the log parser. Everything else in the session
// sees the stream exactly as the device sent it.
function rpcFeed(m, chunk) {
  const r = m.rpc;
  let b = r.buf.length ? concatBytes([r.buf, chunk]) : chunk;
  const out = [];
  if (b.length && r.held && Date.now() - r.held > RPC_RESYNC_MS) {
    out.push(b.subarray(0, 1));            // abandoned — let its magic through
    b = b.subarray(1);
  }
  let i = 0;
  for (;;) {
    let j = -1;
    for (let k = i; k < b.length; k++) if (b[k] === RPC_MAGIC[0]) { j = k; break; }
    if (j < 0) { out.push(b.subarray(i)); i = b.length; break; }
    if (j > i) out.push(b.subarray(i, j));
    i = j;
    const avail = b.length - i;
    if (avail < RPC_MAGIC.length) {
      if (!matchesAt(b, i, avail)) { out.push(b.subarray(i, i + 1)); i++; continue; }
      break;                                // partial magic — wait for more
    }
    if (!matchesAt(b, i, RPC_MAGIC.length)) {
      out.push(b.subarray(i, i + 1)); i++; continue;    // false start — it's text
    }
    if (avail < RPC_HEADER) break;          // header incomplete
    const end = i + RPC_HEADER + ((b[i + 5] << 8) | b[i + 6]);
    if (b.length < end) break;              // payload incomplete
    rpcDeliver(m, b[i + 4], b.subarray(i + RPC_HEADER, end));
    i = end;
  }
  r.buf = b.subarray(i);
  r.held = r.buf.length ? (r.held || Date.now()) : 0;
  return concatBytes(out.length ? out : [new Uint8Array(0)]);
}

function rpcDeliver(m, id, payload) {
  const text = new TextDecoder().decode(payload);
  const waiter = m.rpc.waiters.get(id);
  if (waiter) { m.rpc.waiters.delete(id); waiter(text); return; }
  // Nobody waiting: a reply that landed just after its timeout. Keep it — the
  // retry carries the same id, so this answers it without a second execution.
  m.rpc.replies.set(id, text);
}

// The id identifies WHAT was asked, not when, so a retry reuses it and a late
// reply to the first attempt is a perfectly good answer to the second. That is
// what stops a timeout from returning a *wrong* answer — the late reply being
// taken as the answer to whatever went out next. Derived from the command, so
// neither end keeps state. The device never interprets it; it copies it back.
// Kept in 0x20..0xBF so a frame typed at firmware that doesn't speak them (the
// probe in rpcEnsure) can't carry a byte the console acts on: no CR/LF to
// execute the garbage line, no 0x03 to abort early, no 0xC0 to open a
// serial-handler session. The device never interprets the id either way — it
// copies it back — so constraining it costs nothing.
function rpcId(cmd) {
  let h = 0;
  for (let i = 0; i < cmd.length; i++) h = (h * 31 + cmd.charCodeAt(i)) & 0xff;
  return 0x20 + (h % 0xa0);
}

// Run `cmd` on the device and resolve with its output. null means it did not
// answer — distinct from '', which is a real answer meaning the command printed
// nothing. A command that fails also answers, with whatever it printed.
async function rpcQuery(m, cmd, timeout = 2500, tries = 2) {
  if (!m || !m.rpc.available || !m.writer) return null;
  const bytes = new TextEncoder().encode(cmd);
  if (bytes.length > 0xffff) return null;
  const id = rpcId(cmd);
  const frame = new Uint8Array(RPC_HEADER + bytes.length);
  frame.set(RPC_MAGIC, 0);
  frame[4] = id;
  frame[5] = bytes.length >> 8;
  frame[6] = bytes.length & 0xff;
  frame.set(bytes, RPC_HEADER);
  // Strictly one frame in flight: the device processes them synchronously, and
  // two overlapping queries could each take the other's reply if their ids
  // collided. Chained rather than locked — callers just await.
  const prev = m.rpc.chain;
  let release;
  m.rpc.chain = new Promise((r) => { release = r; });
  await prev.catch(() => {});
  try {
    for (let n = 0; n < tries; n++) {
      m.rpc.replies.delete(id);
      try { await m.writer.write(frame); } catch (_) { return null; }
      const got = await new Promise((resolve) => {
        const t = setTimeout(() => { m.rpc.waiters.delete(id); resolve(null); }, timeout);
        m.rpc.waiters.set(id, (text) => { clearTimeout(t); resolve(text); });
      });
      if (got !== null) return got;
      const late = m.rpc.replies.get(id);   // landed between the timeout and here
      if (late !== undefined) { m.rpc.replies.delete(id); return late; }
    }
    return null;
  } finally { release(); }
}

// Make sure we know whether this device speaks frames, probing once if the
// marker never arrived.
//
// The marker is printed once, very early in boot, so only a session that
// watched this device boot catches it — and opening the monitor deliberately
// does NOT reset the device ("Monitoring only"), which is the everyday case.
// Waiting for a marker that already scrolled past means silently falling back
// to typing commands at the console forever.
//
// Probing is safe because it is recoverable, which is the part that matters. On
// firmware that speaks frames the probe is swallowed and answered and costs
// nothing at all. On firmware that does not, the bytes are typed at the
// console: the first opens a CLI session and the rest land in its line editor —
// so we follow with Ctrl-C, which that firmware treats as "abort this line and
// go back to the log". The price of guessing wrong is a CLI banner and a
// "Press Ctrl-]" notice in the stream, once per session.
async function rpcEnsure(m) {
  if (!m || !m.writer) return false;
  if (m.rpc.available) return true;
  if (m.rpc.probed) return false;          // one probe per session, ever
  m.rpc.probed = true;
  m.rpc.available = true;                  // rpcQuery refuses to send otherwise
  const answered = await rpcQuery(m, 'auth -O', 1500, 1) !== null;
  if (answered) return true;
  // The marker may have landed while the probe was in flight — that is a real
  // answer and outranks the probe's silence.
  if (m.rpc.marker) return true;
  m.rpc.available = false;
  try { await m.writer.write(Uint8Array.of(0x03)); } catch (_) { /* port gone */ }
  return false;
}

// `key=value` lines — the device's `-O` onboarding output — as a Map. Unknown
// keys are ignored and a missing key is unknown, never a default; that is what
// lets the device's key set grow without breaking this.
function parseKv(text) {
  const out = new Map();
  for (const raw of (text || '').split('\n')) {
    const line = raw.replace(/\r$/, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const eq = line.indexOf('=');
    if (eq > 0) out.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return out;
}

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
    // The capability marker: the device's frame sniffer is armed, so a frame
    // may now be sent. Free and instant when we catch it — but it is printed
    // once, very early in boot, so only a session that watched this device boot
    // ever sees it. rpcEnsure() covers the rest.
    if (line.includes(RPC_MARKER)) { m.rpc.marker = true; m.rpc.available = true; continue; }
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
      m.hostnameQueried = true;      // firmware didn't log it — ask for it
      // As a frame where the device speaks them: typing this at the console
      // opens a CLI session and suppresses the log, which is the stream this
      // very parser is reading. The reply is handled here either way — framed
      // it comes back to us, typed it comes back as a log line.
      if (m.rpc.available) {
        rpcQuery(m, 'show s.net.hostname').then((out) => {
          const mm2 = /^s\.net\.hostname = (\S+)/m.exec(out || '');
          if (!mm2) return;
          m.hostname = mm2[1];
          deviceUiHost = mm2[1];
          if (m === monitor) setMonTitle(mm2[1]);
        });
      } else {
        sendToDevice(m, 'show s.net.hostname\n\n');
      }
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
// Block any insertion that contains an illegal hostname char (typed or pasted)
// before it lands, so nothing happens — the text and caret are untouched, and
// nothing has to be reported after the fact. Deletions/navigation have null data
// and pass through. The 20-char cap is the input's native maxlength.
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
  // The field can only ever hold legal hostname characters (the beforeinput
  // filter above) up to its maxlength, so whatever is in it is usable as-is; an
  // empty field means "keep the default".
  const hostname = $('ch-hostname').value.trim() || HOSTNAME_DEFAULT;
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

// Send whatever the user chose, once. The admin password uses `auth passwd
// admin <pw>` (non-interactive; the bare `passwd` command prompts). The
// password is the rest of the line, so it isn't quoted; hostname is
// [A-Za-z0-9_] only; SSID/password may hold spaces so they're quoted.
//
// The commands are the same ones a person would type — only the transport
// differs. As frames they are never echoed, never enter the line editor and
// never flip the console into CLI mode, so this cannot collide with someone
// typing, and each one is answered rather than hoped for. A device that never
// announced the capability gets the old batch, typed at the console.
async function sendSetup(m) {
  if (m.setupSent) return;
  const cmds = [];
  if (m.newPasswd) cmds.push(`auth passwd admin ${m.newPasswd}`);
  if (m.wifiCfg) {
    cmds.push(`hostname ${m.wifiCfg.hostname}`);
    cmds.push(`net add ${cliQuote(m.wifiCfg.ssid)}` +
              (m.wifiCfg.pass ? ` ${cliQuote(m.wifiCfg.pass)}` : ''));
  }
  if (!cmds.length) return;   // user skipped everything
  cmds.push('save');
  m.setupSent = true;         // synchronously, before any await — no double send
  if (await rpcEnsure(m)) sendSetupFramed(m, cmds);
  // Newline-separated, `save` persists, the trailing blank line drops the CLI
  // back to log mode.
  else sendToDevice(m, cmds.join('\n') + '\n\n');
}

// One frame per command, each waited for, then a re-query to confirm it took.
// Nothing is echoed into the terminal, so the only trace is what we note.
async function sendSetupFramed(m, cmds) {
  for (const c of cmds) {
    const verb = c.split(' ')[0];
    if (await rpcQuery(m, c, 8000) === null) {
      note(m, `\x1b[31m-- device didn't answer \`${verb}\` --\x1b[0m`);
      return;
    }
  }
  note(m, '\x1b[90m-- setup sent --\x1b[0m');
  const net = await rpcQuery(m, 'net -O');
  if (net === null || monitor !== m) return;
  const kv = parseKv(net);
  if (kv.get('hostname')) {
    m.hostname = kv.get('hostname');
    deviceUiHost = m.hostname;
    setMonTitle(m.hostname);
  }
  if (kv.get('state') === 'sta' && kv.get('ip')) {
    m.connectedSeen = true;
    showOpenUi(m, kv.get('ip'), kv.get('ssid') || '');
  }
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
  closeDeviceBox();
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

// The device says it is moving its console to the CDC composite. This is the
// one departure that is known not to be a blip — the port is not coming back on
// this transport — so it is one of the only two places allowed to pop a picker.
//
// It still gives recovery first refusal. If this tab has already been pointed
// at the CDC console port once, that port is in pickedPorts, the rescan opens it
// the moment it enumerates, and the move completes with no dialog at all. The
// ask is for the first move only, or after a re-pick pushed the CDC port out of
// the pair.
//
// What it must never do is adopt a CDC port on a grant alone. The composite's
// two interfaces are indistinguishable from each other and from another board's,
// so that is a coin toss, and losing it swaps two consoles on a desk.
function offerConsoleHandover() {
  if (!monitor || awaitingCdc || !$('cdcmove-overlay').hidden) return;
  awaitingCdc = true;
  setTimeout(() => {
    awaitingCdc = false;
    if (!monitor) return;
    if (!monitor.gone && monitor.reader) return;   // followed it on our own
    $('cdcmove-overlay').hidden = false;
  }, 3000);
}

// Move the console onto the port the user just picked, keeping the outgoing
// session rendering into the same terminal until the device drops it. The pick
// re-pins the tab: from here on this is the port, and the one it moved away
// from is only watched out.
//
// The composite device presents two CDC ports with nothing in getInfo() to tell
// them apart, and only the first is the console. The dialog says so and the
// user picks; a port that turns out to be the silent one is caught by
// verifyAlive, which narrates it. Auditioning them here instead would mean
// opening a port nobody chose.
async function adoptConsolePort(port) {
  if (!monitor || !port) { awaitingCdc = false; return; }
  const outgoing = monitor;
  adopting = true;                 // holds the rescan off while this runs
  let committed = null;
  try {
    let chosen;
    try {
      chosen = makeSession(port, outgoing.term, outgoing.resizeObserver, false);
      await attachStreams(chosen);
    } catch (e) {
      note(outgoing, `\x1b[31m-- could not open the new port: ${e && e.message ? e.message : e} --\x1b[0m`);
      scheduleRescan();
      return;
    }
    // Re-check before committing: attachStreams awaits, and a reclaim of the
    // outgoing port can have completed in that gap. Overwriting `monitor` now
    // would throw away a session that is proven live.
    if (monitor !== outgoing) {
      try { await detachStreams(chosen); } catch (_) { /* */ }
      note(outgoing, '\x1b[90m-- console already recovered; move abandoned --\x1b[0m');
      return;
    }
    pinPort(port);                       // the tab's port from here on
    priorSession = outgoing.gone ? null : outgoing;
    monitor = chosen;
    committed = chosen;
    outgoing.term.focus();
    refreshFlashOffer();
  } finally {
    adopting = false;
    awaitingCdc = false;
    // After the flags clear, so its own close/reopen cycle isn't held off by
    // them. This is what tells a user who picked the composite device's other
    // interface — the silent one — that they picked the wrong of the two.
    if (committed) verifyAlive(committed);
  }
}

// The cdc→jtag counterpart, and the other of the two places allowed to pop a
// picker. Same shape: the device is walking off this transport for good, so if
// the tab already owns the JTAG port the rescan is opening it right now and
// there is nothing to ask. Only a tab that does not own it — one that was
// opened straight onto CDC, or whose JTAG port aged out of the pair — needs the
// dialog. A switch the firmware announced but never carried out leaves the CDC
// session running, and the same check covers that: a working monitor is never
// interrupted.
function offerConsoleReturn() {
  if (!monitor) return;
  setTimeout(() => {
    if (monitor && (monitor.gone || !monitor.reader)) askReconnect(null);
  }, 3000);
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

// Re-open the tab's port over the dead session. Shared by the connect event and
// the rescan below, so a port that arrives before its predecessor's death is
// reported gets the same treatment as one that arrives after. `attempts` bounds
// the open retries: a connect event has just proved the device is there and gets
// the patient run (an OS still building the device node needs time), while the
// rescan's blind polling takes one attempt per tick.
let reclaimLastReport = null;   // last failure line printed; cleared on success
async function reclaimPort(p, attempts = 8) {
  monitor.reattaching = true;                 // set synchronously, before any await
  monitor.port = p;
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
        // Whichever of the tab's ports answered is now the active one. That is
        // how a console move completes without a dialog once both transports
        // have been picked: the CDC port this tab already owns turns up, and
        // the session simply follows it.
        pinnedPort = p;
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

// Keep trying the tab's ports while the session is dead. Events cannot be
// trusted to drive this on their own: a connect that lands while the session
// still looks live (or while a reclaim holds the lock) is refused, and that
// one-shot event is spent. Ground truth is polled instead — session dead, one
// of our ports attached → reopen it — and the loop also outlasts a failed
// reclaim, because a port can be listed by the browser well before the OS lets
// it open.
//
// The candidate list is `pickedPorts` and nothing else. It rotates over them,
// pinned first, because after a console move the port that answers is the other
// one — which is what makes the second and every later `usb cdc` free of any
// dialog. A board that was unplugged and plugged back in may return as a fresh
// SerialPort object; this loop deliberately does not go looking for it.
//
// **This loop never raises a dialog.** Ports go away constantly — every reset,
// every reflash — and come straight back, so a departure is not evidence of
// anything and a modal on one would be wrong far more often than right. The
// only thing that says a port is gone *for good* is the device announcing a
// transport switch, and those two paths (offerConsoleHandover /
// offerConsoleReturn) own the ask. What this loop does after a long silence is
// reveal the Re-select port button and go quiet.
let rescanTimer = null;
// Raised for this outage already, so the ask is ONCE per outage. Cleared when
// the outage ends (below).
let reconnectAsked = false;
function askReconnect(why) {
  if (reconnectAsked) return;
  reconnectAsked = true;
  if (monitor && why) note(monitor, `\x1b[33m-- ${why} --\x1b[0m`);
  $('reconnect-overlay').hidden = false;
}
// Offer the re-pick without interrupting: the session may yet recover on its
// own, and this waits to be clicked either way.
function offerRepick() {
  if (!$('monitor-repick').hidden) return;
  $('monitor-repick').hidden = false;
  if (monitor) note(monitor, '\x1b[33m-- still no port; use “Re-select port” if it came back as a new one --\x1b[0m');
}
function scheduleRescan() {
  if (rescanTimer) return;
  let announced = false;
  let ticks = 0;
  let rotate = 0;
  rescanTimer = setInterval(async () => {
    if (!monitor || (!monitor.gone && monitor.reader)) {   // recovered or torn down
      clearInterval(rescanTimer);
      rescanTimer = null;
      reconnectAsked = false;
      $('reconnect-overlay').hidden = true;
      $('monitor-repick').hidden = true;
      return;
    }
    if (monitor.reattaching) return;          // a reclaim is already running
    // A console move is opening one of these ports itself; stay off it rather
    // than race for the handle.
    if (adopting) return;
    ticks++;
    if (ticks === 40) offerRepick();          // ~30 s of nothing; before the
                                              // backoff below, which skips ticks
    // Present and openable is the common case and resolves in the first second
    // or two. Past that the device is off the bus, and polling it hard buys
    // nothing — back off, but never stop: a board that comes back on the same
    // object is still picked up for free, however long it took.
    if (ticks > 20 && (ticks % 6)) return;
    const live = pickedPorts.filter((x) => x.connected !== false);
    if (!live.length) return;
    // Pinned first, then the other transport — after a move it is the other one
    // that turns up, and following it is the whole point of owning both.
    const order = [pinnedPort, ...live.filter((x) => x !== pinnedPort)].filter(
      (x) => x && live.includes(x));
    const p = order[rotate++ % order.length];
    if (!announced) {
      note(monitor, `\x1b[90m-- following the ${portLabel(p)} already present --\x1b[0m`);
      announced = true;
    }
    // One attempt per tick: a stale handle does not fail transiently — it
    // fails, it's dead. (A port whose arrival raised a connect event gets the
    // patient retries in that handler.)
    await reclaimPort(p, 1);
  }, 800);
}

// Dismissing costs nothing: the rescan keeps trying the tab's ports, the
// Re-select port button is there when it is wanted, and the stream carries the
// line saying what to do. What it buys is the ability to use the rest of the page.
$('reconnect-dismiss').addEventListener('click', () => {
  $('reconnect-overlay').hidden = true;
});

// Pop the chooser and adopt what comes back. It takes a gesture by design: with
// several identical boards listed, only the person at the desk knows which entry
// is this tab's. `putBack` restores whatever asked, if the chooser is dismissed.
async function repickPort(putBack) {
  if (!monitor) return;
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (_) {
    if (putBack) putBack();     // dismissed — this was answering a gesture
    return;
  }
  pinPort(port);
  $('monitor-repick').hidden = true;
  await reclaimPort(port);
}

$('reconnect-pick').addEventListener('click', () => {
  $('reconnect-overlay').hidden = true;
  repickPort(() => { $('reconnect-overlay').hidden = false; });
});

// The non-modal way back, revealed by the rescan after a long silence.
$('monitor-repick').addEventListener('click', () => repickPort(null));

// The tab's port leaving the bus: note it in the stream and tear the dead
// streams down. Nothing else on the desk is any of this tab's business — three
// boards mean three sets of these events, and only the one for our own port
// says anything about our session.
navigator.serial.addEventListener('disconnect', (e) => {
  const p = e.port || e.target;
  if (!p) return;
  // The port a handover moved away from, finally going. Expected, not a loss:
  // say so plainly and let it go.
  if (priorSession && p === priorSession.port) {
    const old = priorSession;
    priorSession = null;
    note(old, `\x1b[36m-- previous ${portLabel(old.port)} gone --\x1b[0m`);
    detachStreams(old);
    return;
  }
  // Only the port actually carrying the session. The tab's other transport
  // coming and going is the device's business, not an outage.
  if (!monitor || p !== pinnedPort || monitor.gone) return;
  monitor.gone = true;
  hideOpenUi();            // the device is gone — drop its buttons
  pendingFlash = null;     // can't flash (or detect on) a gone device
  cancelStateWarn();       // …so a warning waiting on an answer is moot
  $('monitor-flash').hidden = true;
  $('monitor-detect').hidden = true;
  note(monitor, `\x1b[31m-- ${portLabel(p)} gone --\x1b[0m`);
  detachStreams(monitor);
  // The port may have re-connected BEFORE this death was reported — its
  // one-shot connect event refused while the session still looked live. Now
  // that the session is known dead, keep trying. This runs during a console
  // move too: the port the device is moving TO may be one this tab already
  // owns, and the loop opening it is exactly how a move completes without
  // troubling anyone.
  if (!adopting) scheduleRescan();
});

// Only ever the tab's own port. An arrival that is not it is another board on
// the desk coming back — possibly into another tab that owns it — and following
// it would be how two consoles trade places.
navigator.serial.addEventListener('connect', async (e) => {
  const p = e.port || e.target;
  if (!isOurs(p) || !monitor) return;
  // Ground truth, not bookkeeping: a session with no reader has no working
  // port, whatever `gone` was left saying. That flag has repeatedly gone stale
  // — a missed disconnect leaves it false — and every time it does, an arriving
  // port is announced and then not taken, which presents as a live-looking
  // session that is mute and deaf until the page is reloaded.
  if (!(monitor.gone || !monitor.reader)) return;
  // Re-enumeration fires `connect` several times; the lock keeps a single
  // reattach running so concurrent handlers don't fight over the port.
  if (monitor.reattaching) return;
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
// The download's own dialog. The image is fetched with the monitor still up and
// the device still running, so its progress has no intro screen to live on —
// this box sits over the terminal for the length of the fetch and unpack, and
// takes no answer: it closes when the image is in hand, or when the fetch fails
// and the error goes to the monitor.
function dlOpen(what) {
  if (!$('dl-overlay')) return;               // page older than this script
  $('dl-sub').textContent = what;
  $('dl-detail').textContent = '';
  $('dl-barfill').style.width = '0';
  $('dl-overlay').hidden = false;
}
function dlProgress(frac, detail) {
  if (!$('dl-overlay')) return;
  if (frac != null) $('dl-barfill').style.width = `${Math.round(frac * 100)}%`;
  if (detail != null) $('dl-detail').textContent = detail;
}
function dlClose() { if ($('dl-overlay')) $('dl-overlay').hidden = true; }

// Fetch `url` into memory, reporting progress as the body streams in. A response
// that declares no Content-Length (chunked, or compressed on the fly) has no
// fraction to report: `frac` comes through null and only the byte count moves.
async function fetchProgress(url, onProgress) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`could not fetch ${url} (HTTP ${res.status}) — is the build published?`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());   // no streaming here
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(total ? got / total : null, got, total);
  }
  return concatBytes(chunks);
}

// Download the image zip at `zipURL` (a flasher.zip produced by `spangap
// build`) and unzip it in the browser: the images to write, each at its offset,
// plus the flash settings. Separate from the write, and touching neither the
// device nor the monitor, so the plan's offsets can be weighed against what is
// on the chip (see stateOverlaps) while there is still nothing to undo.
async function loadFlashPlan(zipURL) {
  log(`Downloading ${zipURL}`);
  dlOpen(zipURL.replace(/^.*\//, ''));
  try {
    return await unpackFlashPlan(zipURL);
  } finally {
    dlClose();
  }
}

async function unpackFlashPlan(zipURL) {
  const bytes = await fetchProgress(zipURL, (frac, got, total) => {
    dlProgress(frac, total ? `${fmtBytes(got)} of ${fmtBytes(total)}` : `${fmtBytes(got)} downloaded`);
  });
  dlProgress(1, `${fmtBytes(bytes.length)} downloaded — unpacking…`);
  const zip = await window.JSZip.loadAsync(bytes);

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
    dlProgress(null, `unpacking ${fname} (${fileArray.length + 1} of ${entries.length})…`);
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

// Names for the USB identities that turn up here. The readable string the
// browser's own chooser shows ("USB JTAG/serial debug unit", "FNB-58") comes
// from the device's USB descriptors, read by the operating system; Web Serial
// hands a page `usbVendorId` and `usbProductId` and nothing else, so a name in
// flashmon's own UI has to be a table of ours. It names the kind of port, never
// the individual board — three identical boards share one identity, and what
// tells them apart is the hostname in the title once the device logs one.
const USB_NAMES = [
  { vid: 0x303A, pid: 0x1001, name: 'ESP32-S3 USB-Serial-JTAG' },
  { vid: 0x303A, pid: 0x4002, name: 'ESP32-S3 CDC console' },
  { vid: 0x10C4, pid: 0xEA60, name: 'CP210x USB-UART bridge' },
  { vid: 0x1A86, pid: 0x55D4, name: 'CH9102 USB-UART bridge' },
  { vid: 0x1A86, pid: 0x7523, name: 'CH340 USB-UART bridge' },
];

function usbDeviceName(port) {
  if (isFnb58Port(port)) return 'FNB58 power meter';
  try {
    const i = port.getInfo ? port.getInfo() : {};
    const hit = USB_NAMES.find((n) => n.vid === i.usbVendorId && n.pid === i.usbProductId);
    return hit ? hit.name : null;
  } catch (_) {
    return null;
  }
}

// The selected port's USB identity (native-USB S3 = 303A:1001, or a bridge's
// CP2102/CH9102 VID:PID), with its name where we have one. Shown at the top of
// the banner. null for non-USB ports.
function usbInfoLine(port) {
  try {
    const i = port.getInfo ? port.getInfo() : {};
    if (i.usbVendorId == null) return null;
    const h = (n) => (n != null ? n.toString(16).toUpperCase().padStart(4, '0') : '????');
    const name = usbDeviceName(port);
    return `USB ${h(i.usbVendorId)}:${h(i.usbProductId)}${name ? ` — ${name}` : ''}`;
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

// ── the device box ──────────────────────────────────────────────────────────
// Everything a detection run read off the attached device, shown over the
// terminal the moment the run ends: the board and its photo, the chip facts, the
// peripherals, where the device keeps its own data, and what firmware it runs.
// It takes no decision — the flash offer is resolved behind it, so OK just
// uncovers a monitor that is already in its normal state, green Flash button and
// all.
//
// The facts are kept because some land late: the running firmware's build stamp
// only arrives with the boot log a few seconds after the reset, and the flash
// offer waits on it, so an open box re-renders as they come in.
let deviceFacts = null;

// The catalogue's photo for `hw` — `image:` on its build entry, a path in the
// web root (`devices/<board>.jpg` by convention). Nothing ships one by default,
// and a board without one simply shows no picture.
function deviceImage(hw) {
  const entry = BUILDS.find((b) => b.name === hw);
  return (entry && entry.image) || null;
}

// A build stamp (YYYYMMDDhhmmss) as a readable date.
function fmtStamp(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(v || '');
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : (v || '');
}

// One <dt>/<dd> pair. Written as text, never markup: every value here is a line
// the device itself printed.
function factRow(dl, key, value) {
  if (!value) return;
  const dt = document.createElement('dt');
  dt.textContent = key;
  const dd = document.createElement('dd');
  dd.textContent = value;
  if (value.includes('\n')) dd.className = 'lines';
  dl.append(dt, dd);
}

function renderDeviceBox() {
  const f = deviceFacts;
  if (!f || !$('device-overlay')) return;     // no facts, or a page older than this script
  const board = f.hw ? f.hw.replace(/^hw-/, '') : null;
  $('device-title').textContent = board || 'Device found';
  $('device-sub').textContent = f.hw
    ? `Identified as ${f.hw}. Everything read off the chip:`
    : 'The chip answered the probe, but no supported board matched it.';

  const photo = $('device-photo');
  const src = f.hw ? deviceImage(f.hw) : null;
  photo.hidden = !src;
  if (src) {
    photo.onerror = () => { photo.hidden = true; };   // catalogue names a file that isn't there
    photo.alt = board;
    photo.src = src;
  }

  const dl = $('device-facts');
  dl.textContent = '';
  factRow(dl, 'Port', f.usb);
  factRow(dl, 'Chip', f.chip.join('\n'));
  factRow(dl, 'Peripherals', f.periph.length ? f.periph.join('\n') : 'none reported');
  factRow(dl, 'Stored data', f.state
    ? `state partition at 0x${f.state.addr.toString(16)}, ${fmtBytes(f.state.size)}`
    : 'no state partition on this chip yet');
  const m = monitor;
  factRow(dl, 'Firmware', m && m.deviceVersion
    ? `${PROJECT} build ${fmtStamp(m.deviceVersion)}`
    : 'no build stamp reported (older firmware, or still booting)');
  const offered = pendingFlash && (BUILDS.find((b) => b.name === pendingFlash.name) || {}).version;
  let catalogue;
  if (!f.hw) catalogue = 'no board identified, so nothing to match against';
  else if (pendingFlash) catalogue = `build ${fmtStamp(offered)} is newer — the green button behind this box flashes it`;
  else if (m && m.versionSettled) catalogue = 'nothing newer published for this board';
  else catalogue = 'checking for a newer build…';
  factRow(dl, 'Catalogue', catalogue);
}

function showDeviceBox(facts) {
  deviceFacts = facts;
  renderDeviceBox();
  if ($('device-overlay')) $('device-overlay').hidden = false;
}

function closeDeviceBox() { if ($('device-overlay')) $('device-overlay').hidden = true; }

on('device-ok', 'click', closeDeviceBox);
// Clicking the dimmed backdrop dismisses it too — but not a click inside the
// box, where the fact list is there to be selected and copied.
on('device-overlay', 'click', (e) => {
  if (e.target === $('device-overlay')) closeDeviceBox();
});

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

// Re-evaluate the flash offer, and with it anything that quotes the offer.
async function refreshFlashOffer() {
  await resolveFlashOffer();
  const box = $('device-overlay');
  if (box && !box.hidden) renderDeviceBox();
}

// Resolve the identified board to the best available image and show the flash
// button — but only when that image is newer than the running firmware. Reactive:
// re-run whenever the board, the device's build stamp, or the catalogue changes. A
// board-specific image names the device in the button; the generic fallback says so.
//
// The green slot falls back to "Detect Hardware" while the board is unknown —
// nothing can be resolved until either the boot log or a detection run names it.
async function resolveFlashOffer() {
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

  // The download, the write and the re-open that follows all run on short timers,
  // which a hidden tab would throttle to a standstill — so they are held for the
  // whole run, from the first byte fetched to the monitor coming back.
  const releaseTimers = useWorkerTimers();
  try {
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
  } finally {
    releaseTimers();
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
  let facts = null;
  // ROM-loader traffic and the reset back into the firmware run on short timers,
  // which a hidden tab would throttle to a standstill.
  const releaseTimers = useWorkerTimers();
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
      // Same findings, for the box: the detector's own conclusions (`DETECTED:`
      // — the board, the state store) are stated as fields of their own, so what
      // is left under "peripherals" is the parts it actually found on the buses.
      facts = {
        usb: usbInfoLine(port),
        chip: info,
        periph: detected.filter((l) => !l.startsWith('DETECTED:')),
        hw,
        state: statePart,
      };
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
    releaseTimers();
  }
  // Record what we learned (nothing, on a failed run — which puts the Detect
  // Hardware button back) and offer a flash only if a newer build is published.
  armFlashGrace(hw, true);
  // Only a run that reached the chip has anything to show.
  if (facts && monitor) showDeviceBox(facts);
}

$('monitor-detect').addEventListener('click', runDetect);

let connecting = false;

// Pop the serial chooser, open the monitor on the port, and identify the board:
// the pick is followed straight away by a detection run, which resets the device,
// reads the chip and its peripherals, and ends in the device box. Under
// `?noreset` the pick opens the monitor and stops there — the device is not
// probed and not reset, it keeps doing whatever it was doing, and identifying it
// waits for the Detect Hardware button or the firmware's own `build: invocation`
// line. requestPort() is called first, while the user gesture is fresh, before
// any long await.
//
// This pick is what the tab is for. It becomes the tab's one port, and only
// another pick — the reconnect dialog, or a console move — ever replaces it.
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
    pinPort(port);
    const banner = AUTO_DETECT
      ? ['Identifying the board — the device is about to be reset.']
      : ['Monitoring only — the device has not been reset.',
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
  // Identify the board the moment the monitor is up — outside the try above, so
  // a detection failure reports itself in the monitor rather than putting the
  // "pick a port" call to action back over a live session.
  if (AUTO_DETECT && monitor) await runDetect();
}

// ── config ────────────────────────────────────────────────────────────────
// Minimal YAML for our shape: `project: <name>` and a `builds:` list whose
// entries each carry a `name:`. The browser needs the project brand, the image
// names and stamps, and the optional `image:` photo the device box shows; the
// invocations are for `make` in builds/, not the browser.
function parseConfig(text) {
  const cfg = { project: 'flashmon', builds: [] };
  let inBuilds = false;
  let cur = null;
  const set = (obj, kv) => {
    const i = kv.indexOf(':');
    if (i < 0) return;
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k === 'name' || k === 'version' || k === 'image') obj[k] = v;
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
  HOSTNAME_DEFAULT = (PROJECT.toLowerCase().replace(/[^a-z0-9_]/g, '') || 'flashmon').slice(0, 20);

  // Re-read the catalogue once a minute so a build published while the page is
  // open becomes available without a reload; re-evaluate the live flash offer
  // against the refreshed stamps. Branding (project/slug) is left as booted.
  setInterval(async () => {
    const c = await loadConfig();
    BUILDS = c.builds;
    BUILD_NAMES = c.builds.map((b) => b.name).filter(Boolean);
    if (monitor) refreshFlashOffer();
  }, 60000);

  // Markup this script drives that the page it loaded into doesn't have: the
  // page was served from cache, older than the script beside it. Flashing and
  // the monitor still work; the dialogs those elements belong to don't, and a
  // reload that bypasses the cache is the fix.
  const stale = ['dl-overlay', 'device-overlay'].filter((id) => !$(id));
  if (stale.length) {
    log(`This page is cached from an older deployment (missing: ${stale.join(', ')}). `
      + 'Reload with Shift held to fetch the current one.', 'err');
  }

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
  // label connects it, and it is never reconnected from a remembered grant: on
  // load we forget any grant a prior session left behind, so the first click
  // always goes through the chooser. A 5 s poll then keeps the shared active
  // stamp fresh while streaming and the label in step with the settle cooldown
  // (hidden until the meter has idled long enough to be safely reopened).
  if ('hid' in navigator) fnbForgetGranted();
  fnbPollStatus();
  setInterval(fnbPollStatus, 5000);
}

boot();
