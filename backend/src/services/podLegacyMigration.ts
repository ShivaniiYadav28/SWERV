import { createHash } from 'node:crypto';
import type { Collection, Filter, UpdateFilter } from 'mongodb';
import mongoose from 'mongoose';
import type { ObjectId } from 'mongodb';
import type { PodFileType, StoredPodFile } from './podStorageService.js';

export type LegacyPodRecord = {
  _id: ObjectId;
  photo?: StoredPodFile | null;
  signature?: StoredPodFile | null;
};

export type LegacyPodCollection = 'drafts' | 'proofs';
export type MigrationConnectionOptions = {
  autoCreate: false;
  autoIndex: false;
  serverSelectionTimeoutMS: 8_000;
};
export type LegacyMigrationCounts = {
  available: number;
  migrated: number;
  missing: number;
  invalid: number;
};

export type LegacyMigrationOperations = {
  records: (collection: LegacyPodCollection) => AsyncIterable<LegacyPodRecord>;
  readLocal: (file: StoredPodFile) => Promise<Buffer>;
  upload: (type: PodFileType, file: StoredPodFile, bytes: Buffer) => Promise<StoredPodFile>;
  updateMetadata: (
    collection: LegacyPodCollection,
    record: LegacyPodRecord,
    type: PodFileType,
    oldFile: StoredPodFile,
    newFile: StoredPodFile,
  ) => Promise<boolean>;
};

export type LegacyObjectOperations = {
  readObject: (storageKey: string) => Promise<Buffer>;
  upload: (
    type: PodFileType,
    file: StoredPodFile,
    bytes: Buffer,
    storageKey: string,
  ) => Promise<StoredPodFile>;
};

export class LegacyMigrationFailure extends Error {
  constructor(
    public readonly reason: 'local_read_failed' | 'upload_failed' | 'metadata_update_failed' | 'object_conflict' | 'source_conflict',
    public readonly orphanedObjectKey?: string,
    public readonly migratedBeforeFailure = 0,
  ) {
    super(reason);
    this.name = 'LegacyMigrationFailure';
  }
}

export function safeLegacyMigrationFailureMessage(error: unknown): string {
  if (error instanceof LegacyMigrationFailure) {
    const partial =
      `${error.migratedBeforeFailure} file reference(s) were migrated before stopping. `;
    if (error.reason === 'metadata_update_failed' && error.orphanedObjectKey) {
      return `Legacy POD migration stopped: metadata update failed. ${partial}` +
        `Investigate orphaned R2 object key: ${error.orphanedObjectKey}`;
    }
    if (error.reason === 'object_conflict') {
      return `Legacy POD migration stopped: a deterministic R2 key contains different bytes. ${partial}` +
        `Investigate object key: ${error.orphanedObjectKey}`;
    }
    if (error.reason === 'source_conflict') {
      return `Legacy POD migration stopped: a local source key changed during migration. ${partial}` +
        'Confirm the legacy volume is stable before retrying.';
    }
    const reason = error.reason === 'upload_failed'
      ? 'an R2 upload failed'
      : 'a local file could not be read';
    return `Legacy POD migration stopped: ${reason}. ${partial}` +
      'No underlying error details are shown.';
  }
  if (error instanceof Error && error.message.startsWith('Required POD collection(s)')) {
    return error.message;
  }
  if (error instanceof Error && error.message.startsWith('Usage:')) return error.message;
  if (
    error instanceof Error &&
    (error.message.startsWith('Set POD_STORAGE_PROVIDER=') ||
      error.message.startsWith('MONGO_URI is required'))
  ) {
    return error.message;
  }
  return 'Legacy POD migration failed. No underlying error details are shown.';
}

export function parseMigrationApplyOption(arguments_: readonly string[]): boolean {
  const options = arguments_.filter((argument) => argument.startsWith('--'));
  if (options.some((option) => option !== '--apply') || options.length > 1) {
    throw new Error('Usage: npm run pod:migrate-legacy [--apply]');
  }
  return options.includes('--apply');
}

export function configureMigrationModels(
  mongoose: { set: (key: 'autoCreate' | 'autoIndex', value: boolean) => unknown },
  schemas: Array<{ set: (key: 'autoCreate' | 'autoIndex', value: boolean) => unknown }>,
): void {
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
  for (const schema of schemas) {
    schema.set('autoCreate', false);
    schema.set('autoIndex', false);
  }
}

export function migrationConnectionOptions(): MigrationConnectionOptions {
  return { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 8_000 };
}

function validLegacyImage(type: PodFileType, file: StoredPodFile, bytes: Buffer): boolean {
  const extension = file.fileName.split('.').pop()?.toLowerCase();
  if (type === 'signature' && (file.contentType !== 'image/png' || extension !== 'png')) return false;
  if (
    type === 'photo' &&
    !(
      (file.contentType === 'image/png' && extension === 'png') ||
      (file.contentType === 'image/jpeg' && ['jpg', 'jpeg'].includes(extension ?? '')) ||
      (file.contentType === 'image/webp' && extension === 'webp')
    )
  ) return false;

  if (file.contentType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  }
  if (file.contentType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return (
    file.contentType === 'image/webp' &&
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  );
}

function isHttpError(error: unknown, status: number): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'status' in error &&
    error.status === status
  );
}

