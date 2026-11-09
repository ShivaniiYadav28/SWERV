import { apiRequest } from './api'
import type { AdminAgentAttendancePage, AgentAttendancePage, AgentAttendanceRecord } from '../types/agentAttendance'

export type AttendanceFilters = {
  page: number
  limit: number
  startDate?: string
  endDate?: string
  agentId?: string
  search?: string
}

function attendanceQuery(filters: AttendanceFilters): string {
  const params = new URLSearchParams({ page: String(filters.page), limit: String(filters.limit) })
  if (filters.startDate) params.set('startDate', filters.startDate)
  if (filters.endDate) params.set('endDate', filters.endDate)
  if (filters.agentId) params.set('agentId', filters.agentId)
  if (filters.search) params.set('search', filters.search)
  return params.toString()
}

export async function getMyAttendance(filters: Pick<AttendanceFilters, 'page' | 'limit' | 'startDate' | 'endDate'>): Promise<AgentAttendancePage> {
  const response = await apiRequest<AgentAttendancePage>(`/api/agent/attendance/me?${attendanceQuery(filters)}`)
  if (!response.data || !Array.isArray(response.data.records) || !response.data.summary || !response.data.pagination) {
    throw new Error('Attendance history returned an invalid response.')
  }
  return response.data
}

export async function checkIn(): Promise<AgentAttendanceRecord> {
  const response = await apiRequest<{ attendance: AgentAttendanceRecord }>('/api/agent/attendance/check-in', {
    method: 'POST',
    body: JSON.stringify({}),
  })
  if (!response.data?.attendance) throw new Error('Check-in could not be completed.')
  return response.data.attendance
}

export async function checkOut(): Promise<AgentAttendanceRecord> {
  const response = await apiRequest<{ attendance: AgentAttendanceRecord }>('/api/agent/attendance/check-out', {
    method: 'POST',
    body: JSON.stringify({}),
  })
  if (!response.data?.attendance) throw new Error('Check-out could not be completed.')
  return response.data.attendance
}

export async function getAdminAgentAttendance(filters: AttendanceFilters): Promise<AdminAgentAttendancePage> {
  const response = await apiRequest<AdminAgentAttendancePage>(`/api/agent-attendance?${attendanceQuery(filters)}`)
  if (!response.data || !Array.isArray(response.data.records) || !response.data.summary || !response.data.pagination) {
    throw new Error('Attendance records returned an invalid response.')
  }
  return response.data
}
