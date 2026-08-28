// flashmon — browser firmware flasher / serial monitor.
//
// Connecting only opens the port: the device is not touched, not reset, and the
// monitor shows whatever it is already doing. It is then ASKED which board it
// is — `show sys.hw`, one frame on the already-open port. spangap confirms the
// board its image was built for against the hardware at every boot and halts on
// a mismatch, so a device that answers has already settled the question and
// nothing needs resetting.
//
// Only a device with no answer — no firmware, an image too old to carry the key,
// a generic image, or one that does not speak frames — is worth a probe: reset
// the chip, RAM-load the peripheral detector (no flash write), and read the
// board off the buses. That run is "Detect hardware" in the settings panel, and
// it is also what a connect falls back to unless "No reset" says to leave the
// device alone.
//
// That probe assumes a reset it can drive, and not every board has one: a device
// whose USB is on the S3's USB-OTG controller rather than USB-Serial-JTAG has
// neither DTR/RTS nor the Serial-JTAG reset sequence, so esptool's reset runs and
// nothing happens. Reaching the ROM loader there takes a human holding BOOT and
// tapping RESET. So a silent device is asked a second question before the probe:
// is it in the loader ALREADY? If it is, the whole run switches to no-reset —
// probe, detector upload and flash alike — because a reset it cannot perform is
// also a state it cannot get back. The RAM detector closes the circle by
// returning to the loader instead of idling, so the flash that follows still
// finds the ROM up without anyone touching the board again. Starting the
// firmware at the end needs no hands either: a reset does not have to come from
// outside the chip, and arming the RTC watchdog from the loader restarts it —
// which is what esptool falls back to on this chip for the same reason.
//
// Once the board is known and the catalogue holds an image for it, the offer
// appears in that same device window, under the facts it follows from: "Flash"
// for an image newer than what runs, "Flash anyway" — behind a warning — for one
// that is the same build or older, which is a re-flash you may still want. Going
// ahead unzips that image in the browser and flashes every segment at its offset
// over Web Serial (vendored esptool-js), then drops back into the monitor and
// resets the device so its boot log streams live. With auto-flash on, a newer
// image doesn't wait to be asked about.
//
// The catalogues are directories beside this page — ../builds/<catalogue>/ —
// and ../builds/index.html lists them. Which one is in force starts at `stable`,
// is overridden by `?build=`, follows the attached device's own
// `build: catalogue` line, and is finally the user's to pick in the settings
// panel. Three files in a catalogue drive everything:
//
//   builds.yaml   the brand and the entries (each `name` matched against the
//                 detected hw-<board>)
//   index.html    the images that exist, as <slug>_<name>_<stamp>.zip links;
//                 the newest stamp for a board is the offer
//   timestamp     the newest stamp in the directory, polled so a build
//                 published while the page is open is noticed
//
// No CDN, no build step — these files can be served from anywhere static.

import { ESPLoader, Transport } from './vendor/esptool-bundle.js';
import { Terminal } from './vendor/xterm.js';
import { FitAddon } from './vendor/xterm-addon-fit.js';
import { SerialPort as UsbSerialPort } from './vendor/web-serial-polyfill.js';

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

// The tree of catalogues, beside the page in the deployment and under `spangap
// dev` alike, so one relative path reaches it in both. Its own index.html lists
// the catalogues that are meant to be found; one that is served but unlisted is
// still reachable by naming it.
const BUILDS_BASE = '../builds/';
const cleanCatalogue = (s) => (s || '').replace(/[^A-Za-z0-9._-]/g, '');

// The catalogue images are offered from — `stable` unless something says
// otherwise. `?build=<name>` names one for this load, the settings panel's
// Build selector changes it live, and an attached device that reports which
// catalogue it was flashed from moves it there on its own (see setCatalogue).
let CATALOGUE = cleanCatalogue(params.get('build')) || 'stable';
let CAT_BASE = `${BUILDS_BASE}${CATALOGUE}/`;
// True once something other than the default has claimed the choice — a
// `?build=`, or the user picking one. A device's own catalogue is adopted only
// while nothing has.
let cataloguePinned = !!cleanCatalogue(params.get('build'));

// Filled from builds.yaml at boot. `project` brands the UI; `builds` is the
// catalogue of entries (each a `name` matched against the detected hw-<board>).
// `slug` is the project name reduced for filenames.
let PROJECT = 'flashmon';
let BUILDS = [];
let BUILD_NAMES = [];
let SLUG = 'flashmon';
// Build name -> the newest stamp published for it, read out of the catalogue's
// index.html. The listing is the record of what exists: the config says what the
// catalogue is meant to hold, this says what it actually holds right now.
let VERSIONS = {};
// Build name -> how a device running that image gets set up, off the same
// listing: `device` means the image asks for itself on its own screen and this
// page must not. Filled by loadVersions alongside VERSIONS, since both come off
// one pass over the same anchors.
let ONBOARDING = {};
// Set once a device-onboarding image has been written to the attached board:
// from then on this session stays out of setup entirely, whatever the device's
// boot log says it is missing — the device is asking for it on its screen.
let deviceOnboards = false;
// The stamp file's last value. A change is the signal to re-read the listing;
// nothing else about it matters.
let LAST_STAMP = null;
// Default device hostname (a DNS/mDNS label): the project name, lowercased and
// reduced to the legal charset. Set once the config loads.
let HOSTNAME_DEFAULT = 'flashmon';
// The image resolved for the connected board, if any:
// { url, label, name, stamp, newer }. `newer` is false when the catalogue's
// image is the one already running, or older than it — still offered, behind a
// warning. Set whenever the offer resolves; read by the offer dialog.
let pendingFlash = null;
// The image URL the offer dialog has already been opened for. The URL carries
// the stamp, so a build that lands while the page is open opens it again while
// a re-render of the same offer doesn't. Set when the dialog opens and when a
// flash starts, so flashing an image is not followed by an offer to flash it.
let offerShownFor = null;
// True while a detection run owns the port (monitor torn down, ROM loader busy):
// disables the settings panel's Detect hardware button and keeps the run
// non-reentrant.
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

// ── settings ────────────────────────────────────────────────────────────────
// What the gear panel holds. Live for this tab as soon as they're changed; the
// panel's "Set as defaults" is what writes them here, so a session can try
// something without committing to it.
const SETTINGS_KEY = 'flashmon.settings';
const SETTINGS_DEFAULTS = {
  baudRate: 115200,     // the device console's rate (ESP-IDF default)
  noReset: false,       // open the monitor without resetting or identifying
  autoFlash: false,     // flash a newer image as soon as one is on offer
};

function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch (_) { /* nothing stored, or not ours */ }
  const s = { ...SETTINGS_DEFAULTS };
  for (const k of Object.keys(SETTINGS_DEFAULTS)) {
    if (typeof stored[k] === typeof SETTINGS_DEFAULTS[k]) s[k] = stored[k];
  }
  // A baud in the URL is for firmware that logs somewhere other than the
  // console default, and outranks the stored one for this load only.
  const urlBaud = parseInt(params.get('monitor_baud'), 10);
  if (urlBaud) s.baudRate = urlBaud;
  return s;
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS));
    return true;
  } catch (_) {
    return false;    // private mode, or storage full — the session keeps them
  }
}

const SETTINGS = loadSettings();

// Default line settings. Only the rate is configurable from the panel; the rest
// of the frame is the console's and is changed from the same panel's selects.
const DEFAULT_CFG = {
  baudRate: SETTINGS.baudRate,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
};

// Picking a port resets the device and identifies the board straight away.
// "No reset" in the settings panel is the hands-off alternative: the monitor
// opens on a device that is left running, and identifying it waits for the
// panel's Detect hardware button.
const autoDetect = () => !SETTINGS.noReset;

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
//
// The same worker also serves callers that need one un-throttled timer without
// taking over the global (wtSetInterval, used by the FNB58 keep-alive).
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

// A repeating timer the worker holds, for a cadence that has to survive a hidden
// tab outside any port-owning run — the FNB58 keep-alive, which the device drops
// the stream over if it stops arriving. It is a self-re-arming chain rather than
// a worker-side interval so a slow callback can never stack up behind itself.
// Returns a stop function; where no worker exists it is a plain window interval
// (throttled, like everything else in that fallback).
function wtSetInterval(fn, ms) {
  if (!wtSpawn()) {
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  }
  let id = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try { fn(); } finally { if (!stopped) id = wtSetTimeout(tick, ms); }
  };
  id = wtSetTimeout(tick, ms);
  return () => { stopped = true; wtClearTimeout(id); };
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

