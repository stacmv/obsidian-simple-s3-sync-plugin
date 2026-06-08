import { App, TFile, normalizePath } from "obsidian";
import type { S3Client } from "@aws-sdk/client-s3";
import type { S3SyncSettings } from "./settings";
import type { SyncManifest } from "./manifest";
import { createEmptyManifest } from "./manifest";
import { shouldSyncFile } from "./filter";
import { sha256 } from "./hash";
import * as s3 from "./s3";

export type SyncAction =
	| "download-new"
	| "download-update"
	| "upload-new"
	| "upload-update"
	| "delete-local"
	| "delete-remote"
	| "conflict";

export interface SyncPlanEntry {
	path: string;
	action: SyncAction;
}

export type HashCache = Map<string, string>;

export interface SyncPlan {
	entries: SyncPlanEntry[];
	hashCache: HashCache;
	remoteManifest: SyncManifest;
}

export type PlanProgressCallback = (detail: string) => void;

export async function computeSyncPlan(
	app: App,
	client: S3Client,
	settings: S3SyncSettings,
	cachedManifest: SyncManifest,
	onProgress?: PlanProgressCallback
): Promise<SyncPlan> {
	const { s3Bucket: bucket, s3Prefix: prefix } = settings;
	const entries: SyncPlanEntry[] = [];
	const hashCache: HashCache = new Map();
	const planned = new Set<string>();

	onProgress?.("Fetching remote state...");

	const remoteManifest =
		(await s3.getManifest(client, bucket, prefix)) ??
		createEmptyManifest(settings.deviceName);

	// Pre-count files to compare for progress reporting
	const remoteEntries = Object.entries(remoteManifest.files).filter(
		([path]) => shouldSyncFile(path, settings.includePatterns, settings.excludePatterns)
	);
	const localFiles = app.vault.getFiles().filter(
		(f) => shouldSyncFile(f.path, settings.includePatterns, settings.excludePatterns)
	);
	const totalFiles = remoteEntries.length + localFiles.length;
	let compared = 0;

	// Check every file known to remote
	for (const [path, remote] of remoteEntries) {
		compared++;
		onProgress?.(`Comparing files ${compared} / ${totalFiles}`);

		const cached = cachedManifest.files[path];
		const localFile = app.vault.getAbstractFileByPath(normalizePath(path));

		if (remote.deleted) {
			if (localFile instanceof TFile) {
				// Resurrect (don't apply the tombstone) when the local file is a
				// fresh creation on this device — i.e. cached shows the deletion
				// was already acknowledged (cached.deleted), or cached has no
				// record of this path at all (the user created it here without
				// having ever seen the file alive). Only fall through to
				// delete-local when cached previously had it alive — that means
				// the tombstone is a peer's deletion of a file we know we shared.
				const action = !cached || cached.deleted ? "upload-new" : "delete-local";
				entries.push({ path, action });
				planned.add(path);
			}
			continue;
		}

		// Our cached manifest recorded this as deleted, but remote shows it live.
		if (cached?.deleted) {
			if (remote.version > cached.version) {
				// Remote is NEWER than our tombstone — a peer resurrected the file
				// after our deletion propagated. Adopt it rather than re-deleting.
				if (!localFile) {
					entries.push({ path, action: "download-new" });
				} else if (localFile instanceof TFile) {
					// Local re-creation races the peer resurrection: compare content.
					const localData = new Uint8Array(await app.vault.readBinary(localFile));
					const localHash = await sha256(localData.buffer as ArrayBuffer);
					hashCache.set(path, localHash);
					if (localHash !== remote.sha256) {
						entries.push({ path, action: "conflict" });
					}
				}
				planned.add(path);
				continue;
			}
			// Remote is stale (our deletion hasn't propagated yet). The next sync
			// will re-apply the deletion; don't surface it.
			planned.add(path);
			continue;
		}

		if (!localFile) {
			if (!cached) {
				// Never seen before: new file from remote
				entries.push({ path, action: "download-new" });
			} else {
				// Was previously synced, now gone locally: deleted locally
				entries.push({ path, action: "delete-remote" });
			}
			planned.add(path);
			continue;
		}

		if (!(localFile instanceof TFile)) continue;

		// mtime pre-filter: if local mtime matches last sync, content is unchanged —
		// reuse the cached hash and skip the disk read entirely.
		let localHash: string;
		if (cached && !cached.deleted && localFile.stat.mtime <= cached.mtimeMs) {
			localHash = cached.sha256;
		} else {
			const localData = new Uint8Array(await app.vault.readBinary(localFile));
			localHash = await sha256(localData.buffer as ArrayBuffer);
		}
		hashCache.set(path, localHash);

		if (localHash === remote.sha256) {
			planned.add(path); // identical — mark planned so local loop skips it
			continue;
		}

		const cachedHash = cached?.sha256 ?? "";
		const localChanged = localHash !== cachedHash;
		const remoteChanged = remote.sha256 !== cachedHash;
		const remoteIsNewer = remote.version > (cached?.version ?? 0);

		if (localChanged && remoteChanged) {
			if (!cached) {
				// No local history — device lost its cache (e.g. app reinstall,
				// Android data cleanup). We can't claim a local "change" without
				// a baseline, so trust the remote version.
				entries.push({ path, action: "download-update" });
			} else {
				entries.push({ path, action: "conflict" });
			}
		} else if (remoteIsNewer && remoteChanged && !localChanged) {
			entries.push({ path, action: "download-update" });
		} else if (localChanged && !remoteChanged) {
			entries.push({ path, action: "upload-update" });
		}
		planned.add(path);
	}

	// Check local files not yet covered
	for (const file of localFiles) {
		compared++;
		onProgress?.(`Comparing files ${compared} / ${totalFiles}`);

		const path = file.path;
		if (planned.has(path)) continue;

		const remote = remoteManifest.files[path];
		if (!remote) {
			entries.push({ path, action: "upload-new" });
		} else if (!remote.deleted) {
			// In remote but not yet planned — check for local modification
			const cachedEntry = cachedManifest.files[path];
			let localHash: string;
			if (cachedEntry && !cachedEntry.deleted && file.stat.mtime <= cachedEntry.mtimeMs) {
				// mtime unchanged — file is the same as last sync, skip disk read
				localHash = cachedEntry.sha256;
			} else {
				const localData = new Uint8Array(await app.vault.readBinary(file));
				localHash = await sha256(localData.buffer as ArrayBuffer);
			}
			hashCache.set(path, localHash);
			const cachedHash = cachedEntry?.sha256 ?? "";
			if (localHash !== remote.sha256 && localHash !== cachedHash) {
				if (!cachedEntry) {
					// No local history — trust remote over untracked local copy
					entries.push({ path, action: "download-update" });
				} else {
					entries.push({ path, action: "upload-update" });
				}
			}
		}
	}

	return { entries, hashCache, remoteManifest };
}
