import { describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { HttpError } from '../src/utils/httpError.js';
import {
  assertRequiredCollectionsExist,
  configureMigrationModels,
  LegacyMigrationFailure,
  migrateLegacyPodEvidence,
  migrationConnectionOptions,
  parseMigrationApplyOption,
  safeLegacyMigrationFailureMessage,
  updateLegacyFileMetadata,
  uploadLegacyObject,
  type LegacyMigrationOperations,
  type LegacyPodRecord,
} from '../src/services/podLegacyMigration.js';
import type { StoredPodFile } from '../src/services/podStorageService.js';
import type { Collection } from 'mongodb';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpl8AAAAASUVORK5CYII=',
  'base64',
);

function legacyFile(storageKey = '82d34d47-b638-46c4-abac-d1cfe21c696f.png'): StoredPodFile {
  return {
    storageKey,
    fileName: 'delivery.png',
    contentType: 'image/png',
    storageProvider: 'local',
  };
}

function record(
  id: string,
  photo: StoredPodFile | null = legacyFile(),
  signature: StoredPodFile | null = null,
): LegacyPodRecord {
  return { _id: new mongoose.Types.ObjectId(id), photo, signature };
}

function operations(
  records: Partial<Record<'drafts' | 'proofs', LegacyPodRecord[]>>,
  overrides: Partial<LegacyMigrationOperations> = {},
): LegacyMigrationOperations {
  return {
    records: async function* (collection) {
      yield* records[collection] ?? [];
    },
    readLocal: async () => png,
    upload: async (_type, file) => ({
      ...file,
      storageKey: `pod/${file.storageKey}`,
      storageProvider: 's3',
    }),
    updateMetadata: async () => true,
    ...overrides,
  };
}

