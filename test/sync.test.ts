import { describe, it, expect, vi, beforeEach } from "vitest";
import { TFile } from "obsidian";
import type { SyncManifest, ManifestEntry } from "../src/manifest";
import type { S3SyncSettings } from "../src/settings";
import { sha256 } from "../src/hash";

// In-memory S3 backend shared across tests via module-level state.
const s3State = {
	manifest: null as SyncManifest | null,
	files: new Map<string, Uint8Array>(),
	ancestors: new Map<string, Uint8Array>(),
	lock: null as { deviceName: string; timestamp: number } | null,
};

vi.mock("../src/s3", () => ({
	getManifest: vi.fn(async () =>
		s3State.manifest ? (JSON.parse(JSON.stringify(s3State.manifest)) as SyncManifest) : null
	),
	putManifest: vi.fn(async (_c: any, _b: any, _p: any, m: SyncManifest) => {
		s3State.manifest = JSON.parse(JSON.stringify(m));
	}),
	getLock: vi.fn(async () => s3State.lock),
	putLock: vi.fn(async (_c: any, _b: any, _p: any, lock: any) => {
		s3State.lock = lock;
	}),
	deleteLock: vi.fn(async () => {
		s3State.lock = null;
	}),
	downloadFile: vi.fn(async (_c: any, _b: any, _p: any, path: string) => {
		const d = s3State.files.get(path);
		return d ? new Uint8Array(d) : null;
	}),
	uploadFile: vi.fn(async (_c: any, _b: any, _p: any, path: string, data: Uint8Array) => {
		s3State.files.set(path, new Uint8Array(data));
	}),
	putAncestor: vi.fn(async (_c: any, _b: any, _p: any, hash: string, data: Uint8Array) => {
		s3State.ancestors.set(hash, new Uint8Array(data));
	}),
	getAncestor: vi.fn(async (_c: any, _b: any, _p: any, hash: string) => {
		const d = s3State.ancestors.get(hash);
		return d ? new Uint8Array(d) : null;
	}),
	softDeleteFile: vi.fn(async (_c: any, _b: any, _p: any, path: string) => {
		s3State.files.delete(path);
	}),
}));

import * as s3 from "../src/s3";
import { computeSyncPlan } from "../src/plan";
import { runSync } from "../src/sync";

beforeEach(() => {
	s3State.manifest = null;
	s3State.files.clear();
	s3State.ancestors.clear();
	s3State.lock = null;
});

function hashOf(text: string): Promise<string> {
	return sha256(new TextEncoder().encode(text).buffer as ArrayBuffer);
}

function settings(deviceName = "me"): S3SyncSettings {
	return {
		s3Endpoint: "",
		s3Region: "",
		s3Bucket: "b",
		s3Prefix: "p",
		s3AccessKey: "",
		s3SecretKey: "",
		deviceName,
		syncIntervalMinutes: 0,
		includePatterns: [],
		excludePatterns: [],
		mergeStrategy: "keep-both",
		tombstoneRetentionDays: 5,
	};
}

function entry(o: Partial<ManifestEntry> & { path: string; sha256: string }): ManifestEntry {
	return {
		mtimeMs: 1000,
		sizeBytes: 100,
		lastSyncedBy: "x",
		lastSyncedAt: 1000,
		version: 1,
		deleted: false,
		...o,
	};
}

function manifest(
	lastUpdated: number,
	lastUpdatedBy: string,
	entries: ManifestEntry[]
): SyncManifest {
	const files: Record<string, ManifestEntry> = {};
	for (const e of entries) files[e.path] = e;
	return { schemaVersion: 1, lastUpdated, lastUpdatedBy, files };
}

