# spangap board-detection binary

A tiny ESP32-S3 app that runs every board straddle's own `detect_hw()` in turn
and stops at the first that answers. It is uploaded into SRAM by the flasher —
nothing is written to flash — and used only where a device cannot say for itself
which board it is (see [`../docs/detect.md`](../docs/detect.md)).

It emits two kinds of line, and flashmon keeps both:

```
D (0812) detect: flash 16 MB, want 4 MB: no
D (0813) detect: flash 16 MB, want 16 MB: yes
D (0910) detect: i2c: 0x55 acks
D (0940) detect: spi(sck40/mosi41/miso38/cs9): radio sx1262
D (0980) detect: i2c(18/8): GT911 touch present
D (2200) detect: uart(rx44): u-blox MIA-M10Q GPS at 38400
I (2201) detect: hw_lilygo_tdeck found
DETECT: DETECTED: hw-lilygo-tdeck
DETECT:
DETECT: DETECTED: spangap state partition at 0x800000 size 0x800000
DETECT: SPANGAP-DETECT-END
```

- **`I`/`D (…) detect: …`** — ordinary ESP-IDF logging under the tag `detect`.
  This is the probe trace, and it is the *same code path* the firmware logs on a
  real boot: everything a probe learns is debug, and the one line naming the
  board it found is info. `app_main` raises the tag to debug for its own run.
- **`DETECT: …`** — the results, printed deliberately for flashmon's parser: the
  board that was settled on, the spangap state partition, and the
  `SPANGAP-DETECT-END` sentinel. Anything else on the wire (IDF boot chatter) is
  dropped.

## How it's structured

`main/detect.c` is **copies**. Each board straddle owns exactly one function —

    hw-<board>/esp-idf/src/detect.cpp  ->  const char *detect_hw(void)

— returning its own `hw-<straddle>` string when the hardware under it is that
board, and NULL when it is not. Those functions are copied in here verbatim,
renamed `detect_hw_<straddle_with_underscores>` so they can sit side by side, and
`app_main()` calls them in order. `detect_probe.h` — the bus vocabulary they are
written in (I2C ACK and register reads, SCCB, the LoRa radio probe, NMEA
autobaud, flash size, rail drive/release) — is likewise a copy of
`spangap-core/esp-idf/include/detect_probe.h`.

The copy is manual and deliberately so: it is a handful of self-contained
functions, and a build-time mechanism to move them would cost more than it saves.
What catches a drift is the firmware itself, which calls the original at every
boot and halts on a board it no longer recognises.

To add a board: write its `detect_hw()` in the straddle, copy it here under the
renamed symbol, and slot it into the `BOARDS[]` array — minding the ordering
below.

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

`BOARDS[]` is ordered deliberately — **the fragile hardware comes first**. Boards
identifiable by **passive bus reads** (nibble, t3s3, xiao-sense, xiao-sx1262) run
before any board whose probe **drives a power-enable or reset GPIO** (heltec Vext
GPIO36 + OLED reset GPIO21, then tdeck rail GPIO10), because those pins mean
something else entirely on the board they are not looking at. Since the run stops
at the first hit, a board found by reads alone is settled before a rail-driving
probe ever touches it.

A probe that drives a rail **releases it when it fails** (`detect_rail_release`)
and **leaves it when it succeeds** — right in both callers: the firmware wants the
rail exactly as the probe left it on the board this actually is, and here the chip
is hard-reset into real firmware the moment the run ends.

If you add a board whose probe drives GPIOs, place it after any board those drives
could disturb.

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
- **Power rails:** the heltec and tdeck functions drive the Heltec Vext (GPIO36 LOW)
  + OLED reset (GPIO21) and the T-Deck master rail (GPIO10 HIGH) so those boards'
  buses respond. These pins mean other things on other boards, so those two
  probes run last (see ordering above), the drives are brief, each is restored to
  hi-Z on exit, and the chip is reset into real firmware afterward.
- **GNSS** is probed only **inside** `detect_hw_lilygo_tdeck`, after the keyboard and
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
