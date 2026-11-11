import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { createAccessToken } from '../src/utils/jwt.js';
import * as authService from '../src/services/authService.js';
import * as deliveryQualityService from '../src/services/deliveryQualityService.js';
import type { DeliveryDataQualitySummary } from '../src/services/deliveryQualityService.js';

describe('Admin Delivery Quality API Endpoint (GET /api/admin/delivery-quality)', () => {
  const testSecret = 'swerv-admin-delivery-quality-test-secret-1234567890';
  const adminId = 'admin-user-id-1234567890';
  const operatorId = 'operator-user-id-1234567890';
  const regularUserId = 'regular-user-id-1234567890';

  const mockQualitySummary: DeliveryDataQualitySummary = {
    totalCompletedDeliveries: 120,
    deliveriesWithRequiredTimestamps: 110,
    deliveriesWithValidChronology: 105,
    deliveriesWithValidCoordinates: 98,
    deliveriesWithVerifiedPod: 95,
    excludedDeliveries: {
      totalExcluded: 28,
      syntheticOrDemo: 10,
      missingTimestamps: 10,
      invalidChronology: 5,
      missingOrInvalidCoordinates: 7,
      unverifiedPod: 5,
      duplicates: 0,
    },
    totalEligibleGenuineRecords: 92,
    qualityMetrics: {
      timestampCompletenessRate: 0.9167,
      chronologicalValidityRate: 0.875,
      coordinateCoverageRate: 0.8167,
      podVerificationRate: 0.7917,
      genuineEligibilityRate: 0.7667,
    },
  };

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = testSecret;
    process.env.JWT_EXPIRES_IN = '1d';
  });

  beforeEach(() => {
    vi.restoreAllMocks();

    vi.spyOn(authService, 'getActiveUserById').mockImplementation(async (id: string) => {
      if (id === adminId) {
        return { id: adminId, name: 'Test Admin', email: 'admin@example.test', role: 'admin', isActive: true } as any;
      }
      if (id === operatorId) {
        return { id: operatorId, name: 'Test Operator', email: 'operator@example.test', role: 'operator', isActive: true } as any;
      }
      if (id === regularUserId) {
        return { id: regularUserId, name: 'Regular User', email: 'user@example.test', role: 'user' as any, isActive: true } as any;
      }
      return null;
    });

    vi.spyOn(deliveryQualityService, 'getDeliveryDataQualitySummary').mockResolvedValue(mockQualitySummary);
  });

  it('allows Admin to retrieve the delivery quality summary with HTTP 200', async () => {
    const adminToken = createAccessToken(adminId);

    const response = await request(app)
      .get('/api/admin/delivery-quality')
      .set('Cookie', `swerv_access=${adminToken}`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Delivery data quality summary retrieved successfully.');
    expect(response.body.data).toEqual(mockQualitySummary);
    expect(deliveryQualityService.getDeliveryDataQualitySummary).toHaveBeenCalledTimes(1);
  });

  it('rejects Operator access with HTTP 403 Forbidden', async () => {
    const operatorToken = createAccessToken(operatorId);

    const response = await request(app)
      .get('/api/admin/delivery-quality')
      .set('Cookie', `swerv_access=${operatorToken}`)
      .expect(403);

    expect(response.body.success).toBe(false);
    expect(response.body.message).toMatch(/permission/i);
    expect(deliveryQualityService.getDeliveryDataQualitySummary).not.toHaveBeenCalled();
  });

  it('rejects regular users with HTTP 403 Forbidden', async () => {
    const userToken = createAccessToken(regularUserId);

    const response = await request(app)
      .get('/api/admin/delivery-quality')
      .set('Cookie', `swerv_access=${userToken}`)
      .expect(403);

    expect(response.body.success).toBe(false);
    expect(response.body.message).toMatch(/permission/i);
    expect(deliveryQualityService.getDeliveryDataQualitySummary).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests with HTTP 401 Unauthorized', async () => {
    const response = await request(app)
      .get('/api/admin/delivery-quality')
      .expect(401);

    expect(response.body.success).toBe(false);
    expect(response.body.message).toMatch(/Authentication required/i);
    expect(deliveryQualityService.getDeliveryDataQualitySummary).not.toHaveBeenCalled();
  });

  it('does not expose any customer PII or raw coordinates in the response payload', async () => {
    const adminToken = createAccessToken(adminId);

    const response = await request(app)
      .get('/api/admin/delivery-quality')
      .set('Cookie', `swerv_access=${adminToken}`)
      .expect(200);

    const responseString = JSON.stringify(response.body);

    // Verify PII indicators are absent
    expect(responseString).not.toContain('email');
    expect(responseString).not.toContain('phone');
    expect(responseString).not.toContain('address');
    expect(responseString).not.toContain('customer');
    expect(responseString).not.toContain('latitude');
    expect(responseString).not.toContain('longitude');

    // Verify allowed top-level metrics keys
    const allowedKeys = [
      'totalCompletedDeliveries',
      'deliveriesWithRequiredTimestamps',
      'deliveriesWithValidChronology',
      'deliveriesWithValidCoordinates',
      'deliveriesWithVerifiedPod',
      'excludedDeliveries',
      'totalEligibleGenuineRecords',
      'qualityMetrics',
    ];
    expect(Object.keys(response.body.data).sort()).toEqual(allowedKeys.sort());
  });

  it('handles service errors gracefully and returns an HTTP 500 error response', async () => {
    vi.spyOn(deliveryQualityService, 'getDeliveryDataQualitySummary').mockRejectedValue(
      new Error('Database read failure during quality summary'),
    );

    const adminToken = createAccessToken(adminId);

    const response = await request(app)
      .get('/api/admin/delivery-quality')
      .set('Cookie', `swerv_access=${adminToken}`)
      .expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.message).toMatch(/Database read failure/i);
  });
});
