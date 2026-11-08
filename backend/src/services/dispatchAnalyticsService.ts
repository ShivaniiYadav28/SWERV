import { DispatchRequest, dispatchPriorities, dispatchRequestStatuses } from '../models/DispatchRequest.js';
import { DispatchRequestActivity } from '../models/DispatchRequestActivity.js';

type DailyDeliveryCount = { date: string; delivered: number };

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function trendRange(startDate?: string, endDate?: string) {
  if (startDate && endDate) {
    return { startDate, endDate };
  }

  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return { startDate: formatUtcDate(start), endDate: formatUtcDate(end) };
}

function datesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (current <= end) {
    dates.push(formatUtcDate(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export async function getDispatchAnalytics(start?: string, end?: string) {
  const range = trendRange(start, end);
  const rangeStart = new Date(`${range.startDate}T00:00:00.000Z`);
  const rangeEnd = new Date(`${range.endDate}T00:00:00.000Z`);
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 1);

  const [requestGroups, deliveryGroups] = await Promise.all([
    DispatchRequest.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          ...Object.fromEntries(dispatchRequestStatuses.map((status) => [
            status,
            { $sum: { $cond: [{ $eq: ['$status', status] }, 1, 0] } },
          ])),
          ...Object.fromEntries(dispatchPriorities.map((priority) => [
            priority,
            { $sum: { $cond: [{ $eq: ['$priority', priority] }, 1, 0] } },
          ])),
        },
      },
    ]),
    DispatchRequestActivity.aggregate([
      {
        $match: {
          eventType: 'status_changed',
          'newValue.status': 'delivered',
          createdAt: { $gte: rangeStart, $lt: rangeEnd },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' },
          },
          delivered: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const counts = requestGroups[0] ?? {
    total: 0,
    ...Object.fromEntries(dispatchRequestStatuses.map((status) => [status, 0])),
    ...Object.fromEntries(dispatchPriorities.map((priority) => [priority, 0])),
  };
  const deliveriesByDate = new Map(
    (deliveryGroups as { _id: string; delivered: number }[]).map((group) => [group._id, group.delivered]),
  );

  return {
    counts: {
      total: counts.total,
      pending: counts.pending,
      assigned: counts.assigned,
      picked_up: counts.picked_up,
      in_transit: counts.in_transit,
      activeDeliveries: counts.picked_up + counts.in_transit,
      delivered: counts.delivered,
      failed: counts.failed,
      cancelled: counts.cancelled,
    },
    priorityDistribution: {
      standard: counts.standard,
      express: counts.express,
      urgent: counts.urgent,
    },
    deliveryTrend: {
      startDate: range.startDate,
      endDate: range.endDate,
      timezone: 'UTC' as const,
      daily: datesBetween(range.startDate, range.endDate).map((date): DailyDeliveryCount => ({
        date,
        delivered: deliveriesByDate.get(date) ?? 0,
      })),
    },
  };
}
