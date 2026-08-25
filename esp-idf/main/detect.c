// spangap board detection — every board's own detect_hw(), one after another.
//
// A board straddle answers exactly one question about itself: detect_hw(), which
// returns its own "hw-<straddle>" string when the hardware under it is that
// board and NULL when it is not. That function is written ONCE, in the straddle
// (hw-<board>/esp-idf/src/detect.cpp), because the board is the only thing that
// knows its own pins.
//
// This file is where the copies live. Each one is that straddle's detect_hw()
// verbatim, renamed to detect_hw_<straddle-with-underscores> so they can sit
// side by side, and app_main() calls them in order and stops at the first that
// answers. The copy is manual and deliberately so — see detect_probe.h, which is
// itself a copy of spangap-core's.
//
//     hw-lilygo-tdeck/esp-idf/src/detect.cpp   detect_hw  →  detect_hw_lilygo_tdeck
//     hw-heltecv4/esp-idf/src/detect.cpp       detect_hw  →  detect_hw_heltecv4
//     hw-meshnology-w12/esp-idf/src/detect.cpp detect_hw  →  detect_hw_meshnology_w12
//     …
//
// Change a board's detect_hw(), change its copy here. Nothing checks that for
// you; what does catch a drift is the firmware itself, which halts on a board
// whose detect_hw() no longer recognises it.
//
// ORDERING IS A SAFETY PROPERTY, not cosmetic. The fragile boards come first:
// one whose identity can be read passively, off buses alone, is settled before
// any probe that DRIVES a power-enable or reset GPIO — because that pin means
// something else entirely on the board it is not looking at. Every probe that
// drives a rail releases it again when it fails, and the flasher hard-resets the
// chip into real firmware when the run ends.
//
// Nothing here writes flash. Every check is a bus read or a scratch-register
// write the real firmware overwrites at init.

#include <stdio.h>
#include <string.h>

#include "esp_flash.h"
#include "esp_partition.h"
#include "esp_system.h"          /* esp_restart, to hand the chip back to the ROM */
#include "soc/rtc_cntl_reg.h"    /* RTC_CNTL_OPTION1_REG / _FORCE_DOWNLOAD_BOOT */
#include "detect_probe.h"

// ── the copies ───────────────────────────────────────────────────────────────
// Each block below is one straddle's detect.cpp, function renamed and its board
// header's pin macros written out (a standalone detector stages no straddles, so
// it has no board headers to include). Everything else is verbatim.

// hw-nibble-zero — passive: no rail to drive, nothing but bus reads.
#define NZ_OLED_SDA    8
#define NZ_OLED_SCL    7
#define NZ_LORA_SCK   13
#define NZ_LORA_MOSI  11
#define NZ_LORA_MISO  12
#define NZ_LORA_CS    10
#define NZ_LORA_RST    6
#define NZ_LORA_BUSY   5

static const char *detect_hw_nibble_zero(void)
{
    if (!detect_flash_mb(4)) return NULL;

    if (!detect_ack2(NZ_OLED_SDA, NZ_OLED_SCL, 0x3C, 0x3D)) {
        detect_dbg("no OLED on 8/7 — not a Nibble Zero");
        return NULL;
    }
    if (!detect_radio(NZ_LORA_SCK, NZ_LORA_MOSI, NZ_LORA_MISO,
                      NZ_LORA_CS, NZ_LORA_RST, NZ_LORA_BUSY, NULL)) {
        detect_dbg("OLED answered but no radio — not a Nibble Zero");
        return NULL;
    }

#if DETECT_EXTRAS
    detect_bme280(NZ_OLED_SDA, NZ_OLED_SCL, NULL);
#endif

    detect_found("hw_nibble_zero");
    return "hw-nibble-zero";
}

// hw-lilygo-t3s3-sx1262 — passive. The T3-S3 is a line, not a board: the radio
// is what names the straddle, so nothing but an SX1262 is this one.
#define T3_OLED_SDA   18
#define T3_OLED_SCL   17
#define T3_LORA_SCK    5
#define T3_LORA_MOSI   6
#define T3_LORA_MISO   3
#define T3_LORA_CS     7
#define T3_LORA_RST    8
#define T3_LORA_BUSY  34

