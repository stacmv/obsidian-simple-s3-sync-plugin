import { describe, it, expect } from "vitest";
import { shouldSyncFile } from "../src/filter";

describe("shouldSyncFile", () => {
	it("includes everything when no include patterns", () => {
		expect(shouldSyncFile("notes/test.md", [], [])).toBe(true);
	});

	it("includes matching files", () => {
		expect(shouldSyncFile("notes/test.md", ["**/*.md"], [])).toBe(true);
	});

	it("excludes non-matching files when include set", () => {
		expect(shouldSyncFile("notes/image.png", ["**/*.md"], [])).toBe(false);
	});

	it("excludes matching exclude patterns", () => {
		expect(shouldSyncFile(".obsidian/workspace.json", [], [".obsidian/**"])).toBe(false);
		expect(shouldSyncFile(".obsidian/plugins/foo/data.json", [], [".obsidian/**"])).toBe(false);
	});

	it("exclude wins over include", () => {
		expect(shouldSyncFile(".trash/old.md", ["**/*.md"], [".trash/**"])).toBe(false);
	});

	it("always excludes sync metadata files", () => {
		expect(shouldSyncFile(".sync-manifest.json", [], [])).toBe(false);
		expect(shouldSyncFile(".sync-lock.json", [], [])).toBe(false);
	});

	it("always excludes plugin data.json", () => {
		expect(
			shouldSyncFile(".obsidian/plugins/my-plugin/data.json", [], [])
		).toBe(false);
	});

	it("handles nested paths", () => {
		expect(
			shouldSyncFile("2 Knowledge/Health/Режим дня.md", ["**/*.md"], [])
		).toBe(true);
	});
});
