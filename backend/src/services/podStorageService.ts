import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { HttpError } from '../utils/httpError.js';

export type PodFileType = 'photo' | 'signature';
export type PodStorageProvider = 'local' | 's3';
export type StoredPodFile = {
  storageKey: string;
  contentType: string;
  fileName: string;
  storageProvider?: PodStorageProvider | null;
};

type S3Configuration = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
};

const s3Clients = new Map<string, S3Client>();

function getStorageProvider(): PodStorageProvider {
  const configuredProvider = process.env.POD_STORAGE_PROVIDER?.trim();
  const provider =
    configuredProvider || (process.env.NODE_ENV === 'production' ? '' : 'local');

  if (provider !== 'local' && provider !== 's3') {
    throw new Error(
      'Set POD_STORAGE_PROVIDER to "s3" in production; local proof storage is not durable.',
    );
  }
  if (process.env.NODE_ENV === 'production' && provider !== 's3') {
    throw new Error(
      'POD_STORAGE_PROVIDER must be "s3" in production; local proof storage is not durable.',
    );
  }
  return provider;
}

function getS3Configuration(): S3Configuration {
  const bucket = process.env.POD_S3_BUCKET?.trim();
  const region = process.env.POD_S3_REGION?.trim();
  if (!bucket || !region) {
    throw new Error('POD_S3_BUCKET and POD_S3_REGION are required for S3 proof storage.');
  }

  const accessKey = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  const endpoint = process.env.POD_S3_ENDPOINT?.trim();
  let parsedEndpoint: URL | undefined;
  let isCloudflareR2 = false;
  if (endpoint) {
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new Error('POD_S3_ENDPOINT must be a valid URL.');
    }
    isCloudflareR2 = parsedEndpoint.hostname
      .toLowerCase()
      .endsWith('.r2.cloudflarestorage.com');
  }
  if (isCloudflareR2 && (!accessKey || !secretKey)) {
    throw new Error(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for Cloudflare R2.',
    );
  }
  if (Boolean(accessKey) !== Boolean(secretKey)) {
    throw new Error(
      'Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or use a workload IAM role.',
    );
  }

  if (endpoint) {
    if (parsedEndpoint?.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
      throw new Error('POD_S3_ENDPOINT must use HTTPS in production.');
    }
  }

  const forcePathStyleValue = process.env.POD_S3_FORCE_PATH_STYLE?.trim();
  if (forcePathStyleValue && !['true', 'false'].includes(forcePathStyleValue)) {
    throw new Error('POD_S3_FORCE_PATH_STYLE must be "true" or "false".');
  }

  return {
    bucket,
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: forcePathStyleValue === 'true' || Boolean(endpoint),
  };
}

function storageUnavailable(): HttpError {
  return new HttpError(503, 'Proof storage is temporarily unavailable.', true);
}

export function validatePodStorageConfiguration(): void {
  const provider = getStorageProvider();
  if (provider === 's3') getS3Configuration();
}

function getS3Client(configuration: S3Configuration): S3Client {
  const key = JSON.stringify({
    region: configuration.region,
    endpoint: configuration.endpoint,
    forcePathStyle: configuration.forcePathStyle,
  });
  let client = s3Clients.get(key);
  if (!client) {
    client = new S3Client({
      region: configuration.region,
      ...(configuration.endpoint ? { endpoint: configuration.endpoint } : {}),
      forcePathStyle: configuration.forcePathStyle,
    });
    s3Clients.set(key, client);
  }
  return client;
}

function getStorageDirectory(): string {
  return resolve(process.env.POD_STORAGE_DIR ?? 'private_uploads/pod');
}

function fileExtension(type: PodFileType, contentType: string): string | null {
  if (type === 'signature') return contentType === 'image/png' ? '.png' : null;
  if (contentType === 'image/jpeg') return '.jpg';
  if (contentType === 'image/png') return '.png';
  if (contentType === 'image/webp') return '.webp';
  return null;
}