static const char *detect_hw_lilygo_t3s3_sx1262(void)
{
    if (!detect_flash_mb(4)) return NULL;

    if (!detect_ack2(T3_OLED_SDA, T3_OLED_SCL, 0x3C, 0x3D)) {
        detect_dbg("no OLED on 18/17 — not a T3-S3");
        return NULL;
    }
    if (!detect_radio_is(T3_LORA_SCK, T3_LORA_MOSI, T3_LORA_MISO,
                         T3_LORA_CS, T3_LORA_RST, T3_LORA_BUSY, "sx1262")) {
        detect_dbg("T3-S3 pins, but the radio is not an SX1262");
        return NULL;
    }

    detect_found("hw_lilygo_t3s3_sx1262");
    return "hw-lilygo-t3s3-sx1262";
}

// hw-xiao-esp32s3-sense — passive. The camera in the DVP socket is the anchor.
#define XS_CAM_SIOD   40
#define XS_CAM_SIOC   39
#define XS_CAM_XCLK   10

static const char *detect_hw_xiao_esp32s3_sense(void)
{
    if (!detect_flash_mb(8)) return NULL;

    char model[16] = {0};
    if (!detect_camera(XS_CAM_SIOD, XS_CAM_SIOC, XS_CAM_XCLK, model)) {
        detect_dbg("no camera on the DVP socket — not a XIAO Sense");
        return NULL;
    }

    detect_found("hw_xiao_esp32s3_sense");
    return "hw-xiao-esp32s3-sense";
}

// hw-xiao-esp32s3-sx1262 — passive. A bare XIAO has no peripheral to anchor on,
// so the radio IS the anchor.
#define XL_LORA_SCK    7
#define XL_LORA_MOSI   9
#define XL_LORA_MISO   8
#define XL_LORA_CS    41
#define XL_LORA_RST   42
#define XL_LORA_BUSY  40

static const char *detect_hw_xiao_esp32s3_sx1262(void)
{
    if (!detect_flash_mb(8) && !detect_flash_mb(16)) return NULL;

    if (!detect_radio_is(XL_LORA_SCK, XL_LORA_MOSI, XL_LORA_MISO,
                         XL_LORA_CS, XL_LORA_RST, XL_LORA_BUSY, "sx1262")) {
        detect_dbg("no SX1262 on the XIAO LoRa header");
        return NULL;
    }

    detect_found("hw_xiao_esp32s3_sx1262");
    return "hw-xiao-esp32s3-sx1262";
}

// hw-lilygo-tbeam-supreme — SWITCHES A RAIL, but over I2C rather than a GPIO:
// the SX1262 is dead until the AXP2101 enables ALDO3, and the PMU answering at
// 0x34 on 42/41 is what licenses the write. So it runs after the passive probes
// and before the ones that drive a pin blind. It puts the PMU's enable register
// back when it fails. The Supreme is a line — SX1262, LR1121 or SX1278 on the
// same pins — so the radio is what names the straddle.
#define TS_PMU_SDA        42
#define TS_PMU_SCL        41
#define TS_PMU_ADDR     0x34
#define TS_RTC_ADDR     0x51
#define TS_PMU_LDO_EN0  0x90
#define TS_PMU_ALDO1_V  0x92
#define TS_PMU_ALDO2_V  0x93
#define TS_PMU_ALDO3_V  0x94
#define TS_PMU_ALDO4_V  0x95
#define TS_PMU_EN_ALDO1 0x01
#define TS_PMU_EN_ALDO2 0x02
#define TS_PMU_EN_ALDO3 0x04
#define TS_PMU_EN_ALDO4 0x08
#define TS_PMU_MV(mv)   (uint8_t)(((mv) - 500) / 100)
#define TS_LORA_SCK       12
#define TS_LORA_MOSI      11
#define TS_LORA_MISO      13
#define TS_LORA_CS        10
#define TS_LORA_RST        5
#define TS_LORA_BUSY       4
#define TS_OLED_SDA       17
#define TS_OLED_SCL       18
#define TS_GPS_RX          9

