import { describe, expect, it, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import {
  evaluateDeliveriesQuality,
  getDeliveryDataQualitySummary,
  isSyntheticOrDemoRecord,
  isValidChronology,
  isValidCoordinatePair,
  type DeliveryRecordInput,
  type PodRecordInput,
} from '../src/services/deliveryQualityService.js';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { ProofOfDelivery } from '../src/models/ProofOfDelivery.js';
import { DispatchRequestActivity } from '../src/models/DispatchRequestActivity.js';

describe('Delivery Data Quality Summary Service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const baseDelivery: DeliveryRecordInput = {
    _id: new mongoose.Types.ObjectId(),
    status: 'delivered',
    createdAt: new Date('2026-11-11T10:00:00.000Z'),
    assignedAt: new Date('2026-11-11T10:05:00.000Z'),
    pickedUpAt: new Date('2026-11-11T10:15:00.000Z'),
    inTransitAt: new Date('2026-11-11T10:20:00.000Z'),
    deliveredAt: new Date('2026-11-11T10:45:00.000Z'),
    pickup: { latitude: 12.9716, longitude: 77.5946 },
    delivery: { latitude: 13.0827, longitude: 80.2707 },
  };

  const validPod: PodRecordInput = {
    dispatchRequestId: baseDelivery._id,
    otpVerified: true,
    photo: { storageKey: 'pod/photo1.png', fileName: 'photo1.png' },
    signature: { storageKey: 'pod/sig1.png', fileName: 'sig1.png' },
    deliveredAt: new Date('2026-11-11T10:45:00.000Z'),
  };

  describe('Validation Helpers', () => {
    it('validates coordinate pairs correctly', () => {
      expect(isValidCoordinatePair(12.97, 77.59)).toBe(true);
      expect(isValidCoordinatePair(0, 0)).toBe(true);
      expect(isValidCoordinatePair(-90, -180)).toBe(true);
      expect(isValidCoordinatePair(90, 180)).toBe(true);

      expect(isValidCoordinatePair(91, 77.59)).toBe(false);
      expect(isValidCoordinatePair(12.97, 181)).toBe(false);
      expect(isValidCoordinatePair(null, 77.59)).toBe(false);
      expect(isValidCoordinatePair(12.97, undefined)).toBe(false);
      expect(isValidCoordinatePair('12.97', 77.59)).toBe(false);
      expect(isValidCoordinatePair(NaN, 77.59)).toBe(false);
      expect(isValidCoordinatePair(Infinity, 77.59)).toBe(false);
    });

    it('identifies synthetic and demo records from various markers', () => {
      expect(isSyntheticOrDemoRecord({ isDemo: true })).toBe(true);
      expect(isSyntheticOrDemoRecord({ isSynthetic: true })).toBe(true);
      expect(isSyntheticOrDemoRecord({ dataSource: 'synthetic_generator' })).toBe(true);
      expect(isSyntheticOrDemoRecord({ source: 'demo_seed' })).toBe(true);
      expect(isSyntheticOrDemoRecord({ provenance: 'synthetic' })).toBe(true);
      expect(isSyntheticOrDemoRecord({ mode: 'demo' })).toBe(true);

      expect(isSyntheticOrDemoRecord({})).toBe(false);
      expect(isSyntheticOrDemoRecord({ source: 'operational' })).toBe(false);
      expect(isSyntheticOrDemoRecord({ dataSource: 'production' })).toBe(false);
    });

    it('validates strict chronological order', () => {
      expect(
        isValidChronology({
          createdAt: new Date('2026-11-11T10:00:00Z'),
          assignedAt: new Date('2026-11-11T10:05:00Z'),
          pickedUpAt: new Date('2026-11-11T10:15:00Z'),
          inTransitAt: new Date('2026-11-11T10:20:00Z'),
          deliveredAt: new Date('2026-11-11T10:45:00Z'),
        }),
      ).toBe(true);

      // Inverted assignment before creation
      expect(
        isValidChronology({
          createdAt: new Date('2026-11-11T10:05:00Z'),
          assignedAt: new Date('2026-11-11T10:00:00Z'),
          pickedUpAt: new Date('2026-11-11T10:15:00Z'),
          deliveredAt: new Date('2026-11-11T10:45:00Z'),
        }),
      ).toBe(false);

      // Inverted pickup before assignment
      expect(
        isValidChronology({
          createdAt: new Date('2026-11-11T10:00:00Z'),
          assignedAt: new Date('2026-11-11T10:20:00Z'),
          pickedUpAt: new Date('2026-11-11T10:15:00Z'),
          deliveredAt: new Date('2026-11-11T10:45:00Z'),
        }),
      ).toBe(false);

      // Delivered before picked up
      expect(
        isValidChronology({
          createdAt: new Date('2026-11-11T10:00:00Z'),
          assignedAt: new Date('2026-11-11T10:05:00Z'),
          pickedUpAt: new Date('2026-11-11T10:45:00Z'),
          deliveredAt: new Date('2026-11-11T10:15:00Z'),
        }),
      ).toBe(false);
    });
  });

  describe('evaluateDeliveriesQuality Summary Aggregation', () => {
    it('evaluates completely valid operational deliveries', () => {
      const summary = evaluateDeliveriesQuality([baseDelivery], [validPod]);

      expect(summary.totalCompletedDeliveries).toBe(1);
      expect(summary.deliveriesWithRequiredTimestamps).toBe(1);
      expect(summary.deliveriesWithValidChronology).toBe(1);
      expect(summary.deliveriesWithValidCoordinates).toBe(1);
      expect(summary.deliveriesWithVerifiedPod).toBe(1);
      expect(summary.totalEligibleGenuineRecords).toBe(1);
      expect(summary.excludedDeliveries.totalExcluded).toBe(0);
      expect(summary.qualityMetrics.genuineEligibilityRate).toBe(1.0);
    });

    it('excludes synthetic or demo records from genuine eligible records', () => {
      const syntheticDelivery: DeliveryRecordInput = {
        ...baseDelivery,
        _id: new mongoose.Types.ObjectId(),
        isSynthetic: true,
      };
      const pod: PodRecordInput = { ...validPod, dispatchRequestId: syntheticDelivery._id };

      const summary = evaluateDeliveriesQuality([syntheticDelivery], [pod]);

      expect(summary.totalCompletedDeliveries).toBe(1);
      expect(summary.deliveriesWithRequiredTimestamps).toBe(1);
      expect(summary.deliveriesWithValidCoordinates).toBe(1);
      expect(summary.excludedDeliveries.syntheticOrDemo).toBe(1);
      expect(summary.excludedDeliveries.totalExcluded).toBe(1);
      expect(summary.totalEligibleGenuineRecords).toBe(0);
    });

    it('detects missing timestamps and excludes record', () => {
      const missingTimeDelivery: DeliveryRecordInput = {
        ...baseDelivery,
        _id: new mongoose.Types.ObjectId(),
        assignedAt: null,
      };
      const pod: PodRecordInput = { ...validPod, dispatchRequestId: missingTimeDelivery._id };

      const summary = evaluateDeliveriesQuality([missingTimeDelivery], [pod]);

      expect(summary.deliveriesWithRequiredTimestamps).toBe(0);
      expect(summary.excludedDeliveries.missingTimestamps).toBe(1);
      expect(summary.totalEligibleGenuineRecords).toBe(0);
    });

    it('detects invalid chronology and excludes record', () => {
      const invertedDelivery: DeliveryRecordInput = {
        ...baseDelivery,
        _id: new mongoose.Types.ObjectId(),
        // Delivered timestamp is earlier than assignedAt
        deliveredAt: new Date('2026-11-11T10:01:00.000Z'),
      };
      const pod: PodRecordInput = {
        ...validPod,
        dispatchRequestId: invertedDelivery._id,
        deliveredAt: invertedDelivery.deliveredAt!,
      };

      const summary = evaluateDeliveriesQuality([invertedDelivery], [pod]);

      expect(summary.deliveriesWithRequiredTimestamps).toBe(1);
      expect(summary.deliveriesWithValidChronology).toBe(0);
      expect(summary.excludedDeliveries.invalidChronology).toBe(1);
      expect(summary.totalEligibleGenuineRecords).toBe(0);
    });

    it('detects missing or invalid coordinates', () => {
      const noCoordsDelivery: DeliveryRecordInput = {
        ...baseDelivery,
        _id: new mongoose.Types.ObjectId(),
        pickup: { latitude: null, longitude: null },
      };
      const pod: PodRecordInput = { ...validPod, dispatchRequestId: noCoordsDelivery._id };

      const summary = evaluateDeliveriesQuality([noCoordsDelivery], [pod]);

      expect(summary.deliveriesWithValidCoordinates).toBe(0);
      expect(summary.excludedDeliveries.missingOrInvalidCoordinates).toBe(1);
      expect(summary.totalEligibleGenuineRecords).toBe(0);
    });

    it('detects unverified or missing proof of delivery', () => {
      const unverifiedDelivery: DeliveryRecordInput = {
        ...baseDelivery,
        _id: new mongoose.Types.ObjectId(),
      };
      // POD missing photo or OTP not verified
      const unverifiedPod: PodRecordInput = {
        dispatchRequestId: unverifiedDelivery._id,
        otpVerified: false,
        photo: null,
        signature: null,
      };

      const summary = evaluateDeliveriesQuality([unverifiedDelivery], [unverifiedPod]);

      expect(summary.deliveriesWithVerifiedPod).toBe(0);
      expect(summary.excludedDeliveries.unverifiedPod).toBe(1);
      expect(summary.totalEligibleGenuineRecords).toBe(0);
    });

    it('detects duplicates among completed records', () => {
      const sharedId = new mongoose.Types.ObjectId();
      const delivery1 = { ...baseDelivery, _id: sharedId };
      const delivery2 = { ...baseDelivery, _id: sharedId };
      const pod = { ...validPod, dispatchRequestId: sharedId };

      const summary = evaluateDeliveriesQuality([delivery1, delivery2], [pod]);

      expect(summary.totalCompletedDeliveries).toBe(2);
      expect(summary.totalEligibleGenuineRecords).toBe(1);
      expect(summary.excludedDeliveries.duplicates).toBe(1);
      expect(summary.excludedDeliveries.totalExcluded).toBe(1);
    });

    it('resolves legacy timestamps from DispatchRequestActivity when document timestamps are null', () => {
      const legacyDelivery: DeliveryRecordInput = {
        ...baseDelivery,
        _id: new mongoose.Types.ObjectId(),
        assignedAt: null,
        pickedUpAt: null,
      };
      const pod: PodRecordInput = { ...validPod, dispatchRequestId: legacyDelivery._id };

      const activities = [
        {
          dispatchRequestId: legacyDelivery._id,
          eventType: 'assignment_changed',
          createdAt: new Date('2026-11-11T10:05:00.000Z'),
        },
        {
          dispatchRequestId: legacyDelivery._id,
          eventType: 'status_changed',
          newValue: { status: 'picked_up' },
          createdAt: new Date('2026-11-11T10:15:00.000Z'),
        },
      ];

      const summary = evaluateDeliveriesQuality([legacyDelivery], [pod], activities);

      expect(summary.deliveriesWithRequiredTimestamps).toBe(1);
      expect(summary.deliveriesWithValidChronology).toBe(1);
      expect(summary.totalEligibleGenuineRecords).toBe(1);
    });

    it('handles empty datasets cleanly without division by zero', () => {
      const summary = evaluateDeliveriesQuality([], []);

      expect(summary.totalCompletedDeliveries).toBe(0);
      expect(summary.totalEligibleGenuineRecords).toBe(0);
      expect(summary.qualityMetrics.genuineEligibilityRate).toBe(0);
      expect(summary.qualityMetrics.timestampCompletenessRate).toBe(0);
    });
  });

  describe('Database Query Integration (getDeliveryDataQualitySummary)', () => {
    it('executes read-only aggregation queries against Mongoose models', async () => {
      const deliveryDoc = { ...baseDelivery };
      const podDoc = { ...validPod };

      const mockFindDispatch = {
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([deliveryDoc]),
      };
      vi.spyOn(DispatchRequest, 'find').mockReturnValue(mockFindDispatch as any);

      const mockFindPod = {
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([podDoc]),
      };
      vi.spyOn(ProofOfDelivery, 'find').mockReturnValue(mockFindPod as any);

      const summary = await getDeliveryDataQualitySummary();

      expect(DispatchRequest.find).toHaveBeenCalledWith({ status: 'delivered' });
      expect(ProofOfDelivery.find).toHaveBeenCalledWith({
        dispatchRequestId: { $in: [deliveryDoc._id] },
      });
      expect(summary.totalCompletedDeliveries).toBe(1);
      expect(summary.totalEligibleGenuineRecords).toBe(1);
    });

    it('returns zeroes when no completed deliveries exist', async () => {
      const mockFindDispatch = {
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      };
      vi.spyOn(DispatchRequest, 'find').mockReturnValue(mockFindDispatch as any);

      const summary = await getDeliveryDataQualitySummary();

      expect(summary.totalCompletedDeliveries).toBe(0);
      expect(summary.totalEligibleGenuineRecords).toBe(0);
    });
  });
});