// Window/tab title and the top `<h1>`. `host` is the device's real hostname
// once it has been seen on the wire, else null. The landing tab reads
// "FlashMon - <project>"; a session's is "<host> - console" — no project, the
// tab strip is for telling sessions apart — with an emoji lead for the states
// worth spotting across a row of tabs (the glyph survives a tab squeezed too
// narrow for any text): ❌ while the serial port is gone, 🔥 while an image is
// being written ("<host> - flashing"). While flashing, the big header shrinks
// to "Flashing <project>" with the image's name (its zip filename, extension
// dropped) as a subheading under it.
let titleHost = null;
let titleMode = 'ok';        // 'ok' | 'gone' | 'flashing'
let flashingImage = null;    // the image name shown while flashing
function renderMonTitle() {
  const flashing = titleMode === 'flashing';
  if (flashing) {
    document.title = `🔥 ${titleHost || PROJECT} - flashing`;
  } else {
    const t = titleHost ? `${titleHost} - console` : `FlashMon - ${PROJECT}`;
    document.title = titleHost && titleMode === 'gone' ? `❌ ${t}` : t;
  }
  const h1 = $('title');
  h1.classList.toggle('flashing', flashing);
  h1.textContent = flashing ? `Flashing ${PROJECT}`
    : titleHost ? `${titleHost} - ${PROJECT}` : PROJECT;
  // The subheading is script-built like the lobby and the toast: the page is
  // served without the module's cache-bust, and the flash screen must read
  // right over a cached page too.
  let sub = $('title-sub');
  if (flashing && flashingImage) {
    if (!sub) {
      ownStyles();
      sub = document.createElement('div');
      sub.id = 'title-sub';
      h1.insertAdjacentElement('afterend', sub);
    }
    sub.textContent = flashingImage;
    sub.hidden = false;
  } else if (sub) {
    sub.hidden = true;
  }
}
function setMonTitle(host) {
  titleHost = host;
  titleMode = 'ok';    // a title set is a session speaking — neither gone nor flashing
  renderMonTitle();
}
function markTitleGone(gone) {
  titleMode = gone ? 'gone' : 'ok';
  renderMonTitle();
}
// `image` (the zip filename without its extension) enters the flashing state;
// null leaves it — though every flash path's closing monitor re-open lands in
// setMonTitle, which leaves it as well.
function markTitleFlashing(image) {
  flashingImage = image;
  titleMode = image ? 'flashing' : 'ok';
  renderMonTitle();
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
async function gatherChipInfo(loader, mode = 'default_reset') {
  await loader.main(mode);
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

// ── reaching the ROM loader without a reset line ────────────────────────────
//
// Every ROM-loader step below normally begins by resetting the chip into the
// loader, which esptool does over DTR/RTS or — when it recognises the
// USB-Serial-JTAG PID — that unit's own sequence. A board whose USB is on the
// **USB-OTG** controller instead (the S3 reports PID 0x0009 there, its chip id)
// has neither: the reset sequence runs and nothing happens.
//
// Such a board can still be flashed, but only from a loader a human put it in,
// by holding BOOT and tapping RESET — and once there it must be kept there, since
// a reset it cannot perform is a state it cannot get back.
//
// Which board that is, is a property of the PORT and is known before anything is
// touched: the USB identity says which controller answers. `303A:1001` is the
// Serial-JTAG unit, which esptool resets with its own sequence; a non-Espressif
// VID is a USB-UART bridge, which resets over DTR/RTS. An Espressif VID with any
// other PID is the OTG path — the chip's own ROM device, whose PID is its chip
// id — and there is nothing to pulse.
//
// Deciding from the PID rather than from "did it answer a sync" matters: a board
// that CAN reset is often sitting in the loader too (the detector leaves it
// there), and treating that as no-reset would suppress the resets it wants — and
// the no-reset chain has a trap of its own, below.
function portCanReset(port) {
  const i = port && port.getInfo ? port.getInfo() : {};
  if (i.usbVendorId !== ESPRESSIF_VID) return true;      // UART bridge: DTR/RTS
  return i.usbProductId === JTAG_ID.usbProductId;        // Serial-JTAG: its own sequence
}

// Set for the run when the port turns out to be one of those, so the ROM steps
// below pick their connect mode from one place. Cleared on a fresh pick.
let noResetLine = false;

const romConnectMode = () => (noResetLine ? 'no_reset' : 'default_reset');

// Chip facts read from a loader the chip is ALREADY in, without resetting it and
// **without running the stub**.
//
// The stub is the trap. `ESPLoader.main()` ends by uploading and jumping into
// esptool's flasher stub, which is fine when every later step resets first — the
// reset wipes it. Under `no_reset` nothing wipes it, so the next connect syncs
// with the stub rather than the ROM, and the detector is then RAM-loaded over
// the stub's own memory and jumped into: an IllegalInstruction, reached quickly
// because the stub is faster than the ROM. So this path never calls main(), and
// nothing else in the no-reset chain may either.
//
// Returns the info lines, or null when the chip is not in the loader at all.
async function romInfoNoReset(port) {
  const transport = new Transport(port, false);
  try {
    const cap = captureTerminal();
    const loader = new ESPLoader({ transport, baudrate: 460800, terminal: cap });
    await loader.detectChip('no_reset');            // syncs and identifies; no stub
    cap.writeLine(`Chip is ${await loader.chip.getChipDescription(loader)}`);
    try { cap.writeLine(`MAC: ${await loader.chip.readMac(loader)}`); } catch (_) { /* skip */ }
    return chipInfoLines(cap.lines);
  } catch (_) {
    return null;                                    // not in the loader (or not an ESP)
  } finally {
    try { await transport.disconnect(); } catch (_) { /* already gone */ }
  }
}

// The RTC force-download-boot flag, cleared.
//
// The RAM detector sets it on its way out so the ROM comes back without anyone
// touching a button, which is the whole trick on a board that cannot be reset.
// The flag lives in the RTC domain and survives an ordinary reset, so left set
// it would send every subsequent boot to the loader instead of the firmware.
// Clearing it is therefore part of finishing with the ROM, not an afterthought —
// esptool's own S3 hard reset does the same thing for the same reason.
//
// Best-effort by design: a chip that is no longer in the loader cannot be asked,
// and on that path something else has already reset it, which clears the flag
// too.
const RTC_CNTL_OPTION1_REG = 0x6000812c;            // S3: DR_REG_RTCCNTL_BASE (0x60008000) + 0x12C
const RTC_CNTL_FORCE_DOWNLOAD_BOOT = 0x1;           // bit 0 — same pair esptool uses
async function clearForceDownloadBoot(loader) {
  try {
    await loader.writeReg(RTC_CNTL_OPTION1_REG, 0, RTC_CNTL_FORCE_DOWNLOAD_BOOT);
  } catch (_) { /* not in the loader — then something already reset it, which clears it too */ }
}

// Restart a device that has no reset line, without one.
//
// A reset does not have to come from outside the chip: arming the RTC watchdog
// with a short timeout and letting it fire restarts the whole system, and every
// step of that is a register write over the ROM loader. It is what esptool falls
// back to on this exact chip when it finds itself on USB-OTG, and esptool-js
// carries the same routine on its S3 class — it simply never reaches for it,
// because its `after()` only knows the RTS-pin reset.
//
// The force-download-boot flag is cleared first, or the chip the watchdog
// restarts would land straight back in the loader instead of the firmware. What
// this cannot control is what the device looks like afterwards: a board whose
// ROM answers on USB-OTG and whose firmware runs USB-Serial-JTAG changes USB
// identity across the restart, so the port the page is holding goes away and
// comes back as a different device. The restart is real either way; only the
// monitor's ability to follow it is not.
async function restartFromRom(port) {
  const transport = new Transport(port, false);
  try {
    const loader = new ESPLoader({ transport, baudrate: 460800, terminal: captureTerminal() });
    await loader.detectChip('no_reset');
    await clearForceDownloadBoot(loader);
    if (!loader.chip || typeof loader.chip.watchdogReset !== 'function') return false;
    await loader.chip.watchdogReset(loader);
    await sleep(500);                               // the timeout esptool waits out
    return true;
  } catch (_) {
    return false;                                   // no loader to ask, or it refused
  } finally {
    try { await transport.disconnect(); } catch (_) { /* already gone */ }
  }
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
      await gatherChipInfo(new ESPLoader({ transport, baudrate: 460800, terminal: cap }),
                           romConnectMode());
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
    await loader.detectChip(romConnectMode());       // ROM loader (no stub)
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
  // Two whitelists, because the detector says two different kinds of thing.
  //
  //   "DETECT: …"          its results — the board it settled on and the state
  //                        store — printed deliberately for this parser.
  //   "I (123) detect: …"  the probe trace, which is ordinary ESP-IDF logging
  //                        under the `detect` tag: every board's detect_hw()
  //                        saying what it read and why it did or didn't match.
  //                        The same lines the firmware logs on a real boot.
  //
  // Everything else on the wire (IDF's own boot chatter) is dropped. ANSI is
  // stripped first: the log lines are coloured by level.
  const TRACE = /^[VDIWE] \(\d+\) detect: (.*)$/;
  const out = [];
  for (let l of buf.split(/\r?\n/)) {
    l = l.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (l.startsWith('DETECT:')) {
      const rest = l.slice('DETECT:'.length).replace(/^ /, '');
      if (rest !== 'SPANGAP-DETECT-END') out.push(rest);
      continue;
    }
    const t = TRACE.exec(l);
    if (t) out.push(t[1]);
  }
  return out;
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
// The handshake writes, said out loud when they fail. These run inside the
// attach, before there is a session to recover, so all they can do is report —
// but reporting is the point: a console that never answers because the byte
// asking never left is indistinguishable, on screen, from a device that has
// nothing to say, and the second reading is the one people arrive at.
// A write that neither completes nor fails is the third outcome, and the one
// that reads as a device with nothing to say: the transfer is posted, sits in a
// queue, and no promise ever settles. Bounded here so it is named instead.
const WRITE_STALL_MS = 2000;

async function writeConsole(m, bytes) {
  let timer;
  const stalled = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from the port in ${WRITE_STALL_MS} ms`)),
                       WRITE_STALL_MS);
  });
  try {
    await Promise.race([m.writer.write(bytes), stalled]);
    return true;
  } catch (e) {
    note(m, `\x1b[31m-- could not write to the port: ${e && e.message ? e.message : e} --\x1b[0m`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function sendTyped(m, bytes) {
  keyEvents++;
  if (!m || !m.writer) return false;
  const ok = await writeConsole(m, bytes);
  if (ok) keySent += bytes.length;
  return ok;
}

async function syncConsole(m) {
  const CR = () => new Uint8Array([0x0d]);
  const wasMuted = m.muted;
  m.muted = true;                       // the reader drops everything meanwhile
  try {
    await writeConsole(m, CR());
    await sleep(100);
  } catch (_) { /* port went away mid-handshake */ }
  // The mute window has already discarded the partial opening line, so the
  // byte-level trim has nothing left to do and would only eat the greeting.
  if (m.lineSync) m.lineSync.pending = false;
  m.muted = wasMuted;
  if (!wasMuted) await writeConsole(m, CR());
}

// Ask the console to say where it is. The firmware answers a bare CR with the
// transport it is running on ("Spangap console on JTAG/serial." / "… USB/CDC 0."),
// which is the only thing that confirms the port just opened is the console and
// not the device's second CDC port. Nothing is muted around it: a port that has
// just come back may be mid-boot-log, and that is precisely what must survive.
async function pokeConsole(m) {
  await writeConsole(m, new Uint8Array([0x0d]));
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
  // empty lines above every "Spangap console on …" greeting.
  t.writeln('');
  t.writeln(text);
}

// Detach the reader/writer and close the port (leaving the terminal intact).
async function detachStreams(m) {
  // Cancelling settles the reader loop but leaves the stream locked to it, and a
  // locked stream is one a close cannot cancel. The loop's own finally releases
  // too, from a task that has not necessarily run yet — so release here, where
  // the close is about to happen, and let whichever call comes second throw into
  // its catch.
  // Cleared before the cancel, not after: the reader loop checks m.reader on its
  // way out to tell a teardown from a stream that died on its own, and the
  // cancel is what ends that loop. Clearing afterwards is a race it can lose.
  if (m.reader) {
    const reader = m.reader;
    m.reader = null;
    try { await reader.cancel(); } catch (_) { /* gone */ }
    try { reader.releaseLock(); } catch (_) { /* the loop got there first */ }
  }
  if (m.writer) {
    const writer = m.writer;
    m.writer = null;
    try { await writer.abort(); } catch (_) { /* gone */ }
    try { writer.releaseLock(); } catch (_) { /* already released */ }
  }
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

  // The write side's death notice. A stream errors between writes as readily as
  // during one, so the rejection often lands on a later write than the one that
  // failed — or on no write at all, when nothing more is typed. `closed` is the
  // one place it always surfaces. detachStreams clears m.writer before aborting,
  // so an ordinary teardown does not read as a drop here.
  const writer = m.writer;
  writer.closed.catch((e) => { if (m.writer === writer) restreamAfterDrop(m, e); });

  const reader = m.reader;   // capture: m.reader is swapped out on reconfigure
  (async () => {
    let lost = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        // Muted until the first reset is issued, so only post-reset output shows.
        if (value && !m.muted) {
          m.rxSeq++;                 // any byte activity (watched by the stuck watchdog)
          m.rxBytes = (m.rxBytes || 0) + value.length;   // against the transport's own count
          m.rxAt = Date.now();
          // Where a stream died is half of diagnosing why: keep the tail.
          if (DEBUG_HUD) m.tail = tailBytes(m.tail, value);
          m.drops = 0;               // bytes flowing: the last drop is behind us
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
    } catch (e) {
      lost = e;                // cancel() during detach also lands here
    } finally {
      try { reader.releaseLock(); } catch (_) { /* */ }
    }
    // A reader that ends while the session still holds it was not detached —
    // the stream died underneath it. detachStreams clears m.reader, so that is
    // exactly what tells a teardown from a drop.
    if (m.reader === reader) restreamAfterDrop(m, lost);
  })();

  // The console is asked to identify itself, unless a reset is about to make
  // the question moot and the byte that asked it a stray keystroke.
  if (sync) await syncConsole(m);
  else if (mode !== 'quiet') await pokeConsole(m);
}

// Rebuild a session's streams after the transport dropped them under it.
//
// A stream is one-shot: a single failed USB transfer errors it for good, and
// the port hands out a fresh pair only when asked again. Nothing above notices
// on its own — the reader loop just ends, the writer just starts rejecting —
// which presents as a session that is alive on screen, deaf and mute in fact:
// no device output, and typing that goes nowhere. The device is fine and the
// port is still there; the streams over it are what died, most often over a
// reset, which every transfer in flight at that moment fails.
//
// So the drop is reported and the streams are rebuilt. What cannot be rebuilt
// is a stream over a port that has actually gone, and the budget below is what
// tells the two apart: a run of drops with no bytes in between hands the
// session to the port-level recovery, which can ask for a new port. Bytes
// arriving clear the run, so a session that drops once an hour never reaches it.
const RESTREAM_MAX = 4;

async function restreamAfterDrop(m, err) {
  if (monitor !== m || m.gone || m.reattaching) return;
  m.reattaching = true;
  const why = err && err.message ? `: ${err.message}` : '';
  try {
    m.drops = (m.drops || 0) + 1;
    if (m.drops > RESTREAM_MAX) {
      note(m, `\x1b[31m-- the serial stream keeps dropping${why}; the port is not usable --\x1b[0m`);
      m.gone = true;
      markTitleGone(true);
      hideOpenUi();
      askReconnect(null);
      return;
    }
    note(m, `\x1b[33m-- serial stream dropped${why}; reopening --\x1b[0m`);
    await detachStreams(m);
    if (monitor !== m) return;
    // `poke` rather than `sync`: the device kept running through this and its
    // output is mid-flow, which is precisely what the sync handshake discards.
    await attachStreams(m);
    note(m, '\x1b[32m-- serial stream back --\x1b[0m');
  } catch (e) {
    note(m, `\x1b[31m-- could not reopen the stream: ${e && e.message ? e.message : e} --\x1b[0m`);
    m.gone = true;
    markTitleGone(true);
    hideOpenUi();
    scheduleRescan();
  } finally {
    m.reattaching = false;
  }
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
           gone: false, reattaching: false, muted, drops: 0, rxBytes: 0,
           lineBuf: '', decoder: new TextDecoder(), aps: new Map(), hostname: HOSTNAME_DEFAULT,
           // Setup coordinator: password → hostname → wifi, then one batched send.
           needPasswd: false, passwdResolved: false, newPasswd: null, passwdOpen: false,
           hostResolved: false, newHostname: null, hostOpen: false,
           hostNamed: false, hostProbed: false, hostProbing: false,
           wifiNeeded: false, wifiResolved: false, wifiCfg: null, wifiOpen: false,
           connectedSeen: false, setupSent: false, hostnameQueried: false,
           // Flash offer: the identified board, the catalogue the running image
           // was published from, and its build stamp — all three off the boot log.
           // hwDetected records that the board came from a detection run (which
           // reads the hardware), so the boot log's weaker claim can't overwrite it.
           // versionSettled goes true once the stamp arrives or the grace expires,
           // so an up-to-date device is never offered a flash on the way there.
           hw: null, hwDetected: false, deviceCatalogue: null, unitId: null, noIdWarned: false,
           deviceVersion: null, versionSettled: false, versionTimer: null,
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

// Espressif's USB vendor ID. A port carrying it is the chip's own USB, not a
// bridge chip on the board, which is what makes the line rate irrelevant there.
const ESPRESSIF_VID = 0x303A;

// The composite device the firmware presents while running two CDC ports.
// The PID is TinyUSB's class-derived one, 0x4000 with the CDC count in the low
// bits.
const CDC_FILTER = { usbVendorId: ESPRESSIF_VID, usbProductId: 0x4002 };

// The USB-Serial-JTAG controller, the device's other console transport.
const JTAG_ID = { usbVendorId: ESPRESSIF_VID, usbProductId: 0x1001 };

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

// ── the transport under the ports ───────────────────────────────────────────
// Two browser interfaces reach a serial device, and this page uses whichever
// the platform actually implements. Everything above and below this section is
// written against the Web Serial shape — requestPort, a port with readable /
// writable / setSignals, connect and disconnect events — and never learns which
// one is underneath.
//
// Web Serial (navigator.serial) is the desktop one. It is also the only one
// that reaches a board through a USB-to-serial bridge chip, because a bridge
// speaks a vendor protocol that the operating system's driver knows and a web
// page does not.
//
// WebUSB (navigator.usb) hands a page raw endpoints instead, so a page can
// itself drive a port that is standard USB CDC-ACM (Communications Device
// Class, Abstract Control Model). That is exactly what an ESP32 with native USB
// presents, on the USB-Serial-JTAG controller and on the firmware's own CDC
// ports alike. web-serial-polyfill builds the Web Serial shape out of those
// endpoints, and the adapter below completes it.
//
// Android is the whole reason for the choice. Chrome there does expose
// navigator.serial, but it enumerates Bluetooth serial ports only: the chooser
// opens on a phone with a board plugged into it and lists nothing, and no
// amount of retrying changes that. WebUSB is what Android implements for a USB
// peripheral, so that is the road taken there — at the cost of the bridge-chip
// boards, which no page can drive over raw endpoints.
//
// `?serial=native` / `?serial=usb` forces one for a load, which is how the two
// are compared on the same machine.
const HAVE_WEB_SERIAL = 'serial' in navigator;
const HAVE_WEBUSB = 'usb' in navigator;
const IS_ANDROID = /Android/i.test(navigator.userAgent || '');

// The USB class code of a CDC-ACM control interface. Both the chooser filter
// and the polyfill's interface hunt key on it: a device carrying one has a
// serial port a page can open, and one that doesn't is not a port at all.
const CDC_CONTROL_CLASS = 0x02;
// Its data interface, which carries the two bulk endpoints the bytes travel on.
const CDC_DATA_CLASS = 0x0a;

const hex4 = (n) => (n != null ? n.toString(16).toUpperCase().padStart(4, '0') : '????');

// An awaited USB request that never settles is worse than one that fails: a
// catch does nothing against it, and whatever awaited it — ultimately the
// "Opening serial monitor…" hint — waits forever with no error to show. So
// every request the open path makes is raced against a deadline and turned
// into a rejection that names itself.
function bounded(label, ms, work) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no completion in ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

// The bulk pair a CDC-ACM device moves serial data over. Null for a device that
// has no such interface, which is a device this page cannot drive.
function cdcEndpoints(device) {
  const data = (device.configurations[0]?.interfaces || [])
    .find((i) => i.alternates[0].interfaceClass === CDC_DATA_CLASS);
  if (!data) return null;
  const eps = data.alternates[0].endpoints;
  const inEp = eps.find((e) => e.direction === 'in');
  const outEp = eps.find((e) => e.direction === 'out');
  if (!inEp || !outEp) return null;
  return { inEp, outEp, iface: data.interfaceNumber };
}

// A bulk IN transfer asks for exactly one packet, and that is not a throughput
// choice — it is the only length that always completes.
//
// A bulk transfer ends when the requested length is reached or a short packet
// arrives, and nothing else. Ask for several packets' worth and a device that
// stops talking on a packet boundary leaves the transfer open: everything
// already received is held by the host, undelivered, until the device speaks
// again. The USB-Serial-JTAG controller's transmit FIFO is one packet deep, so
// that boundary is where its bursts naturally end — which is a console that
// prints a screenful and stops, an answer to a CR that never arrives, and a
// keystroke whose echo appears only once something else is typed.
//
// One packet per transfer makes every packet complete one, at the cost of a
// round trip per 64 bytes. A console never notices; a boot log arrives in a
// few hundred transfers.
const readLength = (inEp) => inEp.packetSize;

// How many of those transfers are kept outstanding at once.
//
// This is the buffering an operating system would have done. A serial port on
// the desktop is drained by a kernel driver that keeps its own transfers queued
// and hands the page a tty's worth of bytes; over raw WebUSB there is no such
// driver, and the only buffer between the device and this script is the
// transfers this script has posted.
//
// One at a time is therefore not slow, it is lossy. Between a transfer
// completing and its replacement being posted sits everything the page does
// with the bytes — the parser, the terminal, a repaint — and for that whole
// window the endpoint has nowhere to put anything. A device that talks faster
// than the page can turn transfers around fills its FIFO and drops the rest,
// which is a boot log that arrives as its first page and then nothing.
//
// Transfers on one endpoint complete in the order they were posted, so a queue
// of them is still a byte stream: post at the tail, take from the head.
// `?readqueue=N` overrides it, so a depth can be tried against real hardware
// without a deploy — a transport that only misbehaves when several transfers
// are posted at once says so in one run.
const READ_QUEUE = Math.min(32, Math.max(1, parseInt(params.get('readqueue'), 10) || 8));

// The Web Serial surface, over WebUSB. What the polyfill leaves out is what a
// long-lived monitor session is built on: stable port identity, the
// connect/disconnect events, and the `connected` flag.
//
// Identity is the load-bearing part. This page tells one board from an
// identical one by object identity alone (see the next section), and the
// polyfill mints a fresh SerialPort on every call, so each USBDevice is wrapped
// exactly once here and every path hands back that one wrapper. A device
// re-enumerating under a new USBDevice does cost the pairing — the port comes
// back as a stranger, and the session recovers through the same "Re-select
// port" path that covers every other way a port can return unrecognisable.
function usbSerial() {
  const ports = new WeakMap();       // USBDevice -> its one SerialPort
  const unplugged = new WeakSet();   // devices seen leaving; drives port.connected
  const events = new EventTarget();

  const wrap = (device) => {
    const known = ports.get(device);
    if (known) return known;
    let port;
    // Both throw for a device with no CDC-ACM interface — a keyboard, a power
    // meter, a phone. Nothing here can drive it, so it is not offered as a port.
    const eps = cdcEndpoints(device);
    if (!eps) return null;
    try { port = new UsbSerialPort(device); } catch (_) { return null; }
    // Web Serial's liveness flag. detachStreams reads it to decide whether a
    // close has anything left to release, and skips the close when it doesn't.
    Object.defineProperty(port, 'connected', { get: () => !unplugged.has(device) });

    // The bytes, both ways — the polyfill's own streams are left unbuilt.
    //
    // Its read source starts each transfer in a detached task and returns
    // nothing, so the stream counts a pull as finished the moment it is made and
    // pulls again, up to a high-water mark that defaults to 255. That leaves a
    // pile of bulk IN transfers pending at once against a device that has
    // nothing to say — and behind them, on the same device queue, every OUT
    // transfer: the console's own CR, and every keystroke after it, posted and
    // never sent. A monitor on a running board then shows nothing, answers
    // nothing, and reports nothing, because none of it ever failed.
    //
    // These are built here instead, over a queue of transfers this side controls.
    let readable = null;
    let writable = null;
    let endRead = null;                // marks the live read stream finished
    const dropStreams = () => {
      if (endRead) endRead();
      readable = null;
      writable = null;
    };

    // Counted at the transport, so what the wire delivered can be compared
    // against what the session made of it. The two disagreeing is the whole
    // question when a monitor shows a screenful and then nothing.
    port.usbStats = { bytesIn: 0, reads: 0, bytesOut: 0, writes: 0, errors: 0 };

    // Named in the monitor's opening banner, because a console that answers
    // nothing looks the same whether the device is quiet or the page is talking
    // to the wrong pipe.
    port.usbEndpoints = { iface: eps.iface, in: eps.inEp.endpointNumber, out: eps.outEp.endpointNumber };
    port.usbDevice = device;          // for the readout's claim check
    // What the device calls itself, for the banner and the readout: two rows
    // in a chooser are indistinguishable by VID:PID alone, and WebUSB hands us
    // the strings that tell them apart.
    port.usbName = [device.productName,
                    device.serialNumber ? `#${device.serialNumber}` : '']
      .filter(Boolean).join(' ') || null;

    // The bare wire, with everything above it taken away.
    //
    // A console that says nothing back has three possible causes and they look
    // identical from the terminal: the byte never left, the byte left and the
    // device had nothing to say, or the device answered and something between
    // the endpoint and the screen ate it. This writes one carriage return with
    // its own hands, reads whatever comes back with its own hands, and prints
    // the raw counts and bytes — no streams, no session, no parser, no terminal.
    // Whatever it reports is true of the wire.
    port.usbProbe = async (say) => {
      const inN = eps.inEp.endpointNumber;
      const outN = eps.outEp.endpointNumber;
      say(`device ${hex4(device.vendorId)}:${hex4(device.productId)} — CDC iface ${eps.iface}, `
        + `in EP${inN} (${eps.inEp.packetSize}-byte packets), out EP${outN}`);
      const claims = ((device.configuration && device.configuration.interfaces) || [])
        .map((i) => `${i.interfaceNumber}:${i.claimed ? 'ours' : 'NOT OURS'}`).join(' ');
      say(`configuration ${device.configuration ? 'selected' : 'NONE'} — interfaces ${claims || '(none listed)'}`);

      // One transfer is kept across the whole probe rather than a fresh one per
      // wait. Giving up on a wait does not unpost the transfer, and a posted
      // transfer will take the next packet the device sends — so a probe that
      // abandoned one would eat the very answer the next phase is listening
      // for, and report silence it caused itself.
      let pending = null;
      const takeRead = async (waitMs) => {
        if (!pending) {
          pending = device.transferIn(inN, eps.inEp.packetSize).then((v) => v, (error) => ({ error }));
        }
        const r = await Promise.race([pending, new Promise((res) => setTimeout(() => res('quiet'), waitMs))]);
        if (r !== 'quiet') pending = null;
        return r;
      };

      const readFor = async (label, tries, waitMs) => {
        let total = 0;
        const seen = [];
        for (let attempt = 0; attempt < tries && total < 240; attempt++) {
          const r = await takeRead(waitMs);
          if (r === 'quiet') { say(`${label} read ${attempt + 1} → nothing in ${waitMs} ms`); break; }
          if (r.error) { say(`${label} read ${attempt + 1} → threw: ${r.error.message || r.error}`); break; }
          const n = r.data ? r.data.byteLength : 0;
          say(`${label} read ${attempt + 1} → status ${r.status}, ${n} byte(s)`);
          if (!n) continue;
          total += n;
          for (let i = 0; i < n; i++) seen.push(r.data.getUint8(i));
        }
        say(`${label} total: ${total} byte(s)`);
        if (total) {
          const text = seen.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b)
                                      : b === 10 ? '\\n' : b === 13 ? '\\r' : '.')).join('');
          say(`${label} as text: ${text.slice(0, 400)}`);
        }
        return total;
      };

      // Before anything is asked of it. A running board that has been left alone
      // is quiet here; bytes at this point are a board that the open disturbed,
      // and early-boot text says so outright.
      const unasked = await readFor('idle', 3, 500);
      say(unasked ? 'the device spoke without being asked — opening the port disturbed it'
                  : 'the device was quiet before being asked, which is what a running board should be');

      try {
        const w = await device.transferOut(outN, Uint8Array.of(0x0d));
        say(`wrote CR → status ${w.status}, ${w.bytesWritten} byte(s) accepted`);
      } catch (e) {
        say(`wrote CR → threw: ${e && e.message ? e.message : e}`);
      }

      const answered = await readFor('answer', 6, 700);
      say(answered ? 'the carriage return was answered — the wire is whole in both directions'
                   : 'no answer to the carriage return');
    };

    Object.defineProperty(port, 'readable', {
      get() {
        if (readable || !device.opened) return readable;

        // A transfer posted before a teardown still completes after it, and a
        // pull sitting on one wakes up into a stream that is already over. That
        // is an ordinary end, not a failure: `finished` is what tells the two
        // apart, so a torn-down port stops quietly instead of reporting a USB
        // read error it never had — and leaving that error as the last word on
        // what went wrong.
        let finished = false;
        let ctrl = null;
        const inflight = [];
        // Rejections are caught into a value on the way in: a queued transfer
        // this stream never gets to look at must not surface as an unhandled
        // rejection when the device closes under it.
        const post = () => device.transferIn(eps.inEp.endpointNumber, readLength(eps.inEp))
          .then((r) => r, (error) => ({ error }));
        // Closing, not just flagging: a port closed while a reader still holds
        // the stream would otherwise leave that reader's read() pending on a
        // stream nothing will ever feed again — silent, and indistinguishable
        // from a device with nothing to say.
        const stop = () => {
          finished = true;
          inflight.length = 0;
          try { if (ctrl) ctrl.close(); } catch (_) { /* already closed or errored */ }
          ctrl = null;
        };
        endRead = stop;

        readable = new ReadableStream({
          start(controller) { ctrl = controller; },
          async pull(controller) {
            try {
              while (!finished && inflight.length < READ_QUEUE) inflight.push(post());
              port.usbStats.posted = inflight.length;
              const r = await inflight.shift();
              if (finished) return;              // torn down while this was in flight
              if (r.error) throw r.error;
              if (r.status !== 'ok') throw new Error(`USB read ${r.status}`);
              const d = r.data;
              port.usbStats.reads++;
              if (d && d.byteLength) {
                port.usbStats.bytesIn += d.byteLength;
                port.usbStats.lastAt = Date.now();
                controller.enqueue(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
              }
            } catch (e) {
              stop();
              readable = null;          // the port builds a fresh one when asked
              port.usbStats.errors++;
              // The message, not just the count. A read that keeps failing is
              // the whole question, and "err 8" does not answer it.
              port.usbStats.lastError = `read: ${(e && e.message) || e}`.slice(0, 90);
              if (!port.usbStats.firstError) port.usbStats.firstError = port.usbStats.lastError;
              controller.error(e);
            }
          },
          cancel() { stop(); readable = null; },
        }, { highWaterMark: 1 });
        return readable;
      },
    });

    Object.defineProperty(port, 'writable', {
      get() {
        if (writable || !device.opened) return writable;
        writable = new WritableStream({
          async write(chunk) {
            const r = await device.transferOut(eps.outEp.endpointNumber, chunk);
            if (r.status !== 'ok') {
              port.usbStats.errors++;
              port.usbStats.lastError = `write: ${r.status}`;
              if (!port.usbStats.firstError) port.usbStats.firstError = port.usbStats.lastError;
              throw new Error(`USB write ${r.status}`);
            }
            port.usbStats.writes++;
            port.usbStats.bytesOut += chunk.byteLength;
          },
          abort() { writable = null; },
          close() { writable = null; },
        });
        return writable;
      },
    });

    // A close that always ends with the device closed, because closing the
    // device is what releases the interfaces.
    //
    // The polyfill finishes its close by dropping DTR and RTS, and that is a
    // control transfer — which throws against a device that has just left the
    // bus. Every teardown here follows a reset, so that is the ordinary case,
    // not the rare one: the detector run and the flash both hand back a chip
    // that is rebooting. The throw skips the device close underneath it, the
    // interfaces stay claimed, and the next open fails on claimInterface —
    // flashing works and the console that follows it never opens again.
    const closePort = port.close.bind(port);
    port.close = async () => {
      // Ours to tear down, since they are ours to build. Cancelling first stops
      // the read pull from posting another transfer into a closing device.
      const [r, w] = [readable, writable];
      dropStreams();
      if (r && !r.locked) { try { await r.cancel(); } catch (_) { /* already dead */ } }
      if (w && !w.locked) { try { await w.abort(); } catch (_) { /* already dead */ } }
      try { await closePort(); } catch (_) { /* the signal write, on a device already gone */ }
      if (device.opened) { try { await device.close(); } catch (_) { /* already gone */ } }
    };

    // An open that survives one claim left behind. Nothing above this can act on
    // a stale claim, and closing the device releases every interface it holds —
    // so a failed open closes it and asks once more. The polyfill does that
    // cleanup itself when it can; this covers the times it could not, and costs
    // a genuinely absent device one extra refusal.
    const openPort = port.open.bind(port);
    const setSignals = port.setSignals.bind(port);

    // Every bulk endpoint carries a one-bit sequence number (DATA0/DATA1) that
    // both ends must agree on. A receiver that sees the wrong one ACKs the
    // packet — the sender counts it delivered — and silently discards it as a
    // retransmission. Nothing errors and nothing retries; one direction of the
    // port just stops carrying data, which on a console reads as a device that
    // went mute mid-boot-log, or a keyboard the firmware never hears, while
    // every transfer on both sides reports success.
    //
    // The two ends drift whenever endpoint state moves without a bus event the
    // other side can see — interfaces claimed and released around a detect run
    // or a flash, a chip that resets without re-enumerating (USB-Serial-JTAG
    // rides through chip reset). A kernel serial driver never meets this
    // because it holds one continuous view of the endpoint from plug to
    // unplug. This page is the driver here, so its open does what a driver's
    // open does: CLEAR_FEATURE(ENDPOINT_HALT) on both endpoints, resetting the
    // toggle to DATA0 on device and host alike.
    const noteEp0 = (e) => {
      port.usbStats.lastError = `${(e && e.message) || e}`.slice(0, 90);
      if (!port.usbStats.firstError) port.usbStats.firstError = port.usbStats.lastError;
    };
    const resyncEndpoints = async () => {
      // Bounded, and a refusal or a hang is worth knowing about but not worth
      // failing the open for: the endpoints may well be in sync already. A
      // control transfer that has not answered in this long is not going to.
      try {
        await bounded('clearHalt', 1500, device.clearHalt('in', eps.inEp.endpointNumber));
        await bounded('clearHalt', 1500, device.clearHalt('out', eps.outEp.endpointNumber));
      } catch (e) {
        noteEp0(e);
      }
    };

    // An open that puts the control lines where the desktop puts them.
    //
    // DTR and RTS are not decoration on a chip whose native USB wires them to
    // its own reset and boot-mode logic. Of the four states, two are wrong in
    // different directions and one is right:
    //
    //   (DTR 1, RTS 0)  the polyfill's own choice, and half of the auto-reset
    //                   sequence — the half that holds the boot pin down.
    //   (DTR 0, RTS 0)  an idle line. Nothing is jogged, but nothing is told a
    //                   host is there either, and a console that answers only a
    //                   host it can see stays silent to this one.
    //   (DTR 1, RTS 1)  both asserted, which is what Web Serial does on the
    //                   desktop when it opens a port — and the desktop is the
    //                   configuration this page is known to work in.
    //
    // So: both, in ONE control transfer, because the pair is what the chip's
    // logic reads and stepping through a corner of the square on the way would
    // be the reset this open is promising not to do. The polyfill's own lone
    // assertion is swallowed for the length of the open so the chip never sees
    // that corner. `?signals=none` leaves them down, for comparing the two
    // against real hardware.
    port.open = async (options) => {
      // Anything still held from the last session belongs to the device as it
      // was then. A fresh open gets fresh streams.
      dropStreams();
      port.setSignals = async () => {};
      try {
        try {
          await bounded('open', 10000, openPort(options));
        } catch (_) {
          if (device.opened) { try { await device.close(); } catch (_) { /* about to fail anyway */ } }
          await bounded('open', 10000, openPort(options));
        }
      } catch (e) {
        // "Unable to claim interface" is the browser saying something else has
        // the device, and it is the one failure here a person can actually do
        // something about — but not from that sentence. Over raw USB the page
        // needs the interfaces exclusively, and an operating system that has
        // already bound its own serial driver to them, or an app that opened
        // the device first, holds them against it.
        throw /claim/i.test((e && e.message) || '') ? new Error(
          'Could not take the device’s serial interfaces: something else on this '
          + 'machine already holds them. Close whatever opened the device — on a phone, '
          + 'the app that offered to open it when you plugged it in — then unplug and '
          + 'replug the board. On Linux the holder is usually the kernel’s own cdc_acm '
          + 'driver, which has to be unbound from this device first.') : e;
      } finally {
        port.setSignals = setSignals;
      }
      await resyncEndpoints();
      const on = params.get('signals') !== 'none';
      try {
        await bounded('setSignals', 1500, setSignals({ dataTerminalReady: on, requestToSend: on }));
      } catch (e) {
        noteEp0(e);          // named in the readout, not fatal to the open
      }
    };

    ports.set(device, port);
    return port;
  };

  // Chooser filters arrive in Web Serial's vocabulary (usbVendorId /
  // usbProductId) and WebUSB wants its own, plus the class code so the list
  // holds serial devices rather than every peripheral on the bus.
  const usbFilters = (filters) => {
    const out = (filters || []).map((f) => {
      const u = { classCode: CDC_CONTROL_CLASS };
      if (f.usbVendorId !== undefined) u.vendorId = f.usbVendorId;
      if (f.usbProductId !== undefined) u.productId = f.usbProductId;
      return u;
    });
    return out.length ? out : [{ classCode: CDC_CONTROL_CLASS }];
  };

  navigator.usb.addEventListener('connect', (e) => {
    unplugged.delete(e.device);
    const port = wrap(e.device);
    if (port) events.dispatchEvent(Object.assign(new Event('connect'), { port }));
  });
  // Marked gone before the dispatch: the handlers read `connected` on the way
  // through, and a port whose device has just left must not read as live.
  navigator.usb.addEventListener('disconnect', (e) => {
    unplugged.add(e.device);
    const port = ports.get(e.device);
    if (port) events.dispatchEvent(Object.assign(new Event('disconnect'), { port }));
  });

  return {
    async requestPort(options) {
      const filters = usbFilters(options && options.filters);
      const port = wrap(await navigator.usb.requestDevice({ filters }));
      if (!port) throw new Error('That device has no USB CDC serial interface, so this page cannot open it.');
      return port;
    },
    async getPorts() {
      return (await navigator.usb.getDevices()).map((d) => wrap(d)).filter(Boolean);
    },
    addEventListener: (...a) => events.addEventListener(...a),
    removeEventListener: (...a) => events.removeEventListener(...a),
  };
}

function chooseSerial() {
  switch (params.get('serial')) {
    case 'native': return HAVE_WEB_SERIAL ? navigator.serial : null;
    case 'usb': return HAVE_WEBUSB ? usbSerial() : null;
  }
  if (HAVE_WEBUSB && (IS_ANDROID || !HAVE_WEB_SERIAL)) return usbSerial();
  return HAVE_WEB_SERIAL ? navigator.serial : null;
}

// Null on a browser with neither interface, which boot() reports and stops on.
const SERIAL = chooseSerial();
// True when the ports come from WebUSB, and so when the CDC-ACM-only limit
// applies: a board reached through a bridge chip is not in the chooser at all.
const SERIAL_OVER_USB = !!SERIAL && SERIAL !== navigator.serial;

// ── the tab's ports ─────────────────────────────────────────────────────────
// A tab opens the ports it was handed by a chooser pick — plus one other case:
// a returning port that has PROVEN, in its own words, that it is the same
// board (the returning-boards machinery, below the rescan loop). Nothing is
// ever opened on a guess. getInfo() exposes the USB vendor and product ids and
// nothing more: no serial number, no device path. So three identical boards on
// a desk are ONE identity to this page, and a tab that infers "my port is
// back" from a matching identity alone is choosing among them at random. When
// it chooses wrong, two tabs have quietly traded consoles, with nothing on
// screen to say so. Object identity is the handle that tells this board from
// its neighbours; a pick establishes it, and the `dev <id>` field of the
// device's own greeting — read off the port before it is trusted — is the one
// other proof accepted.
//
// Two, because a device presents this tab at most two consoles: the
// USB-Serial-JTAG one it boots on, and the CDC one `usb cdc` moves it to. A
// third pick is a replacement, so the oldest goes.
const PICKED_MAX = 2;
let pickedPorts = [];
// The one currently carrying the session. Always a member of pickedPorts.
let pinnedPort = null;

// Take ownership of a port and make it the active one. Callers must hold one
// of the two admissible proofs that it is this tab's board: a requestPort()
// pick — a person pointing at the desk — or the `device` id read off the port
// itself and matched against `pairedUnit` (the returning-boards path).
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

// ── the screen the keyboard leaves ──────────────────────────────────────────
// An on-screen keyboard shrinks the visual viewport and leaves the layout one
// alone, so a fixed full-height element keeps its full height behind the
// keyboard. Publishing the visual viewport as CSS variables lets the monitor
// and the dialogs size themselves to what is actually on screen (see
// index.html): the terminal reflows to fewer rows with its last line just above
// the keyboard, and a dialog re-centres in the band that is left.
function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const s = document.documentElement.style;
  s.setProperty('--vv-top', `${vv.offsetTop}px`);
  s.setProperty('--vv-height', `${vv.height}px`);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewport);
  window.visualViewport.addEventListener('scroll', syncViewport);
  syncViewport();
}

// Focusing the terminal raises the keyboard, so on a touch device the terminal
// is focused by a tap on it and by nothing else — never by the page deciding a
// session is ready, which is a keyboard nobody asked for over a screen nobody
// has touched yet. A pointing device has no such cost, and there the focus is
// what makes the first keystroke reach the device.
const TAP_TO_FOCUS = matchMedia('(pointer: coarse)').matches;

const dialogOpen = () => !!document.querySelector('.modal-overlay:not([hidden])');

// Never focus the terminal out from under a dialog either, on any device: the
// terminal is behind it, and the focus belongs to whatever the dialog is asking.
function focusTerm(term) {
  if (!term || TAP_TO_FOCUS || dialogOpen()) return;
  term.focus();
}

// The other half of that rule: a dialog opening over a terminal that already
// holds the focus. Nothing tells the terminal to give it up, so the keyboard
// stays up over the dialog that just appeared. Watched rather than wired into
// each dialog — there are a dozen, opened from as many places.
const dialogFocusWatch = new MutationObserver(() => {
  if (!dialogOpen()) return;
  const el = document.activeElement;
  if (el && $('monitor-term').contains(el)) el.blur();
});
for (const el of document.querySelectorAll('.modal-overlay'))
  dialogFocusWatch.observe(el, { attributes: true, attributeFilter: ['hidden'] });

// And the tap that does raise it. xterm focuses itself on a mouse press and a
// tap normally reaches that path, but the terminal is the only way to type to
// the device, so it does not rest on "normally".
if (TAP_TO_FOCUS) {
  // A tap, not the end of a scroll. Focusing raises the keyboard, and a drag
  // that finishes over the terminal is someone reading scrollback, not asking
  // to type — a focus there kills the gesture, pops the keyboard over what
  // they were reading, and makes the scrollback effectively unscrollable.
  // Distance, not duration, is what separates the two.
  let downAt = null;
  on('monitor-term', 'pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  on('monitor-term', 'pointerup', (e) => {
    const moved = downAt ? Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) : 0;
    downAt = null;
    if (moved < 12 && monitor && !dialogOpen()) monitor.term.focus();
  });
}

// ── the readout, and the way in ─────────────────────────────────────────────
// `?debug=1` pins a line of counters over the monitor. Its own DOM, not the
// terminal's, because half of what it is for is telling a session that has
// stopped receiving from one that is receiving and not showing: the transport's
// byte count beside the reader loop's, and the terminal's geometry beside the
// box it is supposed to fill.
const DEBUG_HUD = params.get('debug') === '1';
// Under ?debug=1 only: IN silence this long, with transfers posted, triggers
// one reopen-to-resync per silence stretch (below). `?resync=N` sets seconds.
const SILENCE_RESYNC_MS = (parseInt(params.get('resync'), 10) || 10) * 1000;
let hudResyncedAt = 0;

// A rolling last-bytes buffer, enough to name the log line a stream died on.
function tailBytes(tail, chunk) {
  const both = new Uint8Array((tail ? tail.length : 0) + chunk.length);
  if (tail) both.set(tail, 0);
  both.set(chunk, tail ? tail.length : 0);
  return both.length > 240 ? both.slice(-240) : both;
}
let hudEl = null;
let keyEvents = 0;         // input handed over by the terminal or the input line
let keySent = 0;           // …and how much of it the device accepted

let hudFlash = '';

// Which interfaces of a port's device this page actually holds. WebUSB says so
// directly, and an open that reported success while claiming nothing is
// indistinguishable, from every other angle, from a device with nothing to say.
function claimedOf(port) {
  const d = port && port.usbDevice;
  if (!d || !d.configuration) return null;
  return (d.configuration.interfaces || [])
    .map((i) => `${i.interfaceNumber}${i.claimed ? '+' : '-'}`).join('');
}

function hudReport() {
  const m = monitor;
  const e = m && m.port && m.port.usbEndpoints;
  return `flashmon ${location.search || '(no parameters)'}\n`
    + `transport ${SERIAL_OVER_USB ? 'webusb' : 'web serial'}`
    + `${e ? ` iface ${e.iface} in EP${e.in} out EP${e.out}` : ''}`
    + ` readqueue ${READ_QUEUE}`
    + (m && m.port && m.port.usbName ? ` "${m.port.usbName}"` : '') + '\n'
    + `${hudEl ? hudEl.dataset.body || '' : ''}`
    + (m && m.tail && m.tail.length
        ? `\ntail ${JSON.stringify(new TextDecoder().decode(m.tail))}` : '');
}

function updateHud() {
  if (!hudEl) return;
  const m = monitor;
  const st = (m && m.port && m.port.usbStats) || {};
  const box = $('monitor-term');
  const t = m && m.term;
  let view = '-';
  try { const b = t.buffer.active; view = `${b.viewportY}/${b.baseY}`; } catch (_) { /* no terminal */ }
  // How long since each layer last saw a byte. A fresh transport over a stale
  // loop is the stream between them; both stale is the device; the transport
  // stale with transfers posted is a device that has stopped talking to a page
  // that is still listening.
  const ago = (t) => (t ? `${((Date.now() - t) / 1000).toFixed(1)}s` : 'never');
  hudEl.textContent =
    `usb in ${st.bytesIn || 0}B/${st.reads || 0} (${ago(st.lastAt)}, ${st.posted || 0} posted)`
    + ` out ${st.bytesOut || 0}B/${st.writes || 0} err ${st.errors || 0}`
    + ` · loop ${m ? (m.rxBytes || 0) : '-'}B/${m ? (m.rxSeq || 0) : '-'} (${ago(m && m.rxAt)}`
    + `, behind ${m && m.rxAt && st.lastAt ? ((st.lastAt - m.rxAt) / 1000).toFixed(1) : '0.0'}s)`
    + ` · keys ${keyEvents}/${keySent}`
    + ` · term ${t ? `${t.cols}x${t.rows}` : '-'}`
    + ` box ${box ? `${box.clientWidth}x${box.clientHeight}` : '-'}`
    + ` · view ${view} · hw ${(m && m.hw) || '-'}`
    + ` · claimed ${claimedOf(m && m.port) || '-'}`
    + `\nsession ${m ? [m.gone ? 'gone' : 'live',
                        m.reattaching ? 'reattaching' : '',
                        m.rngArmed ? 'rng-armed' : '',
                        m.rngRecovering ? 'rng-recovering' : '',
                        `drops ${m.drops || 0}`,
                        $('stuck-overlay') && !$('stuck-overlay').hidden ? 'stuck-dialog' : '',
                        $('reconnect-overlay') && !$('reconnect-overlay').hidden ? 'reconnect-dialog' : '',
                       ].filter(Boolean).join(' ') : 'none'}`
    + (st.firstError ? `\nfirst ${st.firstError}` : '')
    + (st.lastError && st.lastError !== st.firstError ? `\nlast ${st.lastError}` : '');
  // The experiment that splits the one open question: transfers posted, no
  // completions, no errors is either the host's endpoint state gone bad — a
  // reopen (which resyncs the endpoints) revives it — or the device deciding
  // to stop sending, which nothing on this side revives. One reopen per
  // silence stretch, re-armed only by bytes actually arriving, so a dead port
  // is reopened once and then left to say dead. Debug-gated deliberately:
  // if it proves itself as a recovery it gets promoted to one.
  if (m && !m.gone && !m.reattaching && m.reader && st.lastAt
      && (st.posted || 0) > 0
      && Date.now() - st.lastAt > SILENCE_RESYNC_MS
      && st.lastAt !== hudResyncedAt) {
    hudResyncedAt = st.lastAt;
    // Cheapest probe first. A healthy console that is merely idle answers a
    // bare CR, which settles the question without tearing down streams that
    // work — a reopen costs a mute window and a pair of notes, and doing one
    // every quiet stretch turns an idle session into churn. Only a CR that
    // goes unanswered escalates to the reopen-and-resync.
    const silentFor = Math.round((Date.now() - st.lastAt) / 1000);
    (async () => {
      const seq0 = m.rxSeq;
      await pokeConsole(m);
      for (let waited = 0; waited < 1500 && monitor === m && m.rxSeq === seq0; waited += 100)
        await sleep(100);
      if (monitor === m && m.rxSeq === seq0) {
        restreamAfterDrop(m, new Error(
          `no input for ${silentFor} s with ${st.posted} transfers posted, and a CR went unanswered`));
      }
    })();
  }
  hudEl.dataset.body = hudEl.textContent;
  hudEl.textContent = `${hudEl.textContent}\n${hudFlash || 'tap to copy'}`;
}

function ensureHud() {
  if (hudEl || !DEBUG_HUD) return;
  hudEl = document.createElement('div');
  hudEl.id = 'hud';
  // At the bottom, clear of the action row, and tappable: a readout nobody can
  // get off the screen is a readout that gets transcribed by hand, badly. One
  // tap puts the whole thing on the clipboard.
  hudEl.style.cssText = `position:absolute;left:0;right:0;bottom:${TAP_TO_FOCUS ? '2.8rem' : '0'};`
    + 'z-index:45;font:10px/1.35 ui-monospace,SFMono-Regular,monospace;color:#7ee787;'
    + 'background:rgba(0,0,0,.85);padding:.15rem .3rem;white-space:pre-wrap;'
    + 'cursor:pointer;user-select:text;-webkit-user-select:text';
  hudEl.title = 'tap to copy';
  hudEl.addEventListener('click', async () => {
    const text = hudReport();
    let done = false;
    try { await navigator.clipboard.writeText(text); done = true; } catch (_) { /* denied */ }
    // Selecting it is the fallback when the clipboard is refused: from there a
    // long-press copy is the platform's own.
    if (!done) {
      const r = document.createRange();
      r.selectNodeContents(hudEl);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    hudFlash = done ? 'copied' : 'selected — long-press to copy';
    setTimeout(() => { hudFlash = ''; updateHud(); }, 2000);
    updateHud();
  });
  $('monitor').appendChild(hudEl);
  setInterval(updateHud, 500);
}

// A line of input that does not depend on a terminal being able to take
// keystrokes. On a phone the characters a soft keyboard produces reach a page
// through composition events that a hidden textarea sitting at a cursor was
// never really built for, and a console nobody can type into is not a console.
// So a touch screen gets a plain input: a line is typed, Enter sends it with a
// carriage return, and the terminal above shows the device's echo of it.
//
// `^C` is beside it because a soft keyboard has no way to produce one and a CLI
// that cannot be interrupted is a CLI you can get stuck in.
let touchBar = null;

function ensureTouchInput() {
  if (touchBar || !TAP_TO_FOCUS) return;
  touchBar = document.createElement('div');
  touchBar.id = 'touch-line';
  touchBar.style.cssText = 'position:absolute;left:.6rem;right:.6rem;bottom:.4rem;z-index:44;'
    + 'display:flex;gap:.4rem;align-items:center';

  const field = document.createElement('input');
  field.id = 'touch-input';
  field.type = 'text';
  field.placeholder = 'type a command, then Enter';
  field.autocomplete = 'off';
  field.autocapitalize = 'off';
  field.spellcheck = false;
  field.setAttribute('autocorrect', 'off');
  field.style.cssText = 'flex:1;min-width:0;font:12px/1.4 ui-monospace,SFMono-Regular,monospace;'
    + 'color:#e6edf3;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:.35rem .45rem';

  const btn = 'font:600 12px/1.4 ui-monospace,SFMono-Regular,monospace;color:#e6edf3;'
    + 'background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:.35rem .5rem';

  // The button, not the key, is the reliable way to send a line: Android soft
  // keyboards routinely report their Enter as keyCode 229 with no usable `key`,
  // which is a keydown handler that never fires.
  const enter = document.createElement('button');
  enter.id = 'touch-send';
  enter.type = 'button';
  enter.textContent = '\u23ce';
  enter.style.cssText = btn;

  const ctrlC = document.createElement('button');
  ctrlC.id = 'touch-intr';
  ctrlC.type = 'button';
  ctrlC.textContent = '^C';
  ctrlC.style.cssText = btn;

  const send = (bytes) => sendTyped(monitor, bytes);
  const sendLine = () => {
    const line = field.value;
    field.value = '';
    send(new TextEncoder().encode(`${line}\r`));
  };

  field.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    sendLine();
  });
  ctrlC.addEventListener('click', () => send(Uint8Array.of(0x03)));
  enter.addEventListener('click', sendLine);

  touchBar.append(field, enter, ctrlC);
  $('monitor').appendChild(touchBar);
  // The terminal ends above the bar rather than behind it.
  $('monitor-term').style.bottom = '2.6rem';
}

async function openMonitor(port, doReset, banner) {
  $('monitor').hidden = false;
  syncViewport();
  // One terminal in this container, always. A monitor that throws part-way
  // through opening — a port that will not open, most often — has already put
  // its terminal on screen, and both callers answer a failed open by opening
  // again. Two terminals in one container is two cursors and two hidden input
  // boxes, with the keystrokes going to whichever was built last. The catch at
  // the end of this function is what keeps that from happening; this is the
  // backstop for a terminal that got left behind some other way.
  $('monitor-term').textContent = '';

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
  ensureHud();
  ensureTouchInput();     // before the fit, so the terminal is sized to what is left

  // Everything from the terminal being on screen to the session running, so
  // that whatever goes wrong in between, nothing of this attempt is left behind.
  let live = true;
  let resizeObserver = null;
  try {
    fit.fit();
    // Every later fit goes through this, so a terminal disposed by the cleanup
    // below is not re-fitted by a timer or an observer that outlived it.
    //
    // A refit that loses rows — the keyboard coming up, most of all — must keep
    // the bottom of the log on screen, because that is the part being read. A
    // session scrolled back to read something older is left where it was put.
    const refit = () => {
      if (!live) return;
      const b = term.buffer.active;
      const atBottom = b.viewportY >= b.baseY;
      fit.fit();
      if (atBottom) term.scrollToBottom();
    };
    // The monospace cell size isn't known until the font loads; an early fit
    // over-counts rows so the content overflows. Re-fit once the font is ready
    // (and after a tick, as a backstop), and focus so keystrokes reach xterm.
    if (document.fonts?.ready) document.fonts.ready.then(refit);
    setTimeout(() => { refit(); if (live) focusTerm(term); }, 50);
    resizeObserver = new ResizeObserver(refit);
    resizeObserver.observe($('monitor-term'));

    // Drop incoming bytes until the first reset (below); a plain terminal with no
    // reset shows everything from the start.
    monitor = makeSession(port, term, resizeObserver, doReset);
    syncDetectButton();      // there is a port to run one on now
    showCfg(monitor.cfg);
    updateBaudVisibility(port);
    setMonTitle(null);   // new session: no hostname until the device logs one

    // Forward keystrokes to the current writer. The device's serial line stays in
    // log mode until it receives input, then switches to the interactive CLI.
    // A rejected write is the same drop seen from the other side, and the more
    // likely side to see it first: the reader is idle between bursts, while a
    // keystroke goes out the moment it is typed. Silently swallowing it is what
    // makes a dead stream look like a device that stopped listening.
    const encoder = new TextEncoder();
    term.onData((data) => { sendTyped(monitor, encoder.encode(data)); });

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
  } catch (e) {
    // A half-open monitor is of no use to anyone above, and the retry that
    // follows builds its own — so this one leaves nothing behind, terminal
    // included.
    live = false;
    if (resizeObserver) resizeObserver.disconnect();
    const half = monitor;
    monitor = null;
    if (half) { try { await detachStreams(half); } catch (_) { /* never attached */ } }
    term.dispose();
    $('monitor-term').textContent = '';
    setMonTitle(null);
    syncDetectButton();
    // And out of the way. Every caller answers a failed open by putting the
    // reason on the intro screen — which is behind this overlay. Left up, a
    // port that would not open presents as a black rectangle that does nothing,
    // with the sentence explaining it hidden underneath.
    $('monitor').hidden = true;
    throw e;
  }
}

// Show the live line settings on the panel's own readout.
function showCfg(cfg) {
  const el = $('cfg-current');
  if (el) el.textContent = fmtCfg(cfg);
}

// The line settings the panel's selects currently describe.
function cfgFromControls() {
  return {
    baudRate: parseInt($('cfg-baud').value, 10) || 115200,
    dataBits: parseInt($('cfg-data').value, 10) || 8,
    stopBits: parseInt($('cfg-stop').value, 10) || 1,
    parity: $('cfg-parity').value || 'none',
  };
}

// Re-open the port with new line settings, keeping the same terminal + buffer.
async function applyCfg() {
  const cfg = cfgFromControls();
  // Both, because they answer different questions: SETTINGS is what "Set as
  // defaults" would write, DEFAULT_CFG is what the next session (or a detection
  // run, which opens the port itself) starts at.
  SETTINGS.baudRate = cfg.baudRate;
  DEFAULT_CFG.baudRate = cfg.baudRate;
  showCfg(cfg);
  if (!monitor) return;             // no session yet: it will open at this rate
  monitor.cfg = cfg;
  try {
    await detachStreams(monitor);
    await attachStreams(monitor);
    monitor.term.writeln(`\r\n\x1b[36m── serial ${fmtCfg(cfg)} ──\x1b[0m`);
  } catch (e) {
    monitor.term.writeln(`\r\n\x1b[31m── reconfigure failed: ${e && e.message ? e.message : e} ──\x1b[0m`);
  }
  focusTerm(monitor.term);
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
  focusTerm(term);         // so the next Enter goes to the device, not this button
});

// ── settings panel ──────────────────────────────────────────────────────────
// The gear, top right, on screen from the first paint: everything here is worth
// changing before a port is picked (a device that logs at a different rate, a
// session that must not reset the board) as well as during a session.
function openSettings() {
  syncForgetButton();   // another tab may have stored or wiped since this one opened
  $('settings-box').hidden = false;
  $('settings-overlay').hidden = false;
}
function closeSettings() { $('settings-box').hidden = true; $('settings-overlay').hidden = true; }

on('gear', 'click', () => {
  if ($('settings-box').hidden) openSettings(); else closeSettings();
});
on('settings-overlay', 'click', closeSettings);
on('cfg-apply', 'click', applyCfg);
on('set-noreset', 'change', (e) => { SETTINGS.noReset = e.target.checked; });
on('set-autoflash', 'change', (e) => {
  SETTINGS.autoFlash = e.target.checked;
  // Turning it on with an offer already up should act on that offer, not wait
  // for the next one to resolve.
  if (SETTINGS.autoFlash) maybeAutoFlash();
});
on('set-defaults', 'click', () => {
  SETTINGS.baudRate = cfgFromControls().baudRate;
  const msg = $('settings-saved');
  if (msg) {
    msg.textContent = saveSettings()
      ? 'Saved — these are the settings this page will load with.'
      : 'Could not save: this browser is not storing anything for this page.';
  }
});

// Drop the answers setup was told to reuse, so the next fresh node asks again.
on('set-forget', 'click', () => {
  forgetStoredAnswers();
  const msg = $('settings-saved');
  if (msg) msg.textContent = 'Stored device password and wifi networks deleted.';
});

// The button is also the answer to "is this browser holding any?" — nothing
// stored, nothing to press.
function syncForgetButton() {
  const b = $('set-forget');
  if (b) b.disabled = !haveStoredAnswers();
}

// The baud selector is meaningless on a native USB device: the ESP32-S3's own
// USB (both the Serial/JTAG peripheral and a CDC console) carries the console
// over USB packets, where the line rate is a number nobody reads. Hide it rather
// than offer a control that does nothing.
function isNativeUsb(port) {
  const i = port && port.getInfo ? port.getInfo() : {};
  return i.usbVendorId === ESPRESSIF_VID;
}

function updateBaudVisibility(port) {
  const row = $('cfg-serial');
  if (row) row.hidden = isNativeUsb(port);
}

// ── FNB58 USB power meter (WebHID) ──────────────────────────────────────────
// A FNIRSI FNB58/FNB48 is a USB-HID device (not a serial port), so it rides
// WebHID alongside the device's Web Serial monitor in this same tab. We open it,
// kick the vendor stream with three 64-byte 0xaa commands, and each 64-byte
// input report carries four 15-byte samples (voltage u32 LE, current u32 LE,
// /100000 → volts/amps). At ~100 samples/s we ring-buffer each reading with its
// arrival timestamp (up to 5 minutes) and paint a scrolling bar graph across the
// top of the monitor.
//
// The session outlives a hidden tab. Input reports keep arriving unthrottled, but
// the 1 Hz keep-alive is what holds the stream open and the same 1 Hz tick is the
// stall watchdog — on window timers a background tab would clamp both to a minute,
// the meter would stop streaming and the watchdog would then tear the session down.
// So every FNB58 timer runs on the flasher's worker timers (wtSetInterval, and
// useWorkerTimers around the sleeping open/recover/drain paths). Only the graph is
// left to the tab: requestAnimationFrame pauses while hidden, the ring keeps
// filling from the reports, and the first visible frame draws the history.
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
// DOM when it changes. stopTick: cancels the worker-held keep-alive/watchdog.
const fnb = { device: null, stopTick: null, raf: 0,
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
  fnb.stopTick?.();
  fnb.stopTick = wtSetInterval(fnbTick, 1000);   // worker-held: a hidden tab must not throttle the keep-alive
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
  // Slide the terminal + actions clear of the graph; the gear is fixed to the
  // window rather than the monitor, so it takes the class from the body.
  $('monitor').classList.add('fnb58-open');
  document.body.classList.add('fnb58-open');
  $('monitor-fnb58').classList.add('on');
  cancelAnimationFrame(fnb.raf);
  fnbLoop();
}

// Detach the meter (streams + timers) without touching the panel, and AWAIT the
// close so the OS handle is truly released before anything opens it again — an
// un-awaited close is exactly what lets the next open() land as a second connect.
async function fnbUnbind() {
  fnb.stopTick?.(); fnb.stopTick = null;
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
  // The probe listen, the data wait and the retry pause are all short sleeps; a
  // recovery that lands while the tab is hidden would have them throttled into
  // uselessness, so hold the worker timers for the whole attempt.
  const releaseTimers = useWorkerTimers();
  try {
    for (let a = 0; a < tries; a++) {
      try { await fnbBind(device, allowInit); }
      catch (_) { await fnbUnbind(); if (a + 1 < tries) await sleep(FNB58_RETRY_MS); continue; }
      if (await fnbAwaitData(FNB58_DATA_WAIT_MS)) { fnbShowPanel(); return true; }
      await fnbUnbind();
      if (a + 1 < tries) await sleep(FNB58_RETRY_MS);
    }
    return false;
  } finally {
    releaseTimers();
  }
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
  const releaseTimers = useWorkerTimers();         // recovery is all short sleeps; a hidden tab must not stretch them
  try {
    if (monitor) { try { note(monitor, '\x1b[33m-- FNB58 stream stalled; reconnecting… --\x1b[0m'); } catch (_) {} }
    await fnbUnbind();                             // release our handle before touching it again
    await sleep(FNB58_RETRY_MS);
    if (await fnbTryDevice(device, 1, false)) return;   // re-latch a live stream (no re-init)
    await fnbTeardown();                           // gone quiet → disconnect; cooldown gates the reopen
    await fnbForget(device);                       // revoke the grant (teardown can't — we already unbound)
    if (monitor) { try { note(monitor, '\x1b[31m-- FNB58 disconnected (no data) --\x1b[0m'); } catch (_) {} }
  } finally {
    releaseTimers();
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
  fnb.stopTick?.(); fnb.stopTick = null;       // stop the keepalive FIRST
  $('fnb58-panel').hidden = true;
  $('monitor').classList.remove('fnb58-open');
  document.body.classList.remove('fnb58-open');
  $('monitor-fnb58').classList.remove('on');
  $('monitor-fnb58').hidden = true;            // hide the button immediately (no 5 s poll lag)
  const dev = fnb.device;
  // The drain is a fixed 1 s of the browser reading the endpoint; a throttled
  // hidden tab would turn it into a minute of the panel already gone but the
  // handle still held, so it runs on the worker timers too.
  const releaseTimers = useWorkerTimers();
  try {
    if (dev) await sleep(FNB58_DRAIN_MS);      // drain: browser keeps reading the endpoint until we close
  } finally {
    releaseTimers();
  }
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
  // `build: hw <hw-board>` — the device saying which board it is. Not a claim
  // about the image: it is what the board straddle's own detect_hw() read off
  // the hardware at the top of this boot, checked against the board the image
  // was built for (spangap halts when those disagree). So it is exactly what a
  // detection run would find, arriving for free, and it is marked as such.
  //
  // Printed at boot AND whenever a console attaches, which is what makes this
  // the whole of identification: opening the port sends a CR, the device answers
  // with this, and there is nothing to ask.
  let mm = line.match(/\bbuild: hw (hw-[a-z0-9-]+)/);
  if (mm) {
    if (m === monitor && m.hw !== mm[1]) armFlashGrace(mm[1], true);
    return;
  }
  // The console greeting's identity line — plain text the firmware writes to
  // whoever attaches, not a log line:
  //
  //   dev f9fb74, host tbeam, fw rop/reticulous_hw-lilygo-tbeam-supreme_20260821142037
  //
  // Everything the session learns elsewhere piecemeal, in one answer: the
  // physical unit (getInfo() has no serial number, so `dev` is the only
  // per-unit fact that reaches the page, and it is what the returning-boards
  // adoption verifies against), the hostname (the tab's title), and the image
  // named exactly as its catalogue zip, prefixed by its catalogue. Optional
  // fields: `hw <board>` appears only when the detected board differs from the
  // dist (a variant entry not named after its board), `fw` only for a
  // catalogue build.
  // Fields end at a comma, so the captures must exclude it — `\S+` would eat
  // the comma and knock every field after `host` out of alignment.
  mm = line.match(/^dev ([0-9a-f]{6}), host ([^\s,]+)(.*)$/);
  if (mm) {
    // Per session as well as the tab-level pairing: a console move's incoming
    // session hears the greeting before it becomes `monitor`, and its commit
    // carries the id over rather than losing it.
    m.unitId = mm[1];
    m.hostname = mm[2];
    if (m === monitor) { pairedUnit = mm[1]; setMonTitle(mm[2]); }
    rosterNote(mm[1], mm[2], portUsbKey(m.port));
    const rest = mm[3] || '';
    const fw = rest.match(/, fw (?:([^/\s,]+)\/)?([^\s,]+)_(\d{14})\b/);
    const hw = (rest.match(/, hw (hw-[a-z0-9-]+)\b/) || [])[1]
      || (fw && (fw[2].match(/(hw-[a-z0-9-]+)$/) || [])[1]);
    // The same facts the `build:` boot-log lines carry, with the same
    // strength: a running image has already proved dist and hardware agree
    // (spangap halts on a mismatch), so the board named here is detector-grade.
    if (hw && m === monitor && m.hw !== hw) armFlashGrace(hw, true);
    if (fw) {
      if (fw[1]) {
        m.deviceCatalogue = fw[1];
        if (m === monitor) adoptDeviceCatalogue(fw[1]);
      }
      m.deviceVersion = fw[3];
      m.versionSettled = true;
      clearTimeout(m.versionTimer);
      if (m === monitor) refreshFlashOffer();
    }
    // `ap "<ssid>", ip <addr>` — present while the device is associated with an
    // address: it is online and its UI reachable, known at attach rather than
    // only when a `Connected` boot-log line happens to scroll past. The SSID is
    // free text (spaces, commas), so the parse anchors on the `", ip` after it.
    const net = rest.match(/, ap "(.*)", ip ([^\s,]+)/);
    if (net) {
      m.connectedSeen = true;
      showOpenUi(m, net[2], net[1]);   // device online → show the "Open Device UI" button
      advanceSetup(m);                 // network is up → no wifi dialog needed
    }
    return;
  }
  // `dev a1b2c3` alone at line end — the boot log stating the unit id (the
  // same field, same spelling, as the greeting; a boot log line just has
  // nothing else to say).
  mm = line.match(/\bdev ([0-9a-f]{6})\s*$/);
  if (mm) {
    m.unitId = mm[1];
    if (m === monitor) pairedUnit = mm[1];
    rosterNote(mm[1], null, portUsbKey(m.port));
    return;
  }
  // `build: invocation spangap build <buildable> --with spangap/hw-<board> …` —
  // the `spangap build` command that produced the running image. Firmware too
  // old to print `build: hw` still names its board here, so this is the fallback
  // — and a weaker one: it says what the image was COMPILED for, not what the
  // hardware is, so a real detection run (hwDetected) outranks it.
  mm = line.match(/build: invocation\b.*?\b(hw-[a-z0-9-]+)/);
  if (mm) {
    if (m === monitor && !m.hwDetected) armFlashGrace(mm[1], false);
    return;
  }
  // `build: catalogue <name>` — which catalogue the running image was published
  // from (spangap-core logs it on boot; absent on an image that didn't come from
  // a catalogue run). The device's own answer to "which build is this", so the
  // page follows it: a board flashed from `dev` is compared against `dev`.
  mm = line.match(/build: catalogue (\S+)/);
  if (mm) {
    m.deviceCatalogue = mm[1];
    if (m === monitor) adoptDeviceCatalogue(mm[1]);
    return;
  }
  // `build: datetime <YYYYMMDDhhmmss>` — the running firmware's catalogue build
  // stamp (spangap-core logs it on boot). Remember it and re-evaluate the flash
  // offer: it decides whether the offer reads as an upgrade or as a re-flash.
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
  // `setup: on-device` — this build asks a fresh node's questions on its own
  // screen. Printed every boot, before the device decides whether it has
  // anything to ask, so it is the build talking rather than this boot: the one
  // thing this page needs in order to stay out of the way. It also arrives
  // before `spangap ready`, which is what makes the wait below exact.
  if (line.includes('setup: on-device')) {
    if (!m.deviceOnboards) {
      m.deviceOnboards = true;
      closeSetupDialogs(m);
    }
    return;
  }
  // `spangap ready` — the boot walk is done, so everything that was going to
  // announce itself has. Until then a watched boot's setup flow waits: the
  // device's own onboarding registers near the END of that walk, and asking
  // before it has had its say is how two surfaces end up asking at once.
  if (line.includes('spangap ready')) {
    if (!m.bootDone) { m.bootDone = true; advanceSetup(m); }
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
    noteHostname(m, mm[1]);
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
      noteHostname(m, mm[4]);        // device reported its actual hostname
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
          noteHostname(m, mm2[1]);
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

  $('ch-ssid-custom').value = '';
  $('ch-pass').value = '';
  if ($('ch-remember')) $('ch-remember').checked = false;
  updateConnectFields();
  $('connect-overlay').hidden = false;
  // Land on the field that still needs typing: the SSID when the scan found
  // nothing to pick from, otherwise the password — or the select itself when the
  // chosen network is open and there is nothing left to fill in.
  if (!$('ch-ssid-other').hidden) $('ch-ssid-custom').focus();
  else if (!$('ch-pass-wrap').hidden) $('ch-pass').focus();
  else $('ch-ssid').focus();
}

function closeConnectDialog() { $('connect-overlay').hidden = true; }

$('ch-ssid').addEventListener('change', updateConnectFields);
// Enter anywhere in the wifi box is Connect: the fields it has are already
// filled from the scan unless the network is secured or unlisted, so typing the
// one value and pressing return is the whole dialog.
for (const id of ['ch-ssid', 'ch-ssid-custom', 'ch-pass']) {
  on(id, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('ch-send').click(); } });
}

// Skipping the wifi box skips wifi but still lets the setup flow finish
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
  const sel = $('ch-ssid');
  const opt = sel.selectedOptions[0];
  const isOther = !!(opt && opt.dataset.other === '1');
  const ssid = (isOther ? $('ch-ssid-custom').value : sel.value).trim();
  if (!ssid) { (isOther ? $('ch-ssid-custom') : sel).focus(); return; }
  const isOpen = !isOther && opt && opt.dataset.open === '1';
  const pass = isOpen ? '' : $('ch-pass').value;

  if ($('ch-remember') && $('ch-remember').checked) rememberWifi(ssid, pass);
  m.wifiCfg = { ssid, pass };
  m.wifiResolved = true;
  m.wifiOpen = false;
  closeConnectDialog();
  advanceSetup(m);
});