function legacyFileKey(file: StoredPodFile): string {
  return `${file.storageProvider ?? 'local'}:${file.storageKey}`;
}

export async function uploadLegacyObject(
  operations: LegacyObjectOperations,
  type: PodFileType,
  file: StoredPodFile,
  bytes: Buffer,
): Promise<StoredPodFile> {
  const storageKey = `pod/${file.storageKey}`;
  try {
    const existing = await operations.readObject(storageKey);
    if (!existing.equals(bytes)) {
      throw new LegacyMigrationFailure('object_conflict', storageKey);
    }
    return {
      storageKey,
      contentType: file.contentType,
      fileName: file.fileName,
      storageProvider: 's3',
    };
  } catch (error) {
    if (error instanceof LegacyMigrationFailure) throw error;
    if (!isHttpError(error, 404)) throw new LegacyMigrationFailure('upload_failed');
  }
  try {
    return await operations.upload(type, file, bytes, storageKey);
  } catch {
    throw new LegacyMigrationFailure('upload_failed');
  }
}

export async function migrateLegacyPodEvidence(
  operations: LegacyMigrationOperations,
  apply: boolean,
): Promise<LegacyMigrationCounts> {
  const counts: LegacyMigrationCounts = {
    available: 0,
    migrated: 0,
    missing: 0,
    invalid: 0,
  };
  const migratedFiles = new Map<string, { file: StoredPodFile; digest: string }>();

  for (const collection of ['drafts', 'proofs'] as const) {
    for await (const record of operations.records(collection)) {
      if (!record || typeof record !== 'object' || !(record._id instanceof mongoose.Types.ObjectId)) {
        counts.invalid += 1;
        continue;
      }
      for (const type of ['photo', 'signature'] as const) {
        const file = record[type];
        if (!file || file.storageProvider === 's3') continue;
        if (
          typeof file !== 'object' ||
          Array.isArray(file) ||
          (file.storageProvider != null && file.storageProvider !== 'local') ||
          typeof file.storageKey !== 'string' ||
          !/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(file.storageKey) ||
          typeof file.fileName !== 'string' ||
          !file.fileName ||
          typeof file.contentType !== 'string' ||
          !file.contentType
        ) {
          counts.invalid += 1;
          continue;
        }

        let bytes: Buffer;
        try {
          bytes = await operations.readLocal(file);
        } catch (error) {
          if (isHttpError(error, 404)) {
            counts.missing += 1;
            continue;
          }
          if (isHttpError(error, 400)) {
            counts.invalid += 1;
            continue;
          }
          throw new LegacyMigrationFailure('local_read_failed', undefined, counts.migrated);
        }

        if (!validLegacyImage(type, file, bytes)) {
          counts.invalid += 1;
          continue;
        }
        counts.available += 1;
        if (!apply) continue;

        const sourceKey = legacyFileKey(file);
        const digest = createHash('sha256').update(bytes).digest('hex');
        const cached = migratedFiles.get(sourceKey);
        if (cached && cached.digest !== digest) {
          throw new LegacyMigrationFailure('source_conflict', undefined, counts.migrated);
        }
        let uploaded = cached?.file;
        if (!uploaded) {
          try {
            uploaded = await operations.upload(type, file, bytes);
          } catch (error) {
            if (error instanceof LegacyMigrationFailure) {
              throw new LegacyMigrationFailure(
                error.reason,
                error.orphanedObjectKey,
                counts.migrated,
              );
            }
            if (isHttpError(error, 400)) {
              counts.invalid += 1;
              continue;
            }
            throw new LegacyMigrationFailure('upload_failed', undefined, counts.migrated);
          }
        }

        let updated: boolean;
        try {
          updated = await operations.updateMetadata(collection, record, type, file, uploaded);
        } catch {
          throw new LegacyMigrationFailure(
            'metadata_update_failed',
            uploaded.storageKey,
            counts.migrated,
          );
        }
        if (!updated) {
          throw new LegacyMigrationFailure(
            'metadata_update_failed',
            uploaded.storageKey,
            counts.migrated,
          );
        }

        migratedFiles.set(sourceKey, { file: uploaded, digest });
        counts.migrated += 1;
      }
    }
  }

  return counts;
}

export function assertRequiredCollectionsExist(
  existing: readonly string[],
  required: readonly string[],
): void {
  const names = new Set(existing);
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Required POD collection(s) do not exist: ${missing.join(', ')}.`);
  }
}

export async function updateLegacyFileMetadata(
  collection: Collection<LegacyPodRecord>,
  record: LegacyPodRecord,
  type: PodFileType,
  oldFile: StoredPodFile,
  newFile: StoredPodFile,
): Promise<boolean> {
  const providerFilter = oldFile.storageProvider
    ? { [`${type}.storageProvider`]: oldFile.storageProvider }
    : { [`${type}.storageProvider`]: { $in: [null] } };
  const filter = {
    _id: record._id,
    [`${type}.storageKey`]: oldFile.storageKey,
    ...providerFilter,
  } as Filter<LegacyPodRecord>;
  const update = {
    $set: {
      [`${type}.storageKey`]: newFile.storageKey,
      [`${type}.storageProvider`]: 's3',
    },
  } as UpdateFilter<LegacyPodRecord>;
  const result = await collection.updateOne(filter, update);
  return result.matchedCount === 1;
}
