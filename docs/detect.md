# Board detection

How a board says which board it is, and how a chip whose firmware is unknown is
made to say it anyway.

## One function per board

    hw-<board>/esp-idf/src/detect.cpp  ->  const char *detect_hw(void)

Each board straddle answers exactly one question about itself: `detect_hw()`
returns its own `hw-<straddle>` string when the hardware under it is that board,
and NULL when it is not. Nothing in it enumerates other boards — the board is the
only thing that knows its own pins, and that is all it claims to know.

It is written once, there, and read by two callers:

- **spangap-core**, from `serviceRunStart()` — before the first `onStart()`,
  because the probe opens an I2C bus and the SPI host itself and a board's own
  `onStart` is what claims them (hw-lilygo-tdeck creates the shared I2C0 bus
  there). Anything later loses the bus and reads as an unrecognised board.
  A staged board straddle means the image was built for that board, so a NULL (or
  a different board) means the image is on the wrong hardware. spangap logs the
  mismatch and then **stops where it stands** — the task parks on a slow loop, awake,
  so the console stays enumerated and the reason stays on screen. Every pin map
  in that image belongs to someone else's board; a reboot loop would re-drive
  those pins forever, and going to sleep would take the explanation down with the
  port. Only a reset or a power cycle leaves it. A confirmed board is
  published as `sys.hw`. The symbol is declared **weak** in spangap-core, so the
  generic image — which stages no board straddle — links a null and the check
  simply does not apply.
- **flashmon's detector** ([`../esp-idf/`](../esp-idf)), which carries a **copy**
  of each board's `detect_hw()` renamed
  `detect_hw_<straddle_with_underscores>` — `detect_hw_lilygo_tdeck`,
  `detect_hw_heltecv4`, … — and calls them in turn from RAM, stopping at the
  first that answers.

The copy is manual and deliberately so: it is a handful of self-contained
functions, and a build-time mechanism to move them would cost more than it saves.
`detect_probe.h` — the bus vocabulary the functions are written in — is copied
the same way, from `spangap-core/esp-idf/include/`. Change one, change the other.
What catches a drift is the firmware itself: a board whose `detect_hw()` no
longer recognises it halts on the next boot.

## The device says so, unasked

Because spangap confirms the board at every boot and halts on a mismatch, a
device that is *running* has already settled the question — its baked-in board
and its actual board cannot be seen to disagree. The only problem left is getting
that answer to whoever wants it.

It is **announced**, not queried:

```
build: hw hw-lilygo-tdeck
build: catalogue stable
build: datetime 20260814130700
```

`spangapLogBuildIdentity()` prints those at boot, and again every time a console
attaches — cli.cpp answers a bare Enter with them, right after the "Spangap
console on serial jtag" line. A line is omitted when its fact does not exist, so
a generic image names no board and an image from outside a catalogue run carries
no stamp; absent is the honest answer, and it is what tells a tool to go and look
for itself.

That second call is the whole design. A boot happens once and almost nobody
watches it, so a device that announced itself only then forced every tool that
turned up later to **interrogate** it — over the framed RPC, whose availability
is advertised by a marker printed once at boot, which is exactly the thing the
late arrival missed. Probing for it is unreliable in the moment a port opens, and
a probe that draws a blank is indistinguishable from firmware that cannot answer
at all. The consequence was a reset and an eight-second detector run on a device
that was perfectly able to report for itself.

So flashmon asks nothing. Opening the port already sends a CR (it is how the
console is confirmed to be the console), the device answers with its identity,
and the ordinary log parser reads it. The detector is for devices that stay
silent: firmware too old to know the convention, or none at all.

## What a probe is made of

`detect_probe.h` supplies the reads: I2C bus open / ACK / register read, SCCB for
camera sensors, a LoRa radio probe over SPI, passive NMEA autobaud for GNSS,
physical flash size, and rail drive/release.

Reads that identify **nothing** — the T-Deck's touch, RTC and GNSS, the Nibble
Zero's environmental sensor — sit behind `DETECT_EXTRAS`, which only the detector
defines. They are there for the trace a person reads, and they are not free: the
GNSS autobaud listens 1.2 s per rate, and the firmware runs this on every boot to
answer a question the anchor and the radio have already settled. Everything is a bus read or a
scratch write the real firmware overwrites at init; nothing writes flash. Where a
part has no ID register (keyboard, RTC, OLED) a probe reports a bare ACK rather
than claiming a chip it cannot confirm.

