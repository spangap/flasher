// spangap peripheral detection — probe the hw-* boards one at a time.
//
// Two layers:
//
//   * PERIPHERAL detectors — each takes explicit pin numbers and reports only
//     the part it found, e.g. "I2C(18/8): GT911 touch at 0x5D". They never name
//     a board, so any board can reuse them by passing its own pins.
//
//   * BOARD probes — probe_hw_<straddle>(). Each powers that board's rail (if
//     any), probes a mandatory anchor peripheral on that board's pins, bails if
//     it's absent, confirms with the radio, then reads the optional extras and
//     prints "DETECTED: hw-<straddle> (...extras...)". The board identifier is
//     ALWAYS the straddle name.
//
// app_main() calls the probes in order and STOPS at the first that returns true.
//
// Ordering is a safety property, not cosmetic. Probes that DRIVE power-enable or
// reset GPIOs (heltec Vext GPIO36 + OLED reset GPIO21, tdeck rail GPIO10) run
// LAST, so any board identifiable by passive bus reads alone is found before a
// rail-driving probe pokes pins that mean something else on that board. Every
// probe restores the rails it drove to hi-Z before returning, and the flasher
// hard-resets the chip into real firmware afterwards. See README and detect.md.
//
// Nothing here writes flash; every check is a bus read or a scratch-register
// write/read-back the real firmware overwrites at init.

#include <stdio.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/uart.h"
#include "driver/ledc.h"
#include "driver/i2c.h"        // legacy command-link API for ALL I2C here. The
                               // OV2640 on the XIAO Sense times out on the new
                               // i2c_master (sccb-ng) driver (seccam's finding),
                               // and one framework keeps the bus handling simple.
#include "driver/spi_master.h"
#include "esp_flash.h"
#include "esp_partition.h"
#include "esp_rom_sys.h"

// ── flash-size gate ──────────────────────────────────────────────────────────
// Physical flash size (SFDP) is board-specific and readable without PSRAM init,
// so a probe can bail before touching any pin when the size rules its board out
// (16 MB → tdeck/heltec, 8 MB → seeed/xiao, 4 MB → t3s3/nibble). PSRAM size would
// split the 16 MB pair further, but a single RAM image can't init PSRAM (octal
// vs quad is build-fixed — CONFIG_SPIRAM=n here), so we gate on flash alone and
// let the peripheral anchor settle same-flash boards. Fail open on a read error.
static uint32_t g_flash_bytes;

static bool flash_mb(int mb)
{
    return g_flash_bytes == 0 || g_flash_bytes == (uint32_t)mb * 1024 * 1024;
}

// ── I2C (legacy driver): install on a pin pair, one port, one bus at a time ──
#define I2C_PORT  I2C_NUM_0

static bool i2c_open(int sda, int scl)
{
    i2c_config_t c = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = sda, .scl_io_num = scl,
        .sda_pullup_en = GPIO_PULLUP_ENABLE, .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = 100000,
    };
    if (i2c_param_config(I2C_PORT, &c) != ESP_OK) return false;
    return i2c_driver_install(I2C_PORT, I2C_MODE_MASTER, 0, 0, 0) == ESP_OK;
}

static void i2c_close(void) { i2c_driver_delete(I2C_PORT); }

static bool i2c_ack(uint8_t addr)
{
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_WRITE, true);
    i2c_master_stop(cmd);
    esp_err_t r = i2c_master_cmd_begin(I2C_PORT, cmd, pdMS_TO_TICKS(50));
    i2c_cmd_link_delete(cmd);
    return r == ESP_OK;
}

// Register read, classic I2C style: write the reg address, repeated START, read
// `n` bytes (`rlen` = 1 for an 8-bit reg, 2 for a 16-bit MSB-first reg).
static bool i2c_rd_n(uint8_t addr, const uint8_t *reg, size_t rlen, uint8_t *buf, size_t n)
{
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_WRITE, true);
    i2c_master_write(cmd, (uint8_t *)reg, rlen, true);
    i2c_master_start(cmd);                                 // repeated START
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_READ, true);
    if (n > 1) i2c_master_read(cmd, buf, n - 1, I2C_MASTER_ACK);
    i2c_master_read_byte(cmd, buf + n - 1, I2C_MASTER_NACK);
    i2c_master_stop(cmd);
    esp_err_t r = i2c_master_cmd_begin(I2C_PORT, cmd, pdMS_TO_TICKS(100));
    i2c_cmd_link_delete(cmd);
    return r == ESP_OK;
}