function matchesImageSignature(contentType: string, bytes: Buffer): boolean {
  if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function safeDisplayName(fileName: string, extension: string): string {
  const basename = fileName.split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || `proof${extension}`;
  return basename.toLowerCase().endsWith(extension) ? basename : `proof${extension}`;
}

function localFilePath(storageKey: string): string {
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(storageKey)) {
    throw new HttpError(404, 'Proof file not found.');
  }
  const storageDirectory = getStorageDirectory();
  const path = resolve(storageDirectory, storageKey);
  if (!path.startsWith(`${storageDirectory}/`) && !path.startsWith(`${storageDirectory}\\`)) {
    throw new HttpError(404, 'Proof file not found.');
  }
  return path;
}

function s3ObjectKey(storageKey: string): string {
  if (!/^pod\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(storageKey)) {
    throw new HttpError(404, 'Proof file not found.');
  }
  return storageKey;
}

function isObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: unknown;
    Code?: unknown;
  };
  return [candidate.name, candidate.Code].some(
    (code) => code === 'NoSuchKey' || code === 'NotFound',
  );
}

export async function storePodImage(
  type: PodFileType,
  fileName: string,
  contentType: string,
  bytes: Buffer,
  requestedStorageKey?: string,
): Promise<StoredPodFile> {
  const extension = fileExtension(type, contentType);
  if (!extension || !matchesImageSignature(contentType, bytes)) {
    throw new HttpError(400, 'The uploaded file is not a supported image.');
  }
  const suppliedExtension = fileName.split(/[\\/]/).pop()?.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  const allowedExtensions = contentType === 'image/jpeg' ? ['.jpg', '.jpeg'] : [extension];
  if (!suppliedExtension || !allowedExtensions.includes(suppliedExtension)) {
    throw new HttpError(400, 'The file extension does not match its image format.');
  }

  const safeName = safeDisplayName(fileName, extension);
  const provider = getStorageProvider();
  if (requestedStorageKey && provider !== 's3') {
    throw new Error('A fixed storage key is only supported for S3 proof storage.');
  }
  const storageKey =
    provider === 's3'
      ? requestedStorageKey
        ? s3ObjectKey(requestedStorageKey)
        : `pod/${randomUUID()}${extension}`
      : `${randomUUID()}${extension}`;

  if (provider === 's3') {
    const configuration = getS3Configuration();
    try {
      await getS3Client(configuration).send(
        new PutObjectCommand({
          Bucket: configuration.bucket,
          Key: storageKey,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: contentType,
        }),
      );
    } catch {
      try {
        await deletePodImage({ storageKey, storageProvider: 's3' });
      } catch {
        console.warn('POD object cleanup failed after an upload error.');
      }
      throw storageUnavailable();
    }
  } else {
    const path = localFilePath(storageKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  }

  return { storageKey, contentType, fileName: safeName, storageProvider: provider };
}

export async function readPodImage(file: Pick<StoredPodFile, 'storageKey' | 'storageProvider'>): Promise<Buffer> {
  const provider = file.storageProvider ?? 'local';
  if (provider === 's3') {
    const configuration = getS3Configuration();
    try {
      const response = await getS3Client(configuration).send(
        new GetObjectCommand({
          Bucket: configuration.bucket,
          Key: s3ObjectKey(file.storageKey),
        }),
      );
      if (!response.Body) throw new HttpError(404, 'Proof file not found.');
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (isObjectNotFound(error)) throw new HttpError(404, 'Proof file not found.');
      throw storageUnavailable();
    }
  }

  try {
    return await readFile(localFilePath(file.storageKey));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(404, 'Proof file not found.');
    }
    throw error;
  }
}

export async function deletePodImage(file: Pick<StoredPodFile, 'storageKey' | 'storageProvider'>): Promise<void> {
  if (file.storageProvider === 's3') {
    const configuration = getS3Configuration();
    try {
      await getS3Client(configuration).send(
        new DeleteObjectCommand({
          Bucket: configuration.bucket,
          Key: s3ObjectKey(file.storageKey),
        }),
      );
    } catch {
      throw storageUnavailable();
    }
    return;
  }

  try {
    await unlink(localFilePath(file.storageKey));
  } catch {
    // Cleanup remains best-effort if storing replacement metadata fails.
  }
}