function makeMockApp(initial: { path: string; content: string; mtime?: number }[]) {
	const tfiles = new Map<string, TFile>();
	let clock = 1000;
	const tick = () => (clock += 1000);

	function mkFile(path: string, content: string, mtime: number): TFile {
		const tf = new TFile();
		tf.path = path;
		tf.stat = { mtime, size: content.length } as any;
		(tf as any)._content = content;
		return tf;
	}

	for (const f of initial) {
		tfiles.set(f.path, mkFile(f.path, f.content, f.mtime ?? tick()));
	}

	return {
		vault: {
			getFiles: () => Array.from(tfiles.values()),
			getAbstractFileByPath: (p: string) => tfiles.get(p) ?? null,
			readBinary: async (file: any) =>
				new TextEncoder().encode(file._content).buffer as ArrayBuffer,
			modifyBinary: async (file: any, data: ArrayBuffer) => {
				const content = new TextDecoder().decode(data);
				file._content = content;
				file.stat.mtime = tick();
				file.stat.size = content.length;
			},
			modify: async (file: any, content: string) => {
				file._content = content;
				file.stat.mtime = tick();
				file.stat.size = content.length;
			},
			createBinary: async (path: string, data: ArrayBuffer) => {
				const content = new TextDecoder().decode(data);
				const f = mkFile(path, content, tick());
				tfiles.set(path, f);
				return f;
			},
			createFolder: async () => {},
			trash: async (file: any) => {
				tfiles.delete(file.path);
			},
		},
	};
}

describe("runSync — hashCache must reflect post-pull file content (regression)", () => {
	it("records the actual content hash after pulling a remote update", async () => {
		const oldContent = "v1 — local";
		const newContent = "v2 — remote";
		const oldHash = await hashOf(oldContent);
		const newHash = await hashOf(newContent);

		// Remote has v2 at version 2.
		s3State.files.set("file.md", new TextEncoder().encode(newContent));
		s3State.manifest = manifest(2000, "other", [
			entry({ path: "file.md", sha256: newHash, version: 2, mtimeMs: 2000 }),
		]);

		const app = makeMockApp([{ path: "file.md", content: oldContent }]);
		const cachedManifest = manifest(1000, "me", [
			entry({ path: "file.md", sha256: oldHash, version: 1, mtimeMs: 1000 }),
		]);

		let savedCache: { manifest: SyncManifest } | null = null;
		const plan = await computeSyncPlan(
			app as any,
			{} as any,
			settings(),
			cachedManifest
		);
		await runSync(
			app as any,
			{} as any,
			settings(),
			{ manifest: cachedManifest },
			async (d) => {
				savedCache = d;
			},
			undefined,
			undefined,
			plan.hashCache,
			plan.remoteManifest
		);

		// File on disk should now be v2.
		const localFile = app.vault.getAbstractFileByPath("file.md") as any;
		expect(localFile._content).toBe(newContent);

		// Cached manifest must reflect what's actually on disk (and on S3).
		expect(savedCache!.manifest.files["file.md"].sha256).toBe(newHash);

		// S3 manifest must also reflect the actual blob content.
		expect(s3State.manifest!.files["file.md"].sha256).toBe(newHash);

		// And the blob on S3 must still be v2 (we shouldn't have corrupted it).
		expect(new TextDecoder().decode(s3State.files.get("file.md")!)).toBe(newContent);
	});

	it("a clean pull on device B does not corrupt remote state for device A", async () => {
		// Cascade: A initially pushed v2. B has v1, syncs and pulls v2. Then A syncs
		// (no edits). A should see no work to do — currently A sees a phantom
		// "download-update" because B's pull poisons the S3 manifest sha256.
		const v1 = "v1 content";
		const v2 = "v2 content";
		const v1Hash = await hashOf(v1);
		const v2Hash = await hashOf(v2);

		// A's prior state: pushed v2 to remote, A's cached records v2.
		s3State.files.set("file.md", new TextEncoder().encode(v2));
		s3State.manifest = manifest(2000, "device-a", [
			entry({
				path: "file.md",
				sha256: v2Hash,
				version: 2,
				mtimeMs: 2000,
				lastSyncedBy: "device-a",
				lastSyncedAt: 2000,
			}),
		]);
		const aCached = manifest(2000, "device-a", [
			entry({
				path: "file.md",
				sha256: v2Hash,
				version: 2,
				mtimeMs: 2000,
				lastSyncedBy: "device-a",
				lastSyncedAt: 2000,
			}),
		]);

		// B's state: local v1, cached v1.
		const bApp = makeMockApp([{ path: "file.md", content: v1, mtime: 1000 }]);
		const bCached = manifest(1000, "device-b", [
			entry({
				path: "file.md",
				sha256: v1Hash,
				version: 1,
				mtimeMs: 1000,
				lastSyncedBy: "device-b",
				lastSyncedAt: 1000,
			}),
		]);

		// B syncs → pulls v2.
		const bPlan = await computeSyncPlan(
			bApp as any,
			{} as any,
			settings("device-b"),
			bCached
		);
		await runSync(
			bApp as any,
			{} as any,
			settings("device-b"),
			{ manifest: bCached },
			async () => {},
			undefined,
			undefined,
			bPlan.hashCache,
			bPlan.remoteManifest
		);

		// Now A syncs. A has no local edits and the only thing that happened on
		// the remote is B's pull (which should be a no-op for A).
		const aApp = makeMockApp([{ path: "file.md", content: v2, mtime: 2000 }]);
		const aPlan = await computeSyncPlan(
			aApp as any,
			{} as any,
			settings("device-a"),
			aCached
		);

		// There is genuinely nothing to do — neither device made a real change.
		const fileEntry = aPlan.entries.find((e) => e.path === "file.md");
		expect(fileEntry).toBeUndefined();
	});
});

