.PHONY: help build dev lint lint-fix test test-watch local-install release clean

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  build          Build plugin (main.js)"
	@echo "  dev            Build in watch mode"
	@echo "  lint           Run ESLint"
	@echo "  lint-fix       Run ESLint with auto-fix"
	@echo "  test           Run tests"
	@echo "  test-watch     Run tests in watch mode"
	@echo "  local-install  Build and copy to Obsidian vault (requires .env)"
	@echo "  release        Lint, test, build, bump version, push, create GitHub release"
	@echo "                 Use BUMP=minor or BUMP=major to control version increment (default: patch)"
	@echo "  clean          Remove build artifacts"

ESLINT = node node_modules/eslint/bin/eslint.js
VITEST  = node node_modules/vitest/vitest.mjs

VERSION = $(shell node -p "require('./package.json').version")

# Load .env if it exists (defines OBSIDIAN_PLUGIN_DIR)
-include .env
export

# ── Build ──────────────────────────────────────────────────────────────────────

build:
	node esbuild.config.mjs production

dev:
	node esbuild.config.mjs

# ── Quality ────────────────────────────────────────────────────────────────────

lint:
	$(ESLINT) src/

lint-fix:
	$(ESLINT) src/ --fix

test:
	$(VITEST) run

test-watch:
	$(VITEST)

# ── Local install ──────────────────────────────────────────────────────────────
# Requires OBSIDIAN_PLUGIN_DIR in .env, e.g.:
#   OBSIDIAN_PLUGIN_DIR=O:/obsidian/notes/.obsidian/plugins/simple-s3-sync

local-install: build
ifndef OBSIDIAN_PLUGIN_DIR
	$(error OBSIDIAN_PLUGIN_DIR is not set — create a .env file with OBSIDIAN_PLUGIN_DIR=<path>)
endif
	cp main.js manifest.json styles.css "$(OBSIDIAN_PLUGIN_DIR)/"
	@echo "Installed v$(VERSION) to $(OBSIDIAN_PLUGIN_DIR)"

# ── Release ────────────────────────────────────────────────────────────────────
# Usage: make release        — patch bump (0.1.0 → 0.1.1)
#        make release BUMP=minor — minor bump (0.1.0 → 0.2.0)
#        make release BUMP=major — major bump (0.1.0 → 1.0.0)

BUMP ?= patch

release: lint test build
	@echo "Bumping $(BUMP) version from $(VERSION)..."
	node scripts/bump-version.mjs $(BUMP)
	@NEW_VERSION=$$(node -p "require('./package.json').version"); \
	git add package.json manifest.json versions.json; \
	git commit -m "chore: release v$$NEW_VERSION"; \
	git tag -a "$$NEW_VERSION" -m "v$$NEW_VERSION"; \
	git push origin HEAD --tags; \
	gh release create "$$NEW_VERSION" main.js manifest.json styles.css \
		--title "v$$NEW_VERSION" \
		--notes "Release v$$NEW_VERSION"; \
	echo "Released v$$NEW_VERSION"

# ── Misc ───────────────────────────────────────────────────────────────────────

clean:
	rm -f main.js main.js.map
