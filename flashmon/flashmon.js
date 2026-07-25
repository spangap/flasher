// Spangap web flasher.
//
// Reads ?build=<name> from the URL, looks up the builds-repo root in
// builds-repo.txt, downloads <root>/<branch>/<name>.zip (a flasher.zip produced
// by `spangap build`; ?branch=<ref> selects the builds-repo branch, default
// main), unzips it in the browser, and flashes every image at its
// offset over Web Serial using the vendored esptool-js. No CDN, no build step —
// these files can be served from anywhere static.

import { ESPLoader, Transport } from './vendor/esptool-bundle.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const bar = $('bar');
const barfill = $('barfill');
const flashBtn = $('flash');

function log(msg, cls) {
  logEl.hidden = false;
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
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

const params = new URLSearchParams(location.search);
const build = params.get('build');
// Which builds-repo branch to pull from; the raw-GitHub root omits the ref, so
// the branch becomes the first path segment. Defaults to main.
const branch = params.get('branch') || 'main';

if (!build) {
  $('build-label').textContent = 'no build selected';
  $('hint').innerHTML = 'Add <code>?build=&lt;name&gt;</code> to the URL — e.g. <code>?build=tdeck</code>.';
  flashBtn.disabled = true;
} else {
  $('build-label').textContent = `build: ${build}`;
}

if (!('serial' in navigator)) {
  $('hint').innerHTML = 'This browser has no <b>Web Serial</b>. Use desktop Chrome/Edge (or another Chromium '
    + 'browser) over HTTPS or <code>http://localhost</code>.';
  flashBtn.disabled = true;
}

// First non-blank, non-comment line of builds-repo.txt is the builds-repo root.
async function readBuildsRoot() {
  const res = await fetch('builds-repo.txt', { cache: 'no-store' });
  if (!res.ok) throw new Error(`builds-repo.txt not found (HTTP ${res.status})`);
  const root = (await res.text())
    .split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!root) throw new Error('builds-repo.txt has no URL');
  return root.replace(/\/+$/, '');
}

flashBtn.addEventListener('click', async () => {
  flashBtn.disabled = true;
  bar.style.display = 'none';
  barfill.style.width = '0';
  logEl.hidden = false;
  logEl.textContent = '';
  let transport;
  try {
    const root = await readBuildsRoot();
    const zipURL = `${root}/${branch}/${build}.zip`;
    log(`Downloading ${zipURL}`);
    const res = await fetch(zipURL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`could not fetch ${build}.zip (HTTP ${res.status}) — is the build published?`);
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
    log(`Unpacked ${fileArray.length} image(s). Select your device's serial port…`);

    const port = await navigator.serial.requestPort();
    transport = new Transport(port, true);
    const esploader = new ESPLoader({ transport, baudrate: 460800, terminal });
    const chip = await esploader.main();
    log(`Connected: ${chip}`, 'ok');

    bar.style.display = 'block';
    await esploader.writeFlash({
      fileArray,
      flashSize: settings.flash_size || 'keep',
      flashMode: settings.flash_mode || 'keep',
      flashFreq: settings.flash_freq || 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (_idx, written, total) => {
        if (total) barfill.style.width = `${Math.round((written / total) * 100)}%`;
      },
    });
    barfill.style.width = '100%';

    await esploader.after((fargs.extra_esptool_args || {}).after || 'hard_reset');
    log('Flash complete — device reset. You can open its UI now.', 'ok');
  } catch (e) {
    log(`Error: ${e && e.message ? e.message : e}`, 'err');
  } finally {
    if (transport) { try { await transport.disconnect(); } catch (_) { /* already gone */ } }
    flashBtn.disabled = false;
  }
});
