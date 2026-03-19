import {
	S3Client,
	GetObjectCommand,
	PutObjectCommand,
	CopyObjectCommand,
	DeleteObjectCommand,
	ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { requestUrl } from "obsidian";
import type { SyncManifest, SyncLock } from "./manifest";

export type { S3Client };
export { S3Client as S3ClientClass } from "@aws-sdk/client-s3";

/**
 * Custom request handler that uses Obsidian's requestUrl to bypass CORS.
 * Obsidian's requestUrl uses Electron's net module on desktop and
 * native HTTP on mobile — both bypass browser CORS restrictions.
 */
function buildUrl(request: any): string {
	// AWS SDK v3 HttpRequest has: protocol, hostname, port, path, query
	if (typeof request.url === "string") return request.url;

	const protocol = request.protocol ?? "https:";
	const hostname = request.hostname ?? "";
	const port = request.port ? `:${request.port}` : "";
	const path = request.path ?? "/";

	let url = `${protocol}//${hostname}${port}${path}`;

	// Append query string
	if (request.query && typeof request.query === "object") {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(request.query)) {
			if (v != null) params.append(k, String(v));
		}
		const qs = params.toString();
		if (qs) url += `?${qs}`;
	}

	return url;
}

function obsidianRequestHandler() {
	return {
		handle: async (request: any) => {
			const url = buildUrl(request);

			const headers: Record<string, string> = {};
			if (request.headers) {
				for (const [k, v] of Object.entries(request.headers)) {
					if (v != null) headers[k] = String(v);
				}
			}
			// Remove headers that cause issues with Obsidian's requestUrl
			delete headers["content-length"];
			delete headers["Content-Length"];
			// host header is set automatically
			delete headers["host"];
			delete headers["Host"];

			let body: ArrayBuffer | undefined;
			if (request.body) {
				if (request.body instanceof Uint8Array) {
					body = request.body.buffer.slice(
						request.body.byteOffset,
						request.body.byteOffset + request.body.byteLength
					) as ArrayBuffer;
				} else if (typeof request.body === "string") {
					body = new TextEncoder().encode(request.body).buffer as ArrayBuffer;
				} else if (request.body instanceof ArrayBuffer) {
					body = request.body;
				}
			}

			const method = request.method ?? "GET";

			console.debug(`[S3 Sync] ${method} ${url}`);

			const resp = await requestUrl({
				url,
				method,
				headers,
				body: body,
				throw: false,
			});

			const responseHeaders: Record<string, string> = {};
			for (const [k, v] of Object.entries(resp.headers ?? {})) {
				responseHeaders[k.toLowerCase()] = v;
			}

			return {
				response: {
					statusCode: resp.status,
					headers: responseHeaders,
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(resp.arrayBuffer));
							controller.close();
						},
					}),
				},
			};
		},
	};
}

export function createS3Client(
	endpoint: string,
	region: string,
	accessKey: string,
	secretKey: string
): S3Client {
	return new S3Client({
		endpoint,
		region,
		credentials: {
			accessKeyId: accessKey,
			secretAccessKey: secretKey,
		},
		forcePathStyle: true,
		requestHandler: obsidianRequestHandler() as any,
	});
}

function key(prefix: string, path: string): string {
	return prefix ? `${prefix}/${path}` : path;
}

async function getObject(
	client: S3Client,
	bucket: string,
	objectKey: string
): Promise<Uint8Array | null> {
	try {
		const resp = await client.send(
			new GetObjectCommand({ Bucket: bucket, Key: objectKey })
		);
		return resp.Body
			? new Uint8Array(await resp.Body.transformToByteArray())
			: null;
	} catch (e: any) {
		if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404)
			return null;
		throw e;
	}
}

async function putObject(
	client: S3Client,
	bucket: string,
	objectKey: string,
	data: Uint8Array | string
): Promise<void> {
	await client.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: objectKey,
			Body: typeof data === "string" ? new TextEncoder().encode(data) : data,
		})
	);
}

