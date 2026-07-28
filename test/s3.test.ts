import { describe, it, expect, vi, beforeEach } from "vitest";

// Replace requestUrl with a spy while keeping the rest of the obsidian mock.
vi.mock("obsidian", async (importOriginal) => {
	const orig = await importOriginal<Record<string, unknown>>();
	return {
		...orig,
		requestUrl: vi.fn(async () => ({
			status: 200,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
		})),
	};
});

import { requestUrl } from "obsidian";
import { obsidianRequestHandler } from "../src/s3";

describe("obsidianRequestHandler — HTTP cache busting (regression 2026-07-28)", () => {
	// Real incident: Electron's HTTP cache served a stale .sync-manifest.json
	// (S3 responses carry no Cache-Control, so heuristic caching applies). The
	// stale manifest still held tombstones and the plan proposed re-deleting
	// files that had just been resurrected. Every S3 request must opt out of
	// HTTP caching explicitly.

	beforeEach(() => {
		vi.mocked(requestUrl).mockClear();
	});

	it("sends Cache-Control/Pragma no-cache on GET requests", async () => {
		const handler = obsidianRequestHandler();
		await handler.handle({
			method: "GET",
			protocol: "https:",
			hostname: "s3.example.com",
			path: "/bucket/notes/.sync-manifest.json",
			headers: { "x-amz-date": "20260728T000000Z" },
		});

		expect(vi.mocked(requestUrl)).toHaveBeenCalledTimes(1);
		const call = vi.mocked(requestUrl).mock.calls[0][0] as {
			headers: Record<string, string>;
		};
		expect(call.headers["cache-control"]).toBe("no-cache");
		expect(call.headers["pragma"]).toBe("no-cache");
	});

	it("does not clobber signed headers", async () => {
		const handler = obsidianRequestHandler();
		await handler.handle({
			method: "PUT",
			protocol: "https:",
			hostname: "s3.example.com",
			path: "/bucket/key",
			headers: {
				authorization: "AWS4-HMAC-SHA256 ...",
				"x-amz-content-sha256": "abc",
			},
			body: "data",
		});

		const call = vi.mocked(requestUrl).mock.calls[0][0] as {
			headers: Record<string, string>;
		};
		expect(call.headers["authorization"]).toBe("AWS4-HMAC-SHA256 ...");
		expect(call.headers["x-amz-content-sha256"]).toBe("abc");
		expect(call.headers["cache-control"]).toBe("no-cache");
	});
});
