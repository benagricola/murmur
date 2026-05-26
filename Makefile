# murmur build — esbuild standalone, no npm.
#
# `make dev`   — watch + serve. Edits to src/**/*.js rebuild src/app.js
#                in ~20ms. Open http://localhost:8000 and refresh.
# `make build` — bundle + minify into dist/. This is what GitHub Pages
#                deploys. dist/index.html references the bundled app.js.
# `make clean` — drop build artefacts.
#
# esbuild discovery: prefer the binary on PATH, fall back to $HOME/go/bin
# (where `go install github.com/evanw/esbuild/cmd/esbuild@latest` lands it).
ESBUILD := $(shell command -v esbuild 2>/dev/null || echo $(HOME)/go/bin/esbuild)
SRC     := src
DIST    := dist
ENTRY   := $(SRC)/main.js

.PHONY: dev build clean check

dev:
	@$(ESBUILD) $(ENTRY) --bundle --sourcemap --outfile=$(SRC)/app.js --servedir=$(SRC) --watch

build:
	@mkdir -p $(DIST)
	@$(ESBUILD) $(ENTRY) --bundle --minify --outfile=$(DIST)/app.js
	@cp $(SRC)/index.html $(SRC)/styles.css $(DIST)/

clean:
	@rm -rf $(DIST) $(SRC)/app.js $(SRC)/app.js.map

# Quick parse-check without producing output — useful in CI or pre-commit.
check:
	@$(ESBUILD) $(ENTRY) --bundle --outfile=/dev/null
