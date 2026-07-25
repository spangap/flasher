# Build the peripheral-detection RAM app and stage its image where the browser
# serves it: ../flashmon/detect/spangap_detect.bin (which IS checked in — this
# build/ directory is not).
#
#   make            build in the spangap container (no local ESP-IDF needed),
#                   then copy the image into ../flashmon/detect/
#   make LOCAL=1    build with an ESP-IDF already activated on your PATH instead
#   make clean      remove the build/ directory
#
# The container build uses `spangap detect-build`, which runs idf.py inside the
# workspace's build container — so all you need is a spangap workspace with this
# repo checked out.

BIN  := build/spangap_detect.bin
DEST := ../flashmon/detect/spangap_detect.bin

.PHONY: all build clean
all: build
	cp $(BIN) $(DEST)
	@echo "staged detector -> $(DEST)"

build:
ifeq ($(LOCAL),1)
	idf.py set-target esp32s3 build
else
	spangap detect-build
endif

clean:
	rm -rf build
