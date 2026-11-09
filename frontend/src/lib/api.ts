const apiBase = (
  import.meta.env?.VITE_API_URL ?? 'http://localhost:5000'
).replace(/\/$/, '')

export type ApiResponse<T> = {
  success: boolean
  message: string
  data?: T
  errors?: Record<string, string[]>
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  let response: Response
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      credentials: init.credentials ?? 'include',
      headers: { 'Content-Type': 'application/json', ...init.headers },
    })
  } catch {
    throw new Error(
      'Unable to reach SWERV API. The request may be blocked by network connectivity or the backend CORS settings.',
    )
  }
  const payload = (await response
    .json()
    .catch(() => null)) as ApiResponse<T> | null
  if (!response.ok || !payload?.success) {
    throw new ApiError(payload?.message ?? 'The request could not be completed.', response.status)
  }
  return payload
}

export async function apiBlobRequest(path: string): Promise<Blob> {
  let response: Response
  try {
    response = await fetch(`${apiBase}${path}`, { credentials: 'include' })
  } catch {
    throw new Error('Unable to reach SWERV API. The request may be blocked by network connectivity or the backend CORS settings.')
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as ApiResponse<unknown> | null
    throw new ApiError(payload?.message ?? 'The proof image could not be loaded.', response.status)
  }
  return response.blob()
}