static bool i2c_rd(uint8_t addr, uint8_t reg, uint8_t *buf, size_t n)
{
    return i2c_rd_n(addr, &reg, 1, buf, n);
}

static bool i2c_rd16(uint8_t addr, uint16_t reg, uint8_t *buf, size_t n)   // e.g. GT911
{
    uint8_t r[2] = { (uint8_t)(reg >> 8), (uint8_t)(reg & 0xFF) };
    return i2c_rd_n(addr, r, 2, buf, n);
}

static bool i2c_wr(uint8_t addr, uint8_t reg, uint8_t val)
{
    uint8_t b[2] = { reg, val };
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_WRITE, true);
    i2c_master_write(cmd, b, 2, true);
    i2c_master_stop(cmd);
    esp_err_t r = i2c_master_cmd_begin(I2C_PORT, cmd, pdMS_TO_TICKS(100));
    i2c_cmd_link_delete(cmd);
    return r == ESP_OK;
}

// ── I2C peripheral detectors — (pins…) -> present? Each prints its own line. ──

// Bare presence: the device ACKs its address but has no ID register to confirm
// what it is (keyboard, RTC, OLED). Report only the ACK — never guess the part;
// the board probe's pin context is what gives it meaning.
static bool det_ack(int sda, int scl, uint8_t addr)
{
    if (!i2c_open(sda, scl)) return false;
    bool ok = i2c_ack(addr);
    i2c_close();
    if (!ok) return false;
    printf("DETECT: I2C(%d/%d): ack at 0x%02X\n", sda, scl, addr);
    return true;
}

static bool det_gt911(int sda, int scl)
{
    if (!i2c_open(sda, scl)) return false;
    uint8_t addr = 0;
    if (i2c_ack(0x5D)) addr = 0x5D;
    else if (i2c_ack(0x14)) addr = 0x14;
    bool ok = false;
    if (addr) {
        uint8_t id[4] = {0};                       // product-ID string at 0x8140
        if (i2c_rd16(addr, 0x8140, id, 4) && id[0] == '9' && id[1] == '1' && id[2] == '1')
            ok = true;
    }
    i2c_close();
    if (!ok) return false;
    printf("DETECT: I2C(%d/%d): GT911 touch at 0x%02X\n", sda, scl, addr);
    return true;
}

static bool det_es7210(int sda, int scl)
{
    if (!i2c_open(sda, scl)) return false;
    uint8_t hi = 0, lo = 0;                        // chip-ID 0xFD/0xFE = 0x72/0x10
    bool ok = i2c_ack(0x40) &&
              i2c_rd(0x40, 0xFD, &hi, 1) && i2c_rd(0x40, 0xFE, &lo, 1) &&
              hi == 0x72 && lo == 0x10;
    i2c_close();
    if (!ok) return false;
    printf("DETECT: I2C(%d/%d): ES7210 audio ADC at 0x40\n", sda, scl);
    return true;
}

static bool det_bme280(int sda, int scl)
{
    if (!i2c_open(sda, scl)) return false;
    uint8_t addr = 0;
    if (i2c_ack(0x76)) addr = 0x76;
    else if (i2c_ack(0x77)) addr = 0x77;
    const char *name = NULL;
    if (addr) {
        uint8_t id = 0;                            // chip-ID reg 0xD0
        if (i2c_rd(addr, 0xD0, &id, 1))
            name = id == 0x60 ? "BME280" : id == 0x58 ? "BMP280" : id == 0x61 ? "BME680" : NULL;
    }
    i2c_close();
    if (!name) return false;
    printf("DETECT: I2C(%d/%d): %s environmental at 0x%02X\n", sda, scl, name, addr);
    return true;
}

