export type DispatchAnalytics = {
  counts: {
    total: number
    pending: number
    assigned: number
    picked_up: number
    in_transit: number
    activeDeliveries: number
    delivered: number
    failed: number
    cancelled: number
  }
  priorityDistribution: {
    standard: number
    express: number
    urgent: number
  }
  deliveryTrend: {
    startDate: string
    endDate: string
    timezone: 'UTC'
    daily: { date: string; delivered: number }[]
  }
}
