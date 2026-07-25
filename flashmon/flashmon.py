#!/usr/bin/env python3
"""flashmon — a terminal flasher + serial monitor for spangap devices.

What the browser flasher does, from a plain terminal, for people who can't run a
Chromium browser:

  * pick a serial port
  * probe the chip
  * RAM-load the peripheral detector and auto-identify the board (no flash write)
  * flash the matching image from the catalogue (falling back to generic)
  * open a full-screen serial monitor: while it provisions a fresh device
    (password / WiFi) the bottom third is a dialog and the log scrolls above it,
    then the dialog collapses and the log goes full-screen — the web version's
    floating-dialog UX, tiled. F8 opens the device's web UI.

It reads the same files the browser does — flashmon.yaml, builds/<name>.zip,
detect/spangap_detect.bin — from a deployment URL or a local flashmon folder. All
the esptool work runs first as plain text (so the terminal is clean before the
monitor starts). `--simple` swaps the TUI for esp-idf-monitor if a terminal
misbehaves.

Usage:
    ./<project>-flashmon                  # downloaded copy: fetches from PROJECT_URL
    ./<project>-flashmon/<project>-flashmon   # unzipped bundle: runs fully offline
    ./flashmon.py make-zip                # build the branded script + offline bundle

A deployment sets `project:` and `url:` in flashmon.yaml; `make-zip` copies this
script to `<project>-flashmon` with the URL baked in, and packs it with the config,
images, detector and cross-platform tool wheels into `<project>-flashmon.zip`.

Only Python 3.8+ is required. On first run a downloaded copy quietly sets up its
tools (esptool + esp-idf-monitor) in a private folder in your home cache — nothing
system-wide, no admin; a bundle installs those from wheels it carries, no internet.
"""

import argparse
import io
import json
import os
import re
import signal
import sys
import tempfile
import threading
import time
import zipfile


# ── dependency bootstrap ─────────────────────────────────────────────────────
# esptool drives the ROM/flash protocol; esp-idf-monitor is the serial monitor;
# pyserial (pulled in by both) is used directly for detector capture + reset.
#
# Modern macOS (Homebrew) and Debian/Ubuntu mark the system Python "externally
# managed" and refuse `pip install`, so we DON'T touch it: on first run we make
# our own private environment in the cache dir, install the tools into THAT, and
# re-run ourselves inside it. The user only ever runs `./flashmon.py`.
# ── this deployment ──────────────────────────────────────────────────────────
# Where THIS build's config + firmware images live. A project sets this one line
# (and usually renames the script, e.g. reticulous-flashmon.py) so a downloaded
# copy knows where to fetch flashmon.yaml + builds/. Leave empty for a purely
# local setup; a self-contained zip (see `make-zip`) carries those files next to
# the script, so it needs neither a URL nor any internet.
PROJECT_URL = ""

DEPS = ["esptool", "esp-idf-monitor"]

# `make-zip` builds universal wheels for DEPS once, then resolves the tool tree for
# each combo below (pulling each platform's binary deps), so ONE zip installs
# offline on any of them. (esptool is pure Python but sdist-only on PyPI — hence the
# `pip wheel` build rather than a plain `pip download`.) esptool needs Python ≥3.10.
ZIP_PLATFORMS = ["macosx_11_0_arm64", "macosx_10_13_x86_64",
                 "manylinux2014_x86_64", "manylinux2014_aarch64", "win_amd64"]
ZIP_PYVERS = ["3.10", "3.11", "3.12", "3.13"]


def _script_dir():
    return os.path.dirname(os.path.abspath(__file__))


def _script_stem():
    return os.path.splitext(os.path.basename(os.path.abspath(__file__)))[0]


def _venv_dir():
    # Keyed by the script's own name, so a renamed per-project flashmon gets its
    # own environment instead of colliding with another project's.
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, _script_stem(), "venv")


def _venv_python(venv_dir):
    sub = "Scripts" if os.name == "nt" else "bin"
    exe = "python.exe" if os.name == "nt" else "python"
    return os.path.join(venv_dir, sub, exe)


def _bundled_wheels():
    """Wheels shipped next to the script (an unzipped `make-zip` bundle), or None."""
    d = os.path.join(_script_dir(), ".cache", "wheels")
    return d if os.path.isdir(d) else None


