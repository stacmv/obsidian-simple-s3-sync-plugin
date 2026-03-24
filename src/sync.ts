import { App, Notice, TFile, normalizePath } from "obsidian";
import type { S3Client } from "@aws-sdk/client-s3";
import type { S3SyncSettings } from "./settings";
import type { SyncManifest } from "./manifest";
import { createEmptyManifest, isLockStale } from "./manifest";
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

export type SyncProgressCallback = (phase: string, result: SyncResult) => void;

export async function runSync(
	app: App,
	client: S3Client,
	settings: S3SyncSettings,
	cachedData: LocalCachedManifest | null,
	saveCachedData: (data: LocalCachedManifest) => Promise<void>,
	onProgress?: SyncProgressCallback
): Promise<SyncResult> {
	const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, errors: [] };
	const { s3Bucket: bucket, s3Prefix: prefix, deviceName } = settings;
	// --- Lock ---
	const existingLock = await s3.getLock(client, bucket, prefix);
	if (existingLock && !isLockStale(existingLock)) {
		throw new Error(
			`Sync locked by "${existingLock.deviceName}". Try again in a few minutes.`
		);
	}
	await s3.putLock(client, bucket, prefix, {
		deviceName,
		timestamp: Date.now(),
	});

	try {
		// --- Phase 1: Pull ---
		onProgress?.("pulling", result);
		const remoteManifest =
			(await s3.getManifest(client, bucket, prefix)) ??
			createEmptyManifest(deviceName);

		const cachedManifest = cachedData?.manifest ?? createEmptyManifest(deviceName);

		for (const [path, remote] of Object.entries(remoteManifest.files)) {
			if (!shouldSyncFile(path, settings.includePatterns, settings.excludePatterns))
				continue;

			const cached = cachedManifest.files[path];
			const localFile = app.vault.getAbstractFileByPath(normalizePath(path));

			if (remote.deleted) {
				// Remote deleted: trash local copy if it exists
				if (localFile instanceof TFile) {
					try {
						await app.vault.trash(localFile, true);
						result.pulled++;
						onProgress?.("pulling", result);
					} catch (e: any) {
						result.errors.push(`Delete ${path}: ${e.message}`);
					}
				}
				continue;
			}

			if (!localFile) {
				if (cached) {
					// File was previously synced but is now missing locally: it was
					// deleted locally. Skip download; Phase 2 will soft-delete on S3.
					continue;
				}
				// New file from remote: download it
				const data = await s3.downloadFile(client, bucket, prefix, path);
				if (data) {
					const dir = path.contains("/")
						? path.substring(0, path.lastIndexOf("/"))
						: "";
					if (dir) {
						await ensureDir(app, dir);
					}
					await app.vault.createBinary(normalizePath(path), data.buffer as ArrayBuffer);
					result.pulled++;
					onProgress?.("pulling", result);
				}
				continue;
			}

			if (!(localFile instanceof TFile)) continue;

			// File exists both locally and remotely
			const remoteVersion = remote.version;
			const cachedVersion = cached?.version ?? 0;

			if (remoteVersion <= cachedVersion) continue; // no remote change

			// Remote has a newer version: check for conflict
			const localData = new Uint8Array(await app.vault.readBinary(localFile));
			const localHash = await sha256(localData.buffer as ArrayBuffer);
			const cachedHash = cached?.sha256 ?? "";

			if (localHash === remote.sha256) {
				// Same content, no action needed
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
					cachedHash
				);

				if (resolved) {
					result.conflicts++;
					onProgress?.("pulling", result);
				}
			} else if (remoteChanged && !localChanged) {
				// Remote is newer, no local changes: just pull
				const remoteData = await s3.downloadFile(client, bucket, prefix, path);
				if (remoteData) {
					await app.vault.modifyBinary(localFile, remoteData.buffer as ArrayBuffer);
					result.pulled++;
					onProgress?.("pulling", result);
				}
			}
			// if localChanged && !remoteChanged: will be pushed in Phase 2
		}

		// --- Phase 2: Push ---
		onProgress?.("pushing", result);
		const allFiles = app.vault.getFiles();
		const updatedManifest: SyncManifest = {
			...remoteManifest,
			files: { ...remoteManifest.files },
		};

		for (const file of allFiles) {
			const path = file.path;
			if (!shouldSyncFile(path, settings.includePatterns, settings.excludePatterns))
				continue;

			const localData = new Uint8Array(await app.vault.readBinary(file));
			const localHash = await sha256(localData.buffer as ArrayBuffer);

			const existing = updatedManifest.files[path];

			if (!existing) {
				// New file: upload
				await s3.uploadFile(client, bucket, prefix, path, localData);
				await s3.putAncestor(client, bucket, prefix, localHash, localData);
				updatedManifest.files[path] = {
					path,
					sha256: localHash,
					mtimeMs: file.stat.mtime,
					sizeBytes: file.stat.size,
					lastSyncedBy: deviceName,
					lastSyncedAt: Date.now(),
					version: 1,
					deleted: false,
				};
				result.pushed++;
				onProgress?.("pushing", result);
			} else if (!existing.deleted && localHash !== existing.sha256) {
				// Modified: upload
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
				onProgress?.("pushing", result);
			}
		}

		// Check for locally deleted files
		for (const [path, entry] of Object.entries(updatedManifest.files)) {
			if (entry.deleted) continue;
			if (!shouldSyncFile(path, settings.includePatterns, settings.excludePatterns))
				continue;

			const localFile = app.vault.getAbstractFileByPath(normalizePath(path));
			if (!localFile) {
				const now = Date.now();
				// If cached manifest already recorded this deletion, skip the S3
				// object operations (already done) and just re-mark in the manifest
				// to push the deletion upstream again (remote may be stale).
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
				onProgress?.("pushing", result);
			}
		}

		// --- Phase 3: Upload manifest ---
		onProgress?.("finalizing", result);
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
					// Don't let a concurrent re-upload overwrite our deletion if our
					// deletion is more recent than the other device's last sync.
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

		updatedManifest.lastUpdated = Date.now();
		updatedManifest.lastUpdatedBy = deviceName;

		await s3.putManifest(client, bucket, prefix, updatedManifest);
		await saveCachedData({ manifest: updatedManifest });
	} finally {
		await s3.deleteLock(client, bucket, prefix).catch(() => {});
	}

	return result;
}

async function resolveConflict(
	app: App,
	client: S3Client,
	settings: S3SyncSettings,
	path: string,
	localData: Uint8Array,
	remoteData: Uint8Array,
	ancestorHash: string
): Promise<boolean> {
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
					new Notice(`Merged: ${path}`);
					return true;
				}
			}
			// Merge had conflicts: fall through to keep-both
		}
	}

	// Keep both: write remote as main, local as conflict copy
	const file = app.vault.getAbstractFileByPath(normalizePath(path));
	if (!(file instanceof TFile)) return false;

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

	// Overwrite local with remote version
	await app.vault.modifyBinary(file, remoteData.buffer as ArrayBuffer);

	new Notice(`Conflict: ${path}\nLocal saved as ${conflictPath}`);
	return true;
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