// The device's own name, from whichever source reported it — the `Connected`
// line, a `show s.net.hostname` reply, or the post-setup readback.
//
// `hostNamed` is the setup coordinator's question, and it is deliberately not
// "is a name set": a device still answering to the project default has not been
// named by anyone, so it is the one worth offering the dialog to. Anything else
// is a name somebody chose, and the dialog would offer to overwrite it.
function noteHostname(m, name) {
  if (!name) return;
  m.hostname = name;
  m.hostNamed = name !== HOSTNAME_DEFAULT;
  deviceUiHost = name;
  if (m === monitor) setMonTitle(name);
}

// What this device is currently called. The `Connected "<ssid>" … host <name>`
// line answers it for free on a device that reached a real network — but the
// dialog is raised on the AP-fallback path, where that line never comes. So ask,
// over the same framed channel the other setup probes use. Firmware that cannot
// be asked falls through to the dialog, which is where this started.
async function probeHostname(m) {
  if (m.hostProbing || m.hostProbed) return;
  m.hostProbing = true;
  if (await rpcEnsure(m)) {
    const out = await rpcQuery(m, 'show s.net.hostname');
    if (monitor !== m) return;
    const mm = /^s\.net\.hostname = (\S+)/m.exec(out || '');
    if (mm) noteHostname(m, mm[1]);
  }
  m.hostProbed = true;
  m.hostProbing = false;
  if (monitor === m) advanceSetup(m);
}