describe("runSync — superseded tombstone must not re-delete a peer resurrection (regression)", () => {
	it("a stale-tombstone device adopts a remote resurrection instead of re-deleting it", async () => {
		// Sequence: H deleted 24.md (cached tombstone v2, file gone locally). W
		// re-created it and synced, so remote is now LIVE v3. H syncs again.
		//
		// Buggy behavior: H's pull skips the download (cached entry exists), then
		// H's push delete-loop sees a live manifest entry with no local file and
		// re-tombstones it to v4. W's next sync pulls v4 and trashes its content —
		// the "constant deletion" the user keeps hitting.
		//
		// Correct behavior: remote.version (3) > H's tombstone version (2) means
		// the deletion is superseded; H downloads the resurrection and leaves the
		// manifest live.
		const oldContent = "old pre-deletion content";
		const resurrected = "W re-created this";
		const oldHash = await hashOf(oldContent);
		const resHash = await hashOf(resurrected);

		// Remote: live v3 (W's resurrection).
		s3State.files.set("24.md", new TextEncoder().encode(resurrected));
		s3State.manifest = manifest(3000, "W", [
			entry({
				path: "24.md",
				sha256: resHash,
				version: 3,
				mtimeMs: 3000,
				deleted: false,
				lastSyncedBy: "W",
				lastSyncedAt: 3000,
			}),
		]);

		// H: local file gone, cached records the tombstone at v2.
		const hApp = makeMockApp([]);
		const hCached = manifest(2000, "H", [
			entry({
				path: "24.md",
				sha256: oldHash,
				version: 2,
				mtimeMs: 1000,
				deleted: true,
				deletedBy: "H",
				deletedAt: 2000,
				lastSyncedBy: "H",
				lastSyncedAt: 2000,
			}),
		]);

		const hPlan = await computeSyncPlan(hApp as any, {} as any, settings("H"), hCached);

		// Plan-level: H should adopt the resurrection, not show "nothing to sync".
		expect(hPlan.entries.find((e) => e.path === "24.md")?.action).toBe("download-new");

		await runSync(
			hApp as any,
			{} as any,
			settings("H"),
			{ manifest: hCached },
			async () => {},
			undefined,
			undefined,
			hPlan.hashCache,
			hPlan.remoteManifest
		);

		// H must have downloaded the resurrected file.
		const hFile = hApp.vault.getAbstractFileByPath("24.md") as any;
		expect(hFile?._content).toBe(resurrected);

		// Crucially: the S3 manifest must STILL be live — H must not have
		// re-tombstoned the peer's resurrection.
		expect(s3State.manifest!.files["24.md"].deleted).toBe(false);
		expect(s3State.manifest!.files["24.md"].sha256).toBe(resHash);
		expect(s3State.files.has("24.md")).toBe(true);
	});

	it("a local re-creation that differs from a peer resurrection becomes a conflict (not 'nothing to sync')", async () => {
		// The user's exact symptom: H deleted 24.md (cached tombstone v2), then
		// re-created it locally with its own content. Meanwhile W resurrected it
		// remotely (live v3) with different content. H syncs.
		//
		// Buggy behavior: plan reported "nothing to sync" and H kept its divergent
		// copy forever. Correct: surface a conflict and keep BOTH copies.
		const oldHash = await hashOf("old pre-deletion content");
		const hLocal = "H re-created content";
		const wRemote = "W resurrected content";
		const wHash = await hashOf(wRemote);

		s3State.files.set("24.md", new TextEncoder().encode(wRemote));
		s3State.manifest = manifest(3000, "W", [
			entry({ path: "24.md", sha256: wHash, version: 3, mtimeMs: 3000, deleted: false }),
		]);

		const hApp = makeMockApp([{ path: "24.md", content: hLocal, mtime: 4000 }]);
		const hCached = manifest(2000, "H", [
			entry({
				path: "24.md",
				sha256: oldHash,
				version: 2,
				mtimeMs: 1000,
				deleted: true,
				deletedAt: 2000,
			}),
		]);

		const hPlan = await computeSyncPlan(hApp as any, {} as any, settings("H"), hCached);
		expect(hPlan.entries.find((e) => e.path === "24.md")?.action).toBe("conflict");

		await runSync(
			hApp as any,
			{} as any,
			settings("H"),
			{ manifest: hCached },
			async () => {},
			undefined,
			undefined,
			hPlan.hashCache,
			hPlan.remoteManifest
		);

		// Both copies survive: 24.md now holds W's content, H's content is in a
		// conflict-* copy. Nothing was silently dropped, manifest stays live.
		const files = hApp.vault.getFiles().map((f) => (f as any)._content);
		expect(files).toContain(wRemote);
		expect(files).toContain(hLocal);
		expect(s3State.manifest!.files["24.md"].deleted).toBe(false);
	});
});

