import { describe, it, expect, vi } from "vitest";
import type { SyncManifest, ManifestEntry } from "../src/manifest";
import { createEmptyManifest } from "../src/manifest";
import type { S3SyncSettings } from "../src/settings";
import { sha256 } from "../src/hash";
import { TFile } from "obsidian";

// Mock s3 module
vi.mock("../src/s3", () => ({
	getManifest: vi.fn(),
}));

import { computeSyncPlan } from "../src/plan";
import { getManifest } from "../src/s3";

const mockedGetManifest = vi.mocked(getManifest);

function makeEntry(overrides: Partial<ManifestEntry> & { path: string; sha256: string }): ManifestEntry {
	return {
		mtimeMs: 1000,
		sizeBytes: 100,
		lastSyncedBy: "pc",
		lastSyncedAt: 1000,
		version: 1,
		deleted: false,
		...overrides,
	};
}

function makeSettings(): S3SyncSettings {
	return {
		s3Endpoint: "",
		s3Region: "us-east-1",
		s3Bucket: "test-bucket",
		s3Prefix: "vault",
		s3AccessKey: "",
		s3SecretKey: "",
		deviceName: "phone",
		syncIntervalMinutes: 0,
		includePatterns: [],
		excludePatterns: [],
		mergeStrategy: "keep-both",
	};
}

async function hashOf(text: string): Promise<string> {
	return sha256(new TextEncoder().encode(text).buffer as ArrayBuffer);
}

function makeTFile(path: string, mtime: number, content: string): TFile {
	const tf = new TFile();
	tf.path = path;
	tf.stat = { mtime, size: content.length } as any;
	(tf as any)._content = content;
	return tf;
}

function makeMockApp(files: { path: string; mtime: number; content: string }[]) {
	const tfiles = files.map((f) => makeTFile(f.path, f.mtime, f.content));

	return {
		vault: {
			getFiles: () => tfiles,
			getAbstractFileByPath: (path: string) => tfiles.find((f) => f.path === path) ?? null,
			readBinary: async (file: any) => new TextEncoder().encode(file._content).buffer,
		},
	} as any;
}

describe("computeSyncPlan — empty cached manifest (cache wipe)", () => {
	it("should download-update (not conflict) when cached manifest is empty and local !== remote", async () => {
		const remoteHash = await hashOf("new version from pc");

		mockedGetManifest.mockResolvedValue({
			schemaVersion: 1,
			lastUpdated: 2000,
			lastUpdatedBy: "pc",
			files: {
				"notes/backlog.md": makeEntry({ path: "notes/backlog.md", sha256: remoteHash, version: 2 }),
			},
		});

		const plan = await computeSyncPlan(
			makeMockApp([{ path: "notes/backlog.md", mtime: 2000, content: "old version from phone" }]),
			{} as any,
			makeSettings(),
			createEmptyManifest("phone"),
		);

		const entry = plan.entries.find((e) => e.path === "notes/backlog.md");
		expect(entry).toBeDefined();
		expect(entry!.action).toBe("download-update");
	});

	it("should skip when cached manifest is empty but local === remote", async () => {
		const content = "same content on both";
		const hash = await hashOf(content);

		mockedGetManifest.mockResolvedValue({
			schemaVersion: 1,
			lastUpdated: 2000,
			lastUpdatedBy: "pc",
			files: {
				"notes/todo.md": makeEntry({ path: "notes/todo.md", sha256: hash, version: 1 }),
			},
		});

		const plan = await computeSyncPlan(
			makeMockApp([{ path: "notes/todo.md", mtime: 2000, content }]),
			{} as any,
			makeSettings(),
			createEmptyManifest("phone"),
		);

		expect(plan.entries.find((e) => e.path === "notes/todo.md")).toBeUndefined();
	});

	it("should download-update (not upload-update) for local-only loop with empty cache", async () => {
		const remoteHash = await hashOf("remote new version");

		mockedGetManifest.mockResolvedValue({
			schemaVersion: 1,
			lastUpdated: 2000,
			lastUpdatedBy: "pc",
			files: {
				"daily/2024-01-01.md": makeEntry({ path: "daily/2024-01-01.md", sha256: remoteHash, version: 2 }),
			},
		});

		const plan = await computeSyncPlan(
			makeMockApp([{ path: "daily/2024-01-01.md", mtime: 2000, content: "local old version" }]),
			{} as any,
			makeSettings(),
			createEmptyManifest("phone"),
		);

		const entry = plan.entries.find((e) => e.path === "daily/2024-01-01.md");
		expect(entry).toBeDefined();
		expect(entry!.action).toBe("download-update");
	});

	it("should detect real conflict when cached manifest has history", async () => {
		const baseHash = await hashOf("base version");
		const remoteHash = await hashOf("remotely modified");

		mockedGetManifest.mockResolvedValue({
			schemaVersion: 1,
			lastUpdated: 3000,
			lastUpdatedBy: "pc",
			files: {
				"notes/shared.md": makeEntry({ path: "notes/shared.md", sha256: remoteHash, version: 2 }),
			},
		});

		const cachedManifest: SyncManifest = {
			schemaVersion: 1,
			lastUpdated: 1000,
			lastUpdatedBy: "phone",
			files: {
				"notes/shared.md": makeEntry({ path: "notes/shared.md", sha256: baseHash, mtimeMs: 1000, version: 1 }),
			},
		};

		const plan = await computeSyncPlan(
			makeMockApp([{ path: "notes/shared.md", mtime: 2000, content: "locally modified" }]),
			{} as any,
			makeSettings(),
			cachedManifest,
		);

		const entry = plan.entries.find((e) => e.path === "notes/shared.md");
		expect(entry).toBeDefined();
		expect(entry!.action).toBe("conflict");
	});
});
