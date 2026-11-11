import { DispatchRequest } from '../models/DispatchRequest.js';
import { DispatchRequestActivity } from '../models/DispatchRequestActivity.js';
import { ProofOfDelivery } from '../models/ProofOfDelivery.js';

export type DeliveryDataQualitySummary = {
  totalCompletedDeliveries: number;
  deliveriesWithRequiredTimestamps: number;
  deliveriesWithValidChronology: number;
  deliveriesWithValidCoordinates: number;
  deliveriesWithVerifiedPod: number;
  excludedDeliveries: {
    totalExcluded: number;
    syntheticOrDemo: number;
    missingTimestamps: number;
    invalidChronology: number;
    missingOrInvalidCoordinates: number;
    unverifiedPod: number;
    duplicates: number;
  };
  totalEligibleGenuineRecords: number;
  qualityMetrics: {
    timestampCompletenessRate: number;
    chronologicalValidityRate: number;
    coordinateCoverageRate: number;
    podVerificationRate: number;
    genuineEligibilityRate: number;
  };
};

export type DeliveryRecordInput = {
  _id: unknown;
  status: string;
  createdAt: Date;
  assignedAt?: Date | null;
  pickedUpAt?: Date | null;
  inTransitAt?: Date | null;
  deliveredAt?: Date | null;
  assignedAgent?: unknown;
  pickup?: { latitude?: number | null; longitude?: number | null };
  delivery?: { latitude?: number | null; longitude?: number | null };
  isDemo?: boolean;
  isSynthetic?: boolean;
  dataSource?: string;
  data_source?: string;
  source?: string;
  provenance?: string;
  mode?: string;
};

export type PodRecordInput = {
  dispatchRequestId: unknown;
  otpVerified: boolean;
  photo?: { storageKey?: string; fileName?: string } | null;
  signature?: { storageKey?: string; fileName?: string } | null;
  deliveredAt?: Date;
};

