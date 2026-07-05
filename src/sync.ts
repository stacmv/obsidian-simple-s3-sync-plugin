import { App, Notice, TFile, normalizePath } from "obsidian";
import type { S3Client } from "@aws-sdk/client-s3";
import type { S3SyncSettings } from "./settings";
import type { SyncManifest } from "./manifest";
import { createEmptyManifest, isLockStale } from "./manifest";
import type { HashCache } from "./plan";
import { shouldSyncFile } from "./filter";
import { sha256 } from "./hash";
import { mergeMarkdown } from "./merge";
import * as s3 from "./s3";

export interface SyncResult {
	pulled: number;
	pushed: number;
	conflicts: number;
	errors: string[];
}

interface LocalCachedManifest {
	manifest: SyncManifest;
}

export type SyncProgressCallback = (
	step: 3 | 4 | 5 | 6,
	detail: string,
	result: SyncResult
) => void;

export class SyncCancelledError extends Error {
	constructor() {
		super("Sync cancelled");
		this.name = "SyncCancelledError";
	}
}

function checkAborted(signal?: AbortSignal) {
	if (signal?.aborted) throw new SyncCancelledError();
}

// Drop tombstones (deleted entries) older than retentionMs. Returns a fresh
// manifest with the old entries removed and the count dropped.
//
// Tombstones are load-bearing for peer-resurrection detection — they stay until
// a peer's live upload supersedes them via version comparison, OR until enough
// time passes that no reasonable peer could still resurrect. The cutoff lives
// on the deleted timestamp so the cutoff is deterministic from data already in
// the manifest (no extra clock state to track per-entry).
//
// retentionMs <= 0 disables GC. Entries without a deletedAt are skipped so
// legacy data from older schema versions isn't accidentally wiped.
export function gcOldTombstones(
	manifest: SyncManifest,
	retentionMs: number,
	now: number = Date.now()
): { manifest: SyncManifest; dropped: number } {
	if (retentionMs <= 0) return { manifest, dropped: 0 };
	const files = { ...manifest.files };
	let dropped = 0;
	for (const [path, entry] of Object.entries(files)) {
		if (!entry.deleted) continue;
		const deletedAt = entry.deletedAt;
		if (deletedAt === undefined) continue;
		if (now - deletedAt > retentionMs) {
			delete files[path];
			dropped++;
		}
	}
	if (dropped === 0) return { manifest, dropped: 0 };
	return { manifest: { ...manifest, files }, dropped };
}

// Returns true if all entries under folderPath/ have deleted: true
function isAllFilesDeleted(
	folderPath: string,
	manifest: SyncManifest,
	settings: S3SyncSettings
): boolean {
	const normalizedFolderPath = normalizePath(folderPath);
	const folderPrefix = normalizedFolderPath.endsWith("/")
		? normalizedFolderPath
		: `${normalizedFolderPath}/`;

	for (const [path, entry] of Object.entries(manifest.files)) {
		if (path.startsWith(folderPrefix)) {
			if (shouldSyncFile(path, settings.includePatterns, settings.excludePatterns)) {
				if (!entry.deleted) {
					return false;
				}
			}
		}
	}

	// Return true if all entries are deleted, or if folder has no synced entries
	return true;
}

// Lists folders with zero synced files under the given folderPath
function getEmptyFolders(
	app: App,
	folderPath: string,
	manifest: SyncManifest,
	settings: S3SyncSettings
): string[] {
	const emptyFolders: string[] = [];
	const normalizedFolderPath = normalizePath(folderPath);
	const allFiles = app.vault.getFiles();
	const foldersToCheck = new Set<string>();

	// Collect all folders from manifest entries (includes deleted files)
	// This ensures we check folders even if all their files are deleted
	for (const [path] of Object.entries(manifest.files)) {
		if (shouldSyncFile(path, settings.includePatterns, settings.excludePatterns)) {
			const filePath = normalizePath(path);
			if (filePath.startsWith(`${normalizedFolderPath}/`)) {
				// Extract all parent directories of this file, including folderPath itself
				const parts = filePath.split("/");
				let currentPath = "";
				for (const part of parts.slice(0, -1)) {
					currentPath = currentPath ? `${currentPath}/${part}` : part;
					if (currentPath.startsWith(normalizedFolderPath)) {
						foldersToCheck.add(currentPath);
					}
				}
			}
		}
	}

	// Check each folder to see if it has any synced files (alive, not deleted)
	for (const folderPath of foldersToCheck) {
		let hasSyncedFiles = false;
		for (const file of allFiles) {
			const filePath = normalizePath(file.path);
			if (filePath.startsWith(`${folderPath}/`)) {
				if (shouldSyncFile(filePath, settings.includePatterns, settings.excludePatterns)) {
					hasSyncedFiles = true;
					break;
				}
			}
		}
		if (!hasSyncedFiles) {
			emptyFolders.push(folderPath);
		}
	}

	return emptyFolders;
}

