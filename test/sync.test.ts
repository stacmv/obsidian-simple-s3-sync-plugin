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