describe("runSync — partial failures must not poison cached state (regression)", () => {
	it("interrupted putManifest leaves pulled files reconciled in cached", async () => {
		// Scenario: device pulls a remote update, but step 6 putManifest fails.
		// Before the fix, cached was never written, so the next sync saw the
		// just-pulled local content as a "local change" and the remote as a
		// "remote change" — flagging a phantom conflict.
		const oldContent = "v1";
		const newContent = "v2";
		const oldHash = await hashOf(oldContent);
		const newHash = await hashOf(newContent);

		s3State.files.set("file.md", new TextEncoder().encode(newContent));
		s3State.manifest = manifest(2000, "peer", [
			entry({ path: "file.md", sha256: newHash, version: 2, mtimeMs: 2000 }),
		]);

		const app = makeMockApp([{ path: "file.md", content: oldContent, mtime: 1000 }]);
		const cachedManifest = manifest(1000, "me", [
			entry({ path: "file.md", sha256: oldHash, version: 1, mtimeMs: 1000 }),
		]);

		// Capture every saveCachedData call; we want the last one before failure.
		const saved: SyncManifest[] = [];
		const saveCached = async (d: { manifest: SyncManifest }) => {
			saved.push(JSON.parse(JSON.stringify(d.manifest)));
		};

		// Inject a network outage at the final manifest write.
		vi.mocked(s3.putManifest).mockImplementationOnce(async () => {
			throw new Error("network outage");
		});

		const plan = await computeSyncPlan(app as any, {} as any, settings(), cachedManifest);
		await expect(
			runSync(
				app as any,
				{} as any,
				settings(),
				{ manifest: cachedManifest },
				saveCached,
				undefined,
				undefined,
				plan.hashCache,
				plan.remoteManifest
			)
		).rejects.toThrow("network outage");

		// Local file was written during step 4 — it has the new content now.
		const localFile = app.vault.getAbstractFileByPath("file.md") as any;
		expect(localFile._content).toBe(newContent);

		// The post-pull checkpoint must have been persisted before the throw.
		expect(saved.length).toBeGreaterThan(0);
		const lastSaved = saved[saved.length - 1];
		expect(lastSaved.files["file.md"].sha256).toBe(newHash);

		// Now run a second sync with the checkpoint as the new cached manifest.
		// The plan should see nothing to do — local matches remote, no conflict.
		const plan2 = await computeSyncPlan(app as any, {} as any, settings(), lastSaved);
		const file2 = plan2.entries.find((e) => e.path === "file.md");
		expect(file2).toBeUndefined();
	});

	it("interrupted upload re-attempts the push on the next sync (no phantom conflict)", async () => {
		// Scenario: user edits a file, upload fails partway. Before the fix,
		// cached was never saved, so on retry plan would see remote unchanged
		// (correct) but no conflict — which actually still works for this case.
		// The real regression is: on retry, the next sync must STILL plan an
		// upload-update (not skip the file thinking it's already synced) and
		// must NOT have polluted cached with a sha that doesn't match S3.
		const oldContent = "original";
		const newContent = "user edit";
		const oldHash = await hashOf(oldContent);
		const newHash = await hashOf(newContent);

		// S3 has old content; user has edited locally.
		s3State.files.set("file.md", new TextEncoder().encode(oldContent));
		s3State.manifest = manifest(1000, "me", [
			entry({ path: "file.md", sha256: oldHash, version: 1, mtimeMs: 1000 }),
		]);

		// Local file already has the edit (mtime newer than cached).
		const app = makeMockApp([{ path: "file.md", content: newContent, mtime: 5000 }]);
		const cachedManifest = manifest(1000, "me", [
			entry({ path: "file.md", sha256: oldHash, version: 1, mtimeMs: 1000 }),
		]);

		const saved: SyncManifest[] = [];
		const saveCached = async (d: { manifest: SyncManifest }) => {
			saved.push(JSON.parse(JSON.stringify(d.manifest)));
		};

		// Inject a network outage at uploadFile.
		vi.mocked(s3.uploadFile).mockImplementationOnce(async () => {
			throw new Error("network outage");
		});

		const plan = await computeSyncPlan(app as any, {} as any, settings(), cachedManifest);
		await expect(
			runSync(
				app as any,
				{} as any,
				settings(),
				{ manifest: cachedManifest },
				saveCached,
				undefined,
				undefined,
				plan.hashCache,
				plan.remoteManifest
			)
		).rejects.toThrow("network outage");

		// Checkpoint saved during step 4's finally must still reflect the OLD
		// sha for the file (it was a local change, not a pull — not reconciled).
		expect(saved.length).toBeGreaterThan(0);
		const lastSaved = saved[saved.length - 1];
		expect(lastSaved.files["file.md"].sha256).toBe(oldHash);

		// S3 manifest is untouched.
		expect(s3State.manifest!.files["file.md"].sha256).toBe(oldHash);

		// Next sync must still see the local edit as a pending upload.
		const plan2 = await computeSyncPlan(app as any, {} as any, settings(), lastSaved);
		const file2 = plan2.entries.find((e) => e.path === "file.md");
		expect(file2?.action).toBe("upload-update");
	});

	it("checkpoint persists pulls that completed before a mid-step-4 failure", async () => {
		// Two files to pull. The second download fails. The first file must be
		// reconciled in cached so the next sync doesn't replay its pull as a
		// phantom conflict.
		const aContent = "a-remote";
		const bContent = "b-remote";
		const aHash = await hashOf(aContent);
		const bHash = await hashOf(bContent);
		const aOld = await hashOf("a-old");
		const bOld = await hashOf("b-old");

		s3State.files.set("a.md", new TextEncoder().encode(aContent));
		s3State.files.set("b.md", new TextEncoder().encode(bContent));
		s3State.manifest = manifest(2000, "peer", [
			entry({ path: "a.md", sha256: aHash, version: 2, mtimeMs: 2000 }),
			entry({ path: "b.md", sha256: bHash, version: 2, mtimeMs: 2000 }),
		]);

		const app = makeMockApp([
			{ path: "a.md", content: "a-old", mtime: 1000 },
			{ path: "b.md", content: "b-old", mtime: 1000 },
		]);
		const cachedManifest = manifest(1000, "me", [
			entry({ path: "a.md", sha256: aOld, version: 1, mtimeMs: 1000 }),
			entry({ path: "b.md", sha256: bOld, version: 1, mtimeMs: 1000 }),
		]);

		const saved: SyncManifest[] = [];
		const saveCached = async (d: { manifest: SyncManifest }) => {
			saved.push(JSON.parse(JSON.stringify(d.manifest)));
		};

		// Pass-through for "a.md", fail for "b.md".
		vi.mocked(s3.downloadFile).mockImplementation(async (_c, _b, _p, path) => {
			if (path === "b.md") throw new Error("network outage");
			const d = s3State.files.get(path);
			return d ? new Uint8Array(d) : null;
		});

		const plan = await computeSyncPlan(app as any, {} as any, settings(), cachedManifest);
		await expect(
			runSync(
				app as any,
				{} as any,
				settings(),
				{ manifest: cachedManifest },
				saveCached,
				undefined,
				undefined,
				plan.hashCache,
				plan.remoteManifest
			)
		).rejects.toThrow("network outage");

		// a.md was pulled and reconciled before the throw. b.md was not.
		const aFile = app.vault.getAbstractFileByPath("a.md") as any;
		expect(aFile._content).toBe(aContent);

		expect(saved.length).toBeGreaterThan(0);
		const lastSaved = saved[saved.length - 1];
		expect(lastSaved.files["a.md"].sha256).toBe(aHash);
		// b.md must still show its pre-sync state — we didn't pull it.
		expect(lastSaved.files["b.md"].sha256).toBe(bOld);

		// Restore the downloadFile mock for a clean retry.
		vi.mocked(s3.downloadFile).mockImplementation(async (_c, _b, _p, path) => {
			const d = s3State.files.get(path);
			return d ? new Uint8Array(d) : null;
		});

		// Next plan: a.md is done, b.md is still a pending download-update.
		const plan2 = await computeSyncPlan(app as any, {} as any, settings(), lastSaved);
		expect(plan2.entries.find((e) => e.path === "a.md")).toBeUndefined();
		expect(plan2.entries.find((e) => e.path === "b.md")?.action).toBe("download-update");
	});
});