static bool ts_pmu_rails(const uint8_t *volt_regs, int n, uint8_t bits, uint8_t *saved)
{
    detect_i2c_t h;
    if (!detect_i2c_open(&h, TS_PMU_SDA, TS_PMU_SCL)) return false;
    uint8_t en = 0;
    bool ok = detect_i2c_rd(&h, TS_PMU_ADDR, TS_PMU_LDO_EN0, &en, 1);
    if (ok) {
        if (saved) *saved = en;
        for (int i = 0; i < n; i++)
            detect_i2c_wr(&h, TS_PMU_ADDR, volt_regs[i], TS_PMU_MV(3300));
        ok = detect_i2c_wr(&h, TS_PMU_ADDR, TS_PMU_LDO_EN0, (uint8_t)(en | bits));
    }
    detect_i2c_close(&h);
    return ok;
}

static void ts_pmu_restore(uint8_t en)
{
    detect_i2c_t h;
    if (!detect_i2c_open(&h, TS_PMU_SDA, TS_PMU_SCL)) return;
    detect_i2c_wr(&h, TS_PMU_ADDR, TS_PMU_LDO_EN0, en);
    detect_i2c_close(&h);
}

static const char *detect_hw_lilygo_tbeam_supreme(void)
{
    if (!detect_flash_mb(8)) return NULL;

    if (!detect_ack(TS_PMU_SDA, TS_PMU_SCL, TS_PMU_ADDR)) {
        detect_dbg("no PMU at 0x%02X on 42/41 — not a T-Beam Supreme", TS_PMU_ADDR);
        return NULL;
    }

    static const uint8_t radio_rail[] = { TS_PMU_ALDO3_V };
    uint8_t saved = 0;
    if (!ts_pmu_rails(radio_rail, 1, TS_PMU_EN_ALDO3, &saved)) {
        detect_dbg("PMU answered but would not switch the radio rail");
        return NULL;
    }
    vTaskDelay(pdMS_TO_TICKS(50));             /* 3.3 V rail settle */

    if (!detect_radio_is(TS_LORA_SCK, TS_LORA_MOSI, TS_LORA_MISO,
                         TS_LORA_CS, TS_LORA_RST, TS_LORA_BUSY, "sx1262")) {
        detect_dbg("T-Beam Supreme PMU, but the radio is not an SX1262");
        ts_pmu_restore(saved);
        return NULL;
    }

#if DETECT_EXTRAS
    /* Logged for the person reading rather than tested: the PCF8563 RTC on the
     * PMU bus, and the display / BME280 / GNSS behind their own rails. */
    static const uint8_t extra_rails[] = { TS_PMU_ALDO1_V, TS_PMU_ALDO2_V, TS_PMU_ALDO4_V };
    detect_ack(TS_PMU_SDA, TS_PMU_SCL, TS_RTC_ADDR);
    ts_pmu_rails(extra_rails, 3, TS_PMU_EN_ALDO1 | TS_PMU_EN_ALDO2 | TS_PMU_EN_ALDO4, NULL);
    vTaskDelay(pdMS_TO_TICKS(50));
    detect_ack2(TS_OLED_SDA, TS_OLED_SCL, 0x3C, 0x3D);
    detect_bme280(TS_OLED_SDA, TS_OLED_SCL, NULL);
    detect_gps(TS_GPS_RX, NULL);
#endif

    detect_found("hw_lilygo_tbeam_supreme");
    return "hw-lilygo-tbeam-supreme";
}

// hw-heltecv4 — DRIVES RAILS (Vext + the OLED reset), so it runs after every
// passive probe above.
#define HT_VEXT       36
#define HT_OLED_SDA   17
#define HT_OLED_SCL   18
#define HT_OLED_RST   21
#define HT_LORA_SCK    9
#define HT_LORA_MOSI  10
#define HT_LORA_MISO  11
#define HT_LORA_CS     8
#define HT_LORA_RST   12
#define HT_LORA_BUSY  13