// ── hostname dialog ─────────────────────────────────────────────────────────
// The one answer that is about this node and cannot be reused, so it is asked
// on its own — a name typed on every node, next to two dialogs that a browser
// holding the answers will skip.
function openHostDialog(m) {
  m.hostOpen = true;
  $('hn-name').value = m.hostname || HOSTNAME_DEFAULT;
  $('host-overlay').hidden = false;
  $('hn-name').focus();
  $('hn-name').select();
}

function closeHostDialog() { if ($('host-overlay')) $('host-overlay').hidden = true; }

// Block any insertion that contains an illegal hostname char (typed or pasted)
// before it lands, so nothing happens — the text and caret are untouched, and
// nothing has to be reported after the fact. Deletions/navigation have null data
// and pass through. The 20-char cap is the input's native maxlength.
on('hn-name', 'beforeinput', (e) => {
  if (e.data && /[^A-Za-z0-9_]/.test(e.data)) e.preventDefault();
});
on('hn-name', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('hn-ok').click(); } });

on('hn-skip', 'click', () => {
  const m = monitor;
  closeHostDialog();
  if (!m) return;
  m.newHostname = null;          // the device keeps whatever name it has
  m.hostResolved = true;
  m.hostOpen = false;
  advanceSetup(m);
});

on('hn-ok', 'click', () => {
  const m = monitor;
  if (!m) { closeHostDialog(); return; }
  // The field can only ever hold legal hostname characters (the beforeinput
  // filter above) up to its maxlength, so whatever is in it is usable as-is; an
  // empty field means "keep the default".
  const hostname = $('hn-name').value.trim() || HOSTNAME_DEFAULT;
  m.hostname = hostname;
  m.newHostname = hostname;
  m.hostResolved = true;
  m.hostOpen = false;
  closeHostDialog();
  advanceSetup(m);
});

// ── answers this browser reuses across nodes ────────────────────────────────
// Setting up a pile of fresh nodes is the same three answers over and over, two
// of which are the same on every one of them. Ticking the box in either dialog
// stores that answer here, and setup then skips the dialog it came from: a node
// costs one dialog (its name) instead of three.
//
// Both are held in this origin's LocalSettings as plain text — the browser's
// storage is the trust boundary, the same one the page's other settings sit
// behind. The settings panel's "Delete stored wifi and node passwords" wipes
// both.
const NODE_PW_KEY = 'flashmon.nodePassword';   // LocalSettings: admin password for every new node
const WIFI_KEY = 'flashmon.wifiNetworks';      // LocalSettings: [{ssid, pass}], most recent first

function storedNodePassword() {
  try { return localStorage.getItem(NODE_PW_KEY) || null; } catch (_) { return null; }
}

function rememberNodePassword(pw) {
  try { localStorage.setItem(NODE_PW_KEY, pw); } catch (_) { /* storage blocked */ }
  syncForgetButton();
}

function storedWifi() {
  try {
    const v = JSON.parse(localStorage.getItem(WIFI_KEY));
    if (!Array.isArray(v)) return [];
    return v.filter((n) => n && typeof n.ssid === 'string' && typeof n.pass === 'string');
  } catch (_) { return []; }
}

