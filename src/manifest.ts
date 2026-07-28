export interface ManifestEntry {
	path: string;
	sha256: string;
	mtimeMs: number;
	sizeBytes: number;
	lastSyncedBy: string;
	lastSyncedAt: number;
	version: number;
	deleted: boolean;
	deletedBy?: string;
	deletedAt?: number;
}

export interface SyncManifest {
	schemaVersion: 1;
	lastUpdated: number;
	lastUpdatedBy: string;
	files: Record<string, ManifestEntry>;
}

export function createEmptyManifest(deviceName: string): SyncManifest {
	return {
		schemaVersion: 1,
		lastUpdated: Date.now(),
		lastUpdatedBy: deviceName,
		files: {},
	};
}

/**
 * Refuse to work with a fetched manifest that is OLDER than the state this
 * device has already incorporated (its cached manifest).
 *
 * A time-reversed manifest is a stale read — an HTTP cache (Electron applies
 * heuristic caching because S3 responses carry no Cache-Control) or S3
 * read-after-overwrite lag. Planning against it re-materializes tombstones and
 * versions that were already superseded, producing destructive phantom
 * deletions (incident 2026-07-28). An empty cache (fresh device, after "Reset
 * local sync state") skips the check — its lastUpdated is just "now".
 */
export function assertManifestNotStale(
	fetched: SyncManifest,
	cached: SyncManifest
): void {
	if (Object.keys(cached.files).length === 0) return;
	if (fetched.lastUpdated < cached.lastUpdated) {
		throw new Error(
			`Sync aborted: received a stale manifest (updated ${new Date(fetched.lastUpdated).toISOString()} ` +
				`by "${fetched.lastUpdatedBy}", but this device already knows state from ` +
				`${new Date(cached.lastUpdated).toISOString()}). Try again in a moment.`
		);
	}
}

export interface SyncLock {
	deviceName: string;
	timestamp: number;
}

const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes

export function isLockStale(lock: SyncLock): boolean {
	return Date.now() - lock.timestamp > LOCK_STALE_MS;
}