static const char *detect_hw_heltecv4(void)
{
    if (!detect_flash_mb(16)) return NULL;

    detect_rail_drive(HT_VEXT, 0);                 /* Vext on (active low) */
    detect_rail_drive(HT_OLED_RST, 0);             /* pulse the OLED reset */
    esp_rom_delay_us(5000);
    gpio_set_level((gpio_num_t)HT_OLED_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(50));

    if (!detect_ack2(HT_OLED_SDA, HT_OLED_SCL, 0x3C, 0x3D)) {
        detect_dbg("no OLED on 17/18 — not a Heltec V4");
        detect_rail_release(HT_OLED_RST);
        detect_rail_release(HT_VEXT);
        return NULL;
    }
    // The modem, by name. An OLED on 17/18 with a radio on this header is not
    // enough to settle it: the Meshnology W12 carries the same 16 MB flash, the
    // same panel pins and the same LoRa header, and differs by the part on the
    // end of it — an SX1262 here, an LR2021 there.
    if (!detect_radio_is(HT_LORA_SCK, HT_LORA_MOSI, HT_LORA_MISO,
                         HT_LORA_CS, HT_LORA_RST, HT_LORA_BUSY, "sx1262")) {
        detect_dbg("OLED answered but no SX1262 — not a Heltec V4");
        detect_rail_release(HT_OLED_RST);
        detect_rail_release(HT_VEXT);
        return NULL;
    }

    detect_found("hw_heltecv4");
    return "hw-heltecv4";
}

// hw-meshnology-w12 — DRIVES RAILS (Vext + the OLED reset), so it runs after
// every passive probe, next to the Heltec V4 it shares a pin map with. The two
// are told apart by the modem alone: same 16 MB flash, same OLED on 17/18 with
// its reset on 21, same LoRa header — an SX1262 there, an LR2021 here.
#define W12_VEXT       45   // active LOW (P-MOSFET gate)
#define W12_OLED_SDA   17
#define W12_OLED_SCL   18
#define W12_OLED_RST   21
#define W12_LORA_SCK    9
#define W12_LORA_MOSI  10
#define W12_LORA_MISO  11
#define W12_LORA_CS     8
#define W12_LORA_RST   12
#define W12_LORA_BUSY  13

static const char *detect_hw_meshnology_w12(void)
{
    if (!detect_flash_mb(16)) return NULL;

    detect_rail_drive(W12_VEXT, 0);                /* Vext on (active low) */
    detect_rail_drive(W12_OLED_RST, 0);            /* pulse the OLED reset */
    esp_rom_delay_us(5000);
    gpio_set_level((gpio_num_t)W12_OLED_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(50));

    // Anchor: the SSD1315 OLED, an SSD1306 part that answers at 0x3C or 0x3D
    // depending on one strap. A bare ACK is all it offers.
    if (!detect_ack2(W12_OLED_SDA, W12_OLED_SCL, 0x3C, 0x3D)) {
        detect_dbg("no OLED on 17/18 — not a W12");
        detect_rail_release(W12_OLED_RST);
        detect_rail_release(W12_VEXT);
        return NULL;
    }
    if (!detect_radio_is(W12_LORA_SCK, W12_LORA_MOSI, W12_LORA_MISO,
                         W12_LORA_CS, W12_LORA_RST, W12_LORA_BUSY, "lr2021")) {
        detect_dbg("OLED answered but no LR2021 — not a W12");
        detect_rail_release(W12_OLED_RST);
        detect_rail_release(W12_VEXT);
        return NULL;
    }

    detect_found("hw_meshnology_w12");
    return "hw-meshnology-w12";
}

