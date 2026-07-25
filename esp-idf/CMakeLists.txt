# spangap peripheral-detection binary.
#
# A tiny, board-agnostic ESP32-S3 app that probes every I2C/SPI peripheral the
# hw-* straddles carry and prints "DETECTED: <device>" for each one it finds.
# The flasher uploads it after the esptool chip probe, watches the output in the
# monitor, then flashes the real firmware. See README.md and ../docs/detect.md.
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(spangap_detect)
