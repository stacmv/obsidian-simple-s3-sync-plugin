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

export interface SyncLock {
	deviceName: string;
	timestamp: number;
}

const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes

export function isLockStale(lock: SyncLock): boolean {
	return Date.now() - lock.timestamp > LOCK_STALE_MS;
}