// hw-wismesh-tap-v2 — DRIVES RAILS (the 3V3 peripheral enable + the LoRa power
// enable), so it runs after every passive probe. On the boards it is not
// looking at, the pins it drives are benign (on the T-Deck: an audio data-in
// and the battery ADC sense), and it releases them again when it fails.
#define WT_POWER_EN     14
#define WT_LORA_PWR_EN   4
#define WT_I2C_SDA       9
#define WT_I2C_SCL      40
#define WT_TOUCH_ADDR 0x38
#define WT_GPS_RX       44
#define WT_LORA_SCK      5
#define WT_LORA_MOSI     6
#define WT_LORA_MISO     3
#define WT_LORA_CS       7
#define WT_LORA_RST      8
#define WT_LORA_BUSY    48

static const char *detect_hw_wismesh_tap_v2(void)
{
    if (!detect_flash_mb(16)) return NULL;

    detect_rail_drive(WT_POWER_EN, 1);
    detect_rail_drive(WT_LORA_PWR_EN, 1);
    vTaskDelay(pdMS_TO_TICKS(150));            /* 3.3 V rail settle */

    /* Anchor: the FT5x06 touch controller at its one fixed address on the board
     * I2C bus. A plain ACK is all it needs to give — its meaning comes from the
     * pins. POLLED, not probed once: the controller runs its own firmware off
     * this rail and can miss the first probe after a cold power-on. */
    bool tp = false;
    for (int i = 0; i < 6; i++) {
        if ((tp = detect_ack(WT_I2C_SDA, WT_I2C_SCL, WT_TOUCH_ADDR)))
            break;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (!tp) {
        detect_miss("no touch at 0x%02X — not a WisMesh TAP V2", WT_TOUCH_ADDR);
        detect_rail_release(WT_LORA_PWR_EN);
        detect_rail_release(WT_POWER_EN);
        return NULL;
    }
    /* Confirm with the radio: the RAK3112's internal SX1262 on its private bus.
     * The T-Deck is the other 16 MB touch board and its radio sits on entirely
     * different pins, so an SX1262 answering here settles it. */
    if (!detect_radio_is(WT_LORA_SCK, WT_LORA_MOSI, WT_LORA_MISO,
                         WT_LORA_CS, WT_LORA_RST, WT_LORA_BUSY, "sx1262")) {
        detect_miss("touch answered but no SX1262 — not a WisMesh TAP V2");
        detect_rail_release(WT_LORA_PWR_EN);
        detect_rail_release(WT_POWER_EN);
        return NULL;
    }

#if DETECT_EXTRAS
    detect_gps(WT_GPS_RX, NULL);               /* RAK12501 (Quectel L76K) */
#endif

    detect_found("hw_wismesh_tap_v2");
    return "hw-wismesh-tap-v2";
}

// hw-lilygo-tdeck — DRIVES THE MASTER RAIL, so it runs last of all.
#define TD_POWER_EN   10
#define TD_I2C_SDA    18
#define TD_I2C_SCL     8
#define TD_KB_ADDR  0x55
#define TD_GPS_RX     44
#define TD_LORA_SCK   40
#define TD_LORA_MOSI  41
#define TD_LORA_MISO  38
#define TD_LORA_CS     9
#define TD_LORA_RST   17
#define TD_LORA_BUSY  13
#define TD_LCD_CS     12    // shares SCK/MOSI/MISO with the radio
#define TD_SD_CS      39    // and so does this

static const char *detect_hw_lilygo_tdeck(void)
{
    if (!detect_flash_mb(16)) return NULL;

    detect_rail_drive(TD_POWER_EN, 1);
    /* The panel and the SD card sit on the radio's bus with their MISO wired,
     * so their CS is parked for the probe — on the same terms as the rail. */
    detect_cs_park(TD_LCD_CS);
    detect_cs_park(TD_SD_CS);
    vTaskDelay(pdMS_TO_TICKS(150));                /* 3.3 V rail settle */

    /* The keyboard is its own MCU booting its own firmware off this rail, and
     * from a cold rail it takes several hundred ms to reach its I2C loop — one
     * ACK attempt at 150 ms reads a healthy board as absent. A warm board
     * still answers on the first try. */
    bool kb = false;
    for (int i = 0; i < 12; i++) {
        if ((kb = detect_ack(TD_I2C_SDA, TD_I2C_SCL, TD_KB_ADDR)))
            break;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (!kb) {
        detect_miss("no keyboard at 0x%02X — not a T-Deck", TD_KB_ADDR);
        detect_cs_release(TD_SD_CS);
        detect_cs_release(TD_LCD_CS);
        detect_rail_release(TD_POWER_EN);
        return NULL;
    }
    if (!detect_radio(TD_LORA_SCK, TD_LORA_MOSI, TD_LORA_MISO,
                      TD_LORA_CS, TD_LORA_RST, TD_LORA_BUSY, NULL)) {
        detect_miss("keyboard answered but no radio — not a T-Deck");
        detect_cs_release(TD_SD_CS);
        detect_cs_release(TD_LCD_CS);
        detect_rail_release(TD_POWER_EN);
        return NULL;
    }

#if DETECT_EXTRAS
    detect_gt911(TD_I2C_SDA, TD_I2C_SCL);
    detect_es7210(TD_I2C_SDA, TD_I2C_SCL);
    detect_ack(TD_I2C_SDA, TD_I2C_SCL, 0x51);      /* PCF8563 RTC */
    detect_gps(TD_GPS_RX, NULL);
#endif

    detect_found("hw_lilygo_tdeck");
    return "hw-lilygo-tdeck";
}

// ── spangap state partition ─────────────────────────────────────────────────
// Board-independent, and the one thing here the firmware never reports: where
// the device keeps its own data. Read as it ACTUALLY exists on the chip, never
// by re-deriving spangap's runtime layout math. `state` is absent from the flash
// partition table (spangap registers it in RAM at boot; see spangap-core fs.cpp),
// so there are exactly two real sources:
//
//   1. A board that pins `state` in its table — read it straight from the
//      partition API.
//   2. spangap's runtime `state` — a LittleFS formatted over the flash above the
//      firmware floor. We find that filesystem on flash and read its geometry
//      from its own superblock (block_size × block_count), so the figures are
//      whatever was actually written, not a reconstruction.
static bool det_state_partition(char *out)
{
    // Case 1: a genuine table entry.
    const esp_partition_t *sp = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "state");
    if (sp) {
        sprintf(out, "spangap state partition at 0x%lx size 0x%lx",
                (unsigned long)sp->address, (unsigned long)sp->size);
        return true;
    }

    // Floor = the top of the on-flash partition table, via the partition API (the
    // same enumeration spangap floors on) — the lower bound for where a runtime
    // state filesystem can begin.
    uint32_t floor = 0;
    esp_partition_iterator_t it =
        esp_partition_find(ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, NULL);
    for (; it; it = esp_partition_next(it)) {
        const esp_partition_t *p = esp_partition_get(it);
        uint32_t end = p->address + p->size;
        if (end > floor) floor = end;
    }
    esp_partition_iterator_release(it);
    if (floor == 0) return false;

    uint32_t phys = 0;
    if (esp_flash_get_physical_size(NULL, &phys) != ESP_OK || phys == 0) return false;
    if (esp_flash_default_chip) esp_flash_default_chip->size = phys;   // allow full-chip reads

    // Scan 4K-aligned offsets from the floor for the LittleFS superblock, whose
    // 8-byte "littlefs" magic is stored verbatim in block 0. The superblock struct
    // follows the magic (+ its 4-byte inline-struct tag): version, block_size,
    // block_count — all little-endian u32. block_size × block_count is the real,
    // on-chip size of the store.
    for (uint32_t start = (floor + 0xFFF) & ~0xFFFu, n = 0; n < 16 && start < phys;
         n++, start += 0x1000) {
        uint8_t buf[256];
        if (esp_flash_read(NULL, buf, start, sizeof(buf)) != ESP_OK) continue;
        int m = -1;
        for (int i = 0; i + 24 <= (int)sizeof(buf); i++)
            if (memcmp(&buf[i], "littlefs", 8) == 0) { m = i; break; }
        if (m < 0) continue;
        const uint8_t *s = &buf[m + 12];               // struct: version, bsize, bcount, …
        uint32_t bsize  = s[4] | (s[5] << 8) | (s[6] << 16) | ((uint32_t)s[7] << 24);
        uint32_t bcount = s[8] | (s[9] << 8) | (s[10] << 16) | ((uint32_t)s[11] << 24);
        uint64_t size = (uint64_t)bsize * bcount;
        if (bsize == 0 || bcount == 0 || start + size > phys) continue;
        sprintf(out, "spangap state partition at 0x%lx size 0x%lx",
                (unsigned long)start, (unsigned long)size);
        return true;
    }
    return false;
}

void app_main(void)
{
    // One shot: the flasher captures this output over serial, folds it into the
    // banner, then resets the chip back into real firmware. Delay first so the
    // flasher's capture reader is attached before any line is printed.
    vTaskDelay(pdMS_TO_TICKS(800));

    // The probe trace is the point of running this at all — a board that was NOT
    // found is as informative as the one that was. It reaches the wire because
    // this build sets DETECT_TRACE_AT_INFO (see main/CMakeLists.txt), which puts
    // detect_dbg() at info; a runtime level cannot help, since at the default
    // CONFIG_LOG_MAXIMUM_LEVEL the debug macro is removed by the compiler.

    // Fragile first: passively-identifiable boards are settled before any probe
    // drives a power/reset GPIO that means something else on them.
    typedef const char *(*detect_fn)(void);
    static const detect_fn BOARDS[] = {
        detect_hw_nibble_zero,
        detect_hw_lilygo_t3s3_sx1262,
        detect_hw_xiao_esp32s3_sense,
        detect_hw_xiao_esp32s3_sx1262,
        detect_hw_lilygo_tbeam_supreme,
        detect_hw_heltecv4,
        detect_hw_meshnology_w12,
        detect_hw_wismesh_tap_v2,
        detect_hw_lilygo_tdeck,
    };
    const char *hw = NULL;
    for (size_t i = 0; i < sizeof(BOARDS) / sizeof(BOARDS[0]) && !hw; i++)
        hw = BOARDS[i]();

    // The machine-readable answer the flasher reads out of the capture. The probe
    // trace above is for a person; this line is the result.
    if (hw) printf("DETECT: DETECTED: %s\n", hw);
    else    printf("DETECT: no board matched\n");

    char out[96];
    if (det_state_partition(out)) {                // flash, board-independent
        printf("DETECT:\n");                       // blank line before the partition
        printf("DETECT: DETECTED: %s\n", out);
    }

    printf("DETECT: SPANGAP-DETECT-END\n");        // sentinel: capture is done

    // Hand the chip back to the ROM download loader rather than idling here.
    //
    // The flasher reaches this detector through the ROM loader and, on most
    // boards, leaves it the same way — a reset line it can drive. A board whose
    // USB is on the OTG controller rather than USB-Serial-JTAG has no such line:
    // esptool's reset sequences are DTR/RTS or the Serial-JTAG unit's own, and
    // neither exists there. On those boards a detector that idles is a dead end,
    // because the flash that should follow needs the ROM back and nothing can
    // put it there without a human pressing buttons.
    //
    // So the run ends where it began. Setting the RTC force-download-boot flag
    // and restarting brings the ROM loader up again, ready for the flash, with
    // no reset line involved. It costs the boards that CAN reset nothing: they
    // were going to be reset out of here anyway, and a chip sitting in the ROM
    // loader is what their next step wants too.
    //
    // The flag lives in the RTC domain and outlasts an ordinary reset, so it is
    // the flasher's job to clear it before sending the device back to its
    // firmware — otherwise every boot lands in the loader. flashmon.js does that
    // (`clearForceDownloadBoot`); esptool clears it in its own hard reset for the
    // same reason.
    fflush(stdout);
    vTaskDelay(pdMS_TO_TICKS(50));                 // let the sentinel reach the wire
    REG_WRITE(RTC_CNTL_OPTION1_REG, RTC_CNTL_FORCE_DOWNLOAD_BOOT);
    esp_restart();
}
