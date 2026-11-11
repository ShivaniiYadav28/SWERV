import { describe, expect, it, vi, beforeEach } from 'vitest';
import mongoose, { type ClientSession } from 'mongoose';
import { DispatchRequest } from '../src/models/DispatchRequest.js';
import { Agent } from '../src/models/Agent.js';
import { DispatchRequestActivity } from '../src/models/DispatchRequestActivity.js';
import { ProofOfDelivery, ProofOfDeliveryDraft } from '../src/models/ProofOfDelivery.js';
import { assignDispatchRequest, changeAgentDeliveryStatus } from '../src/services/dispatchRequestService.js';
import { submitProofOfDelivery } from '../src/services/proofOfDeliveryService.js';
import * as notificationService from '../src/services/notificationService.js';
import { HttpError } from '../src/utils/httpError.js';

describe('Delivery Lifecycle Timestamps Regression Tests', () => {
  const mockSession = {
    withTransaction: async (fn: () => Promise<void>) => {
      await fn();
    },
    endSession: vi.fn(),
  } as unknown as ClientSession;

  const validLocation = {
    address: '10 Test Street',
    city: 'Bengaluru',
    region: 'KA',
    postalCode: '560001',
    country: 'India',
    latitude: 12.9716,
    longitude: 77.5946,
  };

  const validPackage = {
    description: 'Electronics box',
    category: 'parcel',
    weightKg: 2.5,
    quantity: 1,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(mockSession);
    vi.spyOn(DispatchRequestActivity, 'create').mockResolvedValue([] as any);
    vi.spyOn(notificationService, 'createUserNotifications').mockResolvedValue([] as any);
    vi.spyOn(notificationService, 'createAgentNotification').mockResolvedValue({} as any);
  });

  describe('DispatchRequest Schema Default & Validation', () => {
    it('defaults all lifecycle timestamps and duration to null', () => {
      const doc = new DispatchRequest({
        pickup: validLocation,
        delivery: validLocation,
        package: validPackage,
        priority: 'standard',
        status: 'pending',
      });

      expect(doc.assignedAt).toBeNull();
      expect(doc.pickedUpAt).toBeNull();
      expect(doc.inTransitAt).toBeNull();
      expect(doc.deliveredAt).toBeNull();
      expect(doc.actualDurationMinutes).toBeNull();
    });

    it('rejects negative actualDurationMinutes per schema constraints', async () => {
      const doc = new DispatchRequest({
        pickup: validLocation,
        delivery: validLocation,
        package: validPackage,
        priority: 'standard',
        status: 'delivered',
        actualDurationMinutes: -5.0,
      });

      await expect(doc.validate()).rejects.toMatchObject({
        errors: {
          actualDurationMinutes: expect.anything(),
        },
      });
    });

    it('accepts valid timestamps and non-negative duration', async () => {
      const doc = new DispatchRequest({
        pickup: validLocation,
        delivery: validLocation,
        package: validPackage,
        priority: 'standard',
        status: 'delivered',
        assignedAt: new Date('2026-11-11T10:00:00.000Z'),
        pickedUpAt: new Date('2026-11-11T10:15:00.000Z'),
        inTransitAt: new Date('2026-11-11T10:20:00.000Z'),
        deliveredAt: new Date('2026-11-11T10:45:00.000Z'),
        actualDurationMinutes: 45.0,
      });

      await expect(doc.validate()).resolves.toBeUndefined();
    });
  });

  describe('Agent Assignment (assignedAt)', () => {
    it('1. Initial agent assignment records assignedAt with server-side timestamp', async () => {
      const dispatchId = new mongoose.Types.ObjectId().toString();
      const agentId = new mongoose.Types.ObjectId().toString();
      const adminId = new mongoose.Types.ObjectId().toString();

      const mockDispatch = new DispatchRequest({
        _id: dispatchId,
        pickup: validLocation,
        delivery: validLocation,
        package: validPackage,
        priority: 'standard',
        status: 'pending',
        assignedAgent: null,
        assignedAt: null,
      });
      mockDispatch.save = vi.fn().mockResolvedValue(mockDispatch);

      const mockCandidate = {
        _id: new mongoose.Types.ObjectId(agentId),
        id: agentId,
        isActive: true,
        status: 'available',
        capabilities: ['parcel_delivery'],
        agentCode: 'AGT-001',
      };

      vi.spyOn(DispatchRequest, 'findById').mockReturnValue({
        session: vi.fn().mockResolvedValue(mockDispatch),
      } as any);

      vi.spyOn(Agent, 'findById').mockReturnValue({
        session: vi.fn().mockResolvedValue(mockCandidate),
      } as any);

      vi.spyOn(Agent, 'findOneAndUpdate').mockResolvedValue(mockCandidate as any);

      const before = Date.now();
      const result = await assignDispatchRequest(dispatchId, agentId, adminId);
      const after = Date.now();

      expect(result.dispatchRequest.status).toBe('assigned');
      expect(result.dispatchRequest.assignedAgent?.toString()).toBe(agentId);
      expect(result.dispatchRequest.assignedAt).toBeInstanceOf(Date);
      expect(result.dispatchRequest.assignedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.dispatchRequest.assignedAt!.getTime()).toBeLessThanOrEqual(after);
      expect(mockDispatch.save).toHaveBeenCalled();
    });

    it('2. Reassignment updates assignedAt to latest assignment timestamp', async () => {
      const dispatchId = new mongoose.Types.ObjectId().toString();
      const initialAgentId = new mongoose.Types.ObjectId().toString();
      const newAgentId = new mongoose.Types.ObjectId().toString();
      const adminId = new mongoose.Types.ObjectId().toString();

      const initialAssignedAt = new Date(Date.now() - 3600_000); // 1 hour ago
      const mockDispatch = new DispatchRequest({
        _id: dispatchId,
        pickup: validLocation,
        delivery: validLocation,
        package: validPackage,
        priority: 'standard',
        status: 'assigned',
        assignedAgent: new mongoose.Types.ObjectId(initialAgentId),
        assignedAt: initialAssignedAt,
      });
      mockDispatch.save = vi.fn().mockResolvedValue(mockDispatch);

      const mockNewAgent = {
        _id: new mongoose.Types.ObjectId(newAgentId),
        id: newAgentId,
        isActive: true,
        status: 'available',
        capabilities: ['parcel_delivery'],
        agentCode: 'AGT-002',
      };

      vi.spyOn(DispatchRequest, 'findById').mockReturnValue({
        session: vi.fn().mockResolvedValue(mockDispatch),
      } as any);

      vi.spyOn(Agent, 'findById').mockReturnValue({
        session: vi.fn().mockResolvedValue(mockNewAgent),
      } as any);

      vi.spyOn(Agent, 'findOneAndUpdate').mockResolvedValue(mockNewAgent as any);
      vi.spyOn(Agent, 'updateOne').mockResolvedValue({ acknowledged: true, modifiedCount: 1 } as any);

      const result = await assignDispatchRequest(dispatchId, newAgentId, adminId);

      expect(result.previousAgentId).toBe(initialAgentId);
      expect(result.dispatchRequest.assignedAgent?.toString()).toBe(newAgentId);
      expect(result.dispatchRequest.assignedAt).toBeInstanceOf(Date);
      expect(result.dispatchRequest.assignedAt!.getTime()).toBeGreaterThan(initialAssignedAt.getTime());
    });
  });

  describe('Delivery Milestone Timestamps (pickedUpAt, inTransitAt)', () => {
    it('3. First picked_up transition records pickedUpAt', async () => {
      const dispatchId = new mongoose.Types.ObjectId().toString();
      const agentId = new mongoose.Types.ObjectId().toString();

      const mockDispatch = new DispatchRequest({
        _id: dispatchId,
        pickup: validLocation,
        delivery: validLocation,
        package: validPackage,
        priority: 'standard',
        status: 'assigned',
        assignedAgent: new mongoose.Types.ObjectId(agentId),
        pickedUpAt: null,
      });
      mockDispatch.save = vi.fn().mockResolvedValue(mockDispatch);

      vi.spyOn(DispatchRequest, 'findOne').mockReturnValue({
        session: vi.fn().mockResolvedValue(mockDispatch),
      } as any);

      const before = Date.now();
      const result = await changeAgentDeliveryStatus(agentId, dispatchId, 'picked_up');
      const after = Date.now();

      expect(result.dispatchRequest.status).toBe('picked_up');
      expect(result.dispatchRequest.pickedUpAt).toBeInstanceOf(Date);
      expect(result.dispatchRequest.pickedUpAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.dispatchRequest.pickedUpAt!.getTime()).toBeLessThanOrEqual(after);
      expect(mockDispatch.save).toHaveBeenCalled();
    });

    it('4. First in_transit transition records inTransitAt', async () => {
      const dispatchId = new mongoose.Types.ObjectId().toString();
      const agentId = new mongoose.Types.ObjectId().toString();
      const pickedUpTime = new Date(Date.now() - 300_000);

      const mockDispatch = new DispatchRequest({
        _id: dispatchId,
        pickup: validLocation,
        delivery: validLocation,
        package: validPackage,
        priority: 'standard',
        status: 'picked_up',
        assignedAgent: new mongoose.Types.ObjectId(agentId),
        pickedUpAt: pickedUpTime,
        inTransitAt: null,
      });
      mockDispatch.save = vi.fn().mockResolvedValue(mockDispatch);

      vi.spyOn(DispatchRequest, 'findOne').mockReturnValue({
        session: vi.fn().mockResolvedValue(mockDispatch),
      } as any);

      const before = Date.now();
      const result = await changeAgentDeliveryStatus(agentId, dispatchId, 'in_transit');
      const after = Date.now();

      expect(result.dispatchRequest.status).toBe('in_transit');
      expect(result.dispatchRequest.pickedUpAt?.toISOString()).toBe(pickedUpTime.toISOString());
      expect(result.dispatchRequest.inTransitAt).toBeInstanceOf(Date);
      expect(result.dispatchRequest.inTransitAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.dispatchRequest.inTransitAt!.getTime()).toBeLessThanOrEqual(after);
    });

    it('5. Repeated status updates do not overwrite milestone timestamps', async () => {
      const dispatchId = new mongoose.Types.ObjectId().toString();
      const agentId = new mongoose.Types.ObjectId().toString();
      const existingPickedUpAt = new Date('2026-11-11T09:30:00.000Z');
      const existingInTransitAt = new Date('2026-11-11T09:40:00.000Z');

      const mockDispatch = new DispatchRequest({
        _id: dispatchId,
        pickup: validLocation,
        delivery: validLocation,
        package: validPackage,
        priority: 'standard',
        status: 'picked_up',
        assignedAgent: new mongoose.Types.ObjectId(agentId),
        pickedUpAt: existingPickedUpAt,
        inTransitAt: existingInTransitAt,
      });
      mockDispatch.save = vi.fn().mockResolvedValue(mockDispatch);

      vi.spyOn(DispatchRequest, 'findOne').mockReturnValue({
        session: vi.fn().mockResolvedValue(mockDispatch),
      } as any);

      // Transition to in_transit when inTransitAt is already populated
      const result = await changeAgentDeliveryStatus(agentId, dispatchId, 'in_transit');

      expect(result.dispatchRequest.pickedUpAt?.toISOString()).toBe(existingPickedUpAt.toISOString());
      expect(result.dispatchRequest.inTransitAt?.toISOString()).toBe(existingInTransitAt.toISOString());
    });
  });

  describe('Proof of Delivery Completion & Duration (deliveredAt, actualDurationMinutes)', () => {
    const photoEvidence = {
      storageKey: 'pod/photo-test-123.png',
      fileName: 'photo.png',
      contentType: 'image/png',
      storageProvider: 's3' as const,
    };
    const signatureEvidence = {
      storageKey: 'pod/signature-test-123.png',
      fileName: 'signature.png',
      contentType: 'image/png',
      storageProvider: 's3' as const,
    };

    function setupPodMocks(options: {
      dispatchStatus?: string;
      assignedAt?: Date | null;
      podExists?: boolean;
      hasDraft?: boolean;
      draftVerified?: boolean;
    }) {
      const dispatchId = new mongoose.Types.ObjectId().toString();
      const agentId = new mongoose.Types.ObjectId().toString();

      const mockDispatch = new DispatchRequest({
        _id: dispatchId,
        pickup: validLocation,
        delivery: validLocation,
        package: validPackage,
        priority: 'standard',
        status: options.dispatchStatus ?? 'in_transit',
        assignedAgent: new mongoose.Types.ObjectId(agentId),
        assignedAt: options.assignedAt !== undefined ? options.assignedAt : new Date(Date.now() - 30 * 60_000),
        pickedUpAt: new Date(Date.now() - 25 * 60_000),
        inTransitAt: new Date(Date.now() - 20 * 60_000),
        deliveredAt: null,
        actualDurationMinutes: null,
      });
      mockDispatch.save = vi.fn().mockResolvedValue(mockDispatch);

      vi.spyOn(DispatchRequest, 'findOne').mockReturnValue({
        session: vi.fn().mockResolvedValue(mockDispatch),
      } as any);

      vi.spyOn(ProofOfDelivery, 'exists').mockReturnValue({
        session: vi.fn().mockResolvedValue(options.podExists ? { _id: new mongoose.Types.ObjectId() } : null),
      } as any);

      const mockDraft = options.hasDraft === false ? null : {
        _id: new mongoose.Types.ObjectId(),
        photo: photoEvidence,
        signature: signatureEvidence,
        otpVerifiedAt: options.draftVerified === false ? null : new Date(),
      };

      vi.spyOn(ProofOfDeliveryDraft, 'findOne').mockReturnValue({
        session: vi.fn().mockResolvedValue(mockDraft),
      } as any);

      vi.spyOn(ProofOfDelivery.prototype, 'save').mockResolvedValue({} as any);
      vi.spyOn(ProofOfDeliveryDraft, 'deleteOne').mockResolvedValue({ acknowledged: true, deletedCount: 1 } as any);
      vi.spyOn(Agent, 'updateOne').mockResolvedValue({ acknowledged: true, modifiedCount: 1 } as any);

      return { dispatchId, agentId, mockDispatch };
    }

    it('6. Successful POD submission records deliveredAt matching POD timestamp', async () => {
      const { dispatchId, agentId, mockDispatch } = setupPodMocks({});

      const before = Date.now();
      const result = await submitProofOfDelivery(agentId, dispatchId, { latitude: 12.97, longitude: 77.59 });
      const after = Date.now();

      expect(mockDispatch.status).toBe('delivered');
      expect(mockDispatch.deliveredAt).toBeInstanceOf(Date);
      expect(mockDispatch.deliveredAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(mockDispatch.deliveredAt!.getTime()).toBeLessThanOrEqual(after);
      expect(result.pod.deliveredAt.toISOString()).toBe(mockDispatch.deliveredAt!.toISOString());
      expect(mockDispatch.save).toHaveBeenCalled();
    });

    it('7. actualDurationMinutes is calculated correctly from assignedAt to deliveredAt', async () => {
      // 45 minutes and 30 seconds ago (45.5 minutes)
      const assignedAt = new Date(Date.now() - 45.5 * 60_000);
      const { dispatchId, agentId, mockDispatch } = setupPodMocks({ assignedAt });

      await submitProofOfDelivery(agentId, dispatchId, { latitude: 12.97, longitude: 77.59 });

      expect(mockDispatch.actualDurationMinutes).not.toBeNull();
      expect(mockDispatch.actualDurationMinutes!).toBeCloseTo(45.5, 1);
    });

    it('8. Missing assignedAt results in null actualDurationMinutes without failure', async () => {
      const { dispatchId, agentId, mockDispatch } = setupPodMocks({ assignedAt: null });

      await submitProofOfDelivery(agentId, dispatchId, { latitude: 12.97, longitude: 77.59 });

      expect(mockDispatch.status).toBe('delivered');
      expect(mockDispatch.deliveredAt).toBeInstanceOf(Date);
      expect(mockDispatch.actualDurationMinutes).toBeNull();
    });

    it('9. Invalid timestamp ordering never produces negative duration', async () => {
      // Clock skew anomaly: assignedAt is in the future relative to completion
      const futureAssignedAt = new Date(Date.now() + 15 * 60_000);
      const { dispatchId, agentId, mockDispatch } = setupPodMocks({ assignedAt: futureAssignedAt });

      await submitProofOfDelivery(agentId, dispatchId, { latitude: 12.97, longitude: 77.59 });

      expect(mockDispatch.status).toBe('delivered');
      expect(mockDispatch.deliveredAt).toBeInstanceOf(Date);
      expect(mockDispatch.actualDurationMinutes).toBeNull();
    });

    it('10. Existing POD verification, evidence storage, R2 integration, and completion behavior remain intact', async () => {
      // Test A: Rejects if status is not in_transit
      const invalidStatusSetup = setupPodMocks({ dispatchStatus: 'picked_up' });
      await expect(
        submitProofOfDelivery(invalidStatusSetup.agentId, invalidStatusSetup.dispatchId, {}),
      ).rejects.toThrow(/In transit before submitting proof/);

      // Test B: Rejects if POD has already been submitted
      const alreadySubmittedSetup = setupPodMocks({ podExists: true });
      await expect(
        submitProofOfDelivery(alreadySubmittedSetup.agentId, alreadySubmittedSetup.dispatchId, {}),
      ).rejects.toThrow(/already been submitted/);

      // Test C: Rejects if draft evidence or OTP verification is missing
      const unverifiedSetup = setupPodMocks({ draftVerified: false });
      await expect(
        submitProofOfDelivery(unverifiedSetup.agentId, unverifiedSetup.dispatchId, {}),
      ).rejects.toThrow(/photo, verified customer code, and signature are required/);

      // Test D: Decrements agent activeDispatchCount and cleans up draft
      const validSetup = setupPodMocks({});
      await submitProofOfDelivery(validSetup.agentId, validSetup.dispatchId, {
        latitude: 12.97,
        longitude: 77.59,
        accuracyMeters: 5.0,
      });

      expect(Agent.updateOne).toHaveBeenCalledWith(
        { _id: validSetup.agentId, activeDispatchCount: { $gt: 0 } },
        { $inc: { activeDispatchCount: -1 } },
        expect.anything(),
      );
      expect(ProofOfDeliveryDraft.deleteOne).toHaveBeenCalled();
    });
  });
});