// Returns true if a folder should be deleted (all synced files deleted, no active subfolders)
function shouldCleanupFolder(
	path: string,
	manifest: SyncManifest,
	app: App,
	settings: S3SyncSettings
): boolean {
	const normalizedPath = normalizePath(path);

	// Check if all synced files under this folder are deleted
	if (!isAllFilesDeleted(normalizedPath, manifest, settings)) {
		return false;
	}

	// Check if the folder path itself matches includePatterns filter
	if (!shouldSyncFile(normalizedPath, settings.includePatterns, settings.excludePatterns)) {
		return false;
	}

	// Check if the folder is in the empty folders list (has no synced files)
	const emptyFolders = getEmptyFolders(app, normalizedPath, manifest, settings);
	return emptyFolders.includes(normalizedPath);
}

// Main cleanup function: recursively delete empty folders after file deletions
async function cleanupEmptyFolders(
	app: App,
	manifest: SyncManifest,
	settings: S3SyncSettings,
	onProgress?: SyncProgressCallback,
	result?: SyncResult
): Promise<void> {
	// Collect all parent folders of deleted files
	const deletedFileFolders = new Set<string>();
	for (const [path, entry] of Object.entries(manifest.files)) {
		if (entry.deleted && shouldSyncFile(path, settings.includePatterns, settings.excludePatterns)) {
			// Extract parent folders
			const parts = path.split("/");
			let currentPath = "";
			for (let i = 0; i < parts.length - 1; i++) {
				currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
				deletedFileFolders.add(currentPath);
			}
		}
	}

	// For each deleted file's parent path, try to cleanup recursively up the tree
	for (const folderPath of deletedFileFolders) {
		let currentPath: string | undefined = folderPath;
		while (currentPath) {
			if (shouldCleanupFolder(currentPath, manifest, app, settings)) {
				try {
					const folder = app.vault.getAbstractFileByPath(normalizePath(currentPath));
					if (folder && !folder.isRoot) {
						await app.vault.delete(folder);
						onProgress?.(6, `Cleaned up folder: ${currentPath}`, result);
						// Move up to parent folder
						const lastSlash = currentPath.lastIndexOf("/");
						currentPath = lastSlash > 0 ? currentPath.substring(0, lastSlash) : undefined;
					} else {
						currentPath = undefined;
					}
				} catch (e: any) {
					// Log error but don't throw; folder might already be gone or permission issue
					result?.errors.push(`Cleanup folder ${currentPath}: ${e.message}`);
					currentPath = undefined;
				}
			} else {
				// Folder has active files, stop going up
				currentPath = undefined;
			}
		}
	}
}

// Returns hash only — uses cache, reads file only on miss. No unnecessary disk I/O.
async function getHashOnly(
	app: App,
	file: TFile,
	cache?: HashCache
): Promise<string> {
	const cached = cache?.get(file.path);
	if (cached) return cached;
	const data = new Uint8Array(await app.vault.readBinary(file));
	const hash = await sha256(data.buffer as ArrayBuffer);
	cache?.set(file.path, hash);
	return hash;
}

// Returns hash + data — used when we know we'll need the file content (conflicts, uploads).
async function getHashAndData(
	app: App,
	file: TFile,
	cache?: HashCache
): Promise<{ hash: string; data: Uint8Array }> {
	const data = new Uint8Array(await app.vault.readBinary(file));
	const hash = cache?.get(file.path) ?? await sha256(data.buffer as ArrayBuffer);
	cache?.set(file.path, hash);
	return { hash, data };
}