def ensure_deps():
    try:
        import serial            # noqa: F401  (pyserial)
        import esptool           # noqa: F401
        import esp_idf_monitor   # noqa: F401
        return
    except ImportError:
        pass

    import subprocess
    venv_dir = _venv_dir()
    venv_py = _venv_python(venv_dir)

    if os.path.realpath(sys.executable) == os.path.realpath(venv_py):
        sys.exit("flashmon: setup looks incomplete — delete %s and run again." % venv_dir)

    if not os.path.exists(venv_py):
        print("flashmon: first-time setup — creating a private tools folder "
              "(nothing system-wide, no admin needed)…", file=sys.stderr)
        import venv
        try:
            venv.create(venv_dir, with_pip=True)
        except Exception:
            sys.exit("flashmon: this Python can't create a private environment.\n"
                     "  On Debian/Ubuntu run:  sudo apt install python3-venv  then try again.")

    have = subprocess.call([venv_py, "-c", "import esptool, serial, esp_idf_monitor"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if have != 0:
        wheels = _bundled_wheels()
        if wheels:
            print("flashmon: setting up the bundled tools (offline, one time)…", file=sys.stderr)
            cmd = [venv_py, "-m", "pip", "install", "--no-index", "--find-links", wheels,
                   "--disable-pip-version-check", "--quiet"] + DEPS
        else:
            print("flashmon: downloading the flashing + monitor tools — a few seconds, one time…",
                  file=sys.stderr)
            cmd = [venv_py, "-m", "pip", "install", "--disable-pip-version-check",
                   "--no-cache-dir", "--quiet"] + DEPS
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if res.returncode != 0:
            sys.stderr.buffer.write(res.stdout)
            sys.exit("flashmon: couldn't set up the tools%s." %
                     ("" if wheels else " — check your internet connection and run again"))

    os.execv(venv_py, [venv_py, os.path.abspath(__file__)] + sys.argv[1:])


# ── config + catalogue (mirrors flashmon.js) ─────────────────────────────────
# Full CSI escape (params + intermediate bytes + final), so colour codes and
# cursor-style resets like "\x1b[0 q" are all stripped.
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
# An incomplete CSI at the very end of a buffer (a sequence split across reads).
CSI_PARTIAL_RE = re.compile(r"\x1b(\[[0-?]*[ -/]*)?$")


def strip_ansi(s):
    return ANSI_RE.sub("", s)


def parse_config(text):
    """Minimal YAML for our shape: top-level `project:` and `url:`, then a
    `builds:` list of entries, each `name:` plus an optional `version:` (the
    build datetime `make` stamped when it produced that image)."""
    cfg = {"project": "flashmon", "url": "", "builds": []}
    in_builds = False
    cur = None

    def setkv(obj, kv):
        i = kv.find(":")
        if i < 0:
            return
        k = kv[:i].strip()
        v = kv[i + 1:].strip().strip("\"'")
        if k in ("name", "version"):
            obj[k] = v

    for raw in text.splitlines():
        st = raw.split("#", 1)[0].strip()   # our values carry no '#'
        if not st:
            continue
        if re.match(r"^project\s*:", st):
            cfg["project"] = st.split(":", 1)[1].strip().strip("\"'")
            in_builds = False
            continue
        if re.match(r"^url\s*:", st):
            cfg["url"] = st.split(":", 1)[1].strip().strip("\"'")
            in_builds = False
            continue
        if re.match(r"^builds\s*:", st):
            in_builds = True
            continue
        if not in_builds:
            continue
        if st.startswith("- "):
            cur = {}
            cfg["builds"].append(cur)
            setkv(cur, st[2:].strip())
        elif cur is not None:
            setkv(cur, st)
    cfg["builds"] = [b for b in cfg["builds"] if b.get("name")]
    return cfg


def build_candidates(hw, names):
    """Image names to try for a detected board, most-specific first: the exact
    name, then successively shorter hw- prefixes, then `generic`."""
    have = set(names)
    out = []
    n = hw
    while n and n.startswith("hw-") and len(n) > 3:
        if n in have:
            out.append(n)
        i = n.rfind("-")
        if i <= 2:
            break
        n = n[:i]
    if "generic" in have:
        out.append("generic")
    return out


def detected_hw(lines):
    for l in lines:
        m = re.match(r"^DETECTED:\s+(hw-[a-z0-9-]+)", l)
        if m:
            return m.group(1)
    return None


def _project_slug(project):
    return re.sub(r"[^a-z0-9]+", "-", (project or "").lower()).strip("-") or "flashmon"


def _build_entry(cfg, name):
    for b in cfg.get("builds", []):
        if b.get("name") == name:
            return b
    return {}


def build_rel(cfg, name):
    """Relative path to a build's zip. A build `make` has stamped carries its own
    `version:` (the build datetime) and is named <slug>_<name>_<version>.zip;
    an unstamped one is plain <name>.zip."""
    ver = _build_entry(cfg, name).get("version", "")
    if ver:
        return "builds/%s_%s_%s.zip" % (_project_slug(cfg.get("project", "")), name, ver)
    return "builds/%s.zip" % name


# ── source: a deployment URL, or a local flashmon folder ─────────────────────
class Source:
    def __init__(self, url, base_dir):
        self.url = url.rstrip("/") if url else None
        self.base_dir = base_dir

    def _local_path(self, rel):
        return os.path.join(self.base_dir, *rel.split("/"))

    def exists(self, rel):
        if self.url:
            import urllib.request
            req = urllib.request.Request(self.url + "/" + rel, method="HEAD")
            try:
                with urllib.request.urlopen(req, timeout=15):
                    return True
            except Exception:
                return False
        return os.path.exists(self._local_path(rel))

    def read_bytes(self, rel):
        if self.url:
            import urllib.request
            with urllib.request.urlopen(self.url + "/" + rel, timeout=30) as r:
                return r.read()
        with open(self._local_path(rel), "rb") as f:
            return f.read()

    def read_text(self, rel):
        return self.read_bytes(rel).decode("utf-8", "replace")

    def local_config_mtime(self):
        """Newest mtime across the local config files, or None for a URL source
        (so a URL source simply isn't mtime-polled)."""
        if self.url:
            return None
        best = None
        for rel in ("flashmon.local.yaml", "flashmon.yaml"):
            try:
                mt = os.path.getmtime(self._local_path(rel))
            except OSError:
                continue
            best = mt if best is None else max(best, mt)
        return best


def resolve_config(src):
    for rel in ("flashmon.local.yaml", "flashmon.yaml"):
        try:
            if src.exists(rel):
                return parse_config(src.read_text(rel))
        except Exception:
            continue
    return {"project": "flashmon", "builds": []}


# ── esptool driver ───────────────────────────────────────────────────────────
def _esptool(args, capture=False):
    """Run `python -m esptool <args>` (used for flashing — its own progress
    output is nicer live than anything we'd capture)."""
    import subprocess
    cmd = [sys.executable, "-m", "esptool"] + args
    if capture:
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        return r.returncode, r.stdout.decode("utf-8", "replace")
    return subprocess.call(cmd), ""


def run_detection(src, port, attempts=2):
    """Connect, print the chip banner, RAM-load the detector (no flash write),
    and read its one-shot output on the SAME open port. Doing it in-process —
    exactly like the browser keeps one Web Serial port — avoids the close/reopen
    gap that silently dropped the detector's output on native-USB boards. Retries
    a pass that finds the anchor but misses a peripheral confirm (no
    `DETECTED: hw-…`). Returns (chip_found, detect_lines)."""
    from esptool.cmds import detect_chip, load_ram
    data = src.read_bytes("detect/spangap_detect.bin")
    result = []
    for attempt in range(attempts):
        try:
            esp = detect_chip(port, baud=115200)      # resets into ROM, prints chip info
        except Exception as e:
            print("  (couldn't connect to the chip: %s)" % e)
            return (False, result)
        try:
            load_ram(esp, data)                       # loads segments + jumps to entry
            ser = esp._port                           # same open port — no gap, no reopen
            ser.timeout = 0.2
            print("Detecting peripherals…" if attempt == 0 else "Trying detection again…")
            lines, buf, deadline = [], "", time.time() + 10
            while time.time() < deadline:
                chunk = ser.read(256)
                if chunk:
                    buf += chunk.decode("utf-8", "replace")
                    if "SPANGAP-DETECT-END" in buf:
                        break
            for line in buf.splitlines():
                line = strip_ansi(line).strip()
                if line.startswith("DETECT:"):
                    t = line[len("DETECT:"):].lstrip()
                    if t and t != "SPANGAP-DETECT-END":
                        lines.append(t)
                        print("  " + t)
            result = lines
        finally:
            try:
                esp._port.close()
            except Exception:
                pass
        if detected_hw(result):
            break
        if attempt + 1 < attempts:
            print("  (board not identified this pass — one more try…)")
    return (True, result)


def flash_image(src, rel, port):
    """Download the image zip at `rel`, unpack it, and write every image at its
    offset. Returns True on success."""
    zbytes = src.read_bytes(rel)
    tmpdir = tempfile.mkdtemp(prefix="flashmon-")
    zipfile.ZipFile(io.BytesIO(zbytes)).extractall(tmpdir)
    args_path = os.path.join(tmpdir, "flasher_args.json")
    if not os.path.exists(args_path):
        print("flasher.zip has no flasher_args.json"); return False
    with open(args_path) as f:
        fargs = json.load(f)
    settings = fargs.get("flash_settings", {})
    files = fargs.get("flash_files", {})
    if not files:
        print("flasher_args.json lists no flash_files"); return False

    args = ["--chip", "esp32s3", "-p", port, "-b", "460800", "write_flash"]
    if settings.get("flash_mode"):
        args += ["--flash_mode", settings["flash_mode"]]
    if settings.get("flash_freq"):
        args += ["--flash_freq", settings["flash_freq"]]
    if settings.get("flash_size"):
        args += ["--flash_size", settings["flash_size"]]
    for off, fname in sorted(files.items(), key=lambda kv: int(kv[0], 16)):
        args += [off, os.path.join(tmpdir, fname)]
    rc, _ = _esptool(args)
    return rc == 0


# ── guided setup + web-UI address (plain, line-oriented) ─────────────────────
def reset_device(ser):
    """Hard-reset into the app: assert RTS (EN low = reset), hold, release. DTR
    stays low so GPIO0 is high and the chip boots firmware, not the ROM stub."""
    ser.dtr = False
    ser.rts = True
    time.sleep(0.1)
    ser.rts = False


def hr():
    print("─" * 64)


def guided_setup(port, host_default):
    """Reset into firmware and watch the boot log: run the one-time password /
    WiFi setup for a fresh device, and print its web-UI address once it's online.
    Single-threaded and line-oriented so it stays readable, then hands off to the
    monitor. Leaves the device running (the monitor attaches with --no-reset)."""
    import serial
    try:
        ser = serial.Serial(port, 115200, timeout=0.4)
    except Exception as e:
        print("(couldn't open %s to watch boot: %s)" % (port, e))
        return
    hr(); print("Booting the device — setup prompts appear below if it's new."); hr()
    try:
        reset_device(ser)
    except Exception:
        pass

    aps = {}
    need_passwd = ap = connected = sent = False
    hostname = None
    buf, deadline = "", time.time() + 18
    try:
        while time.time() < deadline:
            try:
                data = ser.read(256)
            except Exception:
                break
            if data:
                buf += data.decode("utf-8", "replace")
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    line = strip_ansi(line).rstrip("\r")
                    if line:
                        print(line)
                    m = re.search(r'scan found "(.*)" (-?\d+)dBm(.*)$', line)
                    if m and m.group(1):
                        aps[m.group(1)] = bool(re.search(r"\bopen\b", m.group(3)))
                        continue
                    if "No device password set" in line:
                        need_passwd = True
                        continue
                    if re.search(r"\bAP ssid=\S+ ip=\S+", line):
                        ap = True
                        continue
                    m = re.search(r'Connected "(.*)" ip (\S+) dns (\S+)(?: host (\S+))?', line)
                    if m:
                        connected = True
                        ip = m.group(2)
                        if m.group(4):
                            hostname = m.group(4)
                        host = hostname or host_default
                        hr()
                        print("Device is online.")
                        print("  Web UI:  https://%s.local/    (or  https://%s/ )" % (host, ip))
                        print("  Accept the one-time certificate warning; be on the same network.")
                        hr()
                        continue

            # Once the WiFi outcome is known (its own AP, or joined a network),
            # run setup if the device is fresh — asking password AND WiFi together.
            if not sent and (ap or connected):
                sent = True
                cmd = ""
                if need_passwd:
                    pw = input("\nThis device has no password yet. Type one to set it "
                               "(or leave blank to skip): ").strip()
                    if pw:
                        cmd += "auth passwd admin %s\n" % pw
                if ap:
                    default = hostname or host_default
                    host = input("Device name for <name>.local [%s]: " % default).strip() or default
                    if aps:
                        print("Networks found: " + ", ".join(sorted(aps)))
                    ssid = input("Join which WiFi network? Type its name (blank to skip): ").strip()
                    if ssid:
                        pw2 = "" if aps.get(ssid) else input('WiFi password for "%s": ' % ssid)
                        cmd += "hostname %s\n" % host
                        cmd += 'net add "%s"' % ssid + ((' "%s"' % pw2) if pw2 else "") + "\n"
                        hostname = host
                if cmd:
                    ser.write((cmd + "save\n\n").encode("utf-8"))
                    print("-- setup sent; waiting for it to join… --")
                    deadline = time.time() + 20   # give it time to connect
                else:
                    break                         # nothing to set up → hand off

            if connected:
                break
    finally:
        try:
            ser.close()
        except Exception:
            pass
    time.sleep(0.3)   # let the OS release the port before the monitor grabs it


def launch_monitor(port):
    """Hand the terminal to esp-idf's own monitor (robust key handling, panic
    decoding). --no-reset because guided_setup already booted the firmware."""
    hr()
    print("Opening the serial monitor (esp-idf-monitor).")
    print("  Ctrl-]        quit the monitor")
    print("  Ctrl-T Ctrl-R reset the device        Ctrl-T Ctrl-H  more shortcuts")
    hr()
    sys.stdout.flush()
    os.execv(sys.executable, [sys.executable, "-m", "esp_idf_monitor",
                              "--port", port, "--baud", "115200", "--no-reset"])


# ── full-screen TUI monitor (curses) ────────────────────────────────────────
# Started only AFTER all esptool work is done, so the terminal is clean and
# keystrokes behave. While it's provisioning a fresh device the bottom third is a
# dialog and the log scrolls above it; once provisioning is finished the dialog
# collapses and the log goes full-screen — same idea as the web version's
# floating dialogs. Only the main thread touches curses; the reader thread just
# appends to the shared buffer under a lock.
class MonitorTUI:
    def __init__(self, scr, port, project, host_default, src, cfg, hw):
        import curses
        self.c = curses
        self.scr = scr
        self.port = port
        self.project = project
        self._host_default = host_default
        # Flash offer, evaluated live inside the monitor: `src`/`cfg` locate and
        # date the catalogue images, `hw` is the detected board. We resolve the best
        # existing image once (and again when the catalogue file changes), and only
        # offer to flash it when its stamp is newer than the running firmware's.
        self.src = src
        self.cfg = cfg
        self.hw = hw
        self.device_version = None    # running build stamp, from `build: datetime` log
        self._img_name = None         # best existing image for hw (name / zip path)
        self._img_rel = None
        self.flash_name = None        # the offer, when the image is newer (else None)
        self.flash_rel = None
        self.action = None            # run() reads this: ("flash", rel, name) or None
        self._cfg_mtime = src.local_config_mtime()
        self._next_poll = 0.0         # next catalogue-file mtime check
        self._version_deadline = 0.0  # grace: hold the offer until the stamp lands
        self.lock = threading.Lock()
        self.lines = []               # device stream; each line is a list of
        self.curline = []             # (char, curses-attr) cells (so colour survives)
        self.col = 0                  # cursor column within curline (single-line VT)
        self._esc = ""                # incomplete trailing escape carried across reads
        self._fg = -1                 # current SGR foreground (-1 = default)
        self._style = 0               # current SGR style bits (bold/dim/underline/reverse)
        self.cur_attr = 0             # curses attr stamped onto newly-written cells
        self.stop = False
        self.ser = None
        # net-log state (reader thread; guarded by self.lock)
        self.aps = {}
        self.need_passwd = False
        self.need_wifi = False
        self.connected = False
        self.online = False
        self.hostname = None
        self.hostname_queried = False
        self.ip = None
        self.ui_url = None            # web-UI address once online (bottom footer)
        # flashmon's own messages go to the bottom, never into the stream
        self.notice = ""
        self.notice_until = 0.0
        # provisioning dialog (main thread): None → not started, 'done' → collapsed
        self.pstate = None            # None|'passwd'|'hostname'|'ssid'|'ssid_manual'|'wifipass'|'done'
        self.dmode = "text"           # 'text' | 'select'
        self.dmask = False            # text field shows *** (passwords)
        self.question = ""
        self.field = ""
        self.options = []             # [(value, label)] for select mode
        self.sel = 0
        self.pdata = {}
        self.ui_press = 0
        # Colour: the 8 ANSI colours share curses' COLOR_* order, so pair i = fg i
        # on the default background. Falls back to monochrome if unsupported.
        self.colors_ok = False
        self.ncolors = 0
        try:
            if curses.has_colors():
                curses.start_color()
                curses.use_default_colors()
                self.ncolors = min(curses.COLORS, 16)   # 16 → real bright colours
                for i in range(1, self.ncolors):
                    curses.init_pair(i, i, -1)
                self.colors_ok = True
        except Exception:
            pass
        scr.timeout(60)               # getch returns -1 after 60 ms → live redraw

    # -- top region: device serial stream (fed by the reader thread) ---------
    def _feed(self, text):
        # A tiny single-line terminal for the current (uncommitted) line, so the
        # device's line-editing redraws render right: \r moves the cursor to
        # column 0 (does NOT wipe), \b moves left, printable chars overwrite/extend
        # at the cursor, \x1b[K erases from the cursor to end, and \n commits the
        # line. Colour/other escapes are dropped. Without this, a backspace redraw
        # (\r + reprint + erase, sometimes a 2nd \r) came out garbled.
        with self.lock:
            data = self._esc + text
            self._esc = ""
            i, n = 0, len(data)
            while i < n:
                ch = data[i]
                if ch == "\x1b":
                    m = ANSI_RE.match(data, i)
                    if m:
                        self._csi(m.group(0)); i = m.end(); continue
                    if CSI_PARTIAL_RE.match(data, i):
                        self._esc = data[i:]; break        # split across reads → carry over
                    i += 1; continue                       # non-CSI escape → drop the ESC
                if ch == "\n":
                    self.lines.append(self.curline)
                    self.curline, self.col = [], 0
                elif ch == "\r":
                    self.col = 0
                elif ch in ("\b", "\x7f"):
                    self.col = max(0, self.col - 1)
                elif ch >= " " or ch == "\t":
                    cell = (ch, self.cur_attr)
                    if self.col < len(self.curline):
                        self.curline[self.col] = cell
                    else:
                        self.curline.append(cell)
                    self.col += 1
                i += 1
            self._trim()

    def _csi(self, seq):
        final, params = seq[-1], seq[2:-1]
        if final in ("K", "J"):                # erase in line (K) / display (J)
            if (params or "0") == "0":         # from cursor → end (the common case)
                self.curline = self.curline[:self.col]
            elif params == "2":                # whole line / screen
                self.curline, self.col = [], 0
        elif final == "m":                     # SGR — colour / style
            self._set_sgr(params)
        elif final == "G":                     # move to absolute column (1-based)
            try: self.col = max(0, int(params or "1") - 1)
            except ValueError: pass
        elif final == "C":                     # cursor right
            try: self.col += int(params or "1")
            except ValueError: pass
        elif final == "D":                     # cursor left
            try: self.col = max(0, self.col - int(params or "1"))
            except ValueError: pass
        # else: cursor up/down (A/B), show/hide, etc. — ignored

    def _set_sgr(self, params):
        if not self.colors_ok:
            return
        c = self.c
        codes = params.split(";") if params else ["0"]
        i = 0
        while i < len(codes):
            n = int(codes[i]) if codes[i].isdigit() else 0
            if n in (38, 48):                  # 256/truecolour — skip its arguments
                i += 3 if (i + 1 < len(codes) and codes[i + 1] == "5") else \
                     5 if (i + 1 < len(codes) and codes[i + 1] == "2") else 1
                continue
            if n == 0:    self._fg, self._style = -1, 0
            elif n == 1:  self._style |= c.A_BOLD
            elif n == 2:  self._style |= c.A_DIM
            elif n == 4:  self._style |= c.A_UNDERLINE
            elif n == 7:  self._style |= c.A_REVERSE
            elif n == 22: self._style &= ~(c.A_BOLD | c.A_DIM)
            elif n == 24: self._style &= ~c.A_UNDERLINE
            elif n == 27: self._style &= ~c.A_REVERSE
            elif 30 <= n <= 37: self._fg = n - 30
            elif n == 39: self._fg = -1
            elif 90 <= n <= 97:
                if self.ncolors >= 16:
                    self._fg = n - 90 + 8        # true bright colours (8 = grey)
                else:
                    self._fg, self._style = n - 90, self._style | c.A_BOLD
            i += 1
        pair = c.color_pair(self._fg) if 1 <= self._fg < self.ncolors else 0
        self.cur_attr = pair | self._style

    def _trim(self):
        if len(self.lines) > 5000:
            self.lines = self.lines[-4000:]

    def _notify(self, msg):           # flashmon → user; shown briefly on the status bar
        self.notice = msg
        self.notice_until = time.time() + 4

    def _send(self, s):
        try:
            self.ser.write(s.encode("utf-8"))
        except Exception:
            pass

    def host_default(self):
        return self.hostname or self._host_default

    # -- reader thread: serial → stream + net-log parse (no curses here) ------
    def _reader(self):
        buf = ""
        while not self.stop:
            try:
                data = self.ser.read(256)
            except Exception:
                break
            if not data:
                continue
            text = data.decode("utf-8", "replace")
            self._feed(text)
            buf += text
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                self._net(strip_ansi(line).rstrip("\r"))
            if len(buf) > 4096:
                buf = buf[-1024:]

    def _net(self, line):
        with self.lock:               # held for the whole body
            # `build: datetime <YYYYMMDDhhmmss>` — the running firmware's catalogue
            # stamp. Remember it and re-evaluate the offer (no I/O under the lock).
            m = re.search(r"build: datetime (\d{14})", line)
            if m:
                self.device_version = m.group(1)
                self._refresh_flash()
                return
            m = re.search(r'scan found "(.*)" (-?\d+)dBm(.*)$', line)
            if m and m.group(1):
                self.aps[m.group(1)] = bool(re.search(r"\bopen\b", m.group(3)))
                return
            if "No device password set" in line:
                self.need_passwd = True
                return
            if re.search(r"\bAP ssid=\S+ ip=\S+", line):
                self.need_wifi = True
                return
            m = re.match(r"^s\.net\.hostname = (\S+)", line)
            if m:
                self.hostname = m.group(1)
                if self.online:
                    self.ui_url = "https://%s.local/" % self.hostname
                return
            m = re.search(r'Connected "(.*)" ip (\S+) dns (\S+)(?: host (\S+))?', line)
            if m:
                self.connected = True
                self.online = True
                self.ip = m.group(2)
                if m.group(4):
                    self.hostname = m.group(4)
                elif not self.hostname_queried:
                    self.hostname_queried = True
                    self._send("show s.net.hostname\n\n")
                self.ui_url = "https://%s.local/" % (self.hostname or self._host_default)
                return

    # -- flash offer ---------------------------------------------------------
    def _resolve_image(self):
        """Find the best image for the detected board that actually exists in the
        source (does I/O — call from the main thread only), then re-evaluate the
        offer. Re-run when the catalogue file changes."""
        names = [b["name"] for b in self.cfg.get("builds", [])]
        found_name = found_rel = None
        for cand in build_candidates(self.hw or "", names):
            for rel in (build_rel(self.cfg, cand), "builds/%s.zip" % cand):
                try:
                    if self.src.exists(rel):
                        found_name, found_rel = cand, rel
                        break
                except Exception:
                    pass
            if found_name:
                break
        with self.lock:
            self._img_name, self._img_rel = found_name, found_rel
            self._refresh_flash()

    def _refresh_flash(self):
        """Set the offer from the resolved image + stamps. No I/O — safe to call
        under self.lock (from the reader thread). Offer the image UNLESS we know the
        device is already at or past its stamp; an unknown device stamp or an
        unstamped catalogue entry stays offerable."""
        name, rel = self._img_name, self._img_rel
        if not name:
            self.flash_name = self.flash_rel = None
            return
        cv = ""
        for b in self.cfg.get("builds", []):
            if b.get("name") == name:
                cv = b.get("version", "") or ""
                break
        dv = self.device_version
        if (not cv) or (not dv) or (cv > dv):
            self.flash_name, self.flash_rel = name, rel
        else:
            self.flash_name = self.flash_rel = None

    def _flash_ready(self):
        """Show the offer only once the device's stamp has had a chance to arrive,
        so a current device doesn't briefly advertise a pointless re-flash."""
        return bool(self.flash_name) and (
            self.device_version is not None or time.time() >= self._version_deadline)

    def _poll_catalogue(self):
        """Every 10 s, re-read the catalogue when its local file's mtime changed, so
        a build published while the monitor is open becomes offerable without a
        restart. A URL source reports no mtime and so isn't polled."""
        now = time.time()
        if now < self._next_poll:
            return
        self._next_poll = now + 10
        mt = self.src.local_config_mtime()
        if mt == self._cfg_mtime:
            return
        self._cfg_mtime = mt
        try:
            newcfg = resolve_config(self.src)
        except Exception:
            return
        with self.lock:
            self.cfg = newcfg
        self._resolve_image()
        self._notify("catalogue updated")

    # -- provisioning dialog (main thread) -----------------------------------
    def _dialog_active(self):
        return self.pstate is not None and self.pstate != "done"

    def _ask_text(self, state, question, mask=False):
        self.pstate, self.dmode, self.question, self.field, self.dmask = \
            state, "text", question, "", mask

    def _ask_select(self, state, question, options):
        self.pstate, self.dmode, self.question, self.options, self.sel = \
            state, "select", question, options, 0

    def _ask_ssid(self):
        with self.lock:
            aps = sorted(self.aps.items())
        opts = [(s, "%s%s" % (s, "  (open)" if o else "")) for s, o in aps]
        opts += [("__other__", "‹ type another network ›"), ("__skip__", "‹ skip WiFi ›")]
        self._ask_select("ssid", "Join which WiFi network?", opts)

    def _advance(self):
        if self.pstate is not None:
            return
        with self.lock:
            need_passwd, ap, connected = self.need_passwd, self.need_wifi, self.connected
        # Wait until the WiFi outcome is known (own AP, or joined) before asking,
        # so a fresh device is prompted for password AND WiFi together.
        if not (ap or connected):
            return
        if need_passwd:
            self._ask_text("passwd", "This device has no admin password set. Enter one now.", mask=True)
        elif ap:
            self._ask_text("hostname", "Device name for <name>.local [%s]:" % self.host_default())
        else:
            self.pstate = "done"      # connected, nothing to set up → full-screen

    def _dialog_key(self, k):
        c = self.c
        if self.dmode == "select":
            if k in (c.KEY_UP, ord("k")):
                self.sel = (self.sel - 1) % len(self.options)
            elif k in (c.KEY_DOWN, ord("j")):
                self.sel = (self.sel + 1) % len(self.options)
            elif k in (c.KEY_ENTER, 10, 13):
                self._submit()
            elif k == 27:
                while self.scr.getch() != -1:
                    pass
            return
        # text mode
        if k in (c.KEY_ENTER, 10, 13):
            self._submit()
        elif k in (c.KEY_BACKSPACE, 127, 8):
            self.field = self.field[:-1]
        elif k == 27:
            while self.scr.getch() != -1:
                pass
        elif 32 <= k <= 126:
            self.field += chr(k)

    def _after_passwd(self):
        if self.need_wifi:
            self._ask_text("hostname", "Device name for <name>.local [%s]:" % self.host_default())
        else:
            self._finalize()

    def _submit(self):
        st = self.pstate
        if self.dmode == "select":
            val = self.options[self.sel][0]
        else:
            val = self.field.strip() if st in ("hostname", "ssid_manual") else self.field
        if st == "passwd":
            if not val:                       # empty just moves on (not advertised)
                self.pdata.pop("passwd", None)
                self._after_passwd()
            else:
                self.pdata["passwd_try"] = val
                self._ask_text("passwd2", "Type the password again to confirm:", mask=True)
        elif st == "passwd2":
            if val == self.pdata.get("passwd_try"):
                self.pdata["passwd"] = val
                self.pdata.pop("passwd_try", None)
                self._after_passwd()
            else:
                self.pdata.pop("passwd_try", None)
                self._ask_text("passwd", "Passwords didn't match — try again:", mask=True)
        elif st == "hostname":
            self.pdata["hostname"] = val or self.host_default()
            self._ask_ssid()
        elif st == "ssid":                      # picked from the list
            if val == "__skip__":
                self._finalize()
            elif val == "__other__":
                self._ask_text("ssid_manual", "Type the network name:")
            else:
                self.pdata["ssid"] = val
                if self.aps.get(val, False):
                    self._finalize()            # open network, no password
                else:
                    self._ask_text("wifipass", 'WiFi password for "%s":' % val, mask=True)
        elif st == "ssid_manual":
            if not val:
                self._finalize()
            else:
                self.pdata["ssid"] = val
                self._ask_text("wifipass", 'WiFi password for "%s" (blank = open):' % val, mask=True)
        elif st == "wifipass":
            self.pdata["wifipass"] = val
            self._finalize()

    def _finalize(self):
        cmd = ""
        if self.pdata.get("passwd"):
            cmd += "auth passwd admin %s\n" % self.pdata["passwd"]
        if self.pdata.get("ssid"):
            cmd += "hostname %s\n" % self.pdata.get("hostname", self.host_default())
            pw = self.pdata.get("wifipass", "")
            cmd += 'net add "%s"' % self.pdata["ssid"] + ((' "%s"' % pw) if pw else "") + "\n"
        if cmd:
            self._send(cmd + "save\n\n")
            self._notify("setup sent — waiting for the device to join…")
        self.pstate = "done"          # collapse dialog → full-screen log

    def _open_ui(self, force_ip=False):
        import webbrowser
        with self.lock:
            host, ip = self.hostname or self._host_default, self.ip
        if force_ip:
            if not ip:
                self._notify("no IP known yet"); return
            url = "https://%s/" % ip
        else:
            self.ui_press += 1
            url = ("https://%s/" % ip) if (self.ui_press >= 2 and ip) else ("https://%s.local/" % host)
        self._notify("opening %s" % url)
        try:
            webbrowser.open(url)
        except Exception as e:
            self._notify("couldn't open a browser (%s) — open %s yourself" % (e, url))

    # -- drawing (main thread only) ------------------------------------------
    def _draw_cells(self, row, cells, w):
        """Render a line of (char, attr) cells as attribute runs."""
        c, scr = self.c, self.scr
        x, i, n = 0, 0, len(cells)
        while i < n and x < w - 1:
            attr = cells[i][1]
            j = i
            while j < n and cells[j][1] == attr:
                j += 1
            s = "".join(ch for ch, _ in cells[i:j])
            try:
                scr.addnstr(row, x, s, w - 1 - x, attr)
            except c.error:
                pass
            x += len(s)
            i = j

    def _draw_select(self, top, bottom, w):
        c, scr = self.c, self.scr
        avail = max(1, bottom - top)
        n = len(self.options)
        start = max(0, min(self.sel - avail // 2, n - avail))
        for i in range(start, min(n, start + avail)):
            attr = c.A_REVERSE if i == self.sel else c.A_NORMAL
            try:
                scr.addnstr(top + (i - start), 3, " %s " % self.options[i][1], w - 4, attr)
            except c.error:
                pass

    def _draw(self):
        c, scr = self.c, self.scr
        scr.erase()
        h, w = scr.getmaxyx()
        dlg_h = max(6, h // 3) if self._dialog_active() else 1
        log_h = max(1, h - dlg_h)
        with self.lock:
            rows = list(self.lines[-log_h:])
            cur = list(self.curline)          # copy: the reader thread mutates it
        if cur:
            if len(rows) >= log_h:
                rows = rows[1:]
            rows.append(cur)
        for i, cells in enumerate(rows[-log_h:]):
            self._draw_cells(i, cells, w)
        top = log_h
        if self._dialog_active():
            try:
                scr.hline(top, 0, c.ACS_HLINE, w)
                scr.addnstr(top + 1, 1, self.question, w - 2, c.A_BOLD)
            except c.error:
                pass
            if self.dmode == "select":
                self._draw_select(top + 2, h - 1, w)
                foot = " ↑/↓ choose · Enter select "
            else:
                try:
                    shown = "*" * len(self.field) if self.dmask else self.field
                    scr.addnstr(top + 2, 1, "> " + shown, w - 2)
                except c.error:
                    pass
                foot = " Enter = confirm · Backspace edits · blank = skip "
            try:
                scr.addnstr(h - 1, 1, foot, w - 2, c.A_DIM)
            except c.error:
                pass
        else:
            if self.notice and time.time() < self.notice_until:
                bar = " " + self.notice
            elif self._flash_ready():
                bar = (" %s · F6 = flash newer build · Ctrl-] quit · F5 reset · "
                       "F8 UI · F9 UI via IP-addr " % self.project)
            else:
                bar = (" %s · Ctrl-] quit · F5 reset · F8 open UI · F9 UI via IP-addr · "
                       "type for device CLI " % self.project)
            try:
                scr.attron(c.A_REVERSE)
                scr.addnstr(h - 1, 0, bar.ljust(w - 1), w - 1)
                scr.attroff(c.A_REVERSE)
            except c.error:
                pass
        scr.refresh()

    # -- main loop ------------------------------------------------------------
    def run(self):
        import serial
        c = self.c
        try:
            self.ser = serial.Serial(self.port, 115200, timeout=0.2)
        except Exception as e:
            self.scr.addstr(0, 0, "Couldn't open %s: %s  (press a key)" % (self.port, e))
            self.scr.timeout(-1); self.scr.getch()
            return
        try:
            reset_device(self.ser)
        except Exception:
            pass
        threading.Thread(target=self._reader, daemon=True).start()
        # Grace window: the device logs its build stamp a moment after the reset
        # above; hold the flash offer until then (or this deadline) so a current
        # device never flashes the offer on the way there.
        self._version_deadline = time.time() + 4
        self._next_poll = time.time() + 10
        self._resolve_image()                 # initial offer (I/O; main thread)
        # Trap Ctrl-C so it can't abort the monitor mid-session. It's swallowed
        # (not forwarded to the device); Ctrl-] quits, like esp-idf-monitor.
        old_sigint = signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            while True:
                self._advance()
                self._poll_catalogue()
                self._draw()
                k = self.scr.getch()
                if k == -1:
                    continue
                if k in (29, c.KEY_F10):              # Ctrl-] (or F10) → quit
                    return self.action
                if k == c.KEY_F6:                    # flash the newer build (if offered)
                    if self._flash_ready():
                        with self.lock:
                            self.action = ("flash", self.flash_rel, self.flash_name)
                        return self.action
                    continue
                if self._dialog_active():
                    self._dialog_key(k)
                    continue
                # monitor mode: hotkeys, else forward typing to the device CLI.
                if k == c.KEY_F5:
                    self._notify("reset sent")
                    try:
                        reset_device(self.ser)
                    except Exception as e:
                        self._notify("reset failed: %s" % e)
                    continue
                if k == c.KEY_F8:
                    self._open_ui(); continue
                if k == c.KEY_F9:
                    self._open_ui(force_ip=True); continue
                if k == 27:
                    while self.scr.getch() != -1:
                        pass
                    continue
                if k in (c.KEY_ENTER, 10, 13):
                    self._send("\r")
                elif k in (c.KEY_BACKSPACE, 127, 8):
                    self._send("\x7f")
                elif k == 9:
                    self._send("\t")
                elif 32 <= k <= 126 or 1 <= k <= 26:
                    self._send(chr(k))
        finally:
            signal.signal(signal.SIGINT, old_sigint)
            self.stop = True
            time.sleep(0.2)
            try:
                self.ser.close()
            except Exception:
                pass


# ── curses menu (arrow-key selection) ────────────────────────────────────────
def curses_menu(title, options):
    """Full-screen arrow-key menu. `title` may contain newlines (a header shown
    above the choices). Returns the chosen index, or None if the user quit. Runs
    in its own short-lived curses session so the surrounding plain-text esptool
    work keeps a clean terminal."""
    import curses

    def _run(scr):
        curses.curs_set(0)
        scr.keypad(True)
        header = title.split("\n")
        idx = 0
        while True:
            scr.erase()
            h, w = scr.getmaxyx()
            row = 0
            for i, tl in enumerate(header):
                try:
                    scr.addnstr(row, 0, tl, w - 1, curses.A_BOLD if i == 0 else curses.A_NORMAL)
                except curses.error:
                    pass
                row += 1
            row += 1
            for i, label in enumerate(options):
                attr = curses.A_REVERSE if i == idx else curses.A_NORMAL
                try:
                    scr.addnstr(row + i, 2, " %s " % label, w - 3, attr)
                except curses.error:
                    pass
            try:
                scr.addnstr(h - 1, 0, " ↑/↓ move · Enter select · q quit ", w - 1, curses.A_DIM)
            except curses.error:
                pass
            scr.refresh()
            k = scr.getch()
            if k in (curses.KEY_UP, ord("k")):
                idx = (idx - 1) % len(options)
            elif k in (curses.KEY_DOWN, ord("j")):
                idx = (idx + 1) % len(options)
            elif k in (curses.KEY_ENTER, 10, 13):
                return idx
            elif k in (ord("q"), 27):
                return None

    return curses.wrapper(_run)


def choose_port(preset=None):
    from serial.tools import list_ports
    if preset:
        return preset
    ports = list(list_ports.comports())
    if not ports:
        print("No serial ports found. Plug the device in and run again.")
        return None
    if len(ports) == 1:
        return ports[0].device
    labels = ["%-26s %s" % (p.device, (p.description or "").strip()) for p in ports]
    i = curses_menu("Select the serial port your device is connected to:", labels)
    return ports[i].device if i is not None else None


# ── main ─────────────────────────────────────────────────────────────────────
def _simple_flow(src, cfg, args, ui_port, hw, project, host_default):
    """`--simple` fallback: esp-idf-monitor can't host our live, version-gated flash
    offer, so give a one-shot pre-monitor flash choice (unconditional — we can't
    observe the running build here), then guided setup and esp-idf-monitor."""
    names = [b["name"] for b in cfg.get("builds", [])]
    chosen = chosen_rel = None
    for cand in build_candidates(hw or "", names):
        for rel in (build_rel(cfg, cand), "builds/%s.zip" % cand):
            if src.exists(rel):
                chosen, chosen_rel = cand, rel
                break
        if chosen:
            break
    if chosen:
        label = ("Flash %s (generic build)" % project if chosen == "generic"
                 else "Flash %s to %s" % (project, hw[3:] if hw else chosen))
        i = curses_menu("What next?",
                        [label + ", then monitor", "Open the serial monitor", "Quit"])
        if i is None or i == 2:
            return
        if i == 0:
            hr(); print("Flashing %s…" % chosen); hr()
            if not flash_image(src, chosen_rel, ui_port):
                print("Flash FAILED — not opening the monitor.")
                return
            print("Flash complete.")
    guided_setup(ui_port, host_default)
    launch_monitor(ui_port)          # replaces this process; never returns


def run(src, cfg, args):
    project = cfg.get("project", "flashmon")
    hr(); print("%s — flasher / monitor" % project); hr()

    port = choose_port(args.port)
    if not port:
        return
    ui_port = port

    found, detected = run_detection(src, port)
    if not found:
        print("No ESP32 detected (or couldn't connect) — you can still open the monitor.")
    hw = detected_hw(detected)
    if hw:
        print("Detected board: %s" % hw[3:])
    elif found:
        print("Chip detected, but no catalogued board matched.")
    for l in detected:
        if not l.startswith("DETECTED:"):
            print("  " + l)

    # Default device name (mDNS/DHCP label) for the setup prompts: the project
    # name, lowercased and reduced to the legal charset.
    host_default = re.sub(r"[^a-z0-9_]", "", project.lower()) or "device"

    if getattr(args, "simple", False):
        _simple_flow(src, cfg, args, ui_port, hw, project, host_default)
        return

    # Default: our full-screen TUI monitor. It resets the device, splits the screen
    # for provisioning, then goes full-screen. The flash offer lives INSIDE it —
    # shown only when the catalogue holds a build newer than the running firmware,
    # re-checked as the catalogue file changes. Flashing exits curses, runs esptool
    # in the clean terminal, then re-enters the monitor on the fresh build.
    import curses
    while True:
        action = curses.wrapper(
            lambda scr: MonitorTUI(scr, ui_port, project, host_default, src, cfg, hw).run())
        if not (action and action[0] == "flash"):
            break
        _, rel, name = action
        hr(); print("Flashing %s…" % name); hr()
        print("Flash complete — reopening the monitor." if flash_image(src, rel, ui_port)
              else "Flash FAILED — reopening the monitor.")
        time.sleep(0.5)              # let the OS release the port before re-open


def resolve_source(args):
    """Where config + images come from. Explicit --url/--dir win; else files
    co-located with the script (a `make-zip` bundle, or a served folder); else the
    baked-in PROJECT_URL; else the current directory."""
    sd = _script_dir()
    if args.url:
        return Source(args.url, sd)
    if args.dir:
        return Source(None, args.dir)
    if os.path.exists(os.path.join(sd, "flashmon.yaml")) or \
       os.path.exists(os.path.join(sd, "flashmon.local.yaml")):
        return Source(None, sd)           # bundle / co-located files → offline-capable
    if PROJECT_URL:
        return Source(PROJECT_URL, sd)    # baked-in deployment URL
    return Source(None, ".")              # last resort: current directory


def _brand_name(project):
    return _project_slug(project) + "-flashmon"


def _read_local_config(sd):
    p = os.path.join(sd, "flashmon.yaml")
    if not os.path.exists(p):
        sys.exit("no flashmon.yaml next to the script — run this in a flashmon folder "
                 "(with flashmon.yaml, a built builds/ and detect/).")
    return parse_config(open(p, encoding="utf-8").read())


def write_branded(sd, cfg):
    """Copy this script to <project>-flashmon with PROJECT_URL baked in from the
    config's `url:`, so a downloaded copy knows where to fetch from. Returns
    (brand, path)."""
    brand = _brand_name(cfg.get("project"))
    src = open(os.path.abspath(__file__), encoding="utf-8").read()
    url = cfg.get("url", "")
    if url:
        src = re.sub(r'^PROJECT_URL = .*$', 'PROJECT_URL = "%s"' % url, src, count=1, flags=re.M)
    path = os.path.join(sd, brand)
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    try:
        os.chmod(path, 0o755)
    except OSError:
        pass
    return brand, path


def make_brand():
    """Just the branded standalone script (fast; for the plain-download option)."""
    sd = _script_dir()
    _, path = write_branded(sd, _read_local_config(sd))
    print("wrote %s" % path)


def _installer_index_html(project, brand, zipname, mb):
    """The download page placed next to the bundle in offline-installer/. Offers the
    zip with download disposition (the `download` attribute) and says how to run it.
    Self-contained and theme-aware — no external assets, works served or opened."""
    import html
    tmpl = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__PROJECT__ — offline installer</title>
<style>
  :root { color-scheme: light dark; --bg:#f5f6f8; --fg:#1a1d21; --mut:#5b6570;
          --card:#ffffff; --line:#e3e6ea; --accent:#2563eb; --accentfg:#ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#15171b; --fg:#e7e9ec; --mut:#9aa4af; --card:#1e2126;
            --line:#2c313a; --accent:#3b82f6; --accentfg:#ffffff; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:2rem;
         font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         background:var(--bg); color:var(--fg); }
  .card { width:100%; max-width:34rem; background:var(--card); border:1px solid var(--line);
          border-radius:14px; padding:2rem 2.25rem; }
  h1 { margin:0 0 .25rem; font-size:1.5rem; }
  .sub { margin:0 0 1.5rem; color:var(--mut); }
  .dl { display:block; text-align:center; text-decoration:none; font-weight:600;
        background:var(--accent); color:var(--accentfg); padding:.85rem 1rem;
        border-radius:10px; font-size:1.05rem; }
  .dl small { font-weight:400; opacity:.85; }
  h2 { font-size:.95rem; text-transform:uppercase; letter-spacing:.04em;
       color:var(--mut); margin:1.75rem 0 .5rem; }
  ol { margin:0; padding-left:1.2rem; }
  li { margin:.3rem 0; }
  code { background:rgba(127,127,127,.15); padding:.1rem .35rem; border-radius:5px;
         font:0.9em ui-monospace,SFMono-Regular,Menlo,monospace; }
  .note { color:var(--mut); font-size:.9rem; margin-top:1.5rem; }
</style>
</head>
<body>
  <main class="card">
    <h1>__PROJECT__ offline installer</h1>
    <p class="sub">The flasher and serial monitor with every firmware image and the
       flashing tools bundled in — nothing else to download, no internet needed.</p>
    <a class="dl" href="__ZIP__" download>Download for all platforms &nbsp;<small>(__MB__ MB)</small></a>
    <h2>Run it</h2>
    <ol>
      <li>Unzip the download.</li>
      <li>In a terminal, run <code>./__BRAND__/__BRAND__</code>
          (macOS / Linux; needs Python 3.10+).</li>
      <li>On Windows, run <code>python __BRAND__\\__BRAND__</code> from the unzipped folder.</li>
    </ol>
    <p class="note">Prefer the browser? A Chromium-based browser (Chrome, Edge, Brave,
       Opera) can flash straight from the page — no download needed.</p>
  </main>
</body>
</html>
"""
    return (tmpl.replace("__PROJECT__", html.escape(project))
                .replace("__ZIP__", html.escape(zipname, quote=True))
                .replace("__BRAND__", html.escape(brand))
                .replace("__MB__", "%.0f" % mb))


def make_zip():
    """The branded script plus a self-contained <project>-flashmon.zip — the
    script + flashmon.yaml + builds/ + detect/ + the flashing tools' wheels for
    every supported OS — so it runs fully offline anywhere. Needs internet once
    (to fetch the wheels)."""
    import subprocess
    import shutil
    from datetime import datetime, timezone
    sd = _script_dir()
    cfg = _read_local_config(sd)

    # The offline bundle carries the whole catalogue, so it only makes sense once
    # every image is built. Refuse otherwise rather than ship a half-empty zip —
    # the individual images may each carry a different build datetime.
    missing = [b["name"] for b in cfg.get("builds", [])
               if not os.path.exists(os.path.join(sd, build_rel(cfg, b["name"])))]
    if missing:
        sys.exit("make-zip: not every image is built (%s) — run a full `make` in "
                 "builds/ first." % ", ".join(missing))

    brand, branded = write_branded(sd, cfg)   # <slug>-flashmon (the script)
    print("wrote %s" % branded)
    # Stamp the bundle with its newest image's build datetime, so a full `make` run
    # (which builds every image at one stamp) names the bundle to match its images
    # rather than minting a fresh assembly time. Falls back to now only if nothing
    # in the catalogue is stamped. The script inside keeps the -flashmon name.
    vers = [b.get("version", "") for b in cfg.get("builds", []) if b.get("version")]
    bundle_dt = max(vers) if vers else datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    zipstem = "%s_%s" % (_project_slug(cfg.get("project", "")), bundle_dt)

    staging = tempfile.mkdtemp(prefix="flashmon-zip-")
    try:
        bdir = os.path.join(staging, brand)
        wheels = os.path.join(bdir, ".cache", "wheels")
        os.makedirs(wheels)

        def pip(*a):
            r = subprocess.run([sys.executable, "-m", "pip", *a,
                                "--disable-pip-version-check"],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            return r.returncode, r.stdout.decode("utf-8", "replace")

        print("make-zip: assembling the flashing tools for every platform "
              "(needs internet, a few minutes)…")
        # esptool ships as an sdist — no PyPI wheel — so `--only-binary` can never
        # fetch it. But it's pure Python: `pip wheel` builds it (and every pure
        # dependency) into universal py3-none-any wheels that run on any OS/version.
        rc, out = pip("wheel", "--wheel-dir", wheels, *DEPS)
        if rc != 0:
            sys.stderr.write(out)
            sys.exit("make-zip: couldn't build the tool wheels (pip output above).")
        # With that universal esptool wheel now in `wheels` (--find-links), resolve
        # the whole tool tree for each target: pip pulls that platform's correct
        # binary deps (cryptography, cffi, bitarray…) at the versions esptool allows,
        # which vary by platform — so a fixed pin would miss them. `wheels` is both
        # the local source and the destination; universal wheels already cover the
        # pure deps, so only per-platform binaries are added.
        missing = []
        for plat in ZIP_PLATFORMS:
            for ver in ZIP_PYVERS:
                rc, out = pip("download", "--only-binary=:all:", "--platform", plat,
                              "--python-version", ver, "--implementation", "cp",
                              "--find-links", wheels, "--dest", wheels, *DEPS)
                if rc != 0:
                    errs = [l for l in out.splitlines() if l.startswith("ERROR")]
                    missing.append("%s/py%s" % (plat, ver))
                    print("  · %s / py%s: %s" % (plat, ver,
                          errs[-1] if errs else "unresolved"))
        if missing:
            print("make-zip: warning — %d platform/version combo(s) didn't fully "
                  "resolve; an offline install there falls back to fetching online."
                  % len(missing))

        # Everything the offline run needs: the branded script, config, images and
        # the detector binary (the .cache/wheels already staged above).
        shutil.copy2(branded, os.path.join(bdir, brand))
        shutil.copy2(os.path.join(sd, "flashmon.yaml"), os.path.join(bdir, "flashmon.yaml"))
        for name in ("builds", "detect"):
            srcdir = os.path.join(sd, name)
            if os.path.isdir(srcdir):
                shutil.copytree(srcdir, os.path.join(bdir, name),
                                ignore=shutil.ignore_patterns("Makefile", "*.example"))

        # Assemble a fresh download dir, then swap it over the served one in a
        # single rename so only the latest bundle is ever offered — no accumulation
        # of old versions. The page there offers the zip with download disposition.
        newdir = os.path.join(sd, "offline-installer.new")
        served = os.path.join(sd, "offline-installer")
        shutil.rmtree(newdir, ignore_errors=True)
        os.makedirs(newdir)
        zipname = zipstem + ".zip"
        shutil.make_archive(os.path.join(newdir, zipstem), "zip", staging)
        mb = os.path.getsize(os.path.join(newdir, zipname)) / (1024 * 1024)
        with open(os.path.join(newdir, "index.html"), "w", encoding="utf-8") as f:
            f.write(_installer_index_html(cfg.get("project", "flashmon"), brand, zipname, mb))
        shutil.rmtree(served, ignore_errors=True)
        os.replace(newdir, served)
        print("make-zip: wrote offline-installer/%s (%.0f MB) — serve /offline-installer/ "
              "for the download page." % (zipname, mb))
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def main():
    cmd = sys.argv[1:2]
    if cmd == ["make-zip"]:
        return make_zip()             # uses the system pip; no flashing tools needed
    if cmd == ["make-brand"]:
        return make_brand()
    ensure_deps()
    ap = argparse.ArgumentParser(
        description="Terminal flasher + monitor for spangap devices.",
        epilog="Run `%(prog)s make-zip` to build a self-contained offline bundle.")
    ap.add_argument("--url", help="override: base URL to fetch config + images from")
    ap.add_argument("--dir", help="override: local folder holding flashmon.yaml + builds/")
    ap.add_argument("--port", help="serial port (skip the picker)")
    ap.add_argument("--simple", action="store_true",
                    help="plain text + esp-idf-monitor instead of the full-screen TUI")
    args = ap.parse_args()
    src = resolve_source(args)
    cfg = resolve_config(src)
    try:
        run(src, cfg, args)
    except KeyboardInterrupt:
        print("\nbye.")


if __name__ == "__main__":
    main()
