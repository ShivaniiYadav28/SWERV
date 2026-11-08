import { apiRequest } from './api'
import type { Customer, CustomerDetails, CustomerFilters, CustomerInput, CustomerPage } from '../types/customer'

export async function getCustomers(filters: CustomerFilters): Promise<CustomerPage> {
  const params = new URLSearchParams({ page: String(filters.page), limit: String(filters.limit) })
  if (filters.search.trim()) params.set('search', filters.search.trim())
  if (filters.status) params.set('status', filters.status)
  const response = await apiRequest<CustomerPage>(`/api/customers?${params}`)
  if (!response.data) throw new Error('Customers could not be loaded.')
  return response.data
}

export async function getCustomer(id: string): Promise<CustomerDetails> {
  const response = await apiRequest<CustomerDetails>(`/api/customers/${encodeURIComponent(id)}`)
  if (!response.data?.customer) throw new Error('Customer details could not be loaded.')
  return response.data
}

export async function createCustomer(input: CustomerInput) {
  return apiRequest<{ customer: Customer }>('/api/customers', {
    method: 'POST', body: JSON.stringify(input),
  })
}

export async function updateCustomer(id: string, input: CustomerInput) {
  return apiRequest<{ customer: Customer }>(`/api/customers/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(input),
  })
}

export async function setCustomerStatus(id: string, isActive: boolean) {
  return apiRequest<{ customer: Customer }>(`/api/customers/${encodeURIComponent(id)}/status`, {
    method: 'PATCH', body: JSON.stringify({ isActive }),
  })
}
