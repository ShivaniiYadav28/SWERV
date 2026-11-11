import { Schema, model } from 'mongoose';

export const dispatchPriorities = ['standard', 'express', 'urgent'] as const;
export type DispatchPriority = (typeof dispatchPriorities)[number];

export const dispatchRequestStatuses = [
  'pending',
  'assigned',
  'picked_up',
  'in_transit',
  'delivered',
  'cancelled',
  'failed',
] as const;
export type DispatchRequestStatus = (typeof dispatchRequestStatuses)[number];

export const packageCategories = [
  'documents',
  'parcel',
  'food',
  'fragile',
  'heavy_goods',
  'other',
] as const;
export type PackageCategory = (typeof packageCategories)[number];

const contactSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      match: /^\S+@\S+\.\S+$/,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      minlength: 7,
      maxlength: 24,
      match: /^\+?[0-9().\s-]+$/,
    },
  },
  { _id: false },
);

const locationSchema = new Schema(
  {
    address: { type: String, required: true, trim: true, minlength: 1, maxlength: 240 },
    addressLine2: { type: String, trim: true, maxlength: 160 },
    city: { type: String, required: true, trim: true, maxlength: 80 },
    region: { type: String, required: true, trim: true, maxlength: 80 },
    postalCode: { type: String, required: true, trim: true, maxlength: 20 },
    country: { type: String, required: true, trim: true, maxlength: 80 },
    instructions: { type: String, trim: true, maxlength: 300 },
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
  },
  { _id: false },
);

const packageSchema = new Schema(
  {
    description: { type: String, required: true, trim: true, minlength: 2, maxlength: 240 },
    category: { type: String, enum: packageCategories, required: true },
    weightKg: { type: Number, required: true, min: 0.01, max: 10_000 },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: 1_000,
      validate: {
        validator: Number.isInteger,
        message: 'Quantity must be a whole number.',
      },
    },
  },
  { _id: false },
);

const dispatchRequestSchema = new Schema(
  {
    customer: { type: contactSchema, required: false },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    pickup: { type: locationSchema, required: true },
    delivery: { type: locationSchema, required: true },
    package: { type: packageSchema, required: true },
    priority: { type: String, enum: dispatchPriorities, default: 'standard', required: true },
    status: { type: String, enum: dispatchRequestStatuses, default: 'pending', required: true },
    assignedAgent: { type: Schema.Types.ObjectId, ref: 'Agent', default: null },
    assignedAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    inTransitAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    actualDurationMinutes: { type: Number, default: null, min: 0 },
  },
  { timestamps: true, optimisticConcurrency: true },
);

dispatchRequestSchema.index({ status: 1, createdAt: -1 });
dispatchRequestSchema.index({ priority: 1, createdAt: -1 });
dispatchRequestSchema.index({ assignedAgent: 1, status: 1 });
dispatchRequestSchema.index({ customerId: 1, createdAt: -1 });

export const DispatchRequest = model('DispatchRequest', dispatchRequestSchema);
