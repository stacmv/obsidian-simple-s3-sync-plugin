import { describe, it, expect } from "vitest";
import { createEmptyManifest, isLockStale } from "../src/manifest";

describe("createEmptyManifest", () => {
	it("creates manifest with correct schema version", () => {
		const m = createEmptyManifest("desktop");
		expect(m.schemaVersion).toBe(1);
		expect(m.lastUpdatedBy).toBe("desktop");
		expect(m.files).toEqual({});
	});

	it("sets lastUpdated to current time", () => {
		const before = Date.now();
		const m = createEmptyManifest("mobile");
		const after = Date.now();
		expect(m.lastUpdated).toBeGreaterThanOrEqual(before);
		expect(m.lastUpdated).toBeLessThanOrEqual(after);
	});
});

describe("isLockStale", () => {
	it("returns false for recent lock", () => {
		expect(isLockStale({ deviceName: "test", timestamp: Date.now() })).toBe(false);
	});

	it("returns true for old lock", () => {
		const sixMinAgo = Date.now() - 6 * 60 * 1000;
		expect(isLockStale({ deviceName: "test", timestamp: sixMinAgo })).toBe(true);
	});

	it("returns false for lock just under 5 minutes", () => {
		const fourMinAgo = Date.now() - 4 * 60 * 1000;
		expect(isLockStale({ deviceName: "test", timestamp: fourMinAgo })).toBe(false);
	});
});