// DVP camera sensors keep their SCCB block clocked off XCLK — with no XCLK the
// sensor doesn't ACK at all. Generate ~20 MHz on the XCLK pin (LEDC) so the
// SCCB probe below can reach the sensor, and stop it after.
static void xclk_start(int pin)
{
    ledc_timer_config_t t = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_1_BIT,   // 1-bit @ 20 MHz: 20M*2 = 40M ≤ 80M APB
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 20000000,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    if (ledc_timer_config(&t) != ESP_OK) return;
    ledc_channel_config_t c = {
        .gpio_num = pin, .speed_mode = LEDC_LOW_SPEED_MODE, .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0, .duty = 1, .hpoint = 0,   // 50% of 1-bit
    };
    ledc_channel_config(&c);
}

static void xclk_stop(int pin)
{
    ledc_stop(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 0);
    gpio_reset_pin(pin);
}

// ── SCCB register reads (camera) ─────────────────────────────────────────────
// SCCB is not repeated-START-capable: the sub-address write must end in a STOP,
// then a fresh START for the read — unlike i2c_rd above. Same legacy driver/port.
static bool sccb_rd(uint8_t addr, const uint8_t *reg, size_t rlen, uint8_t *val)
{
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_WRITE, true);
    i2c_master_write(cmd, (uint8_t *)reg, rlen, true);
    i2c_master_stop(cmd);
    esp_err_t r = i2c_master_cmd_begin(I2C_PORT, cmd, pdMS_TO_TICKS(200));
    i2c_cmd_link_delete(cmd);
    if (r != ESP_OK) return false;

    cmd = i2c_cmd_link_create();
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_READ, true);
    i2c_master_read_byte(cmd, val, I2C_MASTER_NACK);
    i2c_master_stop(cmd);
    r = i2c_master_cmd_begin(I2C_PORT, cmd, pdMS_TO_TICKS(200));
    i2c_cmd_link_delete(cmd);
    return r == ESP_OK;
}

static bool sccb_rd8(uint8_t addr, uint8_t reg, uint8_t *val)
{
    return sccb_rd(addr, &reg, 1, val);
}

static bool sccb_rd16(uint8_t addr, uint16_t reg, uint8_t *val)
{
    uint8_t r[2] = { (uint8_t)(reg >> 8), (uint8_t)(reg & 0xFF) };
    return sccb_rd(addr, r, 2, val);
}

// Camera sensors that fit the XIAO ESP32-S3 Sense DVP socket, identified over
// SCCB by their chip-ID registers — the same scheme esp32-camera (and seccam,
// which wraps it) use. OV sensors at 0x3C use 16-bit register addressing; OV2640
// needs a bank select first; the GC parts and OV7-series use 8-bit registers.
// `xclk` is the sensor's master clock (its SCCB block is silent without it).
static bool det_camera(int sda, int scl, int xclk, char *model)
{
    if (xclk >= 0) { xclk_start(xclk); vTaskDelay(pdMS_TO_TICKS(20)); }
    if (!i2c_open(sda, scl)) { if (xclk >= 0) xclk_stop(xclk); return false; }
    const char *name = NULL;
    uint8_t at = 0, h = 0, l = 0;

    // OV2640 — 0x30, 8-bit regs: bank 0xFF=1, then PID 0x0A/0x0B = 0x26 / 0x41|0x42.
    i2c_wr(0x30, 0xFF, 0x01);
    if (sccb_rd8(0x30, 0x0A, &h) && sccb_rd8(0x30, 0x0B, &l) &&
        h == 0x26 && (l == 0x41 || l == 0x42)) { name = "OV2640"; at = 0x30; }

    // OV5640 / OV3660 — 0x3C, 16-bit regs: chip ID at 0x300A/0x300B.
    if (!name && sccb_rd16(0x3C, 0x300A, &h) && sccb_rd16(0x3C, 0x300B, &l)) {
        at = 0x3C;
        if (h == 0x56 && l == 0x40) name = "OV5640";
        else if (h == 0x36 && l == 0x60) name = "OV3660";
    }
    // GC2145 — same 0x3C but 8-bit regs: ID 0xF0/0xF1 = 0x21/0x45.
    if (!name && sccb_rd8(0x3C, 0xF0, &h) && sccb_rd8(0x3C, 0xF1, &l) &&
        h == 0x21 && l == 0x45) { name = "GC2145"; at = 0x3C; }

    // OV7670 / OV7725 — 0x21, 8-bit regs: PID 0x0A/0x0B.
    if (!name && sccb_rd8(0x21, 0x0A, &h) && sccb_rd8(0x21, 0x0B, &l)) {
        at = 0x21;
        if (h == 0x76 && l == 0x73) name = "OV7670";
        else if (h == 0x77 && l == 0x21) name = "OV7725";
    }
    // GC0308 — 0x21, 8-bit: reg 0x00 = 0x9B.
    if (!name && sccb_rd8(0x21, 0x00, &h) && h == 0x9B) { name = "GC0308"; at = 0x21; }

    i2c_close();
    // OV2640 can't recover from XCLK gating without a power cycle, but detection
    // is one-shot: the flasher hard-resets straight after, and the real firmware
    // cold-inits the camera. So stopping XCLK here is fine.
    if (xclk >= 0) xclk_stop(xclk);
    if (!name) return false;
    if (model) strcpy(model, name);
    printf("DETECT: I2C(%d/%d): %s camera at 0x%02X (SCCB)\n", sda, scl, name, at);
    return true;
}

