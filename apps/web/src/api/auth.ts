import type { MergeMap } from '../lib/v2Merge'
import type { GuestMergeSkipReason } from '@textstack/shared'

import { authFetch as meFetch, API_BASE } from './client'

/** /me/* data calls: the shared cookie-mode client (401 → refresh → retry). The session
 *  flow below (login/refresh/logout/guest/device) stays on the local `authFetch`, which
 *  never refreshes — refresh going through refresh-on-401 would recurse. */
const json = (method: string, data: unknown): RequestInit =>
  ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })

export interface User {
  id: string
  email: string
  name: string | null
  picture: string | null
  isGuest: boolean
  createdAt: string
  /** BCP-47 code of the user's native language. Null until set via ProfileModal
   *  or propagated from a guest session. Source of truth when present. */
  nativeLanguage: string | null
}

export interface AuthResponse {
  user: User
  /**
   * Set when the sign-in did NOT carry the reader's pre-sign-in work across — see
   * `GuestMergeSkipReason` in the shared types. Absent on the ordinary path.
   */
  guestMergeSkipped?: GuestMergeSkipReason | null
  /** V2 on and a guest merged: the ids that changed (the client re-keys its local stores by it). */
  merge?: MergeMap
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
    const data = await res.json().catch(() => null)
    throw Object.assign(new Error(data?.error || `API error: ${res.status}`), { status: res.status })
  }

  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text)
}

export async function registerWithEmail(email: string, password: string, name?: string): Promise<AuthResponse> {
  try {
    return await authFetch<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name: name || null }),
    })
  } catch (e: any) {
    if (e.status === 409) throw new Error('An account with this email already exists.')
    if (e.status === 400) throw new Error(e.message || 'Invalid email or password.')
    throw new Error(`Registration failed: ${e.status}`)
  }
}

export async function loginWithEmail(email: string, password: string): Promise<AuthResponse> {
  try {
    return await authFetch<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
  } catch (e: any) {
    if (e.status === 401) throw new Error('Invalid email or password.')
    throw new Error(`Login failed: ${e.status}`)
  }
}

export async function forgotPassword(email: string): Promise<void> {
  await authFetch<void>('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function resetPassword(token: string, password: string): Promise<void> {
  await authFetch<void>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  })
}

export async function loginWithGoogle(idToken: string): Promise<AuthResponse> {
  return authFetch<AuthResponse>('/auth/google', {
    method: 'POST',
    body: JSON.stringify({ idToken }),
  })
}

// Single-flight refresh. The reader fires many authenticated requests in
// parallel (chapter, book, progress, bookmarks…), so when the access token
// expires they all 401 at (nearly) the same instant and each would call
// /auth/refresh. The server ROTATES the refresh token on every call — it
// deletes the presented token and issues a new one — so only the first
// concurrent refresh succeeds; the rest present the now-deleted token and get
// 401, surfacing as a spurious "Unauthorized" mid-session (the session is
// actually fine). Dedupe concurrent refreshes into one in-flight request:
// every caller awaits the same promise, one rotation happens, one fresh cookie
// is set, then all callers retry their original request.
let refreshInFlight: Promise<AuthResponse> | null = null

export function refreshToken(): Promise<AuthResponse> {
  refreshInFlight ??= authFetch<AuthResponse>('/auth/refresh', { method: 'POST' })
    .finally(() => { refreshInFlight = null })
  return refreshInFlight
}

export async function logout(): Promise<void> {
  await authFetch<void>('/auth/logout', {
    method: 'POST',
  })
}

export async function createGuestSession(): Promise<AuthResponse> {
  return authFetch<AuthResponse>('/auth/guest', { method: 'POST' })
}

export async function getCurrentUser(): Promise<AuthResponse> {
  return authFetch<AuthResponse>('/auth/me')
}

// Device Authorization Grant (RFC 8628, AI-050a) — consent page approves a
// CLI's user_code from the authenticated browser session. authFetch sends
// credentials:'include', so the session cookie authenticates the approval.
export type DeviceApproveError =
  | 'invalid_user_code'
  | 'expired_user_code'
  | 'user_code_already_used'
  | 'invalid_request'

export async function approveDevice(userCode: string): Promise<void> {
  await authFetch<void>('/auth/device/approve', {
    method: 'POST',
    body: JSON.stringify({ user_code: userCode }),
  })
}

export async function denyDevice(userCode: string): Promise<void> {
  await authFetch<void>('/auth/device/deny', {
    method: 'POST',
    body: JSON.stringify({ user_code: userCode }),
  })
}

// Profile API
export interface UpdateProfilePayload {
  name?: string | null
  nativeLanguage?: string | null
}

export async function updateProfile(payload: UpdateProfilePayload): Promise<AuthResponse> {
  return meFetch<AuthResponse>('/me/profile', json('PUT', payload))
}

export async function uploadAvatar(file: File): Promise<AuthResponse> {
  const formData = new FormData()
  formData.append('file', file)
  return meFetch<AuthResponse>('/me/profile/avatar', { method: 'POST', body: formData })
}

export async function deleteAvatar(): Promise<void> {
  await meFetch<void>('/me/profile/avatar', { method: 'DELETE' })
}

// Permanently deletes the authenticated user and ALL their data. Backend → 204.
export async function deleteAccount(): Promise<void> {
  await meFetch<void>('/me/account', { method: 'DELETE' })
}
