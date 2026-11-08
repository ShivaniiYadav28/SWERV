import { apiRequest } from './api'
import type {
  CreateManagedUserInput,
  ManagedUser,
  ManagedUserFilters,
  ManagedUserPage,
  ManagedUserRole,
} from '../types/adminUser'

export async function getManagedUsers(filters: ManagedUserFilters) {
  const params = new URLSearchParams({
    page: String(filters.page),
    limit: String(filters.limit),
  })
  if (filters.search.trim()) params.set('search', filters.search.trim())
  if (filters.role) params.set('role', filters.role)
  if (filters.status) params.set('status', filters.status)

  const response = await apiRequest<ManagedUserPage>(`/api/admin/users?${params}`)
  if (!response.data) throw new Error('User directory response was empty.')
  return response.data
}

export async function getManagedUser(id: string) {
  const response = await apiRequest<{ user: ManagedUser }>(`/api/admin/users/${id}`)
  if (!response.data) throw new Error('User details response was empty.')
  return response.data.user
}

export async function createManagedUser(input: CreateManagedUserInput) {
  return apiRequest<{ user: ManagedUser }>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function changeManagedUserRole(id: string, role: ManagedUserRole) {
  return apiRequest<{ user: ManagedUser }>(`/api/admin/users/${id}/role`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  })
}

export async function changeManagedUserStatus(id: string, isActive: boolean) {
  return apiRequest<{ user: ManagedUser }>(`/api/admin/users/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  })
}
