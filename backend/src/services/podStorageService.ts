import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { HttpError } from '../utils/httpError.js';

function getStorageDirectory(): string {
  return resolve(process.env.POD_STORAGE_DIR ?? 'private_uploads/pod');
}

export type PodFileType = 'photo' | 'signature';
export type StoredPodFile = { storageKey: string; contentType: string; fileName: string };

function fileExtension(type: PodFileType, contentType: string): string | null {
  if (type === 'signature') return contentType === 'image/png' ? '.png' : null;
  if (contentType === 'image/jpeg') return '.jpg';
  if (contentType === 'image/png') return '.png';
  if (contentType === 'image/webp') return '.webp';
  return null;
}

function matchesImageSignature(type: PodFileType, contentType: string, bytes: Buffer): boolean {
  if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function safeDisplayName(fileName: string, extension: string): string {
  const basename = fileName.split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || `proof${extension}`;
  return basename.toLowerCase().endsWith(extension) ? basename : `proof${extension}`;
}

function filePath(storageKey: string): string {
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(storageKey)) throw new HttpError(404, 'Proof file not found.');
  const storageDirectory = getStorageDirectory();
  const path = resolve(storageDirectory, storageKey);
  if (!path.startsWith(`${storageDirectory}/`) && !path.startsWith(`${storageDirectory}\\`)) throw new HttpError(404, 'Proof file not found.');
  return path;
}

export async function storePodImage(type: PodFileType, fileName: string, contentType: string, bytes: Buffer): Promise<StoredPodFile> {
  const extension = fileExtension(type, contentType);
  if (!extension || !matchesImageSignature(type, contentType, bytes)) {
    throw new HttpError(400, 'The uploaded file is not a supported image.');
  }
  const suppliedExtension = fileName.split(/[\\/]/).pop()?.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  const allowedExtensions = contentType === 'image/jpeg' ? ['.jpg', '.jpeg'] : [extension];
  if (!suppliedExtension || !allowedExtensions.includes(suppliedExtension)) {
    throw new HttpError(400, 'The file extension does not match its image format.');
  }
  const safeName = safeDisplayName(fileName, extension);
  const storageKey = `${randomUUID()}${extension}`;
  const path = filePath(storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  return { storageKey, contentType, fileName: safeName };
}

export async function readPodImage(storageKey: string): Promise<Buffer> {
  try {
    return await readFile(filePath(storageKey));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, 'Proof file not found.');
  }
}

export async function deletePodImage(storageKey: string): Promise<void> {
  try { await unlink(filePath(storageKey)); } catch { /* Cleanup is best-effort after database failures. */ }
}
