import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEmptyManifest } from "../src/manifest";
import type { S3SyncSettings } from "../src/settings";

vi.mock("../src/plan", () => ({ computeSyncPlan: vi.fn() }));
vi.mock("../src/sync", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/sync")>()),
	runSync: vi.fn(),
}));

import { BackgroundSync, BackgroundSnapshot } from "../src/background";
import { computeSyncPlan } from "../src/plan";
import { runSync, SyncCancelledError } from "../src/sync";

const mockedPlan = vi.mocked(computeSyncPlan);
const mockedRunSync = vi.mocked(runSync);

const settings = { deviceName: "phone" } as S3SyncSettings;
const emptyResult = () => ({ pulled: 0, pushed: 0, conflicts: 0, deferredDeletions: 0, errors: [] });

function makePlan(entries: { path: string; action: any }[]) {
	return { entries, hashCache: new Map(), remoteManifest: createEmptyManifest("pc") };
}

function makeBackground() {
	return new BackgroundSync({} as any, {} as any, settings, {
		loadCachedManifest: async () => createEmptyManifest("phone"),
		saveCachedData: async () => {},
	});
}

beforeEach(() => {
	mockedPlan.mockReset();
	mockedRunSync.mockReset();
});

describe("BackgroundSync", () => {
	it("replays the current snapshot to a listener that subscribes mid-run", async () => {
		const bg = makeBackground();
		let release!: () => void;
		mockedPlan.mockImplementation(async (_a, _c, _s, _m, onProgress) => {
			onProgress?.("Comparing files 3 / 10");
			await new Promise<void>((r) => (release = r));
			return makePlan([]);
		});

		const running = bg.run();
		await vi.waitFor(() => expect(release).toBeDefined());

		const seen: BackgroundSnapshot[] = [];
		bg.subscribe((s) => seen.push(s));
		expect(seen[0]).toMatchObject({ phase: "planning", stepIndex: 0, detail: "Comparing files 3 / 10" });

		release();
		await running;
		expect(seen.at(-1)).toMatchObject({ phase: "done" });
	});

	it("ends 'done' without taking the lock when there is nothing to sync", async () => {
		mockedPlan.mockResolvedValue(makePlan([]));
		const final = await makeBackground().run();

		expect(final.phase).toBe("done");
		expect(final.result).toEqual(emptyResult());
		expect(mockedRunSync).not.toHaveBeenCalled();
	});

	it("runs the sync with deletions deferred and reports progress", async () => {
		mockedPlan.mockResolvedValue(makePlan([{ path: "a.md", action: "upload-new" }]));
		mockedRunSync.mockImplementation(async (...args) => {
			const onProgress = args[5]!;
			onProgress(5, "Uploading a.md", { ...emptyResult(), pushed: 1 });
			return { ...emptyResult(), pushed: 1 };
		});

		const bg = makeBackground();
		const seen: BackgroundSnapshot[] = [];
		bg.subscribe((s) => seen.push(s));
		const final = await bg.run();

		expect(mockedRunSync.mock.calls[0][9]).toEqual({ applyDeletions: false });
		expect(seen).toContainEqual(expect.objectContaining({ phase: "syncing", stepIndex: 4, detail: "Uploading a.md" }));
		expect(final).toMatchObject({ phase: "done", stepIndex: 6, result: { pushed: 1 } });
		expect(bg.finished).toBe(true);
	});

	it("cancel during planning ends 'cancelled' and never starts the sync", async () => {
		const bg = makeBackground();
		mockedPlan.mockImplementation(async (_a, _c, _s, _m, _p, signal) => {
			bg.abort();
			if (signal?.aborted) throw new SyncCancelledError();
			return makePlan([{ path: "a.md", action: "upload-new" }]);
		});

		const final = await bg.run();
		expect(final.phase).toBe("cancelled");
		expect(mockedRunSync).not.toHaveBeenCalled();
	});

	it("cancel during the sync passes an aborted signal to runSync", async () => {
		const bg = makeBackground();
		mockedPlan.mockResolvedValue(makePlan([{ path: "a.md", action: "upload-new" }]));
		mockedRunSync.mockImplementation(async (...args) => {
			bg.abort();
			if (args[6]?.aborted) throw new SyncCancelledError();
			return emptyResult();
		});

		const final = await bg.run();
		expect(final.phase).toBe("cancelled");
	});

	it("ends 'error' with the message when planning fails", async () => {
		mockedPlan.mockRejectedValue(new Error("network down"));
		const final = await makeBackground().run();

		expect(final).toMatchObject({ phase: "error", errorMessage: "network down" });
	});

	it("stops notifying a listener after it unsubscribes", async () => {
		mockedPlan.mockResolvedValue(makePlan([]));
		const bg = makeBackground();
		const listener = vi.fn();
		const unsubscribe = bg.subscribe(listener);
		unsubscribe();
		await bg.run();

		expect(listener).toHaveBeenCalledTimes(1); // the initial replay only
	});
});
