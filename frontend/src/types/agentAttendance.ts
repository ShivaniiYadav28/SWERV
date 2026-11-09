export type AgentAttendanceStatus = 'checked_in' | 'checked_out'

export type AgentAttendanceRecord = {
  _id: string
  agentId: string
  attendanceDate: string
  checkInAt: string
  checkOutAt: string | null
  createdAt: string
  updatedAt: string
  durationMinutes: number | null
}

export type AdminAgentAttendanceRecord = AgentAttendanceRecord & {
  agent: { _id: string; name: string; email: string; agentCode: string } | null
  status: AgentAttendanceStatus
}

export type AgentAttendanceSummary = {
  totalRecords: number
  completedCheckouts: number
  openRecords: number
  totalDurationMinutes: number
}

export type AttendancePagination = {
  page: number
  limit: number
  total: number
  pages: number
}

export type AgentAttendancePage = {
  records: AgentAttendanceRecord[]
  todayAttendance: AgentAttendanceRecord | null
  summary: AgentAttendanceSummary
  pagination: AttendancePagination
}

export type AdminAgentAttendancePage = {
  records: AdminAgentAttendanceRecord[]
  summary: AgentAttendanceSummary
  pagination: AttendancePagination
}
