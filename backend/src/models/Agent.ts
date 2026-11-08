import { Schema, model } from 'mongoose';

export const agentStatuses = [
  'available',
  'unavailable',
  'on_duty',
  'suspended',
] as const;
export type AgentStatus = (typeof agentStatuses)[number];

export const vehicleTypes = ['car', 'van', 'motorcycle', 'truck', 'bicycle'] as const;
export type VehicleType = (typeof vehicleTypes)[number];

export const agentCapabilities = [
  'parcel_delivery',
  'food_delivery',
  'document_delivery',
  'heavy_goods',
  'express_delivery',
] as const;
export type AgentCapability = (typeof agentCapabilities)[number];

const vehicleSchema = new Schema(
  {
    vehicleType: { type: String, enum: vehicleTypes, required: true, lowercase: true, trim: true },
    registrationNumber: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    manufacturer: { type: String, required: true, trim: true, maxlength: 60 },
    model: { type: String, required: true, trim: true, maxlength: 60 },
  },
  { _id: false },
);

const agentSchema = new Schema(
  {
    agentCode: { type: String, required: true, unique: true, immutable: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    passwordHash: { type: String, select: false },
    phone: { type: String, required: true, trim: true, maxlength: 24 },
    isActive: { type: Boolean, default: true, required: true },
    vehicle: { type: vehicleSchema, required: true },
    status: { type: String, enum: agentStatuses, default: 'available', required: true },
    capacity: {
      maxOrders: { type: Number, required: true, min: 1, max: 10_000 },
    },
    activeDispatchCount: { type: Number, required: true, min: 0, default: 0 },
    capabilities: {
      type: [{ type: String, enum: agentCapabilities }],
      default: [],
    },
  },
  { timestamps: true, optimisticConcurrency: true },
);

agentSchema.index({ 'vehicle.registrationNumber': 1 }, { unique: true });
agentSchema.index({ isActive: 1, status: 1, createdAt: -1 });
agentSchema.index({ isActive: 1, capabilities: 1 });

export const Agent = model('Agent', agentSchema);