async function deleteObject(
	client: S3Client,
	bucket: string,
	objectKey: string
): Promise<void> {
	try {
		await client.send(
			new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })
		);
	} catch {
		// ignore delete failures
	}
}

// --- Manifest ---

export async function getManifest(
	client: S3Client,
	bucket: string,
	prefix: string
): Promise<SyncManifest | null> {
	const data = await getObject(client, bucket, key(prefix, ".sync-manifest.json"));
	if (!data) return null;
	return JSON.parse(new TextDecoder().decode(data));
}

export async function putManifest(
	client: S3Client,
	bucket: string,
	prefix: string,
	manifest: SyncManifest
): Promise<void> {
	await putObject(
		client,
		bucket,
		key(prefix, ".sync-manifest.json"),
		JSON.stringify(manifest, null, 2)
	);
}

// --- Lock ---

export async function getLock(
	client: S3Client,
	bucket: string,
	prefix: string
): Promise<SyncLock | null> {
	const data = await getObject(client, bucket, key(prefix, ".sync-lock.json"));
	if (!data) return null;
	return JSON.parse(new TextDecoder().decode(data));
}

export async function putLock(
	client: S3Client,
	bucket: string,
	prefix: string,
	lock: SyncLock
): Promise<void> {
	await putObject(
		client,
		bucket,
		key(prefix, ".sync-lock.json"),
		JSON.stringify(lock)
	);
}

export async function deleteLock(
	client: S3Client,
	bucket: string,
	prefix: string
): Promise<void> {
	await deleteObject(client, bucket, key(prefix, ".sync-lock.json"));
}

// --- Files ---

export async function downloadFile(
	client: S3Client,
	bucket: string,
	prefix: string,
	path: string
): Promise<Uint8Array | null> {
	return getObject(client, bucket, key(prefix, path));
}

export async function uploadFile(
	client: S3Client,
	bucket: string,
	prefix: string,
	path: string,
	data: Uint8Array
): Promise<void> {
	await putObject(client, bucket, key(prefix, path), data);
}

// --- Ancestors (for 3-way merge) ---

export async function getAncestor(
	client: S3Client,
	bucket: string,
	prefix: string,
	hash: string
): Promise<Uint8Array | null> {
	return getObject(client, bucket, key(prefix, `.sync-ancestors/${hash}`));
}

export async function putAncestor(
	client: S3Client,
	bucket: string,
	prefix: string,
	hash: string,
	data: Uint8Array
): Promise<void> {
	await putObject(client, bucket, key(prefix, `.sync-ancestors/${hash}`), data);
}

// --- Soft delete ---

export async function softDeleteFile(
	client: S3Client,
	bucket: string,
	prefix: string,
	path: string,
	deviceName: string
): Promise<void> {
	const src = key(prefix, path);
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const dst = key(prefix, `_trash/${path}.${deviceName}.${ts}`);
	try {
		await client.send(
			new CopyObjectCommand({
				Bucket: bucket,
				CopySource: `${bucket}/${src}`,
				Key: dst,
			})
		);
	} catch {
		// source may not exist in S3 yet, that's fine
	}
	await deleteObject(client, bucket, src);
}

// --- List ---

export async function listKeys(
	client: S3Client,
	bucket: string,
	prefix: string
): Promise<string[]> {
	const keys: string[] = [];
	let continuationToken: string | undefined;
	do {
		const resp = await client.send(
			new ListObjectsV2Command({
				Bucket: bucket,
				Prefix: prefix ? `${prefix}/` : "",
				ContinuationToken: continuationToken,
			})
		);
		for (const obj of resp.Contents ?? []) {
			if (obj.Key) keys.push(obj.Key);
		}
		continuationToken = resp.NextContinuationToken;
	} while (continuationToken);
	return keys;
}
