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

describe("runSync — cached manifest must only record disk-reconciled entries (phantom-deletion regression)", () => {
	// Real incident 2026-07-28: pova3's cached manifest accumulated entries for
	// files that never landed on its disk. The next sync classified them as
	// "deleted locally" and tombstoned them on S3, destroying peers' fresh files.

	it("entries merged from the finalize re-check are NOT persisted to the local cache", async () => {
		// We push one file. While we sync, a peer concurrently uploads
		// peer-new.md — it arrives via the finalize re-check merge. It must go
		// into the S3 manifest (peer's entry survives) but NOT into our cached
		// manifest: we never downloaded it, so caching it would flag it as
		// "deleted locally" on our next sync.
		const mineHash = await hashOf("mine");
		const peerHash = await hashOf("peer content");

		const initialRemote = manifest(1000, "peer", []);
		s3State.manifest = initialRemote;

		const app = makeMockApp([{ path: "mine.md", content: "mine", mtime: 5000 }]);
		const cachedManifest = manifest(1000, "me", []);

		// Finalize re-check sees the peer's concurrent upload.
		const recheck = manifest(2000, "peer", [
			entry({
				path: "peer-new.md",
				sha256: peerHash,
				version: 1,
				lastSyncedBy: "peer",
				lastSyncedAt: 2000,
			}),
		]);

		let savedCache: { manifest: SyncManifest } | null = null;
		const plan = await computeSyncPlan(app as any, {} as any, settings(), cachedManifest);

		// The peer's upload lands AFTER our planning phase — only the finalize
		// re-check (the next getManifest call) sees it.
		vi.mocked(s3.getManifest).mockImplementation(async () =>
			JSON.parse(JSON.stringify(recheck))
		);
		await runSync(
			app as any,
			{} as any,
			settings(),
			{ manifest: cachedManifest },
			async (d) => {
				savedCache = JSON.parse(JSON.stringify(d));
			},
			undefined,
			undefined,
			plan.hashCache,
			plan.remoteManifest
		);

		// Restore the default getManifest mock for subsequent tests.
		vi.mocked(s3.getManifest).mockImplementation(async () =>
			s3State.manifest ? (JSON.parse(JSON.stringify(s3State.manifest)) as SyncManifest) : null
		);

		// Peer's entry must survive in the S3 manifest (re-check merge intact).
		expect(s3State.manifest!.files["peer-new.md"]).toBeDefined();
		expect(s3State.manifest!.files["peer-new.md"].deleted).toBe(false);

		// Our push is recorded in both S3 manifest and cache.
		expect(s3State.manifest!.files["mine.md"].sha256).toBe(mineHash);
		expect(savedCache!.manifest.files["mine.md"]?.sha256).toBe(mineHash);

		// THE FIX: peer-new.md was never on our disk — it must NOT be cached.
		expect(savedCache!.manifest.files["peer-new.md"]).toBeUndefined();

		// And the next plan must want to download it — not delete it.
		const plan2 = await computeSyncPlan(
			app as any,
			{} as any,
			settings(),
			savedCache!.manifest
		);
		expect(plan2.entries.find((e) => e.path === "peer-new.md")?.action).toBe(
			"download-new"
		);
	});

	it("a download that 404s is reported as an error and NOT persisted to the cache", async () => {
		const ghostHash = await hashOf("ghost content");

		// Manifest lists ghost.md but the blob is missing on S3 (downloadFile → null).
		s3State.manifest = manifest(2000, "peer", [
			entry({ path: "ghost.md", sha256: ghostHash, version: 1 }),
		]);
		// s3State.files deliberately does NOT contain ghost.md.

		const app = makeMockApp([]);
		const cachedManifest = manifest(1000, "me", []);

		let savedCache: { manifest: SyncManifest } | null = null;
		const plan = await computeSyncPlan(app as any, {} as any, settings(), cachedManifest);
		expect(plan.entries.find((e) => e.path === "ghost.md")?.action).toBe("download-new");

		const result = await runSync(
			app as any,
			{} as any,
			settings(),
			{ manifest: cachedManifest },
			async (d) => {
				savedCache = JSON.parse(JSON.stringify(d));
			},
			undefined,
			undefined,
			plan.hashCache,
			plan.remoteManifest
		);

		// The failed download is loud, not silent.
		expect(result.errors.some((e) => e.includes("ghost.md"))).toBe(true);

		// The entry must not be cached — nothing landed on disk.
		expect(savedCache!.manifest.files["ghost.md"]).toBeUndefined();

		// Next sync still wants to download it — NOT delete it from S3.
		const plan2 = await computeSyncPlan(
			app as any,
			{} as any,
			settings(),
			savedCache!.manifest
		);
		expect(plan2.entries.find((e) => e.path === "ghost.md")?.action).toBe(
			"download-new"
		);
	});

	it("remote entries excluded by local filters are NOT persisted to the cache", async () => {
		// Per-device selective sync: the phone excludes Archive/**. Those remote
		// entries must never enter its cache — otherwise re-enabling the filter
		// (or any cache/desync) marks them "deleted locally".
		const rootHash = await hashOf("root");
		const archHash = await hashOf("archived");

		s3State.files.set("root.md", new TextEncoder().encode("root"));
		s3State.files.set("Archive/a.md", new TextEncoder().encode("archived"));
		s3State.manifest = manifest(2000, "peer", [
			entry({ path: "root.md", sha256: rootHash, version: 1 }),
			entry({ path: "Archive/a.md", sha256: archHash, version: 1 }),
		]);

		const s = settings();
		s.excludePatterns = ["Archive/**"];

		const app = makeMockApp([]);
		const cachedManifest = manifest(1000, "me", []);

		let savedCache: { manifest: SyncManifest } | null = null;
		const plan = await computeSyncPlan(app as any, {} as any, s, cachedManifest);
		await runSync(
			app as any,
			{} as any,
			s,
			{ manifest: cachedManifest },
			async (d) => {
				savedCache = JSON.parse(JSON.stringify(d));
			},
			undefined,
			undefined,
			plan.hashCache,
			plan.remoteManifest
		);

		// root.md downloaded and cached; Archive/a.md neither downloaded nor cached.
		expect(app.vault.getAbstractFileByPath("root.md")).not.toBeNull();
		expect(savedCache!.manifest.files["root.md"]).toBeDefined();
		expect(app.vault.getAbstractFileByPath("Archive/a.md")).toBeNull();
		expect(savedCache!.manifest.files["Archive/a.md"]).toBeUndefined();

		// S3 manifest still carries the excluded entry for other devices.
		expect(s3State.manifest!.files["Archive/a.md"]).toBeDefined();
	});
});

