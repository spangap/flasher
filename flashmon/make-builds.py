#!/usr/bin/env python3
"""Build flashmon's image catalogue — the driver behind `make` in builds/.

Reads flashmon.yaml, runs each entry's `spangap build` invocation (the generic
build primitive stays in spangap; this flashmon-specific orchestration used to be
`spangap make-builds`), copies each resulting flasher.zip to
builds/<slug>_<name>_<datetime>.zip, and records per entry: that datetime as
`version:`, the minimum chip size the image needs as `flash_floor_kb:`, and the
bytes it writes as `image_bytes:`. It is the only writer of the config; the
flasher (browser or flashmon.py) only ever reads it.

The two fit numbers are read out of the build the entry just produced, so a
flasher can tell an image won't fit a board *before* downloading several
megabytes to find out. Each entry's name is also exported as
SPANGAP_BUILD_DIST, which the image reports back as `sys.build.dist`.

    python3 make-builds.py                 build every entry
    python3 make-builds.py hw-x [hw-y …]   build only these, re-stamping just them

A subset run touches only the entries it rebuilt; the rest keep their datetime
(and their already-built image). Run from anywhere inside a spangap workspace.
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone


def die(msg):
    sys.exit("make-builds: " + msg)


def find_workspace(start):
    """Walk up from `start` for spangap's workspace marker (the same file the
    `spangap` launcher looks for), so the built flasher.zip can be found under
    <workspace>/<repo>/."""
    cur = os.path.abspath(start)
    while True:
        if os.path.isfile(os.path.join(cur, "spangap.workspace.yaml")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            die("not inside a spangap workspace (no spangap.workspace.yaml above %s)"
                % start)
        cur = parent


def slug_of(project):
    return re.sub(r"[^a-z0-9]+", "-", (project or "").lower()).strip("-") or "flashmon"


def parse_catalogue(path):
    """Return (project, [(name, invocation), …]) from flashmon.yaml. No PyYAML —
    the host python3 isn't guaranteed to have it."""
    project = "flashmon"
    out = []
    name = inv = None
    in_builds = False

    def flush():
        nonlocal name, inv
        if name is not None:
            if not inv:
                die("build '%s' has no invocation" % name)
            out.append((name, inv))
        name = inv = None

    for raw in open(path, encoding="utf-8"):
        st = raw.split("#", 1)[0].strip()   # our values carry no '#'
        if not st:
            continue
        indent = len(raw) - len(raw.lstrip())
        if indent == 0 and re.match(r"^project\s*:", st):
            project = st.split(":", 1)[1].strip().strip("\"'")
            in_builds = False
            continue
        if indent == 0 and re.match(r"^builds\s*:", st):
            in_builds = True
            continue
        if indent == 0 and not st.startswith("- "):
            in_builds = False       # a later top-level key ends the builds block
            continue
        if not in_builds:
            continue
        if st.startswith("- "):
            flush()
            st = st[2:].strip()
        k, _, v = st.partition(":")
        k, v = k.strip(), v.strip().strip("\"'")
        if k == "name":
            name = v
        elif k == "invocation":
            inv = v
    flush()
    return project, out


def sdkconfig_values(path):
    """The `<repo>/esp-idf/sdkconfig` a build left behind, as a flat dict.

    Every entry builds in the same repo directory, so this file describes only
    the most recent build and the next one overwrites it — read it immediately
    after the build it belongs to."""
    out = {}
    try:
        with open(path, encoding="utf-8") as f:
            for raw in f:
                st = raw.strip()
                if st.startswith("#") or "=" not in st:
                    continue
                k, _, v = st.partition("=")
                out[k.strip()] = v.strip().strip('"')
    except OSError:
        pass
    return out


def flash_floor_kb(sdk):
    """The minimum chip size this image needs, in KB. 0 when unknown.

    CONFIG_SPANGAP_MAX_FIRMWARE_KB is the flash offset where the runtime /state
    partition begins, and the image is size-agnostic above it (bootable on any
    chip at or above that offset), so the offset *is* the floor. 0 there means
    "fill the container", in which case the floor is the declared container
    size. Reading these is why no `spangap build` change is needed: the config
    is something the build already produced."""
    try:
        kb = int(sdk.get("CONFIG_SPANGAP_MAX_FIRMWARE_KB", "0"))
    except ValueError:
        kb = 0
    if kb:
        return kb
    m = re.match(r"^(\d+)MB$", sdk.get("CONFIG_ESPTOOLPY_FLASHSIZE", ""))
    return int(m.group(1)) * 1024 if m else 0


def image_bytes(zip_path):
    """Total bytes this image writes to flash. 0 when unreadable.

    The sum of exactly the files flasher_args.json lists, which is both what a
    download of this entry costs and what has to fit. Recorded so a flasher can
    tell an image won't fit *before* fetching several megabytes to find out."""
    try:
        with zipfile.ZipFile(zip_path) as z:
            args = json.loads(z.read("flasher_args.json"))
            want = set(args.get("flash_files", {}).values())
            return sum(i.file_size for i in z.infolist() if i.filename in want)
    except (OSError, KeyError, ValueError, zipfile.BadZipFile):
        return 0