// ── SPI radio detector — one call tries every LoRa part on a header ──────────
typedef struct { int sck, mosi, miso, cs, rst, busy; } spi_pins_t;

static spi_device_handle_t spi_open(const spi_pins_t *p)
{
    spi_bus_config_t bus = {
        .sclk_io_num = p->sck, .mosi_io_num = p->mosi, .miso_io_num = p->miso,
        .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = 64,
    };
    if (spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_DISABLED) != ESP_OK) return NULL;
    spi_device_interface_config_t dev = {
        .clock_speed_hz = 1000000, .mode = 0, .spics_io_num = p->cs, .queue_size = 1,
    };
    spi_device_handle_t h = NULL;
    if (spi_bus_add_device(SPI2_HOST, &dev, &h) != ESP_OK) { spi_bus_free(SPI2_HOST); return NULL; }
    return h;
}

static void spi_close(spi_device_handle_t h)
{
    if (h) { spi_bus_remove_device(h); spi_bus_free(SPI2_HOST); }
}

static bool spi_xfer(spi_device_handle_t h, const uint8_t *tx, uint8_t *rx, size_t n)
{
    spi_transaction_t t = { .length = n * 8, .tx_buffer = tx, .rx_buffer = rx };
    return spi_device_transmit(h, &t) == ESP_OK;
}