describe("runSync — auto-sync must never apply deletions (applyDeletions: false)", () => {
	it("defers a remote tombstone instead of trashing the local file", async () => {
		const hash = await hashOf("content");

		// Peer deleted gone.md; we still have it and cached knows it alive.
		// deletedAt is recent so tombstone GC doesn't interfere with the test.
		const deletedAt = Date.now() - 1000;
		s3State.manifest = manifest(2000, "peer", [
			entry({
				path: "gone.md",
				sha256: hash,
				version: 2,
				deleted: true,
				deletedBy: "peer",
				deletedAt,
				lastSyncedAt: 2000,
			}),
		]);
		const app = makeMockApp([{ path: "gone.md", content: "content", mtime: 1000 }]);
		const cachedManifest = manifest(1000, "me", [
			entry({ path: "gone.md", sha256: hash, version: 1, mtimeMs: 1000 }),
		]);

		let savedCache: { manifest: SyncManifest } | null = null;
		const plan = await computeSyncPlan(app as any, {} as any, settings(), cachedManifest);
		expect(plan.entries.find((e) => e.path === "gone.md")?.action).toBe("delete-local");

		const result = await runSync(
			app as any,
			{} as any,
			settings(),
			{ manifest: cachedManifest },
			async (d) => {
				savedCache = JSON.parse(JSON.stringify(d));
			},
			undefined,
			undefined,
			plan.hashCache,
			plan.remoteManifest,
			{ applyDeletions: false }
		);

		// Local file is untouched.
		expect(app.vault.getAbstractFileByPath("gone.md")).not.toBeNull();
		// The deferral is visible in the result.
		expect(result.deferredDeletions).toBe(1);
		// Cache still shows the file alive so a manual sync re-plans the deletion.
		expect(savedCache!.manifest.files["gone.md"].deleted).toBe(false);

		const plan2 = await computeSyncPlan(
			app as any,
			{} as any,
			settings(),
			savedCache!.manifest
		);
		expect(plan2.entries.find((e) => e.path === "gone.md")?.action).toBe("delete-local");
	});

	it("defers a local deletion instead of tombstoning the file on S3", async () => {
		const hash = await hashOf("content");

		// File exists on S3 and in cache, but is gone from local disk.
		s3State.files.set("mine-gone.md", new TextEncoder().encode("content"));
		s3State.manifest = manifest(2000, "me", [
			entry({ path: "mine-gone.md", sha256: hash, version: 1, mtimeMs: 1000 }),
		]);
		const app = makeMockApp([]);
		const cachedManifest = manifest(2000, "me", [
			entry({ path: "mine-gone.md", sha256: hash, version: 1, mtimeMs: 1000 }),
		]);

		let savedCache: { manifest: SyncManifest } | null = null;
		const plan = await computeSyncPlan(app as any, {} as any, settings(), cachedManifest);
		expect(plan.entries.find((e) => e.path === "mine-gone.md")?.action).toBe(
			"delete-remote"
		);

		const result = await runSync(
			app as any,
			{} as any,
			settings(),
			{ manifest: cachedManifest },
			async (d) => {
				savedCache = JSON.parse(JSON.stringify(d));
			},
			undefined,
			undefined,
			plan.hashCache,
			plan.remoteManifest,
			{ applyDeletions: false }
		);

		// S3 blob and live manifest entry are untouched.
		expect(s3State.files.has("mine-gone.md")).toBe(true);
		expect(s3State.manifest!.files["mine-gone.md"].deleted).toBe(false);
		expect(result.deferredDeletions).toBe(1);
		// Cache keeps the alive entry so a manual sync re-plans the deletion.
		expect(savedCache!.manifest.files["mine-gone.md"].deleted).toBe(false);
	});

	it("manual mode (default) still applies both deletion directions", async () => {
		const hash = await hashOf("content");

		const deletedAt = Date.now() - 1000;
		s3State.manifest = manifest(2000, "peer", [
			entry({
				path: "gone.md",
				sha256: hash,
				version: 2,
				deleted: true,
				deletedBy: "peer",
				deletedAt,
				lastSyncedAt: 2000,
			}),
		]);
		const app = makeMockApp([{ path: "gone.md", content: "content", mtime: 1000 }]);
		const cachedManifest = manifest(1000, "me", [
			entry({ path: "gone.md", sha256: hash, version: 1, mtimeMs: 1000 }),
		]);

		let savedCache: { manifest: SyncManifest } | null = null;
		const plan = await computeSyncPlan(app as any, {} as any, settings(), cachedManifest);
		const result = await runSync(
			app as any,
			{} as any,
			settings(),
			{ manifest: cachedManifest },
			async (d) => {
				savedCache = JSON.parse(JSON.stringify(d));
			},
			undefined,
			undefined,
			plan.hashCache,
			plan.remoteManifest
		);

		// Deletion applied: file trashed, tombstone acknowledged in cache.
		expect(app.vault.getAbstractFileByPath("gone.md")).toBeNull();
		expect(result.deferredDeletions).toBe(0);
		expect(savedCache!.manifest.files["gone.md"].deleted).toBe(true);
	});
});

