export type AuthRole = 'admin' | 'operator'

export type AuthUser = {
  id: string
  name: string
  email: string
  role: AuthRole
  isActive: boolean
  createdAt: string
  updatedAt: string
}