// One entry per SSID — a re-entered password replaces the stored one rather than
// leaving two answers for the same network.
function rememberWifi(ssid, pass) {
  const list = storedWifi().filter((n) => n.ssid !== ssid);
  list.unshift({ ssid, pass });
  try { localStorage.setItem(WIFI_KEY, JSON.stringify(list)); } catch (_) { /* storage blocked */ }
  syncForgetButton();
}

// The remembered network to use for this device: the first one the device's own
// scan actually saw. A stored network out of range says nothing about where this
// node should join, so it is not offered.
function storedWifiInRange(m) {
  for (const n of storedWifi()) if (m.aps.has(n.ssid)) return n;
  return null;
}

function haveStoredAnswers() { return !!storedNodePassword() || storedWifi().length > 0; }

function forgetStoredAnswers() {
  try {
    localStorage.removeItem(NODE_PW_KEY);
    localStorage.removeItem(WIFI_KEY);
  } catch (_) { /* storage blocked — there was nothing stored either */ }
  syncForgetButton();
}

// ── device setup coordinator ─────────────────────────────────────────────────
// A fresh device can need a password and/or a network. The dialogs run in order
// — password (on "No device password set"), hostname, then wifi (both on the AP
// fallback) — and everything the user chose goes out in ONE batch at the end.
// Skipping a dialog skips that part and lets the rest proceed; an answer this
// browser was told to reuse (the node password, a remembered network in range)
// skips its dialog outright.
// Take down every setup dialog and mark what it was asking as settled, so the
// coordinator neither re-opens it nor stalls waiting on it. Used both when the
// user's own action supersedes them (closeDialogs) and when the device turns out
// to be asking for itself.
function closeSetupDialogs(m) {
  if (!m) return;
  if (m.passwdOpen) { m.passwdOpen = false; m.passwdResolved = true; closePasswdDialog(); }
  if (m.hostOpen)   { m.hostOpen = false;   m.hostResolved = true;   closeHostDialog(); }
  if (m.wifiOpen)   { m.wifiOpen = false;   m.wifiResolved = true;   closeConnectDialog(); }
  if (m.loraOpen)   { m.loraOpen = false;   m.loraResolved = true;   closeLoraDialog(); }
  if (m.lxmfOpen)   { m.lxmfOpen = false;   m.lxmfResolved = true;   closeLxmfDialog(); }
}

function resetSetup(m) {
  // This session watched the boot start, so it can wait for the end of it —
  // `spangap ready` — before asking anything. Cleared here and set by that line.
  m.bootWatching = true;
  m.bootDone = false;
  m.deviceOnboards = false;   // the marker comes round again on the new boot
  m.onboardProbed = false;
  m.needPasswd = false;
  m.passwdResolved = false;
  m.newPasswd = null;
  m.passwdOpen = false;
  m.hostResolved = false;
  m.newHostname = null;
  m.hostOpen = false;
  /* The name itself survives a reboot, so `hostNamed` is left alone; asking
   * again is how a name set on the previous pass is picked up. */
  m.hostProbed = false;
  m.hostProbing = false;
  m.wifiNeeded = false;
  m.wifiResolved = false;
  m.wifiCfg = null;
  m.wifiOpen = false;
  m.connectedSeen = false;
  m.extrasProbed = false;
  m.extrasProbing = false;
  m.loraNeeded = false;
  m.loraSupe = false;
  m.loraResolved = false;
  m.loraCfg = null;
  m.loraOpen = false;
  m.lxmfNeeded = false;
  m.lxmfResolved = false;
  m.lxmfName = null;
  m.lxmfOpen = false;
  m.setupSent = false;
  m.aps.clear();
  closePasswdDialog();
  closeHostDialog();
  closeConnectDialog();
  closeLoraDialog();
  closeLxmfDialog();
}

// ── what the boot log doesn't say ───────────────────────────────────────────
// The radio and the mesh identity have no boot line to watch: nothing is logged
// for "this radio has never been given a frequency" or "there is no identity
// yet", because neither is an event — they are states. So they are asked for,
// once, over the same framed channel the setup commands go out on, and only
// after the questions that DO have boot lines are settled.
//
// `show <key>` answers each one: it prints `<key> = <value>` when the key is
// there and the literal `(no matches)` when it isn't. That is the whole
// protocol — an absent straddle, an absent key and an unset value are all
// distinguishable without any new firmware verb.
//
// ONE KEY PER QUERY, never a subtree. A reply frame is length-counted and the
// device's log echo goes to the same wire on its own path, so a log line that
// lands inside a frame is unrecoverable for this side — and the wider the frame,
// the wider that window. Asking `show s.lora.0` during the boot storm (wifi
// associating, ntp, webrtc, the mesh coming up) put a ~25-line reply in the
// middle of it and lost frames, which surface as `SG` + the frame's id printed
// into the terminal. Each of these replies is one short line.
//
// Firmware that doesn't speak frames is left alone: we cannot ask, so we don't
// guess, and neither dialog opens.
// Does this build carry its own on-device setup? `s.onboard.done` is written by
// that setup's own init, so the key exists in a build that has it and nowhere
// else — the same "a key that is there is the capability" reading the extras
// probe uses. Only reached when this session did not watch the boot (where the
// device's own marker line answers it for free); firmware without frames cannot
// be asked and is left to the marker alone.
async function probeOnboarding(m) {
  if (m.onboardProbing || m.onboardProbed) return;
  m.onboardProbing = true;
  if (await rpcEnsure(m)) {
    const out = await rpcQuery(m, 'show s.onboard.done');
    if (monitor !== m) return;
    if (out && !/\(no matches\)/.test(out)) {
      m.deviceOnboards = true;
      closeSetupDialogs(m);
    }
  }
  m.onboardProbed = true;
  m.onboardProbing = false;
  if (monitor === m) advanceSetup(m);
}

async function probeExtras(m) {
  if (m.extrasProbing || m.extrasProbed) return;
  m.extrasProbing = true;
  const done = () => {
    m.extrasProbed = true;
    m.extrasProbing = false;
    if (monitor === m) advanceSetup(m);
  };
  if (!(await rpcEnsure(m))) { done(); return; }

  // A key that is there is the capability; `(no matches)` is the absence of it.
  const has = (out) => !!out && !/\(no matches\)/.test(out);
  const intOf = (out, key) => {
    const mm = out && new RegExp(`^${key.replace(/\./g, '\\.')} = (-?\\d+)`, 'm').exec(out);
    return mm ? parseInt(mm[1], 10) : null;
  };

  // enable is seeded for every radio in the build, so its presence says there
  // IS a radio; frequency ships with no default at all (the antenna and the
  // region decide it), so its absence says the radio was never set up.
  const loraOn = await rpcQuery(m, 'show s.lora.0.enable');
  if (monitor !== m) return;                       // session went away mid-probe
  if (has(loraOn)) {
    const freq = await rpcQuery(m, 'show s.lora.0.frequency');
    if (monitor !== m) return;
    m.loraNeeded = !((intOf(freq, 's.lora.0.frequency') || 0) > 0);
    if (m.loraNeeded) {
      const supe = await rpcQuery(m, 'show s.lora.0.SUPE.enable');
      if (monitor !== m) return;
      m.loraSupe = has(supe);                      // the key exists only on a SUPE build
    }
  }

  // Identity slot 0 carries a label from the moment one is created, so its
  // absence is "no identity". That reads the same as "no messaging in this
  // build", so ask for a key the straddle always seeds before concluding there
  // is anything to ask the operator.
  const label = await rpcQuery(m, 'show s.lxmf.id.0.label');
  if (monitor !== m) return;
  if (!has(label)) {
    const ver = await rpcQuery(m, 'show s.lxmf.version');
    if (monitor !== m) return;
    m.lxmfNeeded = has(ver);
  }
  done();
}

// ── the LoRa dialog ─────────────────────────────────────────────────────────
function openLoraDialog(m) {
  m.loraOpen = true;
  $('lora-msg').textContent = '';
  $('lora-supe-row').hidden = !m.loraSupe;
  $('lora-regime-row').hidden = !m.loraSupe;
  if ($('lora-supe')) $('lora-supe').checked = false;
  if ($('lora-regime')) $('lora-regime').value = '0';
  $('lora-overlay').hidden = false;
  $('lora-freq').focus();
}

function closeLoraDialog() { if ($('lora-overlay')) $('lora-overlay').hidden = true; }

on('lora-freq', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('lora-ok').click(); } });

on('lora-skip', 'click', () => {
  const m = monitor;
  closeLoraDialog();
  if (!m) return;
  m.loraCfg = null;
  m.loraResolved = true;
  m.loraOpen = false;
  advanceSetup(m);
});

on('lora-ok', 'click', () => {
  const m = monitor;
  if (!m) { closeLoraDialog(); return; }
  const mhz = $('lora-freq').value.trim();
  // The radio's own bounds (iface-lora's LORA_FREQ_MIN_HZ / LORA_FREQ_MAX_HZ).
  // Checked here so the answer is "no" rather than a value the device's unit
  // bridge silently snaps back after the dialog has closed.
  const v = parseFloat(mhz);
  if (!/^\d+(\.\d+)?$/.test(mhz) || !(v >= 100 && v <= 2000)) {
    $('lora-msg').textContent = 'Not a frequency this radio can be set to.';
    $('lora-freq').focus();
    return;
  }
  m.loraCfg = {
    mhz,
    sf: $('lora-sf').value,
    bw: $('lora-bw').value,
    cr: $('lora-cr').value,
    supe: !!($('lora-supe') && m.loraSupe && $('lora-supe').checked),
    regime: (m.loraSupe && $('lora-regime')) ? $('lora-regime').value : null,
  };
  m.loraResolved = true;
  m.loraOpen = false;
  closeLoraDialog();
  advanceSetup(m);
});

// ── the mesh-name dialog ────────────────────────────────────────────────────
function openLxmfDialog(m) {
  m.lxmfOpen = true;
  // The hostname is already a name this node was given, so it is a better
  // starting point than an empty field — and still just a starting point.
  $('lxmf-name').value = m.newHostname || m.hostname || '';
  $('lxmf-overlay').hidden = false;
  $('lxmf-name').focus();
  $('lxmf-name').select();
}

function closeLxmfDialog() { if ($('lxmf-overlay')) $('lxmf-overlay').hidden = true; }

on('lxmf-name', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('lxmf-ok').click(); } });

on('lxmf-skip', 'click', () => {
  const m = monitor;
  closeLxmfDialog();
  if (!m) return;
  m.lxmfName = null;
  m.lxmfResolved = true;
  m.lxmfOpen = false;
  advanceSetup(m);
});

on('lxmf-ok', 'click', () => {
  const m = monitor;
  if (!m) { closeLxmfDialog(); return; }
  const name = $('lxmf-name').value.trim();
  if (!name) { $('lxmf-name').focus(); return; }
  m.lxmfName = name;
  m.lxmfResolved = true;
  m.lxmfOpen = false;
  closeLxmfDialog();
  advanceSetup(m);
});

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
  if (m.newHostname) cmds.push(`hostname ${m.newHostname}`);
  if (m.wifiCfg) {
    cmds.push(`net add ${cliQuote(m.wifiCfg.ssid)}` +
              (m.wifiCfg.pass ? ` ${cliQuote(m.wifiCfg.pass)}` : ''));
  }
  if (m.loraCfg) {
    // Frequency and bandwidth go to the MHz/kHz display keys — iface-lora's own
    // unit bridge converts them to the stored Hz, so the conversion lives in one
    // place and any value works. Enable goes LAST: the modem settings are in
    // before the radio is brought up against them.
    cmds.push(`set lora.0.freq_mhz ${m.loraCfg.mhz}`);
    cmds.push(`set lora.0.bw_khz ${m.loraCfg.bw}`);
    cmds.push(`set s.lora.0.spreading_factor ${m.loraCfg.sf}`);
    cmds.push(`set s.lora.0.coding_rate ${m.loraCfg.cr}`);
    if (m.loraCfg.supe) cmds.push('set s.lora.0.SUPE.enable 1');
    // Sent whatever the switch says: the regime also selects which channels the
    // per-second RSSI beat measures and draws, which is what it does with SUPE
    // off.
    if (m.loraCfg.regime !== null) cmds.push(`set s.lora.0.SUPE.afa ${m.loraCfg.regime}`);
    cmds.push('set s.lora.0.enable 1');
  }
  // lxmf's own verb, not the storage sentinel behind it: it takes the name as
  // the rest of the line (so spaces need no quoting, and quoting would put the
  // quotes IN the name), it creates the identity synchronously, and it answers
  // with the slot and destination — which is what makes this one confirmable
  // like every other command in the batch.
  if (m.lxmfName) cmds.push(`lxmf create ${m.lxmfName}`);
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
  // A second `save`, after the round trip above has given the device's own
  // tasks a moment. Not everything in the batch lands on the task that ran it:
  // iface-lora converts the MHz/kHz display keys into the stored Hz on its own
  // task, so `s.lora.0.frequency` is written AFTER the `save` at the end of the
  // batch. Storage's own deadline is a minute out, and a device unplugged
  // inside that minute would come back with a password, a name and a network
  // but no radio — the worst possible half.
  if (m.loraCfg) await rpcQuery(m, 'save');
  const kv = parseKv(net);
  noteHostname(m, kv.get('hostname'));
  if (kv.get('state') === 'sta' && kv.get('ip')) {
    m.connectedSeen = true;
    showOpenUi(m, kv.get('ip'), kv.get('ssid') || '');
  }
}

function advanceSetup(m) {
  if (m.setupSent) return;
  // The device sets itself up on its own screen: either the image we flashed
  // said so (imageOnboardsItself) or the device itself did (`setup: on-device`).
  // Every dialog below would be asking for an answer it is asking for at the
  // same moment, and the winner of that race is not predictable.
  if (deviceOnboards || m.deviceOnboards) return;
  // A boot we watched start gets to finish before anything is asked. The
  // device's own onboarding announces itself near the END of the init walk,
  // while "No device password set" comes out near the beginning — so acting on
  // the early line is exactly how a dialog opens ten seconds before the device
  // says it did not need one. `spangap ready` is the end of that walk.
  if (m.bootWatching && !m.bootDone) return;
  // Attached mid-session, so there was no boot to watch and no marker to catch:
  // ask the device instead. The key exists only in a build carrying on-device
  // setup, so its presence is the answer. One short framed query, once.
  if (!m.onboardProbed) { probeOnboarding(m); return; }
  // 1. Password first — from storage if this browser was told to set the same
  //    one on every node, otherwise the dialog.
  if (m.needPasswd && !m.passwdResolved) {
    const stored = storedNodePassword();
    if (stored) {
      m.newPasswd = stored;
      m.passwdResolved = true;
      note(m, '\x1b[90m-- using the stored node password --\x1b[0m');
    } else {
      if (!m.passwdOpen) openPasswdDialog(m);
      return;
    }
  }
  if (m.passwdOpen) return;   // user still in the password dialog
  // 2. Hostname next, if the device fell back to its own AP. Asked even when
  //    the network below is answered from storage: the name is this node's.
  //
  //    Only of a node that has no name of its own, though. The dialog prefills
  //    the project default, and its primary button WRITES that value — so
  //    raising it over an already-named device offers to rename it, with the
  //    innocent-looking button being the destructive one. Ask the device what it
  //    is called first: the AP-fallback path has no `Connected … host` line to
  //    read it from, so nothing else here would know.
  if (m.wifiNeeded && !m.hostResolved) {
    if (!m.hostProbed) { probeHostname(m); return; }   // async; re-enters here
    if (m.hostNamed) m.hostResolved = true;            // it has a name; keep it
    else {
      if (!m.hostOpen) openHostDialog(m);
      return;
    }
  }
  if (m.hostOpen) return;     // user still in the hostname dialog
  // 3. Then the network — from a remembered one the device's scan saw, else the
  //    dialog.
  if (m.wifiNeeded && !m.wifiResolved) {
    const known = storedWifiInRange(m);
    if (known) {
      m.wifiCfg = { ssid: known.ssid, pass: known.pass };
      m.wifiResolved = true;
      note(m, `\x1b[90m-- using the stored network "${known.ssid}" --\x1b[0m`);
    } else {
      if (!m.wifiOpen) openConnectDialog(m);
      return;
    }
  }
  if (m.wifiOpen) return;     // user still in the wifi dialog
  // 4. The two questions the boot log can't raise. Wait until the wifi need is
  //    settled first: the probe costs a round trip and the answer doesn't change
  //    while the earlier dialogs are up.
  if (!m.wifiNeeded && !m.connectedSeen) return;   // wifi need still undetermined
  if (!m.extrasProbed) { probeExtras(m); return; } // async; re-enters here
  // 5. The radio, then the name on the mesh.
  if (m.loraNeeded && !m.loraResolved) {
    if (!m.loraOpen) openLoraDialog(m);
    return;
  }
  if (m.loraOpen) return;
  if (m.lxmfNeeded && !m.lxmfResolved) {
    if (!m.lxmfOpen) openLxmfDialog(m);
    return;
  }
  if (m.lxmfOpen) return;
  // 6. Everything settled — send whatever was actually chosen.
  if (!m.newPasswd && !m.newHostname && !m.wifiCfg && !m.loraCfg && !m.lxmfName) return;
  sendSetup(m);
}

// ── device password dialog ───────────────────────────────────────────────────
function openPasswdDialog(m) {
  m.passwdOpen = true;
  $('pw-1').value = '';
  $('pw-2').value = '';
  $('pw-msg').textContent = '';
  $('pw-msg').className = 'pw-msg';
  if ($('pw-remember')) $('pw-remember').checked = false;
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

// The dialog is two fields and a return: Enter on the password moves to the
// retype (as Tab does — Suggest is out of the tab order), Enter on the retype is
// the button. Nothing here has to be clicked.
on('pw-1', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('pw-2').focus(); } });
on('pw-2', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('pw-ok').click(); } });

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
  if ($('pw-remember') && $('pw-remember').checked) rememberNodePassword(p1);
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

// Served from localhost, the button aims at THIS page's own origin — same
// scheme, same port, `/?host=<address>&port=443` — instead of at the device. A
// page on localhost is being served by something already on this machine that
// can reach the device itself, so the device's address is a parameter for it to
// act on rather than somewhere the browser navigates: the tab never leaves
// localhost, and the Local Network Permissions and self-signed-certificate
// prompts that a direct navigation runs into do not arise. Anywhere else the
// device is the only thing that can serve its own UI, so the tab goes there.
const servedFromLocalhost = ['localhost', '127.0.0.1', '[::1]']
  .includes(location.hostname);