export async function runSync(
	app: App,
	client: S3Client,
	settings: S3SyncSettings,
	cachedData: LocalCachedManifest | null,
	saveCachedData: (data: LocalCachedManifest) => Promise<void>,
	onProgress?: SyncProgressCallback,
	signal?: AbortSignal,
	hashCache?: HashCache,
	cachedRemoteManifest?: SyncManifest
): Promise<SyncResult> {
	const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, errors: [] };
	const { s3Bucket: bucket, s3Prefix: prefix, deviceName } = settings;

	// Paths whose local file was overwritten with remote content in step 4
	// (clean pulls and conflict keep-both losers). Step 5 uses this to refresh
	// their cached mtime without re-uploading.
	const pulledPaths = new Set<string>();

	// --- Step 3: Acquire lock ---
	onProgress?.(3, "Checking lock...", result);
	checkAborted(signal);

	const existingLock = await s3.getLock(client, bucket, prefix);
	if (existingLock && !isLockStale(existingLock)) {
		// Allow override if same device (stale lock from crashed sync on this device)
		if (existingLock.deviceName !== deviceName) {
			throw new Error(
				`Sync locked by "${existingLock.deviceName}". Try again in a few minutes.`
			);
		}
	}
	await s3.putLock(client, bucket, prefix, {
		deviceName,
		timestamp: Date.now(),
	});

	try {
		// --- Step 4: Pull ---
		// Use manifest from planning phase if available — avoids a redundant S3 fetch.
		// The finalize re-check later handles any concurrent changes made in the interim.
		onProgress?.(4, "Fetching remote state...", result);
		checkAborted(signal);

		const remoteManifest =
			cachedRemoteManifest ??
			(await s3.getManifest(client, bucket, prefix)) ??
			createEmptyManifest(deviceName);

		const cachedManifest = cachedData?.manifest ?? createEmptyManifest(deviceName);

		// Accumulates the new S3 state across steps 4/5. Initialized from remoteManifest
		// so files we don't touch round-trip cleanly through step 6's putManifest.
		const updatedManifest: SyncManifest = {
			...remoteManifest,
			files: { ...remoteManifest.files },
		};

		// Paths whose on-disk content matches updatedManifest.files[path] AND matches
		// what's currently on S3. Safe to persist to the local cached manifest as a
		// mid-sync checkpoint. Pushed-but-not-yet-manifested entries are deliberately
		// excluded: if step 5/6 fails, the next sync needs to see local changes as
		// pending uploads (the S3 manifest still references the old sha) and retry.
		const reconciledPaths = new Set<string>();

		// Cached snapshot safe to persist mid-sync: pre-sync cached base plus only
		// the entries we've confirmed reconciled. Pushed entries are intentionally
		// absent so a partial sync leaves them as pending local changes for retry.
		const buildCheckpointSnapshot = (): SyncManifest => {
			const snap: SyncManifest = {
				...cachedManifest,
				files: { ...cachedManifest.files },
			};
			for (const path of reconciledPaths) {
				const entry = updatedManifest.files[path];
				if (entry) snap.files[path] = entry;
			}
			return snap;
		};

		const pullEntries = Object.entries(remoteManifest.files).filter(
			([path]) => shouldSyncFile(path, settings.includePatterns, settings.excludePatterns)
		);
		const pullTotal = pullEntries.length;
		let pullIndex = 0;

		try {
			for (const [path, remote] of pullEntries) {
				checkAborted(signal);
				pullIndex++;
				onProgress?.(4, `Checking remote ${pullIndex} / ${pullTotal}`, result);

				const cached = cachedManifest.files[path];
				const localFile = app.vault.getAbstractFileByPath(normalizePath(path));

				if (remote.deleted) {
					// Remote deleted: trash local copy if it exists
					if (localFile instanceof TFile) {
						if (!cached || cached.deleted) {
							// Either we already acknowledged this deletion in a prior
							// sync (cached.deleted), or this device never had a record
							// of the path at all (cached missing). In both cases the
							// local file is a fresh creation here — leave it alone
							// and let the push phase resurrect it on S3.
						} else {
							try {
								await app.vault.trash(localFile, true);
								result.pulled++;
								reconciledPaths.add(path);
							} catch (e: any) {
								result.errors.push(`Delete ${path}: ${e.message}`);
							}
						}
					} else {
						// Already absent locally — confirm cached matches remote (deleted)
						reconciledPaths.add(path);
					}
					continue;
				}

				if (!localFile) {
					// A cached tombstone OLDER than this live remote means a peer
					// resurrected the file after our deletion — the tombstone is
					// superseded, so we must download it rather than skip.
					const supersededTombstone =
						cached?.deleted === true && remote.version > cached.version;
					if (cached && !supersededTombstone) {
						// File was previously synced but is now missing locally: it was
						// deleted locally. Skip download; Phase 2 will soft-delete on S3.
						continue;
					}
					// New file from remote (or a superseded-tombstone resurrection): download it
					const data = await s3.downloadFile(client, bucket, prefix, path);
					if (data) {
						const dir = path.contains("/")
							? path.substring(0, path.lastIndexOf("/"))
							: "";
						if (dir) {
							await ensureDir(app, dir);
						}
						const created = await app.vault.createBinary(
							normalizePath(path),
							data.buffer as ArrayBuffer
						);
						if (created instanceof TFile) {
							updatedManifest.files[path] = {
								...updatedManifest.files[path],
								mtimeMs: created.stat.mtime,
								sizeBytes: created.stat.size,
							};
						}
						hashCache?.set(path, remote.sha256);
						reconciledPaths.add(path);
						result.pulled++;
					}
					continue;
				}

				if (!(localFile instanceof TFile)) continue;

				// File exists both locally and remotely
				const remoteVersion = remote.version;
				const cachedVersion = cached?.version ?? 0;

				if (remoteVersion <= cachedVersion) continue; // no remote change

				// Remote has a newer version: check for conflict
				const { hash: localHash, data: localData } = await getHashAndData(app, localFile, hashCache);
				const cachedHash = cached?.sha256 ?? "";

				if (localHash === remote.sha256) {
					// Already in sync — heal cached entry if it diverged (e.g. previous
					// sync interrupted before saving cached, or peer republished same content).
					updatedManifest.files[path] = {
						...updatedManifest.files[path],
						mtimeMs: localFile.stat.mtime,
						sizeBytes: localFile.stat.size,
					};
					reconciledPaths.add(path);
					continue;
				}

				const localChanged = localHash !== cachedHash;
				const remoteChanged = remote.sha256 !== cachedHash;

				if (localChanged && remoteChanged) {
					// TRUE CONFLICT
					const remoteData = await s3.downloadFile(client, bucket, prefix, path);
					if (!remoteData) continue;

					const resolved = await resolveConflict(
						app,
						client,
						settings,
						path,
						localData,
						remoteData,
						remote.sha256,
						cachedHash,
						hashCache
					);

					if (resolved === "kept-both") {
						// Local file was overwritten with remote content; treat it like a pull.
						pulledPaths.add(path);
						updatedManifest.files[path] = {
							...updatedManifest.files[path],
							mtimeMs: localFile.stat.mtime,
							sizeBytes: localFile.stat.size,
						};
						reconciledPaths.add(path);
						result.conflicts++;
					} else if (resolved === "merged") {
						// Merged content exists only locally until step 5/6 pushes it.
						// Don't reconcile yet — a partial sync must replay the merge.
						result.conflicts++;
					}
				} else if (remoteChanged && !localChanged) {
					// Remote is newer, no local changes: just pull
					const remoteData = await s3.downloadFile(client, bucket, prefix, path);
					if (remoteData) {
						await app.vault.modifyBinary(localFile, remoteData.buffer as ArrayBuffer);
						// Local file is now the remote content; keep hashCache aligned so
						// the push phase doesn't treat its own write as a local change
						// (which would corrupt the manifest's recorded sha256).
						hashCache?.set(path, remote.sha256);
						pulledPaths.add(path);
						updatedManifest.files[path] = {
							...updatedManifest.files[path],
							mtimeMs: localFile.stat.mtime,
							sizeBytes: localFile.stat.size,
						};
						reconciledPaths.add(path);
						result.pulled++;
					}
				}
				// if localChanged && !remoteChanged: will be pushed in Phase 2
			}
		} finally {
			// Persist post-pull progress. Even if the pull loop threw partway, the
			// paths already in reconciledPaths reflect the actual on-disk state, so
			// the next sync won't re-pull them or mistake the partial pull for a
			// concurrent edit (which would manifest as a phantom conflict).
			// Swallow save errors so they don't mask the original exception.
			try {
				await saveCachedData({ manifest: buildCheckpointSnapshot() });
			} catch (saveErr) {
				console.error("S3 Sync: failed to persist post-pull checkpoint", saveErr);
			}
		}

		// --- Step 5: Push ---
		checkAborted(signal);
		const allFiles = app.vault.getFiles();

		const pushFiles = allFiles.filter(
			(f) => shouldSyncFile(f.path, settings.includePatterns, settings.excludePatterns)
		);
		const pushTotal = pushFiles.length;
		let pushIndex = 0;

		for (const file of pushFiles) {
			checkAborted(signal);
			pushIndex++;
			onProgress?.(5, `Checking local ${pushIndex} / ${pushTotal}`, result);

			const path = file.path;
			const existing = updatedManifest.files[path];

			if (!existing || existing.deleted) {
				// New file or resurrection of a previously-deleted entry.
				// Bump version above the tombstone so peers pick up the resurrection.
				const localData = new Uint8Array(await app.vault.readBinary(file));
				const localHash =
					hashCache?.get(path) ??
					await sha256(localData.buffer as ArrayBuffer);
				hashCache?.set(path, localHash);
				onProgress?.(5, `Uploading ${path}`, result);
				await s3.uploadFile(client, bucket, prefix, path, localData);
				await s3.putAncestor(client, bucket, prefix, localHash, localData);
				updatedManifest.files[path] = {
					path,
					sha256: localHash,
					mtimeMs: file.stat.mtime,
					sizeBytes: file.stat.size,
					lastSyncedBy: deviceName,
					lastSyncedAt: Date.now(),
					version: (existing?.version ?? 0) + 1,
					deleted: false,
				};
				result.pushed++;
			} else {
				// Existing non-deleted entry: hash-only check first (cache hit = zero disk I/O for unchanged files)
				const localHash = await getHashOnly(app, file, hashCache);
				if (localHash !== existing.sha256) {
					onProgress?.(5, `Uploading ${path}`, result);
					const localData = new Uint8Array(await app.vault.readBinary(file));
					await s3.uploadFile(client, bucket, prefix, path, localData);
					await s3.putAncestor(client, bucket, prefix, localHash, localData);
					updatedManifest.files[path] = {
						...existing,
						sha256: localHash,
						mtimeMs: file.stat.mtime,
						sizeBytes: file.stat.size,
						lastSyncedBy: deviceName,
						lastSyncedAt: Date.now(),
						version: existing.version + 1,
					};
					result.pushed++;
				} else if (pulledPaths.has(path)) {
					// We just wrote remote content here; bump cached mtimeMs to the
					// post-write local mtime so the next sync's mtime pre-filter
					// recognizes the file as unchanged without re-reading it.
					updatedManifest.files[path] = {
						...existing,
						mtimeMs: file.stat.mtime,
						sizeBytes: file.stat.size,
					};
				}
			}
		}

		// Check for locally deleted files
		for (const [path, entry] of Object.entries(updatedManifest.files)) {
			checkAborted(signal);
			if (entry.deleted) continue;
			if (!shouldSyncFile(path, settings.includePatterns, settings.excludePatterns))
				continue;

			const localFile = app.vault.getAbstractFileByPath(normalizePath(path));
			if (!localFile) {
				// Defensive: if this live entry is NEWER than our cached tombstone, a
				// peer resurrected it after our deletion. The pull phase should have
				// downloaded it; if it somehow didn't (e.g. failed download), never
				// re-tombstone it — that would destroy the peer's content.
				const cachedTomb = cachedManifest.files[path];
				if (cachedTomb?.deleted && entry.version > cachedTomb.version) {
					continue;
				}
				const now = Date.now();
				const alreadyCached = cachedManifest.files[path]?.deleted === true;
				if (!alreadyCached) {
					try {
						await s3.softDeleteFile(client, bucket, prefix, path, deviceName);
					} catch (e: any) {
						result.errors.push(`Delete ${path}: ${e.message}`);
						continue;
					}
				}
				updatedManifest.files[path] = {
					...entry,
					deleted: true,
					deletedBy: deviceName,
					deletedAt: cachedManifest.files[path]?.deletedAt ?? now,
					version: entry.version + 1,
					lastSyncedBy: deviceName,
					lastSyncedAt: now,
				};
				result.pushed++;
			}
		}

		// --- Step 6: Finalize ---
		onProgress?.(6, "Writing manifest...", result);
		checkAborted(signal);

		// Re-check for concurrent changes
		const recheckManifest = await s3.getManifest(client, bucket, prefix);
		if (
			recheckManifest &&
			recheckManifest.lastUpdated !== remoteManifest.lastUpdated
		) {
			// Another device synced concurrently: merge manifests
			for (const [path, entry] of Object.entries(recheckManifest.files)) {
				const ours = updatedManifest.files[path];
				if (!ours || entry.version > ours.version) {
					if (
						ours?.deleted &&
						!entry.deleted &&
						(ours.deletedAt ?? 0) > (entry.lastSyncedAt ?? 0)
					) {
						continue;
					}
					updatedManifest.files[path] = entry;
				}
			}
		}

		// GC tombstones older than the configured retention. Done AFTER the
		// re-check merge so a peer's live resurrection always supersedes a
		// tombstone (the resurrection arrives as a non-deleted entry first;
		// GC then sees it as alive and leaves it alone).
		const retentionMs =
			settings.tombstoneRetentionDays * 24 * 60 * 60 * 1000;
		const { manifest: gcManifest, dropped: droppedTombstones } = gcOldTombstones(
			updatedManifest,
			retentionMs
		);
		if (droppedTombstones > 0) {
			onProgress?.(
				6,
				`Garbage-collected ${droppedTombstones} old tombstone${droppedTombstones === 1 ? "" : "s"}`,
				result
			);
			updatedManifest.files = gcManifest.files;
		}

		// Clean up empty folders after manifest is finalized
		checkAborted(signal);
		onProgress?.(6, "Cleaning up empty folders...", result);
		await cleanupEmptyFolders(app, updatedManifest, settings, onProgress, result);

		updatedManifest.lastUpdated = Date.now();
		updatedManifest.lastUpdatedBy = deviceName;

		// Only write manifest if it changed (avoid slow S3 upload on no-op syncs)
		const manifestChanged =
			JSON.stringify(updatedManifest) !== JSON.stringify(remoteManifest);
		if (manifestChanged) {
			onProgress?.(6, "Writing manifest...", result);
			await s3.putManifest(client, bucket, prefix, updatedManifest);
		}
		await saveCachedData({ manifest: updatedManifest });
	} finally {
		await s3.deleteLock(client, bucket, prefix).catch(() => {});
	}

	return result;
}