def stamp_entries(path, records):
    """Set fields on named build entries in flashmon.yaml in place, keeping
    comments and layout intact (a full YAML re-dump would drop both). `records`
    maps build name -> {field: value}; a field already present is rewritten, a
    new one is inserted directly under the entry's `name:`."""
    lines = open(path, encoding="utf-8").read().split("\n")
    in_builds = False
    starts = []
    block_end = len(lines)
    for idx, ln in enumerate(lines):
        st = ln.strip()
        if not st or st.startswith("#"):
            continue
        indent = len(ln) - len(ln.lstrip())
        if not in_builds:
            if indent == 0 and re.match(r"^builds\s*:", st):
                in_builds = True
            continue
        if indent == 0 and not st.startswith("- "):
            block_end = idx
            break
        m = re.match(r"^-\s*name\s*:\s*(.*)$", st)
        if m:
            starts.append((idx, m.group(1).strip().strip("\"'")))
    bounds = [s[0] for s in starts] + [block_end]
    # Edit bottom-up so inserts don't shift the indices of entries not yet handled.
    for i in range(len(starts) - 1, -1, -1):
        start, nm = starts[i]
        if nm not in records:
            continue
        end = bounds[i + 1]
        child_indent = " " * ((len(lines[start]) - len(lines[start].lstrip())) + 2)
        # Reversed, because every insert lands at the same start+1: writing the
        # fields back-to-front leaves them in the order `records` gave them.
        for field, value in reversed(list(records[nm].items())):
            at = next((j for j in range(start + 1, end)
                       if re.match(r"^\s*%s\s*:" % re.escape(field), lines[j])), None)
            new = "%s%s: %s" % (child_indent, field, value)
            if at is not None:
                lines[at] = new
            else:
                lines.insert(start + 1, new)
                end += 1
    open(path, "w", encoding="utf-8").write("\n".join(lines))


def main():
    sel = set(sys.argv[1:])
    here = os.path.dirname(os.path.abspath(__file__))   # <repo>/flashmon
    byaml = os.path.join(here, "flashmon.yaml")
    if not os.path.isfile(byaml):
        die("no flashmon.yaml next to %s" % os.path.abspath(__file__))
    ws = find_workspace(here)
    project, entries = parse_catalogue(byaml)
    if not entries:
        die("no builds in flashmon.yaml")
    catalogue = {n for n, _ in entries}
    for want in sel:
        if want not in catalogue:
            die("no build named '%s' in flashmon.yaml" % want)

    slug = slug_of(project)
    outdir = os.path.join(here, "builds")
    os.makedirs(outdir, exist_ok=True)
    run_dt = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    # Bake this exact stamp into every image built this run: spangap forwards
    # SPANGAP_BUILD_DATETIME into the build, spangap-core logs it on boot, and the
    # flasher compares that against the `version:` we record below to decide whether
    # a newer build is on offer. UTC so the ordering is machine-independent.
    os.environ["SPANGAP_BUILD_DATETIME"] = run_dt

    stamped = {}
    fails = 0
    for name, inv in entries:
        if sel and name not in sel:
            continue
        print("make-builds: === '%s': spangap build %s ===" % (name, inv),
              file=sys.stderr)
        # The invocation's first token names the buildable; its repo dir holds the
        # esp-idf/build/ where flasher.zip lands.
        toks = shlex.split(inv)
        repo = toks[0].split("/")[-1]
        zip_src = os.path.join(ws, repo, "esp-idf", "build", "flasher.zip")
        # This entry's name is the image's distribution identity: free-format,
        # and separate from the sortable version stamp above because the two
        # answer different questions — which image this is, versus whether the
        # catalogue holds something newer. Baked in via spangap-core's
        # write-build-info.py, which the device reports as sys.build.dist.
        os.environ["SPANGAP_BUILD_DIST"] = name
        rc = subprocess.run(["spangap", "build", *toks], cwd=ws,
                            stdin=subprocess.DEVNULL).returncode
        if rc == 0 and os.path.isfile(zip_src):
            zipname = "%s_%s_%s.zip" % (slug, name, run_dt)
            shutil.copyfile(zip_src, os.path.join(outdir, zipname))
            # Read the fit numbers here, next to the copy, while the sdkconfig
            # and flasher.zip in that repo dir still belong to this entry.
            sdk = sdkconfig_values(os.path.join(ws, repo, "esp-idf", "sdkconfig"))
            rec = {"version": run_dt}
            floor_kb = flash_floor_kb(sdk)
            nbytes = image_bytes(zip_src)
            # Omitted rather than written as 0 when unreadable: a reader treats
            # a missing field as "unknown, offer normally", and 0 would read as
            # "fits anywhere".
            if floor_kb:
                rec["flash_floor_kb"] = floor_kb
            if nbytes:
                rec["image_bytes"] = nbytes
            stamped[name] = rec
            print("make-builds:   -> %s (floor %s KB, %s bytes)"
                  % (zipname, floor_kb or "?", nbytes or "?"), file=sys.stderr)
        else:
            print("make-builds:   !! build failed or no flasher.zip for '%s' "
                  "(looked in %s)" % (name, zip_src), file=sys.stderr)
            fails += 1

    # Record the datetime and fit numbers for every image that built (even if
    # others failed), so the flasher fetches exactly what's on disk.
    if stamped:
        stamp_entries(byaml, stamped)
    if fails:
        die("%d build(s) failed" % fails)
    print("make-builds: wrote %s/*.zip" % outdir, file=sys.stderr)


if __name__ == "__main__":
    main()
