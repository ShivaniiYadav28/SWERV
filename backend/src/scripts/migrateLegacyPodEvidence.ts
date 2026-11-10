import '../config/loadEnv.js';
import mongoose from 'mongoose';
import { migrateLegacyPodEvidence, assertRequiredCollectionsExist, updateLegacyFileMetadata, uploadLegacyObject, configureMigrationModels, migrationConnectionOptions, parseMigrationApplyOption, safeLegacyMigrationFailureMessage, type LegacyPodRecord } from '../services/podLegacyMigration.js';
import {
  readPodImage,
  storePodImage,
  validatePodStorageConfiguration,
  type PodFileType,
  type StoredPodFile,
} from '../services/podStorageService.js';

async function main(): Promise<void> {
  const apply = parseMigrationApplyOption(process.argv.slice(2));
  if (apply) {
    if (process.env.POD_STORAGE_PROVIDER?.trim() !== 's3') {
      throw new Error('Set POD_STORAGE_PROVIDER=s3 before applying the migration.');
    }
    validatePodStorageConfiguration();
  }

  const mongoUri = process.env.MONGO_URI?.trim();
  if (!mongoUri || mongoUri === 'your_mongodb_connection_string') {
    throw new Error('MONGO_URI is required to inspect legacy POD metadata.');
  }

  configureMigrationModels(mongoose, []);
  const { ProofOfDelivery, ProofOfDeliveryDraft } = await import('../models/ProofOfDelivery.js');
  configureMigrationModels(mongoose, [
    ProofOfDelivery.schema,
    ProofOfDeliveryDraft.schema,
  ]);

  await mongoose.connect(mongoUri, migrationConnectionOptions());
  try {
    const database = mongoose.connection.db;
    if (!database) throw new Error('MongoDB is not available.');

    const draftCollectionName = ProofOfDeliveryDraft.collection.collectionName;
    const proofCollectionName = ProofOfDelivery.collection.collectionName;
    const existingCollections = await database
      .listCollections(
        { name: { $in: [draftCollectionName, proofCollectionName] } },
        { nameOnly: true },
      )
      .toArray();
    assertRequiredCollectionsExist(
      existingCollections.map((collection) => collection.name),
      [draftCollectionName, proofCollectionName],
    );

    const drafts = database.collection<LegacyPodRecord>(draftCollectionName);
    const proofs = database.collection<LegacyPodRecord>(proofCollectionName);
    const counts = await migrateLegacyPodEvidence(
      {
        records: (collection) =>
          collection === 'drafts' ? drafts.find({}) : proofs.find({}),
        readLocal: readPodImage,
        upload: (type, file, bytes) =>
          uploadLegacyObject(
            {
              readObject: (storageKey) => readPodImage({
                storageKey,
                storageProvider: 's3',
              }),
              upload: (fileType, legacyFile, contents, storageKey) =>
                storePodImage(fileType, legacyFile.fileName, legacyFile.contentType, contents, storageKey),
            },
            type,
            file,
            bytes,
          ),
        updateMetadata: async (collection, record, type, oldFile, newFile) => {
          const target = collection === 'drafts' ? drafts : proofs;
          return updateLegacyFileMetadata(target, record, type, oldFile, newFile);
        },
      },
      apply,
    );

    console.info(
      `${apply ? 'Migration complete' : 'Dry run complete'}: ` +
        `${counts.available} readable legacy files, ${counts.migrated} migrated, ` +
        `${counts.missing} missing, ${counts.invalid} invalid.`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

function reportSafeFailure(error: unknown): void {
  console.error(safeLegacyMigrationFailureMessage(error));
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/migrateLegacyPodEvidence.js') ||
    process.argv[1]?.replaceAll('\\', '/').endsWith('/migrateLegacyPodEvidence.ts')) {
  main().catch((error: unknown) => {
    reportSafeFailure(error);
    process.exitCode = 1;
  });
}
