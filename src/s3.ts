import {
	S3Client,
	GetObjectCommand,
	PutObjectCommand,
	CopyObjectCommand,
	DeleteObjectCommand,
	ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { SyncManifest, SyncLock } from "./manifest";

export type { S3Client };
export { S3Client as S3ClientClass } from "@aws-sdk/client-s3";

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
		forcePathStyle: true, // needed for MinIO and most S3-compatible
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
