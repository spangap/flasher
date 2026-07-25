# spangap peripheral-detection binary

A tiny ESP32-S3 app that probes the `hw-*` boards one at a time and stops at the
first it can identify. Every intentional line is prefixed with **`DETECT: `** (a
whitelist — flashmon keeps only those and strips the prefix, so boot chatter
and IDF logs are ignored). Each peripheral it finds prints a plain,
board-agnostic line; the identified board prints a `DETECTED: hw-<straddle>`:

```
DETECT: I2C(18/8): ack at 0x55
DETECT: SPI(sck40/mosi41/miso38/cs9): SX126x LoRa (SX1262/68)
DETECT: I2C(18/8): GT911 touch at 0x5D
DETECT: UART(rx44): u-blox MIA-M10Q GPS at 38400
DETECT: DETECTED: hw-lilygo-tdeck
DETECT:
DETECT: DETECTED: spangap state partition at 0x800000 size 0x800000
DETECT: SPANGAP-DETECT-END
```

The `DETECTED: hw-<straddle>` line carries **only the straddle name** — where the
radio splits a board line it's in the name (`hw-lilygo-t3s3-sx1262`,
`hw-lilygo-t3s3-sx1280`, …); everything that doesn't affect straddle choice
(touch, GPS type, BME280) stays on the peripheral lines above, never in brackets.

The pin maps and the chip-ID values behind each check are in
[`../docs/detect.md`](../docs/detect.md) — keep the two in sync.

## How it's structured

`main/detect.c` has two layers:

- **Peripheral detectors** — each takes explicit **pin numbers** and reports only
  what it found, never a board name (`det_gt911`, `det_es7210`, `det_bme280`,
  `det_ov2640`, `det_radio`, `det_gps`, and `det_ack` for the ACK-only parts —
  keyboard, RTC, OLED — which print a bare `ack at 0x<addr>` rather than guessing
  the chip). Passing pins is what makes them reusable across boards.
- **Board probes** — `probe_hw_<straddle>()`. Each powers its board's rail (if
  any), checks a mandatory **anchor** peripheral on that board's pins (bail if
  absent), **confirms** with the radio, reads the optional extras, and prints
  `DETECTED: hw-<straddle> (…extras…)`. The board identifier is always the
  straddle name.

`app_main()` reads the physical flash size once (SFDP), calls the probes in order
and **stops at the first** that returns true, then reports the spangap state
partition and the `SPANGAP-DETECT-END` sentinel. To add a board, write a
`probe_hw_*` and slot it into the `PROBES[]` array (mind the ordering below).

## Flash-size gate

Every probe's first line is a `flash_mb(N)` check: it bails **before touching any
pin** when the physical flash size rules its board out — 16 MB → tdeck/heltec,
8 MB → xiao-sense, 4 MB → t3s3/nibble (the xiao-sx1262 probe accepts **8 or
16 MB** — the Wio-SX1262 fits both the base XIAO and the 16 MB Plus). This is
both a speed and a safety win (a
rail-driving probe never runs on a board of the wrong size). PSRAM size would
split the 16 MB pair (tdeck 8 MB vs heltec 2 MB) further, but a single RAM image
**can't read PSRAM** — its octal-vs-quad mode is build-fixed and `CONFIG_SPIRAM`
is off here — so the gate is flash-only and the peripheral anchor (keyboard vs
OLED) settles same-flash boards. `flash_mb` fails **open** on an SFDP read error,
so a probe is never skipped just because the size couldn't be read.

## Probe ordering (a safety property)

`PROBES[]` is ordered deliberately: probes identifiable by **passive bus reads**
(nibble, t3s3, seeed, xiao) run first; probes that **drive power-enable / reset
GPIOs** (heltec Vext GPIO36 + OLED reset GPIO21, then tdeck rail GPIO10) run
**last**. Because probing stops at the first hit, a board found by reads alone is
identified before any rail-driving probe pokes a pin that means something else on
it. Every rail-driving probe restores the pins it drove to hi-Z before returning
(`rail_release`), and flashmon hard-resets the chip into real firmware
afterwards. If you add a probe that drives GPIOs, place it so boards its drives
could disturb are identified before it runs.

