import { describe, it, expect } from "vitest";
import { mergeMarkdown } from "../src/merge";

describe("mergeMarkdown", () => {
	it("cleanly merges non-overlapping changes", () => {
		const ancestor = "line1\nline2\nline3\nline4\nline5";
		const ours = "line1\nline2-modified\nline3\nline4\nline5";
		const theirs = "line1\nline2\nline3\nline4\nline5-modified";

		const result = mergeMarkdown(ours, ancestor, theirs);
		expect(result.success).toBe(true);
		expect(result.content).toContain("line2-modified");
		expect(result.content).toContain("line5-modified");
	});

	it("detects conflicting changes", () => {
		const ancestor = "line1\nline2\nline3";
		const ours = "line1\nline2-ours\nline3";
		const theirs = "line1\nline2-theirs\nline3";

		const result = mergeMarkdown(ours, ancestor, theirs);
		expect(result.success).toBe(false);
		expect(result.content).toContain("<<<<<<<");
		expect(result.content).toContain(">>>>>>>");
	});

	it("handles identical changes (no conflict)", () => {
		const ancestor = "line1\nline2\nline3";
		const ours = "line1\nline2-same\nline3";
		const theirs = "line1\nline2-same\nline3";

		const result = mergeMarkdown(ours, ancestor, theirs);
		expect(result.success).toBe(true);
		expect(result.content).toBe("line1\nline2-same\nline3");
	});

	it("handles additions by one side", () => {
		const ancestor = "line1\nline2";
		const ours = "line1\nline2\nline3-ours";
		const theirs = "line1\nline2";

		const result = mergeMarkdown(ours, ancestor, theirs);
		expect(result.success).toBe(true);
		expect(result.content).toContain("line3-ours");
	});

	it("handles empty ancestor", () => {
		const ancestor = "";
		const ours = "new content ours";
		const theirs = "new content theirs";

		const result = mergeMarkdown(ours, ancestor, theirs);
		// Both added content from nothing — likely conflict
		expect(result.success).toBe(false);
	});
});