export function isValidCoordinatePair(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function isSyntheticOrDemoRecord(record: Record<string, unknown>): boolean {
  if (record.isDemo === true || record.isSynthetic === true) {
    return true;
  }
  const provenanceFields = ['dataSource', 'data_source', 'source', 'provenance', 'mode'];
  for (const field of provenanceFields) {
    const val = record[field];
    if (typeof val === 'string') {
      const lower = val.trim().toLowerCase();
      if (
        lower === 'synthetic' ||
        lower === 'demo' ||
        lower.includes('synthetic') ||
        lower.includes('demo')
      ) {
        return true;
      }
    }
  }
  return false;
}

export function isValidChronology(timestamps: {
  createdAt: Date;
  assignedAt: Date;
  pickedUpAt: Date;
  inTransitAt?: Date | null;
  deliveredAt: Date;
}): boolean {
  const created = timestamps.createdAt.getTime();
  const assigned = timestamps.assignedAt.getTime();
  const pickedUp = timestamps.pickedUpAt.getTime();
  const delivered = timestamps.deliveredAt.getTime();

  if (![created, assigned, pickedUp, delivered].every(Number.isFinite)) {
    return false;
  }

  // Strict chronological order
  if (assigned < created) return false;
  if (pickedUp <= assigned) return false;
  if (delivered <= pickedUp) return false;
  if (delivered <= assigned) return false;

  if (timestamps.inTransitAt) {
    const inTransit = timestamps.inTransitAt.getTime();
    if (!Number.isFinite(inTransit)) return false;
    if (inTransit < pickedUp || inTransit > delivered) return false;
  }

  const durationMinutes = (delivered - assigned) / 60_000;
  return Number.isFinite(durationMinutes) && durationMinutes > 0;
}

export function evaluateDeliveriesQuality(
  deliveries: DeliveryRecordInput[],
  pods: PodRecordInput[],
  activities: { dispatchRequestId: unknown; eventType: string; createdAt: Date; newValue?: any }[] = [],
): DeliveryDataQualitySummary {
  const totalCompleted = deliveries.length;
  if (totalCompleted === 0) {
    return {
      totalCompletedDeliveries: 0,
      deliveriesWithRequiredTimestamps: 0,
      deliveriesWithValidChronology: 0,
      deliveriesWithValidCoordinates: 0,
      deliveriesWithVerifiedPod: 0,
      excludedDeliveries: {
        totalExcluded: 0,
        syntheticOrDemo: 0,
        missingTimestamps: 0,
        invalidChronology: 0,
        missingOrInvalidCoordinates: 0,
        unverifiedPod: 0,
        duplicates: 0,
      },
      totalEligibleGenuineRecords: 0,
      qualityMetrics: {
        timestampCompletenessRate: 0,
        chronologicalValidityRate: 0,
        coordinateCoverageRate: 0,
        podVerificationRate: 0,
        genuineEligibilityRate: 0,
      },
    };
  }

  // Index verified PODs by string ID
  const podMap = new Map<string, PodRecordInput>();
  for (const pod of pods) {
    const id = String(pod.dispatchRequestId);
    const isVerified =
      Boolean(pod.otpVerified) &&
      Boolean(pod.photo?.storageKey) &&
      Boolean(pod.signature?.storageKey) &&
      pod.deliveredAt instanceof Date &&
      Number.isFinite(pod.deliveredAt.getTime());
    if (isVerified) {
      podMap.set(id, pod);
    }
  }

  // Index fallback activities by dispatchRequestId
  const activityMap = new Map<string, { assignedAt?: Date; pickedUpAt?: Date; inTransitAt?: Date; deliveredAt?: Date }>();
  for (const act of activities) {
    const id = String(act.dispatchRequestId);
    const entry = activityMap.get(id) ?? {};
    if (act.eventType === 'assignment_changed') {
      entry.assignedAt = act.createdAt;
    } else if (act.eventType === 'status_changed') {
      const status = act.newValue?.status;
      if (status === 'picked_up') entry.pickedUpAt = act.createdAt;
      if (status === 'in_transit') entry.inTransitAt = act.createdAt;
      if (status === 'delivered') entry.deliveredAt = act.createdAt;
    }
    activityMap.set(id, entry);
  }

  let withRequiredTimestamps = 0;
  let withValidChronology = 0;
  let withValidCoordinates = 0;
  let withVerifiedPod = 0;

  let syntheticOrDemoCount = 0;
  let missingTimestampsCount = 0;
  let invalidChronologyCount = 0;
  let missingOrInvalidCoordinatesCount = 0;
  let unverifiedPodCount = 0;
  let duplicateCount = 0;

  const seenIds = new Set<string>();
  let eligibleCount = 0;

  for (const delivery of deliveries) {
    const id = String(delivery._id);
    let isExcluded = false;

    // 1. Check duplicate
    if (seenIds.has(id)) {
      duplicateCount += 1;
      isExcluded = true;
    }
    seenIds.add(id);

    // 2. Check synthetic/demo provenance
    const isSynthetic = isSyntheticOrDemoRecord(delivery as Record<string, unknown>);
    if (isSynthetic) {
      syntheticOrDemoCount += 1;
      isExcluded = true;
    }

    // 3. Resolve timestamps (from document, fallback to activity log or POD)
    const fallback = activityMap.get(id);
    const createdAt = delivery.createdAt instanceof Date ? delivery.createdAt : new Date(delivery.createdAt);
    const assignedAt = delivery.assignedAt instanceof Date ? delivery.assignedAt : fallback?.assignedAt;
    const pickedUpAt = delivery.pickedUpAt instanceof Date ? delivery.pickedUpAt : fallback?.pickedUpAt;
    const inTransitAt = delivery.inTransitAt instanceof Date ? delivery.inTransitAt : fallback?.inTransitAt;
    const pod = podMap.get(id);
    const deliveredAt = delivery.deliveredAt instanceof Date ? delivery.deliveredAt : (pod?.deliveredAt || fallback?.deliveredAt);

    const hasTimestamps = Boolean(
      createdAt &&
      Number.isFinite(createdAt.getTime()) &&
      assignedAt &&
      Number.isFinite(assignedAt.getTime()) &&
      pickedUpAt &&
      Number.isFinite(pickedUpAt.getTime()) &&
      deliveredAt &&
      Number.isFinite(deliveredAt.getTime()),
    );

    if (hasTimestamps) {
      withRequiredTimestamps += 1;
    } else {
      missingTimestampsCount += 1;
      isExcluded = true;
    }

    // 4. Check chronology
    const chronologyValid = hasTimestamps && isValidChronology({
      createdAt,
      assignedAt: assignedAt!,
      pickedUpAt: pickedUpAt!,
      inTransitAt: inTransitAt ?? null,
      deliveredAt: deliveredAt!,
    });

    if (chronologyValid) {
      withValidChronology += 1;
    } else if (hasTimestamps) {
      invalidChronologyCount += 1;
      isExcluded = true;
    }

    // 5. Check coordinates
    const coordinatesValid =
      isValidCoordinatePair(delivery.pickup?.latitude, delivery.pickup?.longitude) &&
      isValidCoordinatePair(delivery.delivery?.latitude, delivery.delivery?.longitude);

    if (coordinatesValid) {
      withValidCoordinates += 1;
    } else {
      missingOrInvalidCoordinatesCount += 1;
      isExcluded = true;
    }

    // 6. Check verified POD
    if (pod) {
      withVerifiedPod += 1;
    } else {
      unverifiedPodCount += 1;
      isExcluded = true;
    }

    // Eligible if not excluded by any rule
    if (!isExcluded) {
      eligibleCount += 1;
    }
  }

  const totalExcluded = totalCompleted - eligibleCount;

  return {
    totalCompletedDeliveries: totalCompleted,
    deliveriesWithRequiredTimestamps: withRequiredTimestamps,
    deliveriesWithValidChronology: withValidChronology,
    deliveriesWithValidCoordinates: withValidCoordinates,
    deliveriesWithVerifiedPod: withVerifiedPod,
    excludedDeliveries: {
      totalExcluded,
      syntheticOrDemo: syntheticOrDemoCount,
      missingTimestamps: missingTimestampsCount,
      invalidChronology: invalidChronologyCount,
      missingOrInvalidCoordinates: missingOrInvalidCoordinatesCount,
      unverifiedPod: unverifiedPodCount,
      duplicates: duplicateCount,
    },
    totalEligibleGenuineRecords: eligibleCount,
    qualityMetrics: {
      timestampCompletenessRate: Number((withRequiredTimestamps / totalCompleted).toFixed(4)),
      chronologicalValidityRate: Number((withValidChronology / totalCompleted).toFixed(4)),
      coordinateCoverageRate: Number((withValidCoordinates / totalCompleted).toFixed(4)),
      podVerificationRate: Number((withVerifiedPod / totalCompleted).toFixed(4)),
      genuineEligibilityRate: Number((eligibleCount / totalCompleted).toFixed(4)),
    },
  };
}

/**
 * Execute a read-only database query to compute the delivery data quality summary.
 */
export async function getDeliveryDataQualitySummary(): Promise<DeliveryDataQualitySummary> {
  const completedDeliveries = (await DispatchRequest.find({ status: 'delivered' })
    .select(
      '_id status createdAt assignedAt pickedUpAt inTransitAt deliveredAt assignedAgent pickup delivery isDemo isSynthetic dataSource data_source source provenance mode'
    )
    .lean()) as DeliveryRecordInput[];

  if (completedDeliveries.length === 0) {
    return evaluateDeliveriesQuality([], []);
  }

  const dispatchIds = completedDeliveries.map((d) => d._id);

  const pods = (await (ProofOfDelivery as any)
    .find({ dispatchRequestId: { $in: dispatchIds } })
    .select('dispatchRequestId otpVerified photo signature deliveredAt')
    .lean()) as PodRecordInput[];

  // For any deliveries with missing timestamps on the DispatchRequest doc, query fallback activities
  const idsWithMissingTimestamps = completedDeliveries
    .filter((d) => !d.assignedAt || !d.pickedUpAt || !d.deliveredAt)
    .map((d) => d._id);

  let activities: { dispatchRequestId: unknown; eventType: string; createdAt: Date; newValue?: any }[] = [];
  if (idsWithMissingTimestamps.length > 0) {
    activities = (await (DispatchRequestActivity as any)
      .find({
        dispatchRequestId: { $in: idsWithMissingTimestamps },
        eventType: { $in: ['assignment_changed', 'status_changed'] },
      })
      .select('dispatchRequestId eventType createdAt newValue')
      .lean()) as any[];
  }

  return evaluateDeliveriesQuality(completedDeliveries, pods, activities);
}
