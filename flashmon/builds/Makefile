# Build the images in ../flashmon.yaml and package the branded standalone flasher
# + its offline bundle a directory up (../).
#
# `make-builds.py` (a directory up) reads ../flashmon.yaml, runs each entry's
# `spangap build` invocation in the container (no ESP-IDF install needed), writes
# each image as ../builds/<slug>_<name>_<DATETIME>.zip, and records that DATETIME
# as the entry's `version:` in ../flashmon.yaml. It is the ONLY writer of the
# config; the flasher (browser or `flashmon.py`) only ever reads it. A subset build
# (`BUILD=hw-x`) re-stamps just that entry — the others keep their old datetime and
# stay listed. A failing build stops the run there: the images built before it
# keep their fresh datetime, the rest keep their old one, and make exits
# non-zero without going on to the branded script or the bundle.
# `flashmon.py make-zip` copies ../flashmon.py to ../<project>-flashmon
# (baking the yaml's `url:` in) and packs it with the config, images, the detector
# and cross-platform tool wheels into ../<project>_<DATETIME>.zip; it refuses unless
# every image is present, so the offline bundle only comes from a full build.
#
#   make                         build every image + branded script + offline bundle
#   make OFFLINE=0               build every image + branded script, skip the offline zip
#   make images                  build every image, no branded script, no bundle
#   make images BUILD=hw-x       rebuild just one image (re-stamps only its entry)
#   make brand                   just the branded standalone script (fast, no net)
#   make bundle                  same as `make`
#   make clean                   delete every artifact the targets above produce
#
# All outputs (images, branded script, zips) are gitignored build artifacts.

BUILD ?=
# OFFLINE=0 skips the slow offline bundle (wheel fetch + zip); the branded script
# is still written, so you get everything but ../<project>_<DATETIME>.zip.
OFFLINE ?= 1

.PHONY: all images brand bundle clean
all: bundle

images:
	cd .. && python3 make-builds.py $(BUILD)

brand:
	cd .. && python3 flashmon.py make-brand

# The offline bundle is the whole catalogue, so it only comes from a full build.
bundle:
	@[ -z "$(BUILD)" ] || { echo "make bundle packages ALL images — drop BUILD= (use 'make images BUILD=$(BUILD)' to rebuild one)" >&2; exit 1; }
	cd .. && python3 make-builds.py
ifeq ($(OFFLINE),0)
	cd .. && python3 flashmon.py make-brand
	@echo "make: OFFLINE=0 — wrote the branded script, skipped the offline bundle zip." >&2
else
	cd .. && python3 flashmon.py make-zip
endif

# Every artifact of the targets above, wherever each one lands: the images here,
# and a directory up the branded <slug>-flashmon script, the offline bundle zips
# and the served offline-installer/ directory. The globs match .gitignore's, so
# nothing tracked is in range — flashmon.py, index.html, detect/, vendor/ and
# flashmon.yaml all survive. Old datetimes are swept too: the images are named
# <slug>_<name>_<datetime>.zip, so a rebuild leaves the previous run's copies
# behind and only this removes them.
clean:
	rm -f *.zip
	cd .. && rm -f *-flashmon *.zip
	cd .. && rm -rf offline-installer offline-installer.new __pycache__
	@echo "clean: removed images, branded script, bundles and offline-installer/." >&2
	@echo "clean: ../flashmon.yaml keeps its version: stamps — they name images that" >&2
	@echo "       are now gone, so rebuild before serving the page." >&2