static void radio_reset(const spi_pins_t *p)
{
    if (p->rst < 0) return;
    gpio_set_direction(p->rst, GPIO_MODE_OUTPUT);
    gpio_set_level(p->rst, 0);
    esp_rom_delay_us(2000);
    gpio_set_level(p->rst, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
}

static bool busy_low(int busy)
{
    if (busy < 0) return true;
    gpio_set_direction(busy, GPIO_MODE_INPUT);
    for (int i = 0; i < 1000; i++) {               // up to ~100 ms
        if (gpio_get_level(busy) == 0) return true;
        esp_rom_delay_us(100);
    }
    return false;
}

// Try SX127x (register), LR11xx and SX126x (command/BUSY) on one header. On a
// hit, fills `type_out`, prints the SPI line, and returns true.
static bool det_radio(int sck, int mosi, int miso, int cs, int rst, int busy, char *type_out)
{
    spi_pins_t p = { sck, mosi, miso, cs, rst, busy };
    spi_device_handle_t h = spi_open(&p);
    if (!h) return false;
    radio_reset(&p);

    char name[48] = "";

    // SX127x — RegVersion 0x42 (read: addr bit7 = 0). Most specific, try first.
    {
        uint8_t tx[2] = { 0x42, 0x00 }, rx[2] = {0};
        if (spi_xfer(h, tx, rx, 2)) {
            if (rx[1] == 0x12) strcpy(name, "SX127x LoRa (SX1276/78)");
            else if (rx[1] == 0x22) strcpy(name, "SX127x LoRa (SX1272/73)");
        }
    }

    // LR11xx — GetVersion (0x01 0x01); reply device byte 0xDF/0xDA/0xDB.
    if (!name[0] && busy >= 0 && busy_low(busy)) {
        uint8_t cmd[2] = { 0x01, 0x01 };
        spi_xfer(h, cmd, NULL, 2);
        busy_low(busy);
        uint8_t rtx[5] = {0}, rrx[5] = {0};        // stat, hw, device, fw_maj, fw_min
        if (spi_xfer(h, rtx, rrx, 5)) {
            uint8_t dev = rrx[2];
            if (dev == 0xDF) strcpy(name, "LR1121 (LR11xx)");
            else if (dev == 0xDA) strcpy(name, "LR1110 (LR11xx)");
            else if (dev == 0xDB) strcpy(name, "LR1120 (LR11xx)");
        }
    }

    // SX126x — no version reg: write a scratch byte to sync-word reg 0x0740 and
    // read it back; GetStatus (0xC0) must return a live status byte too.
    if (!name[0] && busy >= 0 && busy_low(busy)) {
        uint8_t w[4] = { 0x0D, 0x07, 0x40, 0xA5 };            // WriteRegister
        spi_xfer(h, w, NULL, 4);
        busy_low(busy);
        uint8_t rtx[5] = { 0x1D, 0x07, 0x40, 0x00, 0x00 }, rrx[5] = {0};   // ReadRegister
        bool ok = spi_xfer(h, rtx, rrx, 5);
        busy_low(busy);
        uint8_t stx[2] = { 0xC0, 0x00 }, srx[2] = {0};        // GetStatus sanity
        spi_xfer(h, stx, srx, 2);
        if (ok && rrx[4] == 0xA5 && srx[1] != 0x00 && srx[1] != 0xFF)
            strcpy(name, "SX126x LoRa (SX1262/68)");
    }

    // SX128x (2.4 GHz) — command/BUSY like SX126x but distinct opcodes (write
    // 0x18 / read 0x19), so the SX126x sync-word probe above can't catch it. Read
    // the firmware-version register at 0x0153/0x0154 via ReadRegister (0x19):
    // opcode + 2 addr + 1 status byte, then the two data bytes.
    if (!name[0] && busy >= 0 && busy_low(busy)) {
        uint8_t rtx[6] = { 0x19, 0x01, 0x53, 0x00, 0x00, 0x00 }, rrx[6] = {0};
        bool ok = spi_xfer(h, rtx, rrx, 6);
        busy_low(busy);
        uint16_t fw = (uint16_t)((rrx[4] << 8) | rrx[5]);
        if (ok && fw != 0x0000 && fw != 0xFFFF)
            strcpy(name, "SX128x LoRa (SX1280, 2.4 GHz)");
    }

    spi_close(h);
    if (!name[0]) return false;
    printf("DETECT: SPI(sck%d/mosi%d/miso%d/cs%d): %s\n", sck, mosi, miso, cs, name);
    // Slug for the straddle name — the radio is what splits e.g. the T3-S3 line.
    if (type_out) {
        const char *slug =
            strstr(name, "SX127x") ? "sx1276" :
            strstr(name, "SX1280") ? "sx1280" :
            strstr(name, "LR11")   ? "lr1121" :
                                     "sx1262";
        strcpy(type_out, slug);
    }
    return true;
}

// ── GNSS — passive autobaud on the receiver's UART RX ────────────────────────
// The two T-Deck GPS options only differ by their default baud (u-blox 38400,
// Quectel 9600). Both stream NMEA continuously when powered, so we listen (RX
// only, no TX — the physical TX pin is the console UART0 on other boards) and
// take the baud that first yields a checksum-valid "$…*hh" sentence.
static bool nmea_valid(const char *buf, int len)
{
    for (int i = 0; i < len; i++) {
        if (buf[i] != '$') continue;
        uint8_t sum = 0;
        int j = i + 1;
        for (; j < len && buf[j] != '*' && buf[j] != '$'; j++) sum ^= (uint8_t)buf[j];
        if (j + 2 >= len || buf[j] != '*') continue;
        int hi = buf[j + 1], lo = buf[j + 2];
        hi = (hi <= '9') ? hi - '0' : (hi | 0x20) - 'a' + 10;
        lo = (lo <= '9') ? lo - '0' : (lo | 0x20) - 'a' + 10;
        if (hi >= 0 && hi < 16 && lo >= 0 && lo < 16 && sum == (uint8_t)((hi << 4) | lo))
            return true;
    }
    return false;
}

static bool det_gps(int rx, char *type_out)
{
    static const int    bauds[] = { 38400, 9600 };
    static const char  *names[] = { "u-blox MIA-M10Q", "Quectel L76K" };
    for (int b = 0; b < 2; b++) {
        uart_config_t cfg = {
            .baud_rate = bauds[b], .data_bits = UART_DATA_8_BITS,
            .parity = UART_PARITY_DISABLE, .stop_bits = UART_STOP_BITS_1,
            .flow_ctrl = UART_HW_FLOWCTRL_DISABLE, .source_clk = UART_SCLK_DEFAULT,
        };
        if (uart_driver_install(UART_NUM_1, 2048, 0, 0, NULL, 0) != ESP_OK) return false;
        uart_param_config(UART_NUM_1, &cfg);
        uart_set_pin(UART_NUM_1, UART_PIN_NO_CHANGE, rx, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);

        char buf[512];
        int got = uart_read_bytes(UART_NUM_1, (uint8_t *)buf, sizeof(buf), pdMS_TO_TICKS(1200));
        uart_driver_delete(UART_NUM_1);

        if (got > 0 && nmea_valid(buf, got)) {
            printf("DETECT: UART(rx%d): %s GPS at %d\n", rx, names[b], bauds[b]);
            if (type_out) strcpy(type_out, names[b]);
            return true;
        }
    }
    return false;
}

// ── power rails — drive on entry, hand back to hi-Z on exit ──────────────────
static void rail_drive(int pin, int level)
{
    gpio_reset_pin(pin);
    gpio_set_direction(pin, GPIO_MODE_OUTPUT);
    gpio_set_level(pin, level);
}

// Return a driven pin to its reset default (input / hi-Z) — "back where it was"
// for a fresh RAM app; real firmware re-establishes the rail after the reset.
static void rail_release(int pin)
{
    gpio_reset_pin(pin);
}

// ── board probes — power the rail, anchor, confirm, enrich, restore ──────────

// The DETECTED line carries only the straddle name — the radio suffix, where it
// splits a board line, matters for straddle choice; everything else (touch, GPS
// type, BME280) is already on the peripheral lines above and stays out of it.

static bool probe_hw_nibble_zero(void)
{
    if (!flash_mb(4)) return false;                    // 4 MB flash or it isn't one
    if (!det_ack(8, 7, 0x3C) && !det_ack(8, 7, 0x3D)) return false;   // anchor: OLED ACK
    char radio[16];
    if (!det_radio(13, 11, 12, 10, 6, 5, radio)) return false;   // confirm
    det_bme280(8, 7);                                  // optional (its own line)
    printf("DETECT: DETECTED: hw-nibble-zero\n");
    return true;
}

static bool probe_hw_lilygo_t3s3(void)
{
    if (!flash_mb(4)) return false;
    if (!det_ack(18, 17, 0x3C) && !det_ack(18, 17, 0x3D)) return false;   // anchor: OLED ACK
    char radio[16];
    if (!det_radio(5, 6, 3, 7, 8, 34, radio)) return false;      // sx1262/76/80/lr1121
    printf("DETECT: DETECTED: hw-lilygo-t3s3-%s\n", radio);
    return true;
}

static bool probe_hw_xiao_esp32s3_sense(void)
{
    if (!flash_mb(8)) return false;                    // Sense board can't mount on the 16 MB Plus
    char cam[16];
    if (!det_camera(40, 39, 10, cam)) return false;    // SIOD 40, SIOC 39, XCLK 10; only anchor
    printf("DETECT: DETECTED: hw-xiao-esp32s3-sense (%s)\n", cam);   // model in brackets
    return true;
}

static bool probe_hw_xiao_esp32s3_sx1262(void)
{
    if (!flash_mb(8) && !flash_mb(16)) return false;   // base XIAO (8 MB) or Plus (16 MB)
    char radio[16];                                    // radio-only kit
    if (!det_radio(7, 9, 8, 41, 42, 40, radio)) return false;
    printf("DETECT: DETECTED: hw-xiao-esp32s3-%s\n", radio);
    return true;
}

static bool probe_hw_heltecv4(void)
{
    if (!flash_mb(16)) return false;
    rail_drive(36, 0);                                 // Vext on (active-low)
    rail_drive(21, 0);                                 // pulse OLED reset
    esp_rom_delay_us(5000);
    gpio_set_level(21, 1);
    vTaskDelay(pdMS_TO_TICKS(50));

    bool ok = false;
    char radio[16];
    if ((det_ack(17, 18, 0x3C) || det_ack(17, 18, 0x3D)) &&
        det_radio(9, 10, 11, 8, 12, 13, radio)) {
        printf("DETECT: DETECTED: hw-heltecv4\n");
        ok = true;
    }
    rail_release(21);
    rail_release(36);
    return ok;
}

static bool probe_hw_lilygo_tdeck(void)
{
    if (!flash_mb(16)) return false;
    rail_drive(10, 1);                                 // master rail on
    vTaskDelay(pdMS_TO_TICKS(150));

    bool ok = false;
    char radio[16];
    if (det_ack(18, 8, 0x55) && det_radio(40, 41, 38, 9, 17, 13, radio)) {   // anchor: keyboard ACK
        det_gt911(18, 8);                              // optional extras (own lines)
        det_es7210(18, 8);
        det_ack(18, 8, 0x51);                          // optional RTC (ACK only)
        det_gps(44, NULL);                             // prints its own line; type unused here
        printf("DETECT: DETECTED: hw-lilygo-tdeck\n");
        ok = true;
    }
    rail_release(10);
    return ok;
}

// ── spangap state partition ─────────────────────────────────────────────────
// Report the state store as it ACTUALLY exists on the chip — never by re-deriving
// spangap's runtime layout math. `state` is absent from the flash partition table
// (spangap registers it in RAM at boot; see spangap-core fs.cpp), so there are
// exactly two real sources:
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

    // Physical flash size up front — each probe uses it to bail before touching a
    // pin when its board can't be this size (see flash_mb).
    if (esp_flash_get_physical_size(NULL, &g_flash_bytes) != ESP_OK) g_flash_bytes = 0;

    // Safety order: passive-read boards first; rail-driving probes (heltec, then
    // tdeck) last, so a board found by bus reads alone is identified before any
    // probe drives a power/reset GPIO that means something else on it.
    typedef bool (*probe_t)(void);
    static const probe_t PROBES[] = {
        probe_hw_nibble_zero,
        probe_hw_lilygo_t3s3,
        probe_hw_xiao_esp32s3_sense,
        probe_hw_xiao_esp32s3_sx1262,
        probe_hw_heltecv4,
        probe_hw_lilygo_tdeck,
    };
    for (size_t i = 0; i < sizeof(PROBES) / sizeof(PROBES[0]); i++)
        if (PROBES[i]()) break;                    // stop at the first positive board

    char out[96];
    if (det_state_partition(out)) {                // flash, board-independent
        printf("DETECT:\n");                       // blank line before the partition
        printf("DETECT: DETECTED: %s\n", out);
    }

    printf("DETECT: SPANGAP-DETECT-END\n");        // sentinel: capture is done

    while (1) vTaskDelay(pdMS_TO_TICKS(1000));      // idle until the flasher resets us
}
