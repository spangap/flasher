# Peripheral detection

How to identify, at runtime from code on the ESP32, every internal peripheral on
the boards we support (the `hw-*` straddles). This is the reference behind the
detection binary in [`../esp-idf/`](../esp-idf), which flashmon can upload
after the chip probe to auto-detect what's attached.

The detector works **per board**: `probe_hw_<straddle>()` powers that board's
rail, checks a mandatory anchor peripheral on the board's pins, confirms with the
radio, then reads the optional extras and prints `DETECTED: hw-<straddle>`. It
tries the boards in turn and stops at the first match. The individual peripheral
detectors take pin numbers and report only what they found — and where a part has
no ID register (keyboard, RTC, OLED) the detector prints a bare `ack at 0x<addr>`
rather than claiming a chip it can't actually confirm.

Two things shape the output. First, each probe gates on the **physical flash
size** (read once via SFDP) and bails before touching a pin when its board can't
be that size — 16 MB → tdeck/heltec, 8 MB → xiao-sense, 4 MB → t3s3/nibble (the
xiao-sx1262 probe accepts **8 or 16 MB**, since the Wio-SX1262 fits both the base
XIAO and the 16 MB Plus).
(PSRAM size would split the 16 MB pair, but a single RAM image can't init PSRAM —
octal vs quad is build-fixed — so the anchor settles those instead.) Second, the
`DETECTED:` line is **only the straddle name**, with the radio in the name where
it splits a board line (`hw-lilygo-t3s3-sx1262` … `-sx1280`); touch, GPS type and
BME280 stay on the peripheral lines, never in brackets. On the wire every
intentional line is prefixed `DETECT: ` as a whitelist flashmon strips.

The model to copy for a real *identification* is the **T-Deck GPS**: the Plus
ships one of two GNSS receivers with nothing host-visible to tell them apart, so
`hw-lilygo-tdeck/docs/gps.md` autobauds (38400 → u-blox MIA-M10Q, 9600 → Quectel L76K)
and infers the chip from the baud that produced the first checksum-valid NMEA
sentence. Most peripherals are easier — an I²C ACK plus a chip-ID register read —
but the principle is the same: probe, then confirm with a value only that part
returns.

All six boards are **ESP32-S3**. Nothing below is destructive: every check is a
bus read (or, for the radios, a register write/read-back on the radio's own
scratch registers), and it can run from RAM without flashing (see the esp-idf
README).

**Probe ordering is a safety property.** Boards identifiable by passive bus reads
alone (nibble, t3s3, seeed, xiao) are probed before boards whose probe drives
power-enable / reset GPIOs (heltec Vext GPIO36 + reset GPIO21, then tdeck rail
GPIO10). Since probing stops at the first hit, a read-only board is identified
before any rail-driving probe pokes a pin that means something else on it; each
rail-driving probe also restores the pins it drove to hi-Z on exit. When adding a
board whose probe drives GPIOs, place it after any board those drives could
disturb.

## Boards at a glance

| Board (`hw-*`) | SoC | Radio | Display | Notable extras |
|---|---|---|---|---|
| `tdeck` | ESP32-S3 16MB/8MB-oct | SX1262 | ST7789 320×240 TFT | GT911 touch, I²C keyboard, trackball, GPS, ES7210+MAX98357A audio, SD, optional PCF8563 |
| `heltecv4` | ESP32-S3 16MB/2MB-quad | SX1262 | SSD1306 128×64 OLED (unwired) | Vext rail, battery ADC |
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
| **PCF8563** RTC | 0x51 | No ID register — identify by **ACK at 0x51**. Sanity: seconds reg 0x02 bit7 = VL (clock-integrity-lost) flag; reads should be valid BCD. | tdeck (optional/add-on) |
| **SSD1306** OLED | 0x3C (alt 0x3D) | No ID register — identify by **ACK**. On heltec, enable Vext (GPIO36 LOW) and pulse the reset (GPIO21) first or it won't ACK. | heltec, t3s3, nibble |
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
| **SX126x** (SX1262/68) | No version register. Reset, wait BUSY low, then **WriteRegister (0x0D)** a scratch value to the LoRa sync-word reg **0x0740** and **ReadRegister (0x1D)** it back (read has 1 NOP/status byte before data). Matching read-back = SX126x present. `GetStatus (0xC0)` must also return a non-0x00/0xFF byte. | The radio on tdeck, heltec, t3s3, nibble, xiao. SX1261/62/68 are not distinguishable in software. |
| **SX128x** (SX1280, 2.4 GHz) | Command/BUSY like SX126x, but has a readable **firmware-version register at 0x0153/0x0154**. | t3s3 variant. |
| **LR1121** (LR11xx) | **GetVersion** command (`0x01 0x01`); reply `[HW, device, FWmaj, FWmin]` with **device = 0xDF** (0xDA = LR1110, 0xDB = LR1120). | t3s3 variant. |

Radio SPI pins by board:

| Board | SCK | MOSI | MISO | CS | RST | BUSY | IRQ/DIO1 |
|---|---|---|---|---|---|---|---|
| tdeck | 40 | 41 | 38 | 9 | 17 | 13 | 45 |
| heltecv4 | 9 | 10 | 11 | 8 | 12 | 13 | 14 |
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
| u-blox **MIA-M10Q** | 38400 | First checksum-valid `$…*` NMEA sentence at 38400; also ACKs UBX (e.g. UBX-MON-VER). Send a `0xFF` wake edge first (may be in software backup). | tdeck |
| Quectel **L76K** | 9600 | First valid NMEA at 9600; speaks PMTK/PCAS only, no UBX. | tdeck |

Pins on tdeck: host RX **44** ← GPS TX, host TX **43** → GPS RX, 8N1. Powered off
the shared GPIO10 rail (no independent GPS enable). This is the batch
distinguisher, not a true probe — a receiver reconfigured off its default baud
would be mis-identified.

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
