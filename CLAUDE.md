# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands go through the Makefile — **always use `make` targets**, not npm scripts directly.

| Command | Purpose |
|---------|---------|
| `make build` | Production build → `main.js` |
| `make dev` | Watch mode with inline sourcemaps |
| `make test` | Run all tests (vitest) |
| `make test-watch` | Tests in watch mode |
| `make lint` | ESLint on `src/` |
| `make lint-fix` | ESLint with auto-fix |
| `make local-install` | Build + copy to Obsidian vault (requires `.env` with `OBSIDIAN_PLUGIN_DIR`) |
| `make release` | Full pipeline: lint → test → build → bump → commit → tag → push → GitHub release |
| `make release BUMP=minor` | Same but minor/major version bump (default: patch) |

Run a single test file: `npx vitest run test/plan.test.ts`

## Architecture

Obsidian plugin that syncs vault files to S3. Six core modules:

**Sync flow:** `main.ts` → `plan.ts` (compute plan) → `modal.ts` (user confirms) → `sync.ts` (execute)

- **`plan.ts`** — Compares local vault vs remote manifest vs cached manifest. Uses mtime pre-filter to skip disk reads for unchanged files. Produces a list of actions: download-new/update, upload-new/update, delete-local/remote, conflict.
- **`sync.ts`** — Executes the plan in 6 steps: plan → confirm → lock → pull → push → finalize. Handles conflict resolution, manifest re-check for concurrent devices, advisory locking (5-min stale timeout).
- **`s3.ts`** — All S3 operations. Uses Obsidian's `requestUrl` (bypasses CORS) with AWS SDK v3 signature. Soft-deletes to `_trash/` prefix.
- **`merge.ts`** — 3-way merge via `node-diff3` for markdown; binary files always use keep-both strategy.
- **`filter.ts`** — Glob-based include/exclude via `picomatch`. Hardcoded exclusions: `.sync-manifest.json`, `.sync-lock.json`, `.sync-ancestors/**`, `.obsidian/plugins/*/data.json`.
- **`manifest.ts`** — Types for `SyncManifest` and `ManifestEntry` (sha256, mtime, version, deleted flag).

**Key design:** Hash-based change detection (SHA-256), single-read uploads, mtime pre-filter avoids I/O, soft deletes (never permanent), advisory locking with stale recovery, manifest re-check merges concurrent device changes.

## Testing

Tests use vitest. The `obsidian` package has no runtime (types-only), so it's aliased to `test/__mocks__/obsidian.ts` via `vitest.config.mts`.

**Mocking pattern for plan/sync tests:**
- `vi.mock("../src/s3", ...)` to stub S3 calls
- Create `TFile` instances from the mock, attach `_content` for `vault.readBinary`
- Mock `app.vault` with `getFiles()`, `getAbstractFileByPath()`, `readBinary()`

## Versioning

Three files must stay in sync: `package.json`, `manifest.json`, `versions.json`. The `make release` target handles this automatically via `scripts/bump-version.mjs`. Never bump versions manually.

## Release artifacts

GitHub releases include: `main.js`, `manifest.json`, `styles.css`. `main.js` is gitignored — it's built fresh for each release.