I2C is the `i2c_master` driver, never the legacy `driver/i2c.h`: the legacy one
latches a process-wide flag that makes every later `i2c_new_master_bus` fail, so
a single probe on the old API would take down the keyboard, touch, RTC and codec
of the firmware that ran it.

Two things shape a probe. First, the **physical flash size** (SFDP), which rules
a board out before a single pin is touched — 16 MB -> tdeck/heltec/w12/tap-v2,
8 MB -> xiao-sense/tbeam-supreme, 4 MB -> t3s3/nibble; the xiao-sx1262 accepts **8 or 16 MB**, since
the Wio-SX1262 fits both the base XIAO and the Plus. (PSRAM size would split the
16 MB pair, but a RAM-loaded detector cannot init PSRAM — octal vs quad is
build-fixed — so the anchor settles those instead.) Second, the **anchor**: one
mandatory peripheral on that board's pins, confirmed by the radio. Where the
radio splits a board line it is also what names the straddle, so
`hw-lilygo-t3s3-sx1262` answers for an SX1262 and stays silent for an LR1121 on
the same PCB — which is exactly the mismatch the firmware check exists to catch.

The model to copy for a real *identification* is the **T-Deck GPS**: the Plus
ships one of two GNSS receivers with nothing host-visible to tell them apart, so
`hw-lilygo-tdeck/docs/gps.md` autobauds (38400 -> u-blox MIA-M10Q, 9600 ->
Quectel L76K) and infers the chip from the baud that produced the first
checksum-valid NMEA sentence. Most peripherals are easier — an I2C ACK plus a
chip-ID register read — but the principle is the same: probe, then confirm with a
value only that part returns.

## A board with no reset line

Everything above assumes the flasher can put the chip in the ROM loader itself.
esptool does that over DTR/RTS, or — when it recognises the USB-Serial-JTAG PID
(`303A:1001`) — with that unit's own sequence. A board whose USB is on the S3's
**USB-OTG** controller instead has neither: it reports `303A:0009` (the PID is
the chip id, which is how esptool's `uses_usb_otg()` recognises it), the reset
sequence runs, and nothing happens. Only a human holding BOOT and tapping RESET
gets that board into the loader.

So a device that answers nothing is asked a second question before the probe:
**is it in the loader already?** That is a sync with no reset in front of it,
which a device merely running firmware ignores. If it answers, the run latches
`manualBootloader` and every ROM step after it — chip probe, detector upload,
flash — connects `no_reset`, because a reset it cannot perform is also a state it
cannot get back.

The detector closes the circle. Rather than idling until someone resets it, it
ends by setting the RTC **force-download-boot** flag and restarting, so the ROM
loader comes back up on its own and the flash that follows still finds it. That
costs the boards that *can* reset nothing — they were being reset out of the
detector anyway, and the loader is where their next step starts too.

The flag lives in the RTC domain and survives an ordinary reset, so leaving it
set would send every later boot to the loader instead of the firmware. Clearing
it is part of finishing with the ROM: `clearForceDownloadBoot()` runs at the end
of a flash, and esptool's own S3 hard reset clears the same bit for the same
reason.

**Starting the firmware afterwards needs no hands either.** A reset does not have
to come from outside the chip: arming the RTC watchdog with a short timeout and
letting it fire restarts the whole system, and every step of that is a register
write over the loader. esptool falls back to exactly this when it finds itself on
USB-OTG, and esptool-js already carries the routine on its S3 class — it simply
never reaches for it, because its `after()` only knows the RTS-pin reset.
`restartFromRom()` clears the download-boot flag and calls it.

What that cannot control is what the device looks like afterwards. A board whose
ROM answers on USB-OTG and whose firmware runs USB-Serial-JTAG changes USB
identity across the restart, so the port the page holds goes away and comes back
as a different device. The restart is real; only the monitor's ability to follow
it is not, and the page says so rather than appearing to hang.

## Ordering is a safety property

**The fragile boards come first.** A board identifiable by passive bus reads
alone (nibble, t3s3, xiao-sense, xiao-sx1262) is settled before any probe that
DRIVES a power-enable or reset GPIO (heltec Vext GPIO36 and W12 Vext GPIO45,
both plus reset GPIO21, then the TAP V2's GPIO14 + GPIO4, then tdeck rail
GPIO10) — because that pin means
something else entirely on the board it is not looking at. Since the run stops at the first hit, a passively-read
board is identified before a rail-driving probe ever touches it.

A board can also switch a rail **over its PMU** rather than a GPIO
(`hw-lilygo-tbeam-supreme`: the SX1262 is dead until the AXP2101 enables ALDO3).
That probe is safer than a blind pin drive — it writes nothing until the PMU has
ACKed at its own address on the board's own I2C pins — but it is still a change,
so it sits after the passive probes and restores the PMU's enable register when
it fails.

A probe that drives a rail **releases it when it fails, and leaves it when it
succeeds**. Both are right in both callers: on the board this actually is, the
firmware wants the rail exactly as the probe left it (and the board's own
`onStart` drove it already), and the detector is hard-reset into real firmware the
moment the run ends. On the board it was not looking at, the release is what makes
the next probe safe.

When adding a board whose probe drives GPIOs, place it after any board those
drives could disturb.

## On the wire

The detector emits two kinds of line, and flashmon keeps both:

    DETECT: DETECTED: hw-lilygo-tdeck        the result, printed for the parser
    I (1234) detect: hw_lilygo_tdeck found   the trace, ordinary ESP-IDF logging

Everything a probe learns on the way is logged at **debug** under the tag
`detect`; the single line saying which board this is, is **info**. The detector
raises that tag to debug for its own run, so the whole trace is captured. The
same lines appear on a real boot after `log tag detect debug`.

All nine boards are **ESP32-S3**.

## Boards at a glance

| Board (`hw-*`) | SoC | Radio | Display | Notable extras |
|---|---|---|---|---|
| `tdeck` | ESP32-S3 16MB/8MB-oct | SX1262 | ST7789 320×240 TFT | GT911 touch, I²C keyboard, trackball, GPS, ES7210+MAX98357A audio, SD, optional PCF8563 |
| `heltecv4` | ESP32-S3 16MB/2MB-quad | SX1262 | SSD1306 128×64 OLED (unwired) | Vext rail, battery ADC |
| `meshnology-w12` | ESP32-S3 16MB/8MB-oct | LR2021 | SSD1315 128×64 OLED | Vext rail, GC1109 30 dBm PA + RFX2402E 2.4 GHz PA (radio-switched), L76K GNSS header, battery ADC, RGB LED |
| `lilygo-tbeam-supreme` | ESP32-S3 8MB/8MB-quad | SX1262 (or LR1121/SX1278 on the same pins) | SH1106 128×64 OLED | AXP2101 PMU gating every rail, PCF8563 RTC on the PMU bus, L76K/u-blox GNSS, SD, IMU + magnetometer + BME280 (unwired), 18650 holder |
| `wismesh-tap-v2` | ESP32-S3 16MB/8MB-oct | SX1262 (inside the RAK3112 module, private bus) | ST7789 320×240 TFT | FT5x06 touch, RAK12501 (L76K) GNSS, SD on the panel bus, Home button, buzzer, 2 LEDs, li-ion |
| `lilygo-t3s3` | ESP32-S3 4MB/2MB-quad | SX1262 (or SX1276/SX1280/LR1121) | SSD1306 OLED (unwired) | SD (own bus) |
| `nibble-zero` | ESP32-S3 4MB/2MB-quad | SX1262 | SSD1306 OLED (unwired) | BME280 (unwired), NeoPixel, buttons |
| `xiao-esp32s3-sense` | ESP32-S3 8MB/8MB-oct | none (WiFi/BLE) | none | Camera (OV2640/OV5640/… on B2B), PDM mic, SD (SDMMC 1-bit). Sense board does **not** fit the 16 MB Plus. |
| `xiao-esp32s3-sx1262` | ESP32-S3 **8 or 16MB**/8MB-oct | SX1262 | none | XIAO ESP32-S3 (8 MB) **or ESP32-S3 Plus (16 MB)** + Wio-SX1262 on B2B; both fit. |

## I²C buses per board

An I²C scan needs the right pins; each board wires them differently. Some rails
must be powered first.

| Board | SDA | SCL | Pre-step | Expected addresses |
|---|---|---|---|---|
| tdeck | 18 | 8 | drive **GPIO10 HIGH** (master rail) | 0x55 kbd, 0x5D/0x14 touch, 0x40 ES7210, 0x51 RTC (opt) |
| heltecv4 | 17 | 18 | drive **GPIO36 LOW** (Vext on); pulse **GPIO21** reset | 0x3C OLED |
| meshnology-w12 | 17 | 18 | drive **GPIO45 LOW** (Vext on); pulse **GPIO21** reset | 0x3C OLED |
| lilygo-tbeam-supreme (PMU bus) | 42 | 41 | — (the PMU is always powered) | 0x34 AXP2101, 0x51 PCF8563 |
| lilygo-tbeam-supreme (peripheral bus) | 17 | 18 | AXP2101 **ALDO1/2/4 on** at 3.3 V | 0x3C/0x3D OLED, 0x76 BME280 |
| wismesh-tap-v2 | 9 | 40 | drive **GPIO14 HIGH** (3V3 peripheral rail) | 0x38 FT5x06 touch |
| lilygo-t3s3 | 18 | 17 | — | 0x3C OLED |
| nibble-zero | 8 | 7 | — | 0x3C OLED, 0x76 BME280 |
| xiao-esp32s3-sense | 40 | 39 | — (SCCB, camera only) | 0x30/0x3C/0x21 camera |
| xiao-esp32s3-sx1262 | 5 | 6 | — | (none populated) |

## Peripheral identification table

### I²C / SCCB devices

| Peripheral | Addr (7-bit) | Identify | Boards |
|---|---|---|---|
| **GT911** capacitive touch | 0x5D or 0x14 | Product-ID at reg **0x8140** (16-bit reg addr) = ASCII `"911\0"` = `39 31 31 00`. Address is 0x5D if INT was low at power-on, else 0x14. | tdeck |
| **T-Deck keyboard** (on-board ESP32-C3) | 0x55 | No ID register. ACK at 0x55; a 1-byte read returns the next queued ASCII key (`0` = none). Confirm with ACK + plausible ASCII. On the tdeck bus only. | tdeck |
| **ES7210** quad mic ADC | 0x40 | Chip-ID regs **0xFD = 0x72**, **0xFE = 0x10** (→ 0x7210). | tdeck (audio build) |
| **PCF8563** RTC | 0x51 | No ID register — identify by **ACK at 0x51**. Sanity: seconds reg 0x02 bit7 = VL (clock-integrity-lost) flag; reads should be valid BCD. | tbeam-supreme (on the PMU bus), tdeck (optional/add-on) |
| **AXP2101** PMU | 0x34 | No ID register worth trusting — identify by **ACK at 0x34** on the board's own PMU pins, which is also what licenses writing to it. The rail control is `LDO_EN0` (0x90), one enable bit per ALDO, with each rail's voltage in 0x92..0x95 at 100 mV/LSB above 500 mV. | tbeam-supreme |
| **FT5x06** capacitive touch | 0x38 | No ID register needed — a plain **ACK at 0x38** is decisive on the pins that carry it. **Poll it**: the controller runs its own firmware off the peripheral rail the probe just raised and can miss the first attempt after a cold power-on, so try for ~600 ms before calling it absent. | wismesh-tap-v2 |
| **SSD1306**-class OLED (SSD1306 / SSD1315 / SH1106) | 0x3C (alt 0x3D) | No ID register — identify by **ACK**. The three parts are indistinguishable on the bus and none of them needs telling apart to name a board. On heltec and the W12, enable Vext (GPIO36 / GPIO45 LOW) and pulse the reset (GPIO21) first or it won't ACK; on the T-Beam Supreme the panel is behind an AXP2101 rail. | heltec, w12, tbeam-supreme, t3s3, nibble |
| **BME280** environmental | 0x76 (alt 0x77) | Chip-ID reg **0xD0**: **0x60** = BME280 (0x58 = BMP280, 0x61 = BME680). | nibble |
| **Camera** (SCCB) — OV2640 / OV5640 / OV3660 / OV7670 / OV7725 / GC2145 / GC0308 | 0x30, 0x3C, 0x21 | The camera is the Sense board's **only** anchor (PDM mic has no bus ID, empty SD slot answers nothing), so `det_camera` probes each sensor by chip-ID, the way esp32-camera/seccam do, and reports the model. **Its SCCB block is clocked from XCLK** — the sensor won't ACK at all until a master clock runs, so `det_camera` first drives ~20 MHz on the XCLK pin (GPIO10 on the XIAO Sense) via LEDC, then probes, then stops it. **OV2640** @0x30 (8-bit regs): bank 0xFF=1, then PID 0x0A=0x26, 0x0B=0x41/0x42. **OV5640/OV3660** @0x3C (16-bit regs): chip ID 0x300A/0x300B = 0x56/0x40 or 0x36/0x60. **GC2145** @0x3C (8-bit): 0xF0/0xF1 = 0x21/0x45. **OV7670/OV7725/GC0308** @0x21 (8-bit): 0x0A/0x0B = 0x76/0x73 or 0x77/0x21; GC0308 reg 0x00 = 0x9B. Model goes in brackets on the `DETECTED:` line. | xiao-esp32s3-sense |
| **QMI8658** IMU (reference; not on current boards) | 0x6A/0x6B | WHO_AM_I reg **0x00 = 0x05**. Listed for future boards. | — |

### SPI radios

All radios sit on the board's SPI header (pins differ per board). On the S3 the
GPIO matrix lets any SPI host drive any pins, so a probe just re-points a spare
host at the candidate pins. Order the checks register-first, command-last.

| Radio | Identify | Notes |
|---|---|---|
| **SX127x** (SX1276/78) | Register read: **RegVersion 0x42** → **0x12** (SX1276/77/78/79) or **0x22** (SX1272/73). Address byte has bit7=0 for read. No BUSY line. | Cheapest, most specific — try first. |
| **SX126x** (SX1262/68) | No version register. Reset, wait BUSY low, then **WriteRegister (0x0D)** a scratch value to the LoRa sync-word reg **0x0740** and **ReadRegister (0x1D)** it back (read has 1 NOP/status byte before data). Matching read-back = SX126x present. `GetStatus (0xC0)` must also return a non-0x00/0xFF byte. | The radio on tdeck, heltec, t3s3, nibble, xiao, tbeam-supreme and tap-v2. SX1261/62/68 are not distinguishable in software. The **W12** shares heltec's flash size, OLED pins and LoRa header, so both boards' probes name their modem — loosening either back to "any radio answers" makes both identify as whichever runs first. |
| **SX128x** (SX1280, 2.4 GHz) | Command/BUSY like SX126x, but has a readable **firmware-version register at 0x0153/0x0154**. | t3s3 variant. |
| **LR1121** (LR11xx) | **GetVersion** command (`0x01 0x01`); reply `[HW, device, FWmaj, FWmin]` with **device = 0xDF** (0xDA = LR1110, 0xDB = LR1120). | t3s3 variant. |
| **LR2021** | Same **GetVersion** opcode as the LR11xx, and told apart by the reply's shape: the LR11xx prefixes it with **one** status byte and names itself in a device byte, the LR2021 with **two** and offers only a firmware version. So there is no device id to match — it is checked **last**, after every part that can identify itself has had its turn, and what is required is the status field both families share (bits 3:1 of the first byte) reading as processed. **Two** of its four codes mean that: `2` is "ok" and `3` is "ok, data is being transmitted", and a command that returns something — as GetVersion does — reports the latter, so both are accepted. A W12 answers `07 21 01 18`: status `3`, then firmware 1.24. `0xFF` is rejected as well as `0x00`, since a floating MISO reads as code `3` and would claim to be a radio. | w12 |

Radio SPI pins by board:

| Board | SCK | MOSI | MISO | CS | RST | BUSY | IRQ/DIO1 |
|---|---|---|---|---|---|---|---|
| tdeck | 40 | 41 | 38 | 9 | 17 | 13 | 45 |
| heltecv4 | 9 | 10 | 11 | 8 | 12 | 13 | 14 |
| meshnology-w12 | 9 | 10 | 11 | 8 | 12 | 13 | 14 (chip DIO8) |
| lilygo-tbeam-supreme | 12 | 11 | 13 | 10 | 5 | 4 | 1 |
| wismesh-tap-v2 | 5 | 6 | 3 | 7 | 8 | 48 | 47 |
| lilygo-t3s3 | 5 | 6 | 3 | 7 | 8 | 34 | 33 |
| nibble-zero | 13 | 11 | 12 | 10 | 6 | 5 | 4 |
| xiao-esp32s3-sx1262 | 7 | 9 | 8 | 41 | 42 | 40 | 39 |

### SD card

| Interface | Identify | Boards |
|---|---|---|
| **SD over SPI** | Standard init: CMD0 (→ idle 0x01) → CMD8 → ACMD41 → CMD58; then read CID (CMD10) / CSD (CMD9) for manufacturer ID and size. | tdeck (CS 39, on the display bus 40/41/38), t3s3 (host 3: SCK 14/MOSI 11/MISO 2, CS 13) |
| **SD over SDMMC (1-bit)** | CMD0/CMD8/ACMD41 on the SDMMC peripheral (CLK 7, CMD 9, D0 8; 1-bit only). | xiao-esp32s3-sense |

### GNSS (UART — the reference case)

| Receiver | Baud | Distinguisher | Boards |
|---|---|---|---|
| u-blox **MIA-M10Q** | 38400 | First checksum-valid `$…*` NMEA sentence at 38400; also ACKs UBX (e.g. UBX-MON-VER). Send a `0xFF` wake edge first (may be in software backup). | tdeck, tbeam-supreme |
| Quectel **L76K** | 9600 | First valid NMEA at 9600; speaks PMTK/PCAS only, no UBX. | tdeck, tbeam-supreme, tap-v2 (RAK12501) |

Host RX pins: tdeck **44**, tap-v2 **44**, tbeam-supreme **9** — each ← the
receiver's TX, 8N1. On tdeck the receiver is powered off the shared GPIO10 rail
and on the Supreme off an AXP2101 rail, so neither has an independent GPS
enable. This is the batch distinguisher, not a true probe — a receiver
reconfigured off its default baud would be mis-identified. It is never an
anchor: a GNSS module is a header populated at the factory's discretion (the
W12's is, which is why its probe does not look), so it runs under
`DETECT_EXTRAS`, logged for the person reading rather than tested.

### spangap state partition

The detector also reports the spangap **`state`** partition:

```
DETECTED: spangap state partition at 0x800000 size 0x800000
```

`state` is **not in the flash partition table** — spangap registers it at runtime
(`spangap-core` `fs.cpp` `statePartitionEnsure`) as a LittleFS over the flash
above the firmware floor. The detector reports it from what is **actually on the
chip**, not by re-deriving that math:

- If a board **pins** an explicit `state` partition in its table, it's read
  straight from the partition API (`esp_partition_find_first`).
- Otherwise the detector finds the **LittleFS filesystem** itself: it floors on
  the partition table (same API enumeration spangap floors on), scans the
  4K-aligned offsets above it for the LittleFS **`littlefs`** superblock magic,
  and reads `block_size × block_count` from the superblock struct — the real size
  the store was formatted with. If no filesystem is found (never-booted chip), it
  reports nothing rather than inventing a region.

This means a change to spangap's floor/alignment logic can't desync the detector:
it reads the store that exists, wherever it landed.

The flasher keeps this line: a flash whose sectors reach into that region would
wipe the device's own settings, keys and files, so it warns and asks before
writing (see the README). A chip that reports no store gets no warning — there is
nothing to lose there.

### Not host-detectable

These are on the PCB but have no bus identity — presence is a board fact, not a
probe: ST7789/OLED are effectively write-only (infer from the board, not MISO);
MAX98357A amp is strap-configured (no register interface); linear Li-ion chargers
(no PMIC/fuel-gauge on any of these boards — unlike T-Beam/T-Deck-Pro); Vext /
power-enable MOSFETs, battery-sense ADC dividers, trackball, buttons, LEDs, and
the NeoPixel are all bare GPIO/ADC. WiFi/BLE are on-die (`esp_chip_info()`), and
flash/PSRAM size come from `esp_flash_get_size()` / `esp_psram_get_size()` — which
the esptool probe already reports before this binary even runs.

## Address collisions to keep in mind

- **0x55** is the tdeck keyboard here, but on a *T-Deck Pro* it's a BQ27220 fuel
  gauge — only probe it on the tdeck (18/8) bus and treat a bare ACK as
  "keyboard" only in that context.
- **0x40** ES7210 is also a common address for INA219/PCA9685/etc. — the
  0xFD/0xFE chip-ID read disambiguates.
- **0x76/0x77** BME280 shares its space with BMP280/BME680 — the 0xD0 value
  disambiguates.
