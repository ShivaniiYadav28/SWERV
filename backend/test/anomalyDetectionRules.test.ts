import { describe, expect, it } from 'vitest';
import { detectOperationalAnomalies } from '../src/services/anomalyDetectionRules.js';

const baseTime = Date.parse('2026-01-01T00:00:00.000Z');

function timestampAt(minutes: number): string {
  return new Date(baseTime + minutes * 60_000).toISOString();
}

function gpsPoint(agentId: string, minutes: number, latitude: number, longitude: number, accuracy = 5) {
  const recordedAt = timestampAt(minutes);
  return {
    agentId,
    latitude,
    longitude,
    accuracy,
    recordedAt,
    receivedAt: recordedAt,
  };
}

function completedDispatch(dispatchId: string, durationMinutes: number) {
  const deliveredAt = durationMinutes;
  return {
    dispatch: { _id: dispatchId, status: 'delivered', assignedAgent: 'agent-1' },
    activities: [
      {
        dispatchRequestId: dispatchId,
        eventType: 'assignment_changed',
        createdAt: timestampAt(0),
        newValue: { agentId: 'agent-1' },
      },
      {
        dispatchRequestId: dispatchId,
        eventType: 'status_changed',
        createdAt: timestampAt(5),
        previousValue: { status: 'assigned' },
        newValue: { status: 'picked_up' },
      },
      {
        dispatchRequestId: dispatchId,
        eventType: 'status_changed',
        createdAt: timestampAt(deliveredAt),
        previousValue: { status: 'in_transit' },
        newValue: { status: 'delivered' },
      },
    ],
  };
}

describe('backend-local anomaly rules', () => {
  it('flags only fresh, accurate GPS coordinate jumps', () => {
    const report = detectOperationalAnomalies([], [], [
      gpsPoint('agent-1', 0, 0, 0),
      gpsPoint('agent-1', 1, 0.05, 0),
    ]);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.anomaly_type).toBe('gps_implausible_jump');
    expect(report.findings[0]?.detection_method).toBe('haversine_distance_with_accuracy_adjustment');
    expect(report.findings[0]?.severity).toBe('high');
  });

  it('reports coordinate and timestamp quality without pairing those points', () => {
    const report = detectOperationalAnomalies([], [], [{
      agentId: 'agent-1',
      latitude: 91,
      longitude: 0,
      accuracy: 5,
      recordedAt: 'not-a-time',
      receivedAt: 'not-a-time',
    }]);

    expect(report.findings.map((finding) => finding.anomaly_type)).toEqual([
      'gps_invalid_coordinates', 'gps_invalid_timestamp',
    ]);
  });

  it('does not report duration anomalies without the minimum baseline', () => {
    const completed = Array.from({ length: 5 }, (_, index) => completedDispatch(`short-${index}`, 10 + index));
    const report = detectOperationalAnomalies(
      completed.map((item) => item.dispatch),
      completed.flatMap((item) => item.activities),
      [],
    );

    expect(report.findings.some((finding) => finding.anomaly_type === 'unusual_delivery_duration')).toBe(false);
    expect(report.limitations.some((limitation) => limitation.includes('5 valid completed deliveries'))).toBe(true);
  });

  it('uses delivered activity timestamps for duration outliers', () => {
    const completed = Array.from({ length: 31 }, (_, index) => completedDispatch(`duration-${index}`, index === 30 ? 100 : 10));
    const report = detectOperationalAnomalies(
      completed.map((item) => item.dispatch),
      completed.flatMap((item) => item.activities),
      [],
    );
    const durationFindings = report.findings.filter((finding) => finding.anomaly_type === 'unusual_delivery_duration');

    expect(durationFindings).toHaveLength(1);
    expect(durationFindings[0]?.dispatch_id).toBe('duration-30');
    expect(durationFindings[0]?.evidence_timestamp).toBe(timestampAt(100));
    expect(durationFindings[0]?.detection_method).toBe('upper_quartile_plus_configured_iqr_multiple');
  });
});