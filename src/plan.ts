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

export interface SyncPlan {
	entries: SyncPlanEntry[];
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
				entries.push({ path, action: "delete-local" });
				planned.add(path);
			}
			continue;
		}

		// If our cached manifest already recorded this as deleted, the remote
		// manifest is just stale (e.g. another device re-synced concurrently).
		// The next sync will re-apply the deletion; don't show it again.
		if (cached?.deleted) {
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

		const localData = new Uint8Array(await app.vault.readBinary(localFile));
		const localHash = await sha256(localData.buffer as ArrayBuffer);

		if (localHash === remote.sha256) continue; // identical content

		const cachedHash = cached?.sha256 ?? "";
		const localChanged = localHash !== cachedHash;
		const remoteChanged = remote.sha256 !== cachedHash;
		const remoteIsNewer = remote.version > (cached?.version ?? 0);

		if (localChanged && remoteChanged) {
			entries.push({ path, action: "conflict" });
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
			// In remote but hash mismatch not caught above — check for local modification
			const localData = new Uint8Array(await app.vault.readBinary(file));
			const localHash = await sha256(localData.buffer as ArrayBuffer);
			const cachedHash = cachedManifest.files[path]?.sha256 ?? "";
			if (localHash !== remote.sha256 && localHash !== cachedHash) {
				entries.push({ path, action: "upload-update" });
			}
		}
	}

	return { entries };
}