describe("stale manifest read protection (regression 2026-07-28, second incident)", () => {
	// Real incident: right after a sync pushed resurrections (manifest T2), the
	// next plan was built from a STALE manifest (T1, served by an HTTP cache)
	// still carrying tombstones — and proposed re-deleting the fresh files.
	// A fetched manifest older than what this device has already incorporated
	// must abort the sync, never produce a destructive plan.

	it("computeSyncPlan throws when the fetched manifest is older than local state", async () => {
		const hash = await hashOf("content");

		// Local cache reflects manifest state T=5000; the "fetched" one is T=1000
		// and still shows a tombstone for a file we know is alive.
		s3State.manifest = manifest(1000, "peer", [
			entry({
				path: "file.md",
				sha256: hash,
				version: 2,
				deleted: true,
				deletedBy: "peer",
				deletedAt: 900,
				lastSyncedAt: 900,
			}),
		]);
		const app = makeMockApp([{ path: "file.md", content: "content", mtime: 1000 }]);
		const cachedManifest = manifest(5000, "me", [
			entry({ path: "file.md", sha256: hash, version: 3, mtimeMs: 1000 }),
		]);

		await expect(
			computeSyncPlan(app as any, {} as any, settings(), cachedManifest)
		).rejects.toThrow(/stale/i);
	});

	it("an empty local cache (fresh device or after reset) never triggers the guard", async () => {
		const hash = await hashOf("content");
		// Empty cache stamps lastUpdated with the current time — newer than any
		// remote. That must not be read as "remote is stale".
		s3State.manifest = manifest(1000, "peer", [
			entry({ path: "file.md", sha256: hash, version: 1 }),
		]);
		s3State.files.set("file.md", new TextEncoder().encode("content"));
		const app = makeMockApp([]);
		const cachedManifest = manifest(Date.now(), "me", []);

		const plan = await computeSyncPlan(app as any, {} as any, settings(), cachedManifest);
		expect(plan.entries.find((e) => e.path === "file.md")?.action).toBe("download-new");
	});

	it("runSync refuses to run against a stale manifest", async () => {
		const hash = await hashOf("content");
		const staleRemote = manifest(1000, "peer", [
			entry({ path: "file.md", sha256: hash, version: 2, deleted: true, deletedAt: 900 }),
		]);
		const app = makeMockApp([{ path: "file.md", content: "content", mtime: 1000 }]);
		const cachedManifest = manifest(5000, "me", [
			entry({ path: "file.md", sha256: hash, version: 3, mtimeMs: 1000 }),
		]);

		await expect(
			runSync(
				app as any,
				{} as any,
				settings(),
				{ manifest: cachedManifest },
				async () => {},
				undefined,
				undefined,
				new Map(),
				staleRemote
			)
		).rejects.toThrow(/stale/i);

		// Nothing was touched.
		expect(app.vault.getAbstractFileByPath("file.md")).not.toBeNull();
	});

	it("a stale finalize re-check is ignored instead of merged", async () => {
		// The re-check merge must only accept manifests NEWER than the one the
		// sync started from — an older body (cache flashback) could reintroduce
		// entries that were since removed.
		const mineHash = await hashOf("mine");
		const ghostHash = await hashOf("ghost");

		const current = manifest(5000, "peer", []);
		s3State.manifest = current;
		const app = makeMockApp([{ path: "mine.md", content: "mine", mtime: 6000 }]);
		const cachedManifest = manifest(5000, "me", []);

		const plan = await computeSyncPlan(app as any, {} as any, settings(), cachedManifest);

		// Re-check returns an OLDER manifest carrying a long-gone entry.
		const staleRecheck = manifest(1000, "old", [
			entry({ path: "ghost.md", sha256: ghostHash, version: 9, lastSyncedAt: 1000 }),
		]);
		vi.mocked(s3.getManifest).mockImplementation(async () =>
			JSON.parse(JSON.stringify(staleRecheck))
		);

		await runSync(
			app as any,
			{} as any,
			settings(),
			{ manifest: cachedManifest },
			async () => {},
			undefined,
			undefined,
			plan.hashCache,
			plan.remoteManifest
		);

		vi.mocked(s3.getManifest).mockImplementation(async () =>
			s3State.manifest ? (JSON.parse(JSON.stringify(s3State.manifest)) as SyncManifest) : null
		);

		// Our push landed; the stale ghost entry did NOT come back.
		expect(s3State.manifest!.files["mine.md"]?.sha256).toBe(mineHash);
		expect(s3State.manifest!.files["ghost.md"]).toBeUndefined();
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

import { releaseLock } from "../src/sync";

describe("releaseLock — a leaked lock must never be swallowed", () => {
	const noWait = async () => {};

	it("returns true and clears the lock on success", async () => {
		s3State.lock = { deviceName: "me", timestamp: 1000 };
		const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, deferredDeletions: 0, errors: [] };

		const ok = await releaseLock({} as any, "b", "p", result, noWait);

		expect(ok).toBe(true);
		expect(s3State.lock).toBeNull();
		expect(result.errors).toHaveLength(0);
	});

	it("retries a transient failure and succeeds", async () => {
		s3State.lock = { deviceName: "me", timestamp: 1000 };
		const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, deferredDeletions: 0, errors: [] };

		// Call history accumulates across the file (no clearMocks); reset it so
		// the count assertion below only measures this test's attempts.
		vi.mocked(s3.deleteLock).mockClear();
		vi.mocked(s3.deleteLock)
			.mockRejectedValueOnce(new Error("network blip"))
			.mockImplementationOnce(async () => {
				s3State.lock = null;
			});

		const ok = await releaseLock({} as any, "b", "p", result, noWait);

		expect(ok).toBe(true);
		expect(s3State.lock).toBeNull();
		expect(result.errors).toHaveLength(0);
		expect(vi.mocked(s3.deleteLock)).toHaveBeenCalledTimes(2);
	});

	it("surfaces the failure (does not swallow) when every attempt fails", async () => {
		s3State.lock = { deviceName: "me", timestamp: 1000 };
		const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, deferredDeletions: 0, errors: [] };
		const created: string[] = [];

		vi.mocked(s3.deleteLock).mockRejectedValue(new Error("S3 down"));

		const ok = await releaseLock(
			{} as any,
			"b",
			"p",
			result,
			noWait,
			(m) => created.push(m)
		);

		expect(ok).toBe(false);
		// The error is recorded on the result, not silently dropped.
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toMatch(/lock/i);
		// The lock is still on S3 — the leak is real and must be reported.
		expect(s3State.lock).not.toBeNull();
		// The user is notified.
		expect(created.some((m) => /lock/i.test(m))).toBe(true);
	});
});

describe("runSync — a failed final lock release is reported, not swallowed", () => {
	it("a successful sync whose deleteLock fails still surfaces the leak in result.errors", async () => {
		const content = "hello";
		const hash = await hashOf(content);

		// Nothing to pull; one local-only file to push so the sync does real work.
		s3State.manifest = manifest(1000, "peer", []);
		const app = makeMockApp([{ path: "note.md", content, mtime: 5000 }]);
		const cachedManifest = manifest(1000, "me", []);

		// The final lock release fails permanently.
		vi.mocked(s3.deleteLock).mockRejectedValue(new Error("S3 unreachable"));

		const plan = await computeSyncPlan(app as any, {} as any, settings(), cachedManifest);
		const result = await runSync(
			app as any,
			{} as any,
			settings(),
			{ manifest: cachedManifest },
			async () => {},
			undefined,
			undefined,
			plan.hashCache,
			plan.remoteManifest
		);

		void hash;
		// The sync itself succeeded (file pushed) but the leaked lock is reported.
		expect(result.errors.some((e) => /lock/i.test(e))).toBe(true);
	});
});

describe("runSync — an unmodified copy of a deleted file must not be re-uploaded", () => {
	// Incident 2026-09-08 (@Weekly/36.md): the device still holding the untouched
	// file treated it as a fresh local creation and pushed it back to S3, undoing
	// the peer's deletion. The manifest entry went live again, so every later sync
	// — manual ones included — had no deletion left to apply, and the duplicate
	// survived for a day until the week planner re-closed the week over it.
	//
	// The upload side is what loses the deletion, so that is what changes here.
	// Auto-sync still deletes nothing locally: it defers, exactly as before.

	// Earlier describes in this file replace the s3.getManifest mock with
	// mockImplementation() and never restore it, so a later describe would read
	// THEIR manifests instead of s3State. Restore the shared default here.
	beforeEach(() => {
		vi.mocked(s3.getManifest).mockImplementation(async () =>
			s3State.manifest
				? (JSON.parse(JSON.stringify(s3State.manifest)) as SyncManifest)
				: null
		);
		vi.mocked(s3.deleteLock).mockImplementation(async () => {
			s3State.lock = null;
		});
		vi.mocked(s3.uploadFile).mockClear();
	});

	const CONTENT = "# Неделя 36\n\n### Work\n- [x] done\n";

	function tombstoneManifest(hash: string): SyncManifest {
		return manifest(2000, "desktop", [
			entry({
				path: "@Weekly/36.md",
				sha256: hash,
				version: 2,
				deleted: true,
				deletedBy: "desktop",
				deletedAt: Date.now() - 1000,
				lastSyncedAt: 2000,
			}),
		]);
	}

	// Cached entry already carries the tombstone: this device acknowledged the
	// deletion at some point, yet the file is still on disk.
	function cachedWithTombstone(hash: string): SyncManifest {
		return manifest(2000, "phone", [
			entry({
				path: "@Weekly/36.md",
				sha256: hash,
				version: 2,
				deleted: true,
				deletedBy: "desktop",
				deletedAt: Date.now() - 1000,
				lastSyncedAt: 2000,
			}),
		]);
	}

	async function run(
		app: any,
		cachedManifest: SyncManifest,
		options?: { applyDeletions?: boolean }
	) {
		let savedCache: { manifest: SyncManifest } | null = null;
		const plan = await computeSyncPlan(app, {} as any, settings("phone"), cachedManifest);
		const result = await runSync(
			app,
			{} as any,
			settings("phone"),
			{ manifest: cachedManifest },
			async (d) => {
				savedCache = JSON.parse(JSON.stringify(d));
			},
			undefined,
			undefined,
			plan.hashCache,
			plan.remoteManifest,
			options
		);
		return { result, savedCache: savedCache as unknown as { manifest: SyncManifest } };
	}

	it("auto-sync keeps the file on disk but never pushes it back to S3", async () => {
		const hash = await hashOf(CONTENT);
		s3State.manifest = tombstoneManifest(hash);
		const app = makeMockApp([{ path: "@Weekly/36.md", content: CONTENT, mtime: 1000 }]);

		const { result } = await run(app, cachedWithTombstone(hash), { applyDeletions: false });

		// The tombstone survives — nothing resurrected it.
		expect(s3State.manifest!.files["@Weekly/36.md"].deleted).toBe(true);
		expect(vi.mocked(s3.uploadFile).mock.calls.some((c) => c[3] === "@Weekly/36.md")).toBe(false);
		// Auto-sync deletes nothing locally; the deletion is merely pending.
		expect(app.vault.getAbstractFileByPath("@Weekly/36.md")).not.toBeNull();
		expect(result.deferredDeletions).toBe(1);
	});

	it("manual sync applies the pending deletion instead of resurrecting the file", async () => {
		const hash = await hashOf(CONTENT);
		s3State.manifest = tombstoneManifest(hash);
		const app = makeMockApp([{ path: "@Weekly/36.md", content: CONTENT, mtime: 1000 }]);

		const { result, savedCache } = await run(app, cachedWithTombstone(hash));

		expect(app.vault.getAbstractFileByPath("@Weekly/36.md")).toBeNull();
		expect(s3State.manifest!.files["@Weekly/36.md"].deleted).toBe(true);
		expect(savedCache.manifest["files"]["@Weekly/36.md"].deleted).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("applies the deletion even when this device has no cached record of the file", async () => {
		const hash = await hashOf(CONTENT);
		s3State.manifest = tombstoneManifest(hash);
		const app = makeMockApp([{ path: "@Weekly/36.md", content: CONTENT, mtime: 1000 }]);

		const { result } = await run(app, manifest(1000, "phone", []));

		expect(app.vault.getAbstractFileByPath("@Weekly/36.md")).toBeNull();
		expect(s3State.manifest!.files["@Weekly/36.md"].deleted).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("still resurrects a file whose local content differs from the tombstone", async () => {
		const tombstoneHash = await hashOf(CONTENT);
		s3State.manifest = tombstoneManifest(tombstoneHash);
		const app = makeMockApp([
			{ path: "@Weekly/36.md", content: "написано заново, руками", mtime: 5000 },
		]);

		const { result } = await run(app, cachedWithTombstone(tombstoneHash));

		// Real local content beats a peer's deletion, exactly as before.
		expect(app.vault.getAbstractFileByPath("@Weekly/36.md")).not.toBeNull();
		expect(s3State.manifest!.files["@Weekly/36.md"].deleted).toBe(false);
		expect(result.pushed).toBeGreaterThan(0);
	});
});