type ConflictResolution = "merged" | "kept-both" | null;

async function resolveConflict(
	app: App,
	client: S3Client,
	settings: S3SyncSettings,
	path: string,
	localData: Uint8Array,
	remoteData: Uint8Array,
	remoteHash: string,
	ancestorHash: string,
	hashCache?: HashCache
): Promise<ConflictResolution> {
	const decoder = new TextDecoder();
	const isMarkdown = path.endsWith(".md");
	const { s3Bucket: bucket, s3Prefix: prefix, deviceName } = settings;

	if (settings.mergeStrategy === "3way-merge" && isMarkdown && ancestorHash) {
		// Try 3-way merge
		const ancestorData = await s3.getAncestor(client, bucket, prefix, ancestorHash);
		if (ancestorData) {
			const ours = decoder.decode(localData);
			const ancestor = decoder.decode(ancestorData);
			const theirs = decoder.decode(remoteData);
			const merged = mergeMarkdown(ours, ancestor, theirs);

			if (merged.success) {
				// Clean merge: write result
				const file = app.vault.getAbstractFileByPath(normalizePath(path));
				if (file instanceof TFile) {
					await app.vault.modify(file, merged.content);
					// Keep hashCache aligned with on-disk content so the push phase
					// uploads the merged content with the correct sha256.
					const mergedBytes = new TextEncoder().encode(merged.content);
					hashCache?.set(
						path,
						await sha256(mergedBytes.buffer as ArrayBuffer)
					);
					new Notice(`Merged: ${path}`);
					return "merged";
				}
			}
			// Merge had conflicts: fall through to keep-both
		}
	}

	// Keep both: write remote as main, local as conflict copy
	const file = app.vault.getAbstractFileByPath(normalizePath(path));
	if (!(file instanceof TFile)) return null;

	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const ext = path.contains(".") ? path.substring(path.lastIndexOf(".")) : "";
	const base = path.contains(".")
		? path.substring(0, path.lastIndexOf("."))
		: path;
	const conflictPath = `${base}.conflict-${deviceName}-${ts}${ext}`;

	// Save local version as conflict copy
	await app.vault.createBinary(
		normalizePath(conflictPath),
		localData.buffer as ArrayBuffer
	);

	// Overwrite local with remote version. Align hashCache to the new on-disk
	// content so the push phase doesn't see a phantom local change.
	await app.vault.modifyBinary(file, remoteData.buffer as ArrayBuffer);
	hashCache?.set(path, remoteHash);

	new Notice(`Conflict: ${path}\nLocal saved as ${conflictPath}`);
	return "kept-both";
}

async function ensureDir(app: App, dirPath: string): Promise<void> {
	const normalized = normalizePath(dirPath);
	if (app.vault.getAbstractFileByPath(normalized)) return;

	const parts = normalized.split("/");
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			await app.vault.createFolder(current);
		}
	}
}
