import type { DispatchRequest } from './dispatchRequest'

export type Customer = {
  id: string
  name: string
  email: string
  phone: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type CustomerPage = {
  customers: Customer[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

export type CustomerDetails = {
  customer: Customer
  dispatchRequests: DispatchRequest[]
}

export type CustomerFilters = {
  page: number
  limit: number
  search: string
  status: 'active' | 'inactive' | ''
}

export type CustomerInput = Pick<Customer, 'name' | 'email' | 'phone'>