## Build

```
make            # build in the spangap container, stage into ../flashmon/detect/
```

`make` builds the image and copies it to `../flashmon/detect/spangap_detect.bin`
(the path flashmon serves, and the one checked in). By default the compile runs
inside the spangap build container (`spangap detect-build`), so **no local
ESP-IDF is needed** — just a spangap workspace with this repo checked out. `make
LOCAL=1` builds with an ESP-IDF already activated on your PATH instead
(equivalent to `idf.py set-target esp32s3 build`). This `build/` directory is
**not** checked in; the staged binary in `../flashmon/detect/` is.

It builds as a **RAM app** (`CONFIG_APP_BUILD_TYPE_RAM`, no PSRAM): all segments
load into SRAM and the ROM jumps to it, so it runs with **no flash write**.
Console output goes to **both** UART0 and native USB-Serial-JTAG, so it reaches
whichever port a given board exposes — CP2102/CH9102 bridge boards (Heltec, some
T3-S3) on UART0, native-USB boards (T-Deck, XIAO, S3-Zero, Sense) on
USB-Serial-JTAG.

## How flashmon uses it

`flashmon.js`, on connect, does the chip probe, then `runDetection()`:

1. fetches `detect/spangap_detect.bin` and parses its segments + entry point,
2. connects the **ROM loader** (`detectChip`, no stub) and RAM-loads each segment
   with `memBegin`/`memBlock`, then `memFinish(entry)` jumps to it — no flash
   write, same MEM_BEGIN/MEM_DATA/MEM_END path esptool's own stub uses,
3. **captures** the detector's one-shot serial output (it probes the boards once,
   stops at the first match, and prints a `SPANGAP-DETECT-END` sentinel), folds
   the peripheral + `DETECTED:` lines into the cyan banner, then **resets** the
   chip back into its real firmware and opens the monitor on that.

The detector delays ~800 ms before printing so flashmon's capture reader is
attached first, runs one pass, then idles until the reset. Manual run for
debugging: `esptool --chip esp32s3 -p PORT --no-stub load_ram
build/spangap_detect.bin`, then open a serial monitor at 115200.

## Scope & caveats

- **ESP32-S3 only** — every supported board is an S3. Other targets would need
  their own pin tables.
- **Power rails:** the heltec and tdeck probes drive the Heltec Vext (GPIO36 LOW)
  + OLED reset (GPIO21) and the T-Deck master rail (GPIO10 HIGH) so those boards'
  buses respond. These pins mean other things on other boards, so those two
  probes run last (see ordering above), the drives are brief, each is restored to
  hi-Z on exit, and the chip is reset into real firmware afterward.
- **GNSS** is probed only **inside** `probe_hw_lilygo_tdeck`, after the keyboard and
  radio have already confirmed a T-Deck — so the GPS UART pins (43/44), which are
  the console UART on other boards, are only touched once we know it's a T-Deck.
  It listens **passively** on RX44 (no TX) and takes the baud whose first
  checksum-valid NMEA sentence wins: 38400 → u-blox MIA-M10Q, 9600 → Quectel
  L76K.
- **Not probed here (documented in `detect.md`):**
  - **SD card** — SPI/SDMMC init is heavier and shares pins with the radio bus;
    documented but not swept.
  - **ST7789 / OLED panels, amps, chargers, LEDs, buttons, Vext** — no bus
    identity (write-only or bare GPIO); presence is a board fact, not a probe.
- **Flash / PSRAM size and quad/octal** already come out of the esptool probe
  flashmon runs *before* this binary (`esp_flash_get_size`, the S3 efuse
  flash/PSRAM caps), so they're not re-detected here.
