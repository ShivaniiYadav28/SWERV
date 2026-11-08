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
      'Unable to reach SWERV API. Check that the backend is running and try again.',
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