import { gcOldTombstones } from "../src/sync";

describe("gcOldTombstones — unit", () => {
	const DAY = 24 * 60 * 60 * 1000;
	const NOW = Date.now();

	function build(entries: Partial<ManifestEntry>[]): SyncManifest {
		const files: Record<string, ManifestEntry> = {};
		for (const e of entries) {
			files[e.path!] = {
				sha256: "h",
				mtimeMs: 1,
				sizeBytes: 1,
				lastSyncedBy: "x",
				lastSyncedAt: 1,
				version: 1,
				deleted: false,
				...e,
			} as ManifestEntry;
		}
		return { schemaVersion: 1, lastUpdated: NOW, lastUpdatedBy: "x", files };
	}

	it("drops tombstones older than retention", () => {
		const m = build([
			{ path: "old.md", deleted: true, deletedAt: NOW - 6 * DAY },
			{ path: "fresh.md", deleted: true, deletedAt: NOW - 3 * DAY },
			{ path: "alive.md", deleted: false, mtimeMs: 1 },
		]);
		const { manifest: out, dropped } = gcOldTombstones(m, 5 * DAY, NOW);
		expect(dropped).toBe(1);
		expect(out.files["old.md"]).toBeUndefined();
		expect(out.files["fresh.md"]).toBeDefined();
		expect(out.files["alive.md"]).toBeDefined();
	});

	it("retentionMs = 0 disables GC entirely", () => {
		const m = build([{ path: "ancient.md", deleted: true, deletedAt: NOW - 365 * DAY }]);
		const { dropped } = gcOldTombstones(m, 0, NOW);
		expect(dropped).toBe(0);
		expect(m.files["ancient.md"]).toBeDefined();
	});

	it("tombstones without deletedAt are skipped (legacy safety)", () => {
		// Schema v1 always populated deletedAt on tombstone creation, but older
		// entries from migrations could lack it. Don't silently drop them.
		const m = build([{ path: "legacy.md", deleted: true }]);
		const { dropped, manifest: out } = gcOldTombstones(m, 5 * DAY, NOW);
		expect(dropped).toBe(0);
		expect(out.files["legacy.md"]).toBeDefined();
	});

	it("boundary: exactly at retention is kept (strict greater-than)", () => {
		const m = build([{ path: "edge.md", deleted: true, deletedAt: NOW - 5 * DAY }]);
		const { dropped, manifest: out } = gcOldTombstones(m, 5 * DAY, NOW);
		expect(dropped).toBe(0);
		expect(out.files["edge.md"]).toBeDefined();
	});

	it("does not mutate input manifest", () => {
		const m = build([{ path: "old.md", deleted: true, deletedAt: NOW - 10 * DAY }]);
		const before = JSON.stringify(m);
		gcOldTombstones(m, 5 * DAY, NOW);
		expect(JSON.stringify(m)).toBe(before);
	});

	it("returns the original reference when nothing is dropped (no GC churn)", () => {
		const m = build([{ path: "fresh.md", deleted: true, deletedAt: NOW - 1 * DAY }]);
		const { manifest: out, dropped } = gcOldTombstones(m, 5 * DAY, NOW);
		expect(dropped).toBe(0);
		expect(out).toBe(m); // identity preserved when no work to do
	});
});

