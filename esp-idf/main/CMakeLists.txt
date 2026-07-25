idf_component_register(
    SRCS "detect.c"
    INCLUDE_DIRS "."
    REQUIRES driver spi_flash esp_partition
)
