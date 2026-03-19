import { describe, it, expect } from "vitest";
import { sha256, sha256str } from "../src/hash";

describe("sha256", () => {
	it("hashes empty buffer", async () => {
		const hash = await sha256(new ArrayBuffer(0));
		expect(hash).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
		);
	});

	it("hashes known string", async () => {
		const hash = await sha256str("hello");
		expect(hash).toBe(
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
		);
	});

	it("produces different hashes for different inputs", async () => {
		const a = await sha256str("foo");
		const b = await sha256str("bar");
		expect(a).not.toBe(b);
	});

	it("produces same hash for same input", async () => {
		const a = await sha256str("test");
		const b = await sha256str("test");
		expect(a).toBe(b);
	});
});
