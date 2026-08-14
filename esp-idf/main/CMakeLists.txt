# The detector: every board straddle's detect_hw(), copied in and run in turn.
# detect_probe.h is likewise a copy of spangap-core's — see detect.c.
#
# DETECT_EXTRAS turns on the reads that identify nothing and are only there for
# the trace (touch, RTC, GNSS, environmental sensor). Here the trace IS the
# product and the run ends in a reset, so their cost does not matter; in the
# firmware, which runs the same functions on every boot, it does.
idf_component_register(
    SRCS "detect.c"
    INCLUDE_DIRS "."
    REQUIRES driver esp_driver_i2c esp_driver_spi esp_driver_ledc esp_driver_uart
             spi_flash esp_partition
)
target_compile_definitions(${COMPONENT_LIB} PRIVATE DETECT_EXTRAS=1)
