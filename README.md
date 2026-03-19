# Simple S3 Sync

Minimal Obsidian plugin for syncing your vault between devices via any S3-compatible storage.

Built as a simpler, safer alternative to full-featured sync plugins — focused on reliability and no data loss.

## Features

- **S3-only** — works with AWS S3, MinIO, Timeweb Cloud, Backblaze B2, or any S3-compatible provider
- **Per-device file filters** — each device syncs only the files matching its include/exclude glob patterns (e.g. mobile syncs only `**/*.md`, desktop syncs everything)
- **Conflict resolution**:
  - **3-way merge** (desktop default) — automatically merges non-overlapping changes in markdown files using a common ancestor
  - **Keep both** (mobile default) — creates a `.conflict-<device>-<timestamp>.md` copy so nothing is lost
- **Soft deletes** — deleted files are moved to `_trash/` prefix in S3, never truly removed
- **Manual or automatic sync** — ribbon button, command palette, or configurable interval

## How it works

1. A single **manifest** (`.sync-manifest.json`) in S3 tracks every file's hash, version, and which device last synced it
2. On sync: **pull** remote changes → **push** local changes → update manifest
3. **Ancestor versions** are stored in S3 (`.sync-ancestors/<sha256>`) to enable 3-way merge
4. An advisory **lock** prevents concurrent syncs from different devices

## Setup

1. Install the plugin (Community Plugins → Search "Simple S3 Sync")
2. Open Settings → Simple S3 Sync
3. Enter your S3 credentials:
   - Endpoint (e.g. `https://s3.amazonaws.com`)
   - Region
   - Bucket name
   - Access Key / Secret Key
4. Set a unique **Device name** (e.g. `desktop`, `mobile`)
5. Configure **File Filters** if you want this device to sync only a subset
6. Click the refresh icon in the ribbon to sync

## Per-device filtering

Set include/exclude glob patterns in settings. Examples:

| Device | Include | Exclude | Effect |
|--------|---------|---------|--------|
| Desktop | *(empty = all)* | `.obsidian/**`, `.trash/**` | Syncs everything except Obsidian config |
| Mobile | `**/*.md` | `.obsidian/**`, `.trash/**`, `Attachments/**` | Syncs only markdown files |

Each device only downloads and uploads files matching its own filter. The manifest is global — devices don't interfere with each other's files.

## Conflict resolution

When the same file is modified on two devices between syncs:

- **3-way merge**: the plugin downloads the common ancestor from S3 and performs a line-based merge. If the merge is clean, it writes the result. If there are conflicts (overlapping edits), it falls back to keep-both.
- **Keep both**: the remote version becomes the main file, the local version is saved as `filename.conflict-devicename-timestamp.md`.

Binary files always use keep-both.

## Safety

- **No mass deletes** — files are soft-deleted to `_trash/` in S3
- **Advisory locking** — prevents two devices from syncing simultaneously
- **Manifest re-check** — before uploading, the plugin verifies no other device changed the manifest during sync

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Endpoint | — | S3-compatible endpoint URL |
| Region | `us-east-1` | S3 region |
| Bucket | — | Bucket name |
| Key prefix | `vault` | All files stored under this prefix |
| Device name | `desktop`/`mobile` | Unique name per device |
| Sync interval | `0` (manual) | Auto-sync interval in minutes |
| Include patterns | *(empty)* | Glob patterns to include |
| Exclude patterns | `.obsidian/**`, `.trash/**` | Glob patterns to exclude |
| Merge strategy | `3way-merge` (desktop) / `keep-both` (mobile) | How to resolve conflicts |

## Development

```bash
# Install dependencies
make install

# Build for production
make build

# Run linter
make lint

# Run tests
make test

# Watch mode for tests
make test-watch
```

## License

MIT
