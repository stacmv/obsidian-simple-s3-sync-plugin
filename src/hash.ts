export async function sha256(data: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function sha256str(text: string): Promise<string> {
	return sha256(new TextEncoder().encode(text).buffer as ArrayBuffer);
}
