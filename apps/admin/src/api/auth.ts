const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'

export interface AdminUser {
  id: string
  email: string
  role: 'Admin' | 'Editor' | 'Moderator'
  createdAt: string
}

export interface AdminAuthResponse {
  user: AdminUser
}

async function authFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Unauthorized')
    }
    if (res.status === 429) {
      throw new Error('Too many login attempts. Please wait a minute.')
    }
    throw new Error(`API error: ${res.status}`)
  }

  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text)
}

export async function adminLogin(email: string, password: string): Promise<AdminAuthResponse> {
  return authFetch<AdminAuthResponse>('/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function adminRefresh(): Promise<AdminAuthResponse> {
  return authFetch<AdminAuthResponse>('/admin/auth/refresh', {
    method: 'POST',
  })
}

export async function adminLogout(): Promise<void> {
  await authFetch<void>('/admin/auth/logout', {
    method: 'POST',
  })
}

export async function getAdminMe(): Promise<AdminAuthResponse> {
  return authFetch<AdminAuthResponse>('/admin/auth/me')
}