describe("runSync — tombstone GC drops stale deletions from the manifest (regression)", () => {
	const DAY = 24 * 60 * 60 * 1000;

	it("a tombstone past retention is removed from the S3 manifest", async () => {
		const oldContent = "deleted content";
		const oldHash = await hashOf(oldContent);

		// Remote: stale tombstone, deletedAt is 10 days ago.
		const deletedAt = Date.now() - 10 * DAY;
		s3State.manifest = manifest(deletedAt, "old-device", [
			entry({
				path: "old.md",
				sha256: oldHash,
				version: 5,
				mtimeMs: 1,
				deleted: true,
				deletedBy: "old-device",
				deletedAt,
				lastSyncedAt: deletedAt,
			}),
		]);

		// Local: nothing for old.md. Cached: same tombstone.
		const app = makeMockApp([]);
		const cachedManifest = manifest(deletedAt, "me", [
			entry({
				path: "old.md",
				sha256: oldHash,
				version: 5,
				deleted: true,
				deletedAt,
			}),
		]);

		const s = settings();
		s.tombstoneRetentionDays = 5;

		await runSync(
			app as any,
			{} as any,
			s,
			{ manifest: cachedManifest },
			async () => {},
			undefined,
			undefined,
			new Map(),
			JSON.parse(JSON.stringify(cachedManifest))
		);

		// S3 manifest must no longer carry the tombstone.
		expect(s3State.manifest!.files["old.md"]).toBeUndefined();
	});

	it("a recent tombstone (within retention) is preserved", async () => {
		const hash = await hashOf("freshly deleted");
		const deletedAt = Date.now() - 1 * DAY; // 1 day ago, retention is 5
		s3State.manifest = manifest(deletedAt, "me", [
			entry({
				path: "recent.md",
				sha256: hash,
				version: 3,
				deleted: true,
				deletedBy: "me",
				deletedAt,
				lastSyncedAt: deletedAt,
			}),
		]);

		const app = makeMockApp([]);
		const cachedManifest = manifest(deletedAt, "me", [
			entry({
				path: "recent.md",
				sha256: hash,
				version: 3,
				deleted: true,
				deletedAt,
			}),
		]);

		const s = settings();
		s.tombstoneRetentionDays = 5;

		await runSync(
			app as any,
			{} as any,
			s,
			{ manifest: cachedManifest },
			async () => {},
			undefined,
			undefined,
			new Map(),
			JSON.parse(JSON.stringify(cachedManifest))
		);

		expect(s3State.manifest!.files["recent.md"]).toBeDefined();
		expect(s3State.manifest!.files["recent.md"].deleted).toBe(true);
	});

	it("retentionDays = 0 keeps tombstones forever", async () => {
		const hash = await hashOf("ancient");
		const deletedAt = Date.now() - 365 * DAY;
		s3State.manifest = manifest(deletedAt, "me", [
			entry({
				path: "ancient.md",
				sha256: hash,
				version: 7,
				deleted: true,
				deletedBy: "me",
				deletedAt,
				lastSyncedAt: deletedAt,
			}),
		]);

		const app = makeMockApp([]);
		const cachedManifest = manifest(deletedAt, "me", [
			entry({
				path: "ancient.md",
				sha256: hash,
				version: 7,
				deleted: true,
				deletedAt,
			}),
		]);

		const s = settings();
		s.tombstoneRetentionDays = 0;

		await runSync(
			app as any,
			{} as any,
			s,
			{ manifest: cachedManifest },
			async () => {},
			undefined,
			undefined,
			new Map(),
			JSON.parse(JSON.stringify(cachedManifest))
		);

		expect(s3State.manifest!.files["ancient.md"]).toBeDefined();
	});

	it("peer resurrection arriving via re-check wins over GC", async () => {
		// Scenario: stale tombstone on S3 (older than retention). A peer
		// resurrects the file concurrently and uploads a new version before
		// our finalize re-check runs. GC must NOT drop the live entry — the
		// re-check merge is what installs the live entry first, then GC sees
		// a non-deleted entry and leaves it alone.
		const oldHash = await hashOf("pre-deletion");
		const resContent = "peer resurrected this";
		const resHash = await hashOf(resContent);

		const deletedAt = Date.now() - 10 * DAY; // tombstone is way past retention
		s3State.files.set("24.md", new TextEncoder().encode(resContent));

		// Initial remoteManifest (what runSync sees at step 4): the tombstone.
		const initialRemote = manifest(deletedAt, "peer", [
			entry({
				path: "24.md",
				sha256: oldHash,
				version: 5,
				deleted: true,
				deletedBy: "peer",
				deletedAt,
				lastSyncedAt: deletedAt,
			}),
		]);
		s3State.manifest = initialRemote;

		// Re-check manifest (what runSync fetches at finalize): the peer just
		// uploaded a live version v6. lastUpdated differs so the merge runs.
		const recheckManifest = manifest(Date.now(), "peer", [
			entry({
				path: "24.md",
				sha256: resHash,
				version: 6,
				mtimeMs: Date.now(),
				deleted: false,
				lastSyncedBy: "peer",
				lastSyncedAt: Date.now(),
			}),
		]);

		// Mock getManifest to return initial on first call (pull phase) and
		// the resurrected version on second call (finalize re-check).
		let call = 0;
		vi.mocked(s3.getManifest).mockImplementation(async () => {
			call++;
			return call === 1
				? JSON.parse(JSON.stringify(initialRemote))
				: JSON.parse(JSON.stringify(recheckManifest));
		});

		const app = makeMockApp([]);
		const cachedManifest = manifest(deletedAt, "me", [
			entry({
				path: "24.md",
				sha256: oldHash,
				version: 5,
				deleted: true,
				deletedAt,
			}),
		]);

		const s = settings();
		s.tombstoneRetentionDays = 5;

		await runSync(
			app as any,
			{} as any,
			s,
			{ manifest: cachedManifest },
			async () => {},
			undefined,
			undefined,
			new Map(),
			undefined // force re-fetch on pull so our mock gets called
		);

		// The live resurrection must survive — re-check merge installs v6,
		// GC then sees a non-deleted entry and skips it.
		expect(s3State.manifest!.files["24.md"]).toBeDefined();
		expect(s3State.manifest!.files["24.md"].deleted).toBe(false);
		expect(s3State.manifest!.files["24.md"].sha256).toBe(resHash);
	});
});