function uiUrl(target) {
  const addr = target === 'ip' ? deviceUiIp : `${deviceUiHost}.local`;
  return servedFromLocalhost
    ? `${location.origin}/?host=${encodeURIComponent(addr)}&port=443`
    : `https://${addr}/`;
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
  // (m.wifiCfg = the credentials this session provisioned, typed or remembered).
  // A device that auto-joined a network it was already provisioned for just gets
  // the button.
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

// Force-dismiss every modal dialog. The floating action buttons (Detect
// Hardware / Open Device UI / Reset) sit above the overlay and call this, so one
// click both fires the action AND clears whatever dialog was up — no separate
// dismiss click. Setup-input dialogs (password / hostname / wifi), if open, are marked
// settled so the setup coordinator neither re-opens them nor stalls waiting on
// them.
function closeDialogs(m) {
  $('info-overlay').hidden = true;
  $('stuck-overlay').hidden = true;
  closeDeviceBox();
  closeUiChoice();
  cancelStateWarn();       // an unanswered warning means: don't flash
  closeSetupDialogs(m);
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
    // The pick re-establishes identity: whatever the new port's attach banner
    // said is the pairing now — even when the pick landed on a different board.
    pairedUnit = chosen.unitId;
    committed = chosen;
    focusTerm(outgoing.term);
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
    port = await SERIAL.requestPort({ filters: [CDC_FILTER] });
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
        markTitleGone(false);
        // Whichever of the tab's ports answered is now the active one. That is
        // how a console move completes without a dialog once both transports
        // have been picked: the CDC port this tab already owns turns up, and
        // the session simply follows it.
        pinnedPort = p;
        note(monitor, `\x1b[32m-- ${portLabel(p)} came back --\x1b[0m`);
        focusTerm(monitor.term);
        refreshFlashOffer();   // the board is reachable again — re-evaluate the offer
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
// SerialPort object; this loop does not go looking for it — the
// returning-boards machinery (below) handles that arrival, and only ever on
// the device's own proof of identity.
//
// **This loop never raises a dialog, and never gives up.** Ports go away
// constantly — every reset, every reflash — and come straight back, so a
// departure is not evidence of anything and a modal on one would be wrong far
// more often than right. Nor is a long silence: a board can sit unpowered for an
// afternoon and be the same board when it returns. So the loop simply keeps the
// port and its grant and waits, however long that takes, saying nothing. A board
// that comes back as a fresh object is adopted once it identifies itself, or is
// Re-select port in the settings panel, which is on screen the whole time and
// needs no prompting. The only thing that says a port is gone *for good* is the
// device announcing a transport switch, and those two paths
// (offerConsoleHandover / offerConsoleReturn) own the ask.
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
function scheduleRescan() {
  if (rescanTimer) return;
  let announced = false;
  let sweptOnce = false;
  let ticks = 0;
  let rotate = 0;
  rescanTimer = setInterval(async () => {
    if (!monitor || (!monitor.gone && monitor.reader)) {   // recovered or torn down
      clearInterval(rescanTimer);
      rescanTimer = null;
      reconnectAsked = false;
      $('reconnect-overlay').hidden = true;
      return;
    }
    if (monitor.reattaching) return;          // a reclaim is already running
    // A console move is opening one of these ports itself; stay off it rather
    // than race for the handle. Same for an adoption probe committing its port.
    if (adopting || negotiating) return;
    ticks++;
    // Present and openable is the common case and resolves in the first second
    // or two. Past that the device is off the bus, and polling it hard buys
    // nothing — back off, but never stop: a board that comes back on the same
    // object is still picked up for free, however long it took.
    if (ticks > 20 && (ticks % 6)) return;
    const live = pickedPorts.filter((x) => x.connected !== false);
    // Nothing picked to follow. A returning port may be queued already (its
    // connect event can land before the disconnect that frees the session to
    // act on it) — and one may never have raised an event at all, so the
    // granted ports are swept for candidates too. The grant is the boundary: a
    // port the browser quietly un-granted is absent from getPorts(), invisible
    // to this sweep and to every event, and only a pick can bring it back.
    if (!live.length) {
      try {
        const granted = await SERIAL.getPorts();
        if (!sweptOnce) {
          sweptOnce = true;
          console.debug(`adopt: no picked port present; granted ports: [${granted.map(portUsbKey).join(', ')}]`);
        }
        for (const p of granted) if (!strayBaseline.has(p)) considerStray(p);
      } catch (_) { /* */ }
      maybeAdoptStray();
      return;
    }
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
  repicking = true;             // the person's pick outranks the adoption probes
  try {
    let port;
    try {
      port = await SERIAL.requestPort();
    } catch (_) {
      if (putBack) putBack();   // dismissed — this was answering a gesture
      return;
    }
    // An in-flight probe may hold the very port just picked; it stands down at
    // its next check — wait that out (bounded) rather than racing it for the
    // handle and losing all eight open attempts.
    for (let i = 0; i < 40 && (negotiating || probeHeld.has(port)); i++) await sleep(250);
    pairedUnit = null;    // identity is re-learned off the wire after every pick
    strayArrivals = [];   // …and arrivals queued for the old pairing are moot
    pinPort(port);
    await reclaimPort(port);
  } finally {
    repicking = false;
  }
}

$('reconnect-pick').addEventListener('click', () => {
  $('reconnect-overlay').hidden = true;
  repickPort(() => { $('reconnect-overlay').hidden = false; });
});

// The non-modal way back: always on screen in the settings panel, for the one
// case the rescan can't solve — a board that returned as a different port object.
on('monitor-repick', 'click', () => { closeSettings(); repickPort(null); });

// ── the node roster ─────────────────────────────────────────────────────────
// Every node this origin has ever identified, by dev id: its hostname, the USB
// identities its transports wear, and when it was last seen. localStorage, so
// it is origin-wide and outlives sessions — it is what lets the startup lobby
// greet a returning board by name instead of a chooser row. A convenience
// only: identity is never TRUSTED from here (grants have no page-visible
// identity, and the greeting is the proof); the roster just says what is worth
// probing and what to call it while the probe is out.
const ROSTER_KEY = 'flashmon-nodes';
function rosterLoad() {
  try {
    const r = JSON.parse(localStorage.getItem(ROSTER_KEY));
    return r && typeof r === 'object' ? r : {};
  } catch (_) { return {}; }
}
function rosterNote(devId, host, key) {
  if (!devId) return;
  try {
    const r = rosterLoad();
    const n = r[devId] || (r[devId] = { keys: [] });
    if (host) n.host = host;
    // At most two transports per node — USB-Serial-JTAG and the CDC composite;
    // a third identity is a replacement, so the oldest goes (pickedPorts' rule).
    if (key && !n.keys.includes(key)) {
      n.keys.push(key);
      while (n.keys.length > 2) n.keys.shift();
    }
    n.seen = Date.now();
    localStorage.setItem(ROSTER_KEY, JSON.stringify(r));
  } catch (_) { /* storage unavailable — the lobby just has less to offer */ }
}

// ── who is holding what ─────────────────────────────────────────────────────
// A tab with a live console says so: every couple of seconds it stamps its
// paired dev id in localStorage, and drops the entry when it lets go. Other
// tabs read the stamps to call a node busy without touching its port — a fresh
// stamp is a held console, a stale one is a tab that crashed, whose port is
// fair game again. The ticks are worker-held for the same reason the FNB58
// keep-alive's are: a hidden tab is throttled, and its stamp going stale while
// it is still streaming would read as an idle device.
const HELD_KEY = 'flashmon-held';
const HELD_FRESH_MS = 6000;
function heldLoad() {
  try {
    const r = JSON.parse(localStorage.getItem(HELD_KEY));
    return r && typeof r === 'object' ? r : {};
  } catch (_) { return {}; }
}
function heldStamp() {
  try {
    const r = heldLoad();
    let dirty = false;
    for (const [id, e] of Object.entries(r)) {
      const mine = e.tab === TAB_ID;
      const stale = !e.t || Date.now() - e.t > 60000;   // long dead either way
      if (stale || (mine && (!monitor || monitor.gone || pairedUnit !== id))) {
        delete r[id];
        dirty = true;
      }
    }
    if (monitor && !monitor.gone && pairedUnit) {
      r[pairedUnit] = { t: Date.now(), tab: TAB_ID };
      dirty = true;
    }
    if (dirty) localStorage.setItem(HELD_KEY, JSON.stringify(r));
  } catch (_) { /* storage unavailable — probing still tells busy from free */ }
}
function heldByOther(devId) {
  const e = heldLoad()[devId];
  return !!e && e.tab !== TAB_ID && Date.now() - e.t < HELD_FRESH_MS;
}
wtSetInterval(heldStamp, 2000);
window.addEventListener('beforeunload', () => {
  try {
    const r = heldLoad();
    let dirty = false;
    for (const [id, e] of Object.entries(r)) {
      if (e.tab === TAB_ID) { delete r[id]; dirty = true; }
    }
    if (dirty) localStorage.setItem(HELD_KEY, JSON.stringify(r));
  } catch (_) { /* the 60 s staleness sweep covers a cut-short unload */ }
});

// ── returning boards ────────────────────────────────────────────────────────
// A board that re-enumerates — an unplug, a `usb down`, a long power loss —
// comes back as a fresh SerialPort object: object identity is lost, and with
// it the rescan's whole candidate list. When the browser kept the grant (it
// does for these boards, whose USB descriptors carry a unique serial number),
// the port turns up in a `connect` event wearing only its vendor/product ids —
// which every identical board on the desk shares. So a returning port is never
// adopted on arrival. It is adopted on PROOF: open it, poke it, and let the
// firmware's greeting say which physical unit answered (`dev a1b2c3`, the
// field the parser feeds into `pairedUnit`). A match is this tab's board back;
// a mismatch is closed again, untouched beyond the one carriage return — which
// a spangap console answers and ignores, and which is the only thing ever
// written before identity is known. A port another tab holds open cannot even
// be probed: open() is exclusive browser-wide and fails, and that exclusivity
// — not the negotiation below — is what makes a steal impossible.
//
// Tabs on this origin coordinate the ORDER of their probes over a
// BroadcastChannel, because every tab receives every connect event (grants are
// origin-scoped, not tab-scoped) and unordered probes would race open() for
// the same port, burning attempts. The tab that lost its port most recently
// goes first. Recency is only an ordering heuristic; correctness comes from
// the identity check.
let pairedUnit = null;    // `device` id of the board this tab is paired with;
                          // cleared on every chooser pick, re-learned off the wire
let lostPortAt = 0;       // when the pinned port left the bus
let strayArrivals = [];   // matching arrivals that are not (yet) this tab's
let negotiating = false;  // an adoption probe, or its wait for a turn, is running
// Two budgets per port object, because the two failures mean different things:
// a port that OPENED and said nothing three times is not going to answer, while
// a port that will not open is usually just early — the OS still building the
// device node — and deserves the same patience reclaimPort shows, bounded so a
// port another tab holds is not pestered forever.
let probeSilent = new WeakMap();
let probeNoOpen = new WeakMap();
const PROBE_SILENT_MAX = 3;
const PROBE_NOOPEN_MAX = 10;
// A port whose budget ran out is done for good: the sweep re-encounters the
// same object every 800 ms, and without a terminal state each encounter would
// re-queue it and re-print its epitaph. (A 'mismatch' from another tab lifts
// this — that tab just released a port, so the story may have changed.)
let probeGaveUp = new WeakSet();
// A person is at the chooser. Their pick outranks any probe: nothing new is
// probed, and the running probe's open-retry loop stands down at its next check.
let repicking = false;
// Ports already listed when this tab lost its own are not "returning" — they
// are other boards that were on the desk all along, and probing them is noise
// at best. Snapshotted at each loss; only the getPorts() sweep consults it. A
// connect event is an arrival by definition and clears membership.
let strayBaseline = new WeakSet();
function snapshotStrayBaseline() {
  strayBaseline = new WeakSet();
  try {
    SERIAL.getPorts().then((ports) => { for (const q of ports) strayBaseline.add(q); }).catch(() => {});
  } catch (_) { /* */ }
}

const TAB_ID = Math.random().toString(36).slice(2);
let claimChannel = null;
try { claimChannel = new BroadcastChannel('flashmon-port-claims'); } catch (_) { /* no peers */ }
// Rival claims gathered while negotiating: tab id → that tab's lostPortAt.
let rivalClaims = new Map();
let negotiatingKey = null;
if (claimChannel) claimChannel.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.tab === TAB_ID) return;
  if (msg.type === 'claim' && msg.key === negotiatingKey) {
    rivalClaims.set(msg.tab, msg.lostAt || 0);
    // Answer while negotiating, so a tab whose claim window opened later than
    // ours still ranks us — a bare claim only reaches windows already open.
    if (negotiating) {
      claimChannel.postMessage({ type: 'claim-echo', key: negotiatingKey, tab: TAB_ID, lostAt: lostPortAt });
    }
  }
  if (msg.type === 'claim-echo' && msg.key === negotiatingKey) {
    rivalClaims.set(msg.tab, msg.lostAt || 0);
  }
  // Another tab probed a port and found it was not theirs. It may be ours — and
  // any budget this tab spent failing open() against that probe deserves a redo.
  if (msg.type === 'mismatch') {
    probeSilent = new WeakMap();
    probeNoOpen = new WeakMap();
    probeGaveUp = new WeakSet();
    maybeAdoptStray();
  }
};

const portUsbKey = (p) => {
  const i = p && p.getInfo ? p.getInfo() : {};
  return i.usbVendorId == null ? null : `${i.usbVendorId}:${i.usbProductId}`;
};

// A stranger is worth probing only when it wears the identity of a port this
// tab was actually given, and only when this tab knows who its board is:
// without a pairedUnit there is nothing to verify against, and unverified
// adoption is the traded-consoles bug by construction. Declines are said in
// the console (not the terminal — most of them are other boards on the desk,
// none of this tab's business), so a return that goes nowhere is diagnosable.
const strayLogged = new WeakSet();   // one console line per port object, not per sighting
function considerStray(p) {
  if (!monitor || isOurs(p) || strayArrivals.includes(p) || probeGaveUp.has(p)) return;
  const key = portUsbKey(p);
  if (!pairedUnit) {
    if (!strayLogged.has(p)) { strayLogged.add(p); console.debug(`adopt: ${key} declined — no device id was ever learned from this tab's board`); }
    return;
  }
  if (!key || !pickedPorts.some((x) => portUsbKey(x) === key)) {
    if (!strayLogged.has(p)) { strayLogged.add(p); console.debug(`adopt: ${key} declined — matches no port this tab was given`); }
    return;
  }
  strayArrivals.push(p);
  while (strayArrivals.length > 4) strayArrivals.shift();
  console.debug(`adopt: ${key} queued (paired unit ${pairedUnit})`);
  maybeAdoptStray();
}

// Wait for this tab's turn at the returning port. Every tab that wants one
// posts its bereavement time; the most recent loss probes first, and each
// earlier loss waits long enough for the tabs ahead of it to finish a probe.
// Ties break on tab id, so two tabs never take the same slot.
async function claimTurn(key) {
  if (!claimChannel) return;
  negotiatingKey = key;
  rivalClaims = new Map();
  claimChannel.postMessage({ type: 'claim', key, tab: TAB_ID, lostAt: lostPortAt });
  await sleep(250);
  const ahead = [...rivalClaims.entries()].filter(([tab, at]) =>
    at > lostPortAt || (at === lostPortAt && tab > TAB_ID)).length;
  if (ahead) await sleep(ahead * 3500);
}

// Open the port, ask with one CR, and read until the firmware names the unit.
// Outcomes: `{status:'id', id, host}` — the firmware named itself (host absent
// when only a boot log's bare `dev` line was seen); `{status:'silent'}` —
// opened, poked, nothing identifiable came; `{status:'no-open'}` — the open
// failed every attempt, because the OS is still building the device node or
// another tab holds the port. The port ends closed in every case. The open
// gets the same patient retries as reclaimPort — a port rarely accepts an open
// the instant it appears — re-checking `alive()` between attempts, which is
// the caller's "this probe still serves a purpose": the adoption path passes
// its bereft-session test, the startup lobby its still-on-screen test.
// An await that is not allowed to wedge the probe: settle in `ms` or move on.
// The probe runs unattended in a loop, so any of its teardown awaits hanging —
// close() on a vanished port is the known one — would stick `negotiating` and
// with it every recovery path, including a user's own re-pick.
const settled = (x, ms) => Promise.race([Promise.resolve(x).catch(() => {}), sleep(ms)]);

// Ports an identity probe currently holds open. A user's own connect must not
// race a probe for the handle and lose (a chooser pick or a lobby row click
// landing while a probe is mid-read would fail its open) — callers that open a
// port for a person first wait, bounded, for the probe to let go.
const probeHeld = new Set();

async function probeUnitId(p, cfg, alive) {
  let opened = false;
  let openErr = null;
  for (let attempt = 0; attempt < 8 && !opened; attempt++) {
    if (!alive() || p.connected === false) return { status: 'no-open' };
    try { await p.open(cfg); opened = true; } catch (e) { openErr = e; await sleep(300); }
  }
  if (!opened) {
    console.debug(`adopt: ${portUsbKey(p)} would not open`, openErr);
    return { status: 'no-open' };
  }
  probeHeld.add(p);
  let id = null;
  const reader = p.readable.getReader();
  const writer = p.writable.getWriter();
  // A device mid-boot answers late, and one fresh on the bus may still be
  // settling (or being sniffed by the OS), so the ask is repeated a couple of
  // times across a ~4 s window before the read is cancelled — an unanswered
  // read never settles on its own. Every CR that went out is counted: each one
  // the firmware reads costs one greeting, and the count is what the cleanup
  // below consumes by.
  let crs = 0;
  const cr = () => { crs++; writer.write(new Uint8Array([0x0d])).catch(() => {}); };
  const repoke1 = setTimeout(cr, 1300);
  const repoke2 = setTimeout(cr, 2600);
  const stop = setTimeout(() => { reader.cancel().catch(() => {}); }, 4000);
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  let text = '';
  try {
    cr();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      // The unit id field: `dev f9fb74` — leading the greeting a console
      // answers a CR with, and standing alone in a boot log.
      const mm = stripAnsi(text).match(/\bdev ([0-9a-f]{6})(?![0-9a-f])/);
      if (mm) { id = mm[1]; break; }
      if (text.length > 8192) text = text.slice(-2048);
    }
    if (id) {
      // The question is answered — no further asks, so the cleanup below has a
      // fixed count to consume to.
      clearTimeout(repoke1);
      clearTimeout(repoke2);
      // Consume what the probe caused — and nothing else — before closing.
      // Bytes left unread stay in the transport's buffer and come back as
      // backlog when the reclaim reopens this port, so the surplus greetings
      // this probe's CRs earned would print above the real one. Each greeting
      // ends in a known line, so read until as many of those terminators have
      // passed as CRs went out. A hush is no yardstick here: a console logging
      // continuously never goes quiet — and its log lines are not ours to eat,
      // so anything real behind our greetings reappears as ordinary backlog
      // for the session that reclaims the port. Deadline-capped: a CR the
      // firmware never got to read has no greeting to wait for.
      const cap = setTimeout(() => { reader.cancel().catch(() => {}); }, 1500);
      try {
        for (;;) {
          const seen = (stripAnsi(text).match(/Start typing to enter CLI/g) || []).length;
          if (seen >= crs) break;
          const { value, done } = await reader.read();
          if (done) break;
          text += dec.decode(value, { stream: true });
        }
      } finally {
        clearTimeout(cap);
      }
    }
  } catch (_) { /* the device left mid-probe; id stays null */ }
  clearTimeout(repoke1);
  clearTimeout(repoke2);
  clearTimeout(stop);
  await settled(reader.cancel(), 1500);
  try { reader.releaseLock(); } catch (_) { /* */ }
  await settled(writer.abort(), 1500);
  try { writer.releaseLock(); } catch (_) { /* */ }
  // Like detachStreams: only close a port that still has a device behind it —
  // close() on a vanished port is a known Web Serial hang spot. Bounded anyway.
  if (p.connected !== false) await settled(p.close(), 3000);
  probeHeld.delete(p);
  if (id) {
    // The greeting's host field, if the drain captured it — the id match fires
    // on the line's first field, so the hostname is read off the full text
    // afterwards rather than raced for.
    const g = stripAnsi(text).match(new RegExp(`\\bdev ${id}, host ([^\\s,]+)`));
    return { status: 'id', id, host: g ? g[1] : undefined };
  }
  // A device that left mid-probe did not decline to answer — it was gone. Let
  // the arrival filters retire the object without burning the silence budget.
  return p.connected === false ? { status: 'no-open' } : { status: 'silent' };
}

// Probe the queued stranger, if the session is actually bereft and nothing else
// is driving a port. One probe per call, budgeted per port object, so a port
// that turns out to be someone else's is not pestered forever.
// Retire a port from the adoption machinery for good, with its epitaph said
// once — in the console, not the terminal: the terminal narrates only what the
// session actually did (`gone`, `came back`), and the probes' comings and
// goings are diagnostics. The object stays in probeGaveUp, so re-encounters
// (the sweep sees it every tick) stay silent.
function retireStray(p, epitaph) {
  probeGaveUp.add(p);
  strayArrivals = strayArrivals.filter((x) => x !== p);
  if (epitaph) console.debug(`adopt: ${portUsbKey(p)} retired — ${epitaph}`);
}

async function maybeAdoptStray() {
  if (negotiating || adopting || repicking) return;
  if (!monitor || !(monitor.gone || !monitor.reader) || monitor.reattaching) return;
  strayArrivals = strayArrivals.filter((p) => p.connected !== false && !isOurs(p));
  const p = strayArrivals[0];
  if (!p) return;
  negotiating = true;
  try {
    if (!probeSilent.has(p) && !probeNoOpen.has(p)) {
      console.debug(`adopt: ${portUsbKey(p)} probing — asking it to identify itself`);
    }
    await claimTurn(portUsbKey(p));
    // The wait was long; re-check the ground the probe stands on.
    if (!monitor || !(monitor.gone || !monitor.reader) || monitor.reattaching || adopting || repicking) return;
    if (p.connected === false) return;
    const r = await probeUnitId(p, monitor.cfg,
      () => !!monitor && (monitor.gone || !monitor.reader) && !repicking);
    if (r.status === 'no-open') {
      const rounds = (probeNoOpen.get(p) || 0) + 1;
      probeNoOpen.set(p, rounds);
      // No epitaph for a port that is no longer on the bus — it did not decline,
      // it left (a bus still bouncing after re-enumeration does this), and its
      // successor object gets its own probes.
      if (p.connected === false) retireStray(p, null);
      else if (rounds >= PROBE_NOOPEN_MAX) {
        retireStray(p, 'would not open (held elsewhere, or the OS never finished the node)');
      }
      return;                                  // otherwise the rescan re-offers it next tick
    }
    if (r.status === 'silent') {
      const asked = (probeSilent.get(p) || 0) + 1;
      probeSilent.set(p, asked);
      if (asked >= PROBE_SILENT_MAX) {
        retireStray(p, 'never identified itself (no dev/device line in its answer)');
      }
      return;
    }
    if (r.id !== pairedUnit) {
      if (claimChannel) claimChannel.postMessage({ type: 'mismatch', tab: TAB_ID });
      retireStray(p, `is device ${r.id}, not this tab's ${pairedUnit}`);
      return;
    }
    // Proven: the tab's board, back on a fresh port object. Retire the dead
    // twin it replaces, take the port, and let the ordinary reclaim finish —
    // whose `came back` is the one line the terminal shows for all of this.
    strayArrivals = strayArrivals.filter((x) => x !== p);
    const key = portUsbKey(p);
    pickedPorts = pickedPorts.filter((x) => x.connected !== false || portUsbKey(x) !== key);
    console.debug(`adopt: ${key} answered as device ${r.id} — this tab's board; reclaiming`);
    rosterNote(r.id, r.host, key);
    pinPort(p);
    await reclaimPort(p);
  } finally {
    negotiating = false;
    negotiatingKey = null;
  }
}

// The tab's port leaving the bus: note it in the stream and tear the dead
// streams down. Nothing else on the desk is any of this tab's business — three
// boards mean three sets of these events, and only the one for our own port
// says anything about our session.
SERIAL.addEventListener('disconnect', (e) => {
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
  markTitleGone(true);       // the tab strip says so too
  lostPortAt = Date.now();   // ranks this tab first when the board returns re-enumerated
  snapshotStrayBaseline();   // what is on the bus NOW was not "returning" later
  // Without a device id there is nothing a returning re-enumerated port could
  // be verified against, so adoption is off the table for this board — said in
  // the console once, because from the outside it looks identical to a working
  // setup.
  if (!pairedUnit && !monitor.noIdWarned) {
    monitor.noIdWarned = true;
    console.debug('adopt: this board announced no device id; if its port re-enumerates it will need Re-select port');
  }
  hideOpenUi();            // the device is gone — drop its buttons
  pendingFlash = null;     // can't flash (or detect on) a gone device
  cancelStateWarn();       // …so a warning waiting on an answer is moot
  closeDeviceBox();        // …and an offer for a device that isn't there
  syncDetectButton();      // …and nothing to run a detection on
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

// The tab's own port arriving is reclaimed directly. Any other arrival is
// either another board on the desk — following it blind would be how two
// consoles trade places — or this tab's own board back under a fresh
// SerialPort object, which only the device itself can say: considerStray
// queues it for the verified-adoption path, which opens nothing on a guess.
SERIAL.addEventListener('connect', async (e) => {
  const p = e.port || e.target;
  if (!p) return;
  console.debug(`serial connect event: ${portUsbKey(p)} ${isOurs(p) ? '(a port this tab was given)' : '(stranger)'}`);
  strayBaseline.delete(p);   // it just arrived — that is what a return looks like
  if (!monitor) return;
  if (!isOurs(p)) { considerStray(p); return; }
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

// Populate the settings panel from what's in force (adding the baud as an option
// if a ?monitor_baud= or a stored rate isn't one of the presets).
function initSettingsControls() {
  const b = $('cfg-baud');
  if (b) {
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
  if ($('set-noreset')) $('set-noreset').checked = SETTINGS.noReset;
  if ($('set-autoflash')) $('set-autoflash').checked = SETTINGS.autoFlash;
  syncForgetButton();
  syncDetectButton();
  syncBuildSelector();
  showCfg(DEFAULT_CFG);
}

// ── the build selector ──────────────────────────────────────────────────────
// Which catalogue the page offers images from, as a select in the settings
// panel. Its options are what `builds/index.html` lists, plus the catalogue in
// force and the one the attached device says it was flashed from — either can be
// a catalogue the tree deliberately doesn't list, and a selector that couldn't
// show where you already are would be lying about the state of the page.
const BUILD_OTHER = ' other';       // no catalogue name can collide with it
let CATALOGUES = [];

function buildOptions() {
  const out = [...CATALOGUES];
  for (const extra of [CATALOGUE, monitor && monitor.deviceCatalogue]) {
    if (extra && !out.includes(extra)) out.push(extra);
  }
  return out;
}

// Rebuild the select from the options that apply right now and show the
// catalogue in force. Cheap and idempotent — every path that could change either
// calls it rather than reasoning about what moved.
function syncBuildSelector() {
  const sel = $('set-build');
  if (!sel) return;                            // page older than this script
  sel.textContent = '';
  for (const name of buildOptions()) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    sel.appendChild(o);
  }
  const other = document.createElement('option');
  other.value = BUILD_OTHER;
  other.textContent = '- other -';
  sel.appendChild(other);
  sel.value = CATALOGUE;
}

on('set-build', 'change', (e) => {
  const field = $('set-build-other');
  if (e.target.value === BUILD_OTHER) {
    // Name one the listing doesn't carry. The field replaces the choice rather
    // than accompanying it, so nothing switches until a name is actually given.
    if (field) { field.value = ''; field.hidden = false; field.focus(); }
    return;
  }
  if (field) field.hidden = true;
  setCatalogue(e.target.value, true);
});

// Enter or leaving the field commits it; leaving it empty is a change of mind,
// and puts the selector back on the catalogue that is still in force.
function commitOtherBuild() {
  const field = $('set-build-other');
  if (!field || field.hidden) return;
  const name = cleanCatalogue(field.value.trim());
  field.hidden = true;
  if (name) setCatalogue(name, true); else syncBuildSelector();
}
on('set-build-other', 'change', commitOtherBuild);
on('set-build-other', 'blur', commitOtherBuild);

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

// The two-letter esptool flags for the SPI-flash settings, which is how the
// argfile spells them: the long names differ between esptool 4 (`--flash_mode`)
// and esptool 5 (`--flash-mode`), while these have been the same since esptool 2.
const ESPTOOL_SHORT_FLAGS = { '-fm': 'flash_mode', '-ff': 'flash_freq', '-fs': 'flash_size' };

// An esptool argfile for write_flash: `-flag value` pairs, then one
// `<offset> <file>` pair per image. Returns the flags as flash settings (the
// names esptool-js wants) and the images as [offset, name] pairs in file order.
// Long flag names are read too, in either spelling, so a zip built before the
// switch to the short ones still parses.
//
//     -fm dio -ff 80m -fs 16MB
//     0x0 bootloader/bootloader.bin
//     0x10000 reticulous.bin
function parseEsptoolArgs(text) {
  const settings = {};
  const entries = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const tok = line.split(/\s+/);
    for (let i = 0; i < tok.length; i++) {
      if (ESPTOOL_SHORT_FLAGS[tok[i]]) {
        settings[ESPTOOL_SHORT_FLAGS[tok[i]]] = tok[i + 1] || '';
        i++;
      } else if (tok[i].startsWith('--')) {
        // A flag esptool takes without a value would swallow the next token;
        // the ones that appear here are all `--flag value`.
        settings[tok[i].replace(/^--/, '').replace(/-/g, '_')] = tok[i + 1] || '';
        i++;
      } else if (/^0x[0-9a-f]+$/i.test(tok[i]) && tok[i + 1]) {
        entries.push([tok[i], tok[i + 1]]);
        i++;
      }
    }
  }
  return { settings, entries };
}

async function unpackFlashPlan(zipURL) {
  const bytes = await fetchProgress(zipURL, (frac, got, total) => {
    dlProgress(frac, total ? `${fmtBytes(got)} of ${fmtBytes(total)}` : `${fmtBytes(got)} downloaded`);
  });
  dlProgress(1, `${fmtBytes(bytes.length)} downloaded — unpacking…`);
  const zip = await window.JSZip.loadAsync(bytes);

  // The image's own flashing instructions: an esptool argfile named for the
  // project that built it. Found by extension rather than by name — the project
  // names itself, and this side has no business knowing what it chose.
  const argsFile = zip.file(/\.esptool$/)[0];
  if (!argsFile) throw new Error('image zip has no .esptool argfile');
  const { settings, entries } = parseEsptoolArgs(await argsFile.async('string'));
  if (!entries.length) throw new Error(`${argsFile.name} lists no images`);

  // esptool-js (0.6.0) wants each image as a Uint8Array of raw bytes. Passing a
  // binary string makes pako's deflater UTF-8-encode any byte >= 0x80, so the
  // image inflates on-device past its declared size and the stub aborts with
  // ESP_TOO_MUCH_DATA (status 0xC9) partway through the largest image.
  const fileArray = [];
  for (const [offset, fname] of entries) {
    const f = zip.file(fname);
    if (!f) throw new Error(`image "${fname}" missing from the zip`);
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
    await gatherChipInfo(esploader, romConnectMode());
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
    // Leave the boot path alone before letting go: the RAM detector may have set
    // force-download-boot to hand the ROM back for exactly this flash, and a
    // device that keeps the flag boots into the loader forever rather than into
    // the image just written.
    await clearForceDownloadBoot(esploader);
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
    const name = port.usbName || usbDeviceName(port);
    // Which interface and endpoints the bytes are actually on, where the page
    // chose them itself rather than being handed a port by the operating system.
    // A console that answers nothing is either a device with nothing to say or a
    // page talking to the wrong pipe, and only this tells those apart.
    const e = port.usbEndpoints;
    const eps = e ? ` — CDC iface ${e.iface}, in EP${e.in}, out EP${e.out}` : '';
    return `USB ${h(i.usbVendorId)}:${h(i.usbProductId)}${name ? ` — ${name}` : ''}${eps}`;
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
  $('device-sub').textContent = !f.probed
    ? `Identified as ${f.hw} from its own boot log — the chip has not been probed.`
    : f.hw
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
  // Only a detection run reads these off the chip. Without one there is nothing
  // to say about them — which is not the same as "none found", so they are left
  // out rather than reported empty.
  if (f.probed) {
    factRow(dl, 'Chip', f.chip.join('\n'));
    factRow(dl, 'Peripherals', f.periph.length ? f.periph.join('\n') : 'none reported');
    factRow(dl, 'Stored data', f.state
      ? `state partition at 0x${f.state.addr.toString(16)}, ${fmtBytes(f.state.size)}`
      : 'no state partition on this chip yet');
  }
  const m = monitor;
  factRow(dl, 'Firmware', m && m.deviceVersion
    ? `${PROJECT} ${m.deviceCatalogue || CATALOGUE} build ${fmtStamp(m.deviceVersion)}`
    : 'no build stamp reported (older firmware, or still booting)');
  let catalogue;
  if (!f.hw) catalogue = 'no board identified, so nothing to match against';
  else if (pendingFlash) catalogue = `${CATALOGUE} build ${fmtStamp(pendingFlash.stamp)}`
    + (pendingFlash.newer ? ' — newer than what runs here' : '');
  else if (m && m.versionSettled) catalogue = `nothing published for this board in ${CATALOGUE}`;
  else catalogue = 'checking the catalogue…';
  factRow(dl, 'Catalogue', catalogue);
  renderFlashOffer();
}

function showDeviceBox(facts) {
  deviceFacts = facts;
  renderDeviceBox();
  if ($('device-overlay')) $('device-overlay').hidden = false;
}

function deviceBoxOpen() { return !!$('device-overlay') && !$('device-overlay').hidden; }

function closeDeviceBox() { if ($('device-overlay')) $('device-overlay').hidden = true; }

on('device-ok', 'click', closeDeviceBox);
// Clicking the dimmed backdrop dismisses it too — but not a click inside the
// box, where the fact list is there to be selected and copied.
on('device-overlay', 'click', (e) => {
  if (e.target === $('device-overlay')) closeDeviceBox();
});
on('flash-go', 'click', () => { closeDeviceBox(); runPendingFlash(); });

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

// The URL of the newest published image for `name`, or null if the listing
// doesn't have one. No HEAD probe: the listing is generated from the directory
// it lists, so what it names is what is there.
function findBuildUrl(name) {
  const ver = VERSIONS[name];
  return ver ? `${CAT_BASE}${SLUG}_${name}_${ver}.zip` : null;
}

// Is the published image for `name` newer than what's running? Both stamps are
// YYYYMMDDhhmmss, which sorts lexicographically. An unknown device stamp (old
// firmware, or a non-catalogue image) counts as newer: there is nothing to be
// no-newer than. Comparing across catalogues is meaningless, so a device that
// names a different catalogue than the one selected reads the same way — the
// stamps come from two unrelated series.
function catalogueNewer(name, m) {
  const cv = VERSIONS[name] || '';
  if (!cv || !m || !m.deviceVersion) return true;
  if (m.deviceCatalogue && m.deviceCatalogue !== CATALOGUE) return true;
  return cv > m.deviceVersion;
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

// Resolve the identified board to the best available image, and offer it.
// Reactive: re-run whenever the board, the device's build stamp, or the
// catalogue changes. A board-specific image names the device in the offer; the
// generic fallback says so.
//
// The catalogue's image is offered whether or not it is newer — an image that is
// already running, or older than what is, is a re-flash you may well want (a
// device that came back wrong, a switch to another catalogue). What changes is
// how it is put: `newer` drives the wording and the button, so a downgrade can
// never be taken for an upgrade.
//
// Nothing can be resolved until the board is known — until then there is no
// offer, and "Detect hardware" in the settings panel is what makes one possible.
async function resolveFlashOffer() {
  const m = monitor;
  pendingFlash = null;
  syncDetectButton();
  if (!m || !m.hw) return;
  // Hold off until the device's stamp has had a chance to arrive, so a current
  // device isn't offered a pointless re-flash on the way to knowing better.
  if (!m.versionSettled && m.deviceVersion === null) return;
  for (const name of buildCandidates(m.hw)) {
    const url = findBuildUrl(name);
    if (!url) continue;
    const device = m.hw.replace(/^hw-/, '');
    const label = name === 'generic'
      ? `Flash ${PROJECT} (generic build)`
      : `Flash ${PROJECT} to ${device}`;
    pendingFlash = { url, name, label, stamp: VERSIONS[name] || '', newer: catalogueNewer(name, m) };
    maybeAutoFlash();
    offerFlash();
    return;
  }
  // Nothing published for this board any more. An open window is left up — the
  // caller repaints it, and it drops back to the facts and an OK.
}

// With auto-flash on, an offer is the whole trigger — the run starts itself the
// moment one resolves. Only for an image that is actually newer: auto-flash is
// there to keep a board on the bench current, never to re-write what it already
// runs or to walk it backwards. Once per image: `url` carries the stamp, so a
// rebuild starts a new run while a failed or declined one doesn't loop. A run
// already in flight (or a device the port isn't ours to take) is left alone.
let autoFlashed = null;
function maybeAutoFlash() {
  if (!SETTINGS.autoFlash || !pendingFlash || !pendingFlash.newer || detecting) return;
  if (autoFlashed === pendingFlash.url) return;
  autoFlashed = pendingFlash.url;
  offerShownFor = pendingFlash.url;      // it is being flashed, not offered
  log(`Auto-flash: ${pendingFlash.label}`);
  runPendingFlash();
}

// ── the flash offer ─────────────────────────────────────────────────────────
// The offer lives in the device window, under the facts it follows from: what
// the board is, what it runs, what the catalogue holds. Those facts are the
// decision, so putting the button anywhere else would mean stating them twice.
//
// Two halves: renderFlashOffer paints the offer into an open window, and
// offerFlash decides when that window should be up for it — once per published
// image, so a connect that settles opens it, a build published while the page
// is open opens it again, and a re-render of the same offer doesn't.

// The offer's part of the device window: the warning (only when the image is not
// an upgrade) and the button that goes ahead. Called from renderDeviceBox, so it
// is repainted every time a fact lands.
function renderFlashOffer() {
  const f = pendingFlash;
  const m = monitor;
  const go = $('flash-go');
  const warn = $('flash-warn');
  if (!go || !warn) return;                   // page older than this script
  go.hidden = !f;
  warn.hidden = !f || f.newer;
  $('device-ok').textContent = f ? 'Not now' : 'OK';
  $('device-ok').className = f ? 'btn-ghost' : 'btn-primary';
  if (!f) return;
  // A device that reports no stamp is not being told this is an upgrade — there
  // is nothing to compare — so it gets the plain green button and no warning.
  if (!f.newer) {
    warn.textContent = f.stamp && m && m.deviceVersion && f.stamp < m.deviceVersion
      ? 'The published image is OLDER than the firmware on the device. Flashing it takes '
        + 'the device back to that build.'
      : 'This is the build the device already runs. Flashing writes the same image again.';
  }
  go.textContent = f.newer ? f.label : 'Flash anyway';
  go.className = f.newer ? 'btn-primary' : 'btn-warn';
}

// Put the device window up for an offer that hasn't been shown yet. With the
// window already open (a detection run just ended) the render alone is enough —
// the button appears under the facts the user is reading. With nothing on
// screen, the facts the boot log gave us are the window's contents.
function offerFlash() {
  const f = pendingFlash;
  const m = monitor;
  if (!f || !m || detecting || !$('device-overlay')) return;
  // Already open: the caller's repaint puts the button under the facts being
  // read, and the offer counts as shown without anything moving on screen.
  if (deviceBoxOpen()) { offerShownFor = f.url; return; }
  if (offerShownFor === f.url) return;
  offerShownFor = f.url;
  // An image that is not an upgrade is not worth a dialog — the fact fits in a
  // moment's toast, and the device window (with its Flash anyway) stays one
  // click away for the re-flash that is actually meant.
  if (!f.newer) { toast('You have the latest firmware.'); return; }
  showDeviceBox(deviceFacts && deviceFacts.hw === m.hw ? deviceFacts : {
    usb: usbInfoLine(m.port), chip: [], periph: [], hw: m.hw, state: statePart, probed: false,
  });
}

// A moment's notice: no buttons, gone on its own in 1.5 s or on a click.
// Built here rather than in the markup, so a cached page older than this
// script still shows it.
let toastEl = null;
let toastTimer = null;
function toast(text) {
  if (!toastEl) {
    ownStyles();
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    toastEl.addEventListener('click', () => { clearTimeout(toastTimer); toastEl.hidden = true; });
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1500);
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
  const { url, name } = pendingFlash;
  const port = m.port;
  const hw = m.hw;                            // carry the board across the re-open
  const hwDetected = m.hwDetected;            // …and how we came to know it
  const host = m.hostname;                    // …and whose board the flash screen names
  // Decided here, before the write, from the catalogue's own account of the
  // image: what comes back up owns its setup, so this page steps out of it for
  // the rest of the session. A later re-flash of a flasher-onboarded image
  // hands it back.
  deviceOnboards = imageOnboardsItself(name);
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
    // The tab and the header both say what is happening: 🔥 "<host> -
    // flashing" up top, the header down to "Flashing <project>" with the
    // image's name under it. The monitor re-open at the end resets both.
    setMonTitle(host);                          // closeMonitor cleared it
    markTitleFlashing(decodeURIComponent(url.split('/').pop() || '').replace(/\.zip$/, ''));
    $('monitor').hidden = true;                 // reveal the intro screen behind it
    try {
      let banner = await flash(port, plan);
      const usb = usbInfoLine(port);
      if (usb) banner = [usb, ...(banner || [])];
      // Reset into the freshly-flashed firmware. A board with no reset line gets
      // there by watchdog instead of by RTS, which is a restart all the same —
      // but it may re-enumerate under a different USB identity on the way, and
      // then the port this page holds is gone and the monitor cannot follow.
      if (noResetLine) {
        const ok = await restartFromRom(port);
        banner = [...(banner || []), '',
                  ok ? 'Restarted the device with the RTC watchdog (no reset line on this board).'
                     : 'Could not restart the device from here — press RESET to start the firmware.',
                  ok ? 'If the port does not come back, it re-enumerated: connect again to watch it.' : ''];
      }
      await openMonitor(port, !noResetLine, banner);
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

// ── hardware detection ──────────────────────────────────────────────────────
// Identify the board on demand, from the settings panel. Probing needs the
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
  closeSettings();                          // it was pressed in the panel; get it out of the way
  syncDetectButton();
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
    // A port that cannot be reset takes the whole run through the loader a human
    // already put the chip in — no reset anywhere, and no stub, which is what
    // romInfoNoReset() exists for. Every other port keeps the path it always
    // had: reset into the ROM, probe with the stub, reset out again.
    noResetLine = !portCanReset(port);
    if (noResetLine) {
      $('intro-hint').textContent = 'No reset line on this port — probing the bootloader…';
      info = await romInfoNoReset(port);
    } else {
      info = await probeChip(port);
    }
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
        probed: true,
      };
    } else if (noResetLine) {
      // Nothing answered, and on this port nothing can be made to: the loader is
      // reached by hand or not at all. Say which hand movement.
      banner = ['This port has no reset line, and the device is not in the bootloader.',
                'Hold BOOT, tap RESET, release BOOT, then run detection again.'];
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
  //
  // Except on the board this run reached without a reset line, where pulsing RTS
  // would do nothing. The loader is deliberately still up — the detector put it
  // back — and that is exactly the state a flash wants to start from, so it is
  // left there and said so. Starting the firmware from here is possible (the
  // watchdog restart the flash path uses) but not wanted yet: the reason to
  // detect is usually to flash next, and a restart would only have to be undone.
  if (noResetLine) {
    banner = [...banner, '',
              'Device is in the ROM bootloader — there is no reset line on this board.',
              'It has been left there, which is where flashing starts; “Flash” works as it is.'];
  }
  try {
    await openMonitor(port, !noResetLine && !!info, banner);
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
  // Hardware button back) and resolve what the catalogue has for it. The offer
  // lands in the same window as the findings below — it arrives a few seconds
  // later, with the device's build stamp, and the window repaints around it.
  armFlashGrace(hw, true);
  // Only a run that reached the chip has anything to show.
  if (facts && monitor) showDeviceBox(facts);
}

on('monitor-detect', 'click', runDetect);

// "Detect hardware" is a settings-panel action now, so it is always on screen
// and says whether it can run instead of appearing and vanishing: disabled with
// no port to run it on, and for the length of a run.
function syncDetectButton() {
  const b = $('monitor-detect');
  if (b) b.disabled = !monitor || detecting;
}

// `?usbprobe=1` turns the Start button into the wire test described in
// port.usbProbe: pick a port, open it, write one CR, read what comes back, print
// the counts and the bytes, close. It exists because a console that says nothing
// back looks the same from the terminal whichever half is at fault, and because
// the page it would otherwise open has a dozen layers between the endpoint and
// the screen, every one of which could be the one eating the answer.
const USB_PROBE = params.get('usbprobe') === '1';

async function runUsbProbe(port) {
  logEl.hidden = false;
  logEl.textContent = '';
  $('intro-hint').textContent = 'Testing the wire…';
  log('── USB wire test ──');
  try {
    await port.open({ baudRate: DEFAULT_CFG.baudRate });
  } catch (e) {
    log(`open failed: ${e && e.message ? e.message : e}`, 'err');
    $('start').hidden = false;
    return;
  }
  try {
    await port.usbProbe((line) => log(line));
  } catch (e) {
    log(`probe threw: ${e && e.message ? e.message : e}`, 'err');
  } finally {
    try { await port.close(); } catch (_) { /* nothing left to release */ }
  }
  log('── end of test ──');
  $('intro-hint').textContent = 'Wire test finished. Reload without ?usbprobe=1 for the monitor.';
  $('start').hidden = false;     // let it be run again
}

let connecting = false;

// Pop the serial chooser, open the monitor on the port, and identify the board —
// by asking it first, and only probing what cannot answer.
//
// The pick opens the monitor without touching the device, then asks it `show
// sys.hw` over a frame. A device that answers is identified at that point, still
// running, never reset. One that does not gets the detection run: reset, chip
// probe, RAM-loaded detector, ending in the device window. "No reset" stops
// short of that run — the asking costs the device nothing and happens either
// way.
//
// requestPort() is called first, while the user gesture is fresh, before any
// long await. `givenPort` skips the chooser: the startup lobby passes the port
// it has just identity-probed, which is the other admissible proof of "this is
// the board the person means" (see pinPort).
//
// This pick is what the tab is for. It becomes the tab's one port, and only
// another pick — the reconnect dialog, a console move, or a verified adoption
// — ever replaces it.
async function connect(givenPort) {
  if (connecting || monitor) return;
  connecting = true;
  statePart = null;                  // a fresh pick may be a different chip
  deviceFacts = null;                // …so nothing the last one reported carries over
  noResetLine = false;          // …and it may be one that resets perfectly well

  $('start').hidden = true;          // the action is underway — drop the CTA
  bar.style.display = 'none';
  barfill.style.width = '0';
  logEl.textContent = '';
  logEl.hidden = true;
  $('intro-hint').textContent = 'Opening serial monitor…';
  // Connecting supersedes the lobby, whatever state its probes are in.
  lobbyHide();
  try {
    const port = givenPort || await SERIAL.requestPort();
    if (USB_PROBE && port.usbProbe) { await runUsbProbe(port); return; }
    if (isFnb58Port(port)) {
      $('intro-hint').innerHTML =
        '<span class="err">That looks like the FNB58 power meter, not your device. ' +
        'Pick your device&rsquo;s serial port instead — then use the FNB58 button in ' +
        'the monitor to graph the meter.</span>';
      showFrontDoor();                // let them re-pick; finally{} clears `connecting`
      return;
    }
    // An identity probe may still hold the very port just picked (a lobby
    // probe, or an adoption's); it lets go within its own deadlines — wait it
    // out, bounded, rather than losing the open to it.
    for (let i = 0; i < 40 && probeHeld.has(port); i++) await sleep(200);
    pairedUnit = null;      // identity is re-learned off the wire after every pick
    strayArrivals = [];
    pinPort(port);
    const banner = ['Monitoring — the device has not been reset.'];
    const usb = usbInfoLine(port);
    await openMonitor(port, false, usb ? [usb, ...banner] : banner);
    refreshFlashOffer();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    $('intro-hint').innerHTML = `<span class="err">${msg}</span>`;
    showFrontDoor();                 // let them try again
  } finally {
    connecting = false;
  }
  // Identify the board the moment the monitor is up — outside the try above, so
  // a failure reports itself in the monitor rather than putting the "pick a
  // port" call to action back over a live session.
  //
  // Nothing is asked here, because nothing needs to be. Opening the port already
  // sent the console a bare CR (syncConsole), and spangap answers that by saying
  // who it is — `build: hw …` / `build: catalogue …` / `build: datetime …`, the
  // same lines it prints at boot. The ordinary log parser picks them up and arms
  // the board, so all this waits for is the round trip.
  //
  // That is the whole identification, and it is why there is no query channel to
  // maintain: the device volunteers the fact to whoever turns up, rather than
  // holding it until interrogated over a side-channel that has to be probed for,
  // may not be armed, and cannot be relied on the moment a port opens.
  if (!monitor) return;
  if (!(await waitForBoardNamed(monitor))) {
    // Silence means firmware too old to answer a CR with its identity, or none
    // at all. Reading it off the chip is the only way left — and under "No
    // reset" not even that, since the point of the setting is to leave the
    // device alone.
    // Not under ?debug=1: a session that probes has already failed at the thing
    // a debug session exists to observe — and the run itself destroys the
    // evidence, resetting the device and burying the dead console under a
    // fresh boot. The settings-panel button still runs one deliberately.
    if (DEBUG_HUD && monitor) {
      note(monitor, '\x1b[33m-- debug: the device did not answer the CR; auto-detection is off '
                  + 'under ?debug=1 so the failure stays observable. Reset shows the boot log; '
                  + '\u201cDetect hardware\u201d still runs manually. --\x1b[0m');
    } else if (autoDetect() && monitor) await runDetect();
    else if (monitor) note(monitor, '\x1b[33m-- the device did not say which board it is; '
                                  + '“Detect hardware” in the settings panel will read it off the chip --\x1b[0m');
  }
}

// Wait for the console's answer to the CR that opening the port already sent.
// A round trip on an open port, so this is short: what has not arrived in a
// couple of seconds is not coming, and what is not coming means old firmware or
// none. `m.hw` is set by the log parser the moment `build: hw` lands.
const BOARD_NAMED_MS = 2500;

async function waitForBoardNamed(m) {
  for (let waited = 0; waited < BOARD_NAMED_MS; waited += 200) {
    if (monitor !== m) return false;        // session replaced under us
    if (m.hw) return true;
    // The opening handshake's own CR goes out inside its mute window, so an
    // answer that comes back promptly is discarded with the backlog it was
    // muted for — the question eats its own answer. A bare CR is free, so a
    // console that has not answered is asked again in the open before it is
    // called silent.
    if (waited === 600 || waited === 1400) pokeConsole(m);
    await sleep(200);
  }
  return !!m.hw;
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
    if (k === 'name' || k === 'image') obj[k] = v;
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

// The selected catalogue's config. Missing or broken falls back to defaults —
// the page still monitors, it just has nothing to offer.
async function loadConfig() {
  try {
    const res = await fetch(`${CAT_BASE}builds.yaml`, { cache: 'no-store' });
    if (res.ok) return parseConfig(await res.text());
  } catch (_) { /* served without a catalogue */ }
  return { project: 'flashmon', builds: [] };
}

// The images the catalogue actually holds, from its index.html: name -> newest
// stamp. Every image is <slug>_<name>_<stamp>.zip, and the stamps sort
// lexicographically, so the highest one per name is the current image. Read out
// of the hrefs, so any listing that links its files works — this one is
// generated by `spangap make-builds`.
async function loadVersions() {
  let text;
  try {
    const res = await fetch(`${CAT_BASE}index.html`, { cache: 'no-store' });
    if (!res.ok) return {};
    text = await res.text();
  } catch (_) {
    return {};
  }
  const out = {};
  // One pass over the anchors rather than over the hrefs: the listing carries
  // per-image facts as attributes on the same element (`data-onboarding`), and
  // reading the tag whole is what keeps a fact attached to the image it is about.
  ONBOARDING = {};
  for (const tag of text.matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = tag[1];
    const href = /href\s*=\s*["']([^"']+\.zip)["']/i.exec(attrs);
    if (!href) continue;
    const base = href[1].replace(/^.*\//, '').replace(/\.zip$/i, '');
    const parts = /^(.+?)_(.+)_(\d{8,14})$/.exec(base);
    if (!parts) continue;
    const [, , name, stamp] = parts;
    if (out[name] && stamp <= out[name]) continue;
    out[name] = stamp;
    const onb = /data-onboarding\s*=\s*["']([^"']+)["']/i.exec(attrs);
    ONBOARDING[name] = onb ? onb[1] : '';
  }
  return out;
}

// True when the catalogue says this image sets a fresh node up from its own
// screen. Then this page has nothing to ask: asking anyway would race the
// device's own dialogs for the same answers, and the second answer wins for no
// reason anybody could predict. Unmarked images are the flasher's to set up,
// which is the safe default — a node nobody asks and that cannot ask for itself
// is a node nobody set up.
function imageOnboardsItself(name) { return ONBOARDING[name] === 'device'; }

// The catalogues the tree says it holds, from `builds/index.html`: the directory
// links in it, in the order it lists them. Read out of the hrefs, like the image
// listing — any page that links its subdirectories works. A catalogue marked
// `.unlisted` is deliberately absent here and is reached by naming it, which is
// what the selector's "- other -" is for.
async function loadCatalogueList() {
  let text;
  try {
    const res = await fetch(`${BUILDS_BASE}index.html`, { cache: 'no-store' });
    if (!res.ok) return [];
    text = await res.text();
  } catch (_) {
    return [];                    // tree not served, or briefly unreachable
  }
  const out = [];
  for (const m of text.matchAll(/href\s*=\s*["']([^"']+)\/["']/gi)) {
    const name = cleanCatalogue(m[1].replace(/^.*\//, ''));
    if (name && name !== '.' && name !== '..' && !out.includes(name)) out.push(name);
  }
  return out;
}

// The brand the catalogue wears. It comes out of the catalogue's own config, so
// it is re-applied whenever the selected catalogue changes.
function applyBrand(cfg) {
  PROJECT = cfg.project || 'flashmon';
  SLUG = projectSlug(PROJECT);
  HOSTNAME_DEFAULT = (PROJECT.toLowerCase().replace(/[^a-z0-9_]/g, '') || 'flashmon').slice(0, 20);
}

// Re-read the listing and re-evaluate the live offer. Called when the stamp file
// moves, which is the catalogue telling us it has something new. Branding is
// left as booted: a catalogue doesn't get to rename the page under a running
// session (switching catalogue does — see setCatalogue).
async function refreshCatalogue() {
  const [cfg, versions] = await Promise.all([loadConfig(), loadVersions()]);
  BUILDS = cfg.builds;
  BUILD_NAMES = cfg.builds.map((b) => b.name).filter(Boolean);
  VERSIONS = versions;
  if (monitor) refreshFlashOffer();
}

// Serve images from a different catalogue from here on. Everything read out of
// the old one goes — its images, its stamp, and the record of what has already
// been offered, since an offer from another catalogue is a different offer even
// when it names the same image. `pin` marks the choice as the user's, which
// stops a device's own catalogue from moving it afterwards.
async function setCatalogue(name, pin) {
  const want = cleanCatalogue(name);
  if (!want) return;
  if (pin) cataloguePinned = true;
  syncBuildSelector();
  if (want === CATALOGUE) return;
  CATALOGUE = want;
  CAT_BASE = `${BUILDS_BASE}${CATALOGUE}/`;
  VERSIONS = {};
  LAST_STAMP = null;
  offerShownFor = null;
  autoFlashed = null;
  const [cfg, versions, stamp] = await Promise.all([loadConfig(), loadVersions(), fetchStamp()]);
  if (CATALOGUE !== want) return;              // switched again while loading
  applyBrand(cfg);
  BUILDS = cfg.builds;
  BUILD_NAMES = cfg.builds.map((b) => b.name).filter(Boolean);
  VERSIONS = versions;
  LAST_STAMP = stamp;
  setMonTitle(monitor ? monitor.hostname : null);
  syncBuildSelector();
  if (monitor) refreshFlashOffer();
}

// A device that says which catalogue it was flashed from moves the page there,
// so what it is compared against is the series it came from. Only while nothing
// has claimed the choice: a `?build=` or a pick in the panel outranks the
// device, and stays put when the next board says something else.
function adoptDeviceCatalogue(name) {
  if (cataloguePinned) { syncBuildSelector(); return; }
  setCatalogue(name, false);
}

// Poll the catalogue's stamp file: one small request, and the only thing that
// has to be cheap because it runs whether or not anything is happening. The
// listing is re-read only when the value moves.
const STAMP_POLL_MS = 15000;
async function fetchStamp() {
  try {
    const res = await fetch(`${CAT_BASE}timestamp`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch (_) {
    return null;                  // catalogue not served, or briefly unreachable
  }
}

async function pollStamp() {
  const stamp = await fetchStamp();
  if (stamp === null || stamp === LAST_STAMP) return;
  LAST_STAMP = stamp;
  await refreshCatalogue();
}

// ── boot ──────────────────────────────────────────────────────────────────
// ── the startup lobby ───────────────────────────────────────────────────────
// On load the roster and the granted ports become a menu: every node this
// browser has identified before, by hostname, its presence probed live with
// the same primitive adoption uses — open, one CR, read `dev …, host …`, close
// — which needs no gesture on a granted port. The chooser, whose
// /dev/cu.usbmodem-style rows nobody can tell apart, is behind "Other
// device…": the one road for a device this origin has never met. Only ports
// wearing a USB identity the roster has seen are probed at all, so a serial
// device this origin granted for some other purpose is never poked.
// Built by this script, styles included, never taken from the page: index.html
// is served without the cache-bust the module gets, so a surface whose markup
// or CSS lived only in a fresh page would silently vanish on a cached one —
// exactly what must not happen to the front door.
let ownStylesDone = false;
function ownStyles() {
  if (ownStylesDone) return;
  ownStylesDone = true;
  const s = document.createElement('style');
  s.textContent = `
  #lobby-list{display:flex;flex-direction:column;gap:.45rem;margin-top:.9rem}
  .lobby-node{display:flex;align-items:baseline;gap:.6rem;width:100%;text-align:left}
  .lobby-node small{color:var(--muted);font-weight:400;margin-left:auto;white-space:nowrap}
  .lobby-node:disabled{cursor:default;opacity:.55}
  #toast{position:fixed;left:50%;bottom:2.2rem;transform:translateX(-50%);z-index:40;
       background:var(--panel);border:1px solid var(--line);border-radius:8px;
       color:var(--fg);padding:.55rem .9rem;font-weight:600;cursor:pointer;
       box-shadow:0 4px 18px rgba(0,0,0,.5)}
  #toast[hidden]{display:none}
  #title.flashing{font-size:1.25rem}
  #title-sub{color:var(--muted);font-size:.85rem;margin:.1rem 0 .6rem}
  #title-sub[hidden]{display:none}`;
  document.head.appendChild(s);
}

let lobbyUi = null;   // { box, list }, built on first use
function lobbyBuild() {
  if (lobbyUi) return lobbyUi;
  ownStyles();
  const box = document.createElement('div');
  box.className = 'modal-overlay';
  box.hidden = true;
  const modal = document.createElement('div');
  modal.className = 'modal';
  const h2 = document.createElement('h2');
  h2.textContent = 'Connect to a device';
  const sub = document.createElement('div');
  sub.className = 'sub';
  const list = document.createElement('div');
  list.id = 'lobby-list';
  const row = document.createElement('div');
  row.className = 'row';
  const other = document.createElement('button');
  other.type = 'button';
  other.className = 'btn-primary';
  other.textContent = 'Other device…';
  other.addEventListener('click', () => { box.hidden = true; connect(); });
  row.append(other);
  modal.append(h2, sub, list, row);
  box.appendChild(modal);
  document.body.appendChild(box);
  lobbyUi = { box, list, sub };
  return lobbyUi;
}
function lobbyHide() {
  if (lobbyUi) lobbyUi.box.hidden = true;
}

// The way back to square one. The lobby is the page's one front door — an
// empty roster just makes it a short dialog ("No known devices found" and the
// chooser behind Other device…). The plain Start button survives only in the
// ?usbprobe=1 wire-test mode, which has no lobby. A failed connect lands here
// too: the lobby re-probes, so a node that was taken between probe and click
// now says so instead of "ready".
function showFrontDoor() {
  if (USB_PROBE) { $('start').hidden = false; return; }
  lobbyShow();
}

let lobbyScanning = false;
async function lobbyShow() {
  if (USB_PROBE || monitor) return;          // wire-test mode, or already connected
  const roster = rosterLoad();
  const ids = Object.keys(roster).sort((a, b) => (roster[b].seen || 0) - (roster[a].seen || 0));
  if (lobbyScanning) {                       // a scan is mid-flight — just re-surface it
    if (lobbyUi) lobbyUi.box.hidden = false;
    return;
  }
  lobbyScanning = true;
  try {
    await lobbyScan(roster, ids);
  } finally {
    lobbyScanning = false;
  }
}

async function lobbyScan(roster, ids) {
  const { box, list, sub } = lobbyBuild();
  sub.textContent = ids.length
    ? 'Devices this browser has connected to before:'
    : 'No known devices found.';
  list.textContent = '';
  const rows = new Map();
  const addRow = (devId, host) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lobby-node btn-ghost';
    btn.disabled = true;
    const name = document.createElement('span');
    name.textContent = host || `device ${devId}`;
    const state = document.createElement('small');
    state.textContent = 'looking…';
    btn.append(name, state);
    list.appendChild(btn);
    const row = { btn, name, state };
    rows.set(devId, row);
    return row;
  };
  for (const devId of ids) addRow(devId, roster[devId].host);
  // The heartbeat answers "busy" before any port is touched: a node another
  // tab is stamping is labeled at once and its ports are left alone — probing
  // them could only fail on exclusivity anyway.
  const heldIds = new Set(ids.filter((devId) => heldByOther(devId)));
  for (const devId of heldIds) {
    rows.get(devId).state.textContent = 'in use in another tab';
  }
  box.hidden = false;

  // Probe whatever is present and wears a roster identity. In parallel — the
  // ports are separate devices, and the list should settle in one probe's
  // time, not one per device.
  let granted = [];
  try { granted = await SERIAL.getPorts(); } catch (_) { /* road closed */ }
  if (monitor || box.hidden) { box.hidden = true; return; }   // superseded while away
  // Only keys some free node wears are worth probing — a key that belongs
  // exclusively to stamped-held nodes has nothing to offer this tab. A key
  // shared between a held and a free node is still probed, for the free one.
  const knownKeys = new Set(ids.filter((i) => !heldIds.has(i))
    .flatMap((i) => roster[i].keys || []));
  const candidates = granted.filter((p) => knownKeys.has(portUsbKey(p)) && p.connected !== false);
  const busyKeys = new Set();
  await Promise.all(candidates.map(async (p) => {
    const r = await probeUnitId(p, { ...DEFAULT_CFG }, () => !monitor && !box.hidden);
    if (monitor || box.hidden) return;       // a connect won while this probed
    if (r.status === 'no-open') {
      // On the bus but not openable: held by another tab, almost always.
      if (p.connected !== false) busyKeys.add(portUsbKey(p));
      return;
    }
    if (r.status !== 'id') return;           // mute, or gone — not offerable
    rosterNote(r.id, r.host, portUsbKey(p));
    const row = rows.get(r.id) || addRow(r.id, r.host);
    if (r.host) row.name.textContent = r.host;
    row.state.textContent = `dev ${r.id} — ready`;
    row.btn.disabled = false;
    row.btn.addEventListener('click', () => { box.hidden = true; connect(p); });
  }));
  if (monitor) { box.hidden = true; return; }
  // Whatever never answered is busy (a port with its USB identity refused to
  // open — a holder without a heartbeat, some other program most likely) or
  // simply not here. Stamped-held rows keep the label they already have.
  for (const [devId, row] of rows) {
    if (!row.btn.disabled || heldIds.has(devId)) continue;
    const n = roster[devId] || {};
    const busy = (n.keys || []).some((k) => busyKeys.has(k));
    row.state.textContent = busy ? 'in use — another program?'
      : n.seen ? `last seen ${new Date(n.seen).toLocaleDateString()}` : 'not present';
  }
}

async function boot() {
  const cfg = await loadConfig();
  applyBrand(cfg);
  BUILDS = cfg.builds;
  BUILD_NAMES = cfg.builds.map((b) => b.name).filter(Boolean);

  CATALOGUES = await loadCatalogueList();
  VERSIONS = await loadVersions();
  LAST_STAMP = await fetchStamp();

  // Watch the catalogue for the rest of the session, so a build published while
  // the page is open is picked up without a reload. Worker-held like the other
  // background polls: a hidden tab is exactly when an unattended flasher is
  // waiting for a build to land. Branding (project/slug) is left as booted.
  wtSetInterval(pollStamp, STAMP_POLL_MS);

  // Markup this script drives that the page it loaded into doesn't have: the
  // page was served from cache, older than the script beside it. Flashing and
  // the monitor still work; the dialogs those elements belong to don't, and a
  // reload that bypasses the cache is the fix.
  const stale = ['dl-overlay', 'device-overlay', 'flash-go', 'set-build', 'hn-name',
                 'lora-freq', 'lxmf-name']
    .filter((id) => !$(id));
  if (stale.length) {
    log(`This page is cached from an older deployment (missing: ${stale.join(', ')}). `
      + 'Reload with Shift held to fetch the current one.', 'err');
  }

  setMonTitle(null);
  if ($('hn-name')) $('hn-name').value = HOSTNAME_DEFAULT;
  initSettingsControls();

  if (!SERIAL) {
    $('intro-hint').innerHTML = 'This page needs a <b>Chromium-based browser</b> to work, for now — '
      + 'desktop <b>Chrome</b>, <b>Edge</b>, <b>Brave</b>, or <b>Opera</b>, or <b>Chrome on Android</b>. '
      + 'This browser can’t talk to the device over USB.';
    return;
  }

  // The lobby is the front door: known nodes by name, the chooser behind
  // "Other device…" for devices this origin has never met. A grant alone still
  // never picks a board — Web Serial exposes only USB VID/PID, so a remembered
  // grant can't be told apart from a same-model board on a different port —
  // but the lobby's identity probe reads the `dev` id off the port before
  // offering it, which is the same proof adoption stands on. Only the
  // ?usbprobe=1 wire test keeps the plain Start button: its run wants the
  // chooser and nothing else.
  $('start').addEventListener('click', () => connect());
  if (USB_PROBE) {
    $('start').textContent = 'Click here to select the serial port your device is connected to.';
    $('start').hidden = false;
  } else {
    lobbyShow();
  }

  // Say up front what the WebUSB road can and cannot reach, because the chooser
  // itself won't: a board behind a bridge chip is simply absent from the list,
  // which reads as a broken page rather than a boundary. Also the one thing a
  // phone user has to do by hand — another app holding the device keeps the
  // browser out of it, with no way for the page to see that or say so later.
  if (SERIAL_OVER_USB) {
    $('intro-hint').innerHTML = 'This browser reaches the device over <b>WebUSB</b>: boards whose serial '
      + 'port is the chip’s own USB are offered, boards behind a USB-to-serial bridge chip are not. '
      + 'If another app opens when the board is plugged in, dismiss it — an app holding the device '
      + 'keeps this page out of it.';
  }

  // The FNB58 graph never opens on its own — only the user clicking the FNB58
  // label connects it, and it is never reconnected from a remembered grant: on
  // load we forget any grant a prior session left behind, so the first click
  // always goes through the chooser. A 5 s poll then keeps the shared active
  // stamp fresh while streaming and the label in step with the settle cooldown
  // (hidden until the meter has idled long enough to be safely reopened).
  // Worker-held like the keep-alive: a throttled poll would let the shared active
  // stamp go stale while this tab is still streaming, and another tab would read
  // that as an idle meter and take it.
  if ('hid' in navigator) fnbForgetGranted();
  fnbPollStatus();
  wtSetInterval(fnbPollStatus, 5000);
}

boot();
