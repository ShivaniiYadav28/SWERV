import { Schema, model } from 'mongoose';

const alertFields = {
  anomalyType: { type: String, required: true, maxlength: 80 },
  severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], required: true },
  dispatchId: { type: String, default: null, maxlength: 100 },
  agentId: { type: String, default: null, maxlength: 100 },
  explanation: { type: String, required: true, maxlength: 1000 },
  evidence: { type: Schema.Types.Mixed, default: null },
  evidenceTimestamp: { type: Date, default: null },
  measuredValue: { type: Schema.Types.Mixed, default: null },
  threshold: { type: Schema.Types.Mixed, default: null },
  detectionMethod: { type: String, required: true, maxlength: 80 },
  modelName: { type: String, default: null, maxlength: 100 },
  modelVersion: { type: String, default: null, maxlength: 120 },
  modelProvenance: { type: String, default: null, maxlength: 500 },
  dataSource: { type: String, enum: ['real', 'synthetic_demo'], required: true },
  detectionMode: { type: String, enum: ['real', 'synthetic_demo'], required: true },
  dataQualityNotes: { type: [String], default: [] },
  reviewStatus: { type: String, enum: ['new', 'under_review', 'resolved', 'dismissed'], default: 'new' },
  reviewerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  reviewNotes: { type: String, default: '', maxlength: 1000 },
  deduplicationKey: { type: String, required: true },
};

function createAlertModel(collectionName: string, modelName: string) {
  const schema = new Schema(alertFields, { timestamps: true, versionKey: false });
  schema.index({ deduplicationKey: 1 }, { unique: true });
  schema.index({ createdAt: -1, severity: 1, anomalyType: 1, reviewStatus: 1 });
  return model(modelName, schema, collectionName);
}

// Demo alerts live in their own collection and cannot appear in real summaries.
export const AnomalyAlert = createAlertModel('anomaly_alerts', 'AnomalyAlert');
export const AnomalyDemoAlert = createAlertModel('anomaly_demo_alerts', 'AnomalyDemoAlert');

export async function ensureAnomalyAlertIndexes(): Promise<void> {
  await Promise.all([
    AnomalyAlert.collection.createIndex({ deduplicationKey: 1 }, { unique: true }),
    AnomalyDemoAlert.collection.createIndex({ deduplicationKey: 1 }, { unique: true }),
  ]);
}
