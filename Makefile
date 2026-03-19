.PHONY: build dev lint lint-fix test test-watch install clean

ESLINT = node node_modules/eslint/bin/eslint.js
VITEST = node node_modules/vitest/vitest.mjs

build:
	node esbuild.config.mjs production

dev:
	node esbuild.config.mjs

lint:
	$(ESLINT) src/

lint-fix:
	$(ESLINT) src/ --fix

test:
	$(VITEST) run

test-watch:
	$(VITEST)

install:
	npm install

clean:
	rm -f main.js main.js.map
