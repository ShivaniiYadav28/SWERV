export type ManagedUserRole = 'admin' | 'operator'
export type ManagedUserStatus = 'active' | 'inactive'

export type ManagedUser = {
  id: string
  name: string
  email: string
  role: ManagedUserRole
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type ManagedUserPage = {
  users: ManagedUser[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

export type ManagedUserFilters = {
  page: number
  limit: number
  search: string
  role: ManagedUserRole | ''
  status: ManagedUserStatus | ''
}

export type CreateManagedUserInput = {
  name: string
  email: string
  password: string
  role: ManagedUserRole
}