describe('legacy POD evidence migration', () => {
  it('requires an explicit apply option and disables Mongoose auto writes', () => {
    expect(parseMigrationApplyOption([])).toBe(false);
    expect(parseMigrationApplyOption(['--apply'])).toBe(true);
    expect(() => parseMigrationApplyOption(['--apply', '--other'])).toThrow(/Usage:/);

    const mongooseSet = vi.fn();
    const schemaSet = vi.fn();
    configureMigrationModels({ set: mongooseSet }, [{ set: schemaSet }]);
    expect(mongooseSet.mock.calls).toEqual([
      ['autoCreate', false],
      ['autoIndex', false],
    ]);
    expect(schemaSet.mock.calls).toEqual([
      ['autoCreate', false],
      ['autoIndex', false],
    ]);
    expect(migrationConnectionOptions()).toEqual({
      autoCreate: false,
      autoIndex: false,
      serverSelectionTimeoutMS: 8_000,
    });
  });

  it('keeps dry-run to reads and does not upload or update metadata', async () => {
    let readCount = 0;
    const source = record('507f1f77bcf86cd799439011', legacyFile(), legacyFile(
      '9fbd1a84-240e-4824-b54e-d1ad0a4b47ce.png',
    ));
    const counts = await migrateLegacyPodEvidence(
      operations({ drafts: [source] }, {
        readLocal: async () => { readCount += 1; return png; },
        upload: async () => { throw new Error('upload must not run'); },
        updateMetadata: async () => { throw new Error('database write must not run'); },
      }),
      false,
    );
    expect(counts).toEqual({ available: 2, migrated: 0, missing: 0, invalid: 0 });
    expect(readCount).toBe(2);
  });

  it('reports absent collections without creating them', () => {
    expect(() => assertRequiredCollectionsExist(['proofofdeliveries'], [
      'proofofdeliverydrafts',
      'proofofdeliveries',
    ])).toThrow('Required POD collection(s) do not exist: proofofdeliverydrafts.');
  });

  it('updates only the selected evidence metadata on the matching record', async () => {
    const source = record('507f1f77bcf86cd799439011');
    let filter: Record<string, unknown> | undefined;
    let update: Record<string, unknown> | undefined;
    const collection = {
      updateOne: async (actualFilter: Record<string, unknown>, actualUpdate: Record<string, unknown>) => {
        filter = actualFilter;
        update = actualUpdate;
        return { matchedCount: 1 };
      },
    } as unknown as Collection<LegacyPodRecord>;
    const saved = await updateLegacyFileMetadata(
      collection,
      source,
      'photo',
      source.photo!,
      { ...source.photo!, storageKey: 'pod/new.png', storageProvider: 's3' },
    );
    expect(saved).toBe(true);
    expect(filter).toEqual({
      _id: source._id,
      'photo.storageKey': source.photo!.storageKey,
      'photo.storageProvider': 'local',
    });
    expect(update).toEqual({
      $set: { 'photo.storageKey': 'pod/new.png', 'photo.storageProvider': 's3' },
    });
  });

  it('processes collection records and files sequentially', async () => {
    const events: string[] = [];
    const source = record('507f1f77bcf86cd799439011', legacyFile(), legacyFile(
      '9fbd1a84-240e-4824-b54e-d1ad0a4b47ce.png',
    ));
    const result = await migrateLegacyPodEvidence(
      operations({ drafts: [source], proofs: [record('507f1f77bcf86cd799439012')] }, {
        records: async function* (collection) {
          events.push(`records:${collection}`);
          if (collection === 'drafts') yield source;
          else yield record('507f1f77bcf86cd799439012');
        },
        upload: async (_type, file) => {
          events.push(`upload:${file.storageKey}`);
          await Promise.resolve();
          return { ...file, storageKey: `pod/${file.storageKey}`, storageProvider: 's3' };
        },
        updateMetadata: async (_collection, _record, type) => {
          events.push(`update:${type}`);
          return true;
        },
      }),
      true,
    );
    expect(result.migrated).toBe(3);
    expect(events).toEqual([
      'records:drafts',
      'upload:82d34d47-b638-46c4-abac-d1cfe21c696f.png',
      'update:photo',
      'upload:9fbd1a84-240e-4824-b54e-d1ad0a4b47ce.png',
      'update:signature',
      'records:proofs',
      'update:photo',
    ]);
  });

  it('stops safely on upload failure without revealing provider errors', async () => {
    let failure: unknown;
    try {
      await migrateLegacyPodEvidence(
      operations({ drafts: [record('507f1f77bcf86cd799439011')] }, {
        upload: async () => { throw new Error('AWS_SECRET_ACCESS_KEY=private-value'); },
      }),
      true,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ reason: 'upload_failed' });
    const message = safeLegacyMigrationFailureMessage(failure);
    expect(message).not.toContain('private-value');
    expect(message).toContain('No underlying error details are shown.');
  });

  it('reports an orphan key when metadata update fails after upload', async () => {
    const uploadedKey = 'pod/82d34d47-b638-46c4-abac-d1cfe21c696f.png';
    await expect(migrateLegacyPodEvidence(
      operations({ drafts: [record('507f1f77bcf86cd799439011')] }, {
        upload: async (_type, file) => ({ ...file, storageKey: uploadedKey, storageProvider: 's3' }),
        updateMetadata: async () => { throw new Error('database credential detail'); },
      }),
      true,
    )).rejects.toMatchObject({
      reason: 'metadata_update_failed',
      orphanedObjectKey: uploadedKey,
      migratedBeforeFailure: 0,
    });
  });

  it('counts missing files and skips invalid metadata and image bytes', async () => {
    const invalidKey = record('507f1f77bcf86cd799439011', legacyFile('../outside.png'));
    const missing = record('507f1f77bcf86cd799439012');
    const malformedBytes = record(
      '507f1f77bcf86cd799439013',
      legacyFile('9fbd1a84-240e-4824-b54e-d1ad0a4b47ce.png'),
    );
    const invalidRecord = {
      ...record('507f1f77bcf86cd799439014'),
      _id: 'not-an-object-id',
    } as unknown as LegacyPodRecord;
    const result = await migrateLegacyPodEvidence(
      operations({ drafts: [invalidKey, missing, malformedBytes, invalidRecord] }, {
        readLocal: async (file) => {
          if (file.storageKey === missing.photo!.storageKey) throw new HttpError(404, 'missing');
          if (file.storageKey === malformedBytes.photo!.storageKey) return Buffer.from('not an image');
          return png;
        },
        upload: async () => { throw new Error('invalid files must not upload'); },
        updateMetadata: async () => { throw new Error('dry run must not write'); },
      }),
      false,
    );
    expect(result).toEqual({ available: 0, migrated: 0, missing: 1, invalid: 3 });
  });

  it('does not upload already-migrated evidence on a rerun', async () => {
    const source = record('507f1f77bcf86cd799439011');
    let uploadCount = 0;
    const deps = operations({ proofs: [source] }, {
      upload: async (_type, file) => {
        uploadCount += 1;
        return { ...file, storageKey: `pod/${file.storageKey}`, storageProvider: 's3' };
      },
      updateMetadata: async (_collection, target, type, _oldFile, newFile) => {
        target[type] = newFile;
        return true;
      },
    });
    await migrateLegacyPodEvidence(deps, true);
    const secondRun = await migrateLegacyPodEvidence(deps, true);
    expect(uploadCount).toBe(1);
    expect(secondRun.migrated).toBe(0);
  });

  it('stops if duplicate local references change contents during a run', async () => {
    let readCount = 0;
    await expect(migrateLegacyPodEvidence(
      operations({
        drafts: [record('507f1f77bcf86cd799439011')],
        proofs: [record('507f1f77bcf86cd799439012')],
      }, {
        readLocal: async () => {
          readCount += 1;
          const bytes = Buffer.from(png);
          if (readCount === 2) bytes[bytes.length - 1] ^= 0xff;
          return bytes;
        },
      }),
      true,
    )).rejects.toMatchObject({
      reason: 'source_conflict',
      migratedBeforeFailure: 1,
    });
  });

  it('reuses the deterministic object after a prior upload and refuses mismatched bytes', async () => {
    const file = legacyFile();
    const key = `pod/${file.storageKey}`;
    let uploadCount = 0;
    const reused = await uploadLegacyObject({
      readObject: async (objectKey) => {
        expect(objectKey).toBe(key);
        return png;
      },
      upload: async () => { uploadCount += 1; return file; },
    }, 'photo', file, png);
    expect(reused.storageKey).toBe(key);
    expect(uploadCount).toBe(0);

    await expect(uploadLegacyObject({
      readObject: async () => Buffer.from('different bytes'),
      upload: async () => { uploadCount += 1; return file; },
    }, 'photo', file, png)).rejects.toMatchObject({
      reason: 'object_conflict',
      orphanedObjectKey: key,
    });
    expect(uploadCount).toBe(0);
  });
});
