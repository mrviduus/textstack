import { PERCENT_UNIT_BOOK } from '@textstack/shared'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'

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
  return authFetch<AuthResponse>('/me/profile', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export async function uploadAvatar(file: File): Promise<AuthResponse> {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(`${API_BASE}/me/profile/avatar`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error || 'Upload failed')
  }
  return res.json()
}

export async function deleteAvatar(): Promise<void> {
  await authFetch<void>('/me/profile/avatar', { method: 'DELETE' })
}

// Permanently deletes the authenticated user and ALL their data. Backend → 204.
export async function deleteAccount(): Promise<void> {
  await authFetch<void>('/me/account', { method: 'DELETE' })
}

// Reading Progress API
export interface ReadingProgressDto {
  editionId: string
  chapterId: string
  chapterSlug: string | null
  locator: string
  percent: number | null
  updatedAt: string
  /** Non-null once the book is finished. Read this instead of comparing
   *  `percent` against a threshold of your own. */
  completedAt?: string | null
  /** Where the reader is IN THE TEXT, serialised (ADR-015). Prefer it over
   *  `locator`: a pixel offset stops being true the moment the text reflows. */
  positionJson?: string | null
}

export interface UpsertProgressRequest {
  chapterId: string
  locator: string
  /** Serialised TextPosition — where the reader is in the TEXT (ADR-015).
   *  Travels beside the locator, never instead of it, so a build that predates
   *  this keeps resuming from the pixel offset. Absent means absent: the server
   *  clears the stored position rather than leaving it beside a fresher pixel. */
  positionJson?: string
  percent: number | null
  updatedAt?: string
}

export async function getProgress(editionId: string): Promise<ReadingProgressDto | null> {
  try {
    return await authFetch<ReadingProgressDto>(`/me/progress/${editionId}`)
  } catch {
    return null
  }
}

export interface AllProgressResponse {
  total: number
  items: ReadingProgressDto[]
}

export async function getAllProgress(): Promise<AllProgressResponse> {
  return authFetch<AllProgressResponse>('/me/progress')
}

export async function upsertProgress(editionId: string, data: UpsertProgressRequest): Promise<ReadingProgressDto> {
  return authFetch<ReadingProgressDto>(`/me/progress/${editionId}`, {
    method: 'PUT',
    // Every web writer funnels through here, so the unit is declared once. The
    // server stores a percentage only when it knows what it is a fraction of —
    // see Application.ReadingTracking.ProgressUnit.
    body: JSON.stringify({ ...data, percentUnit: PERCENT_UNIT_BOOK }),
  })
}

// Mark book as fully read (100%)
export async function markAsRead(editionId: string, chapterId: string): Promise<ReadingProgressDto> {
  return upsertProgress(editionId, {
    chapterId,
    locator: '{"type":"end"}',
    percent: 1,
  })
}

// Mark book as unread (0%)
export async function markAsUnread(editionId: string, chapterId: string): Promise<ReadingProgressDto> {
  return upsertProgress(editionId, {
    chapterId,
    locator: '{"type":"start"}',
    percent: 0,
  })
}

// Library API
export interface LibraryItem {
  editionId: string
  slug: string
  title: string
  language: string
  coverPath: string | null
  createdAt: string
  author: string | null
}

export interface LibraryResponse {
  total: number
  items: LibraryItem[]
}

export async function getLibrary(): Promise<LibraryResponse> {
  return authFetch<LibraryResponse>('/me/library')
}

export async function addToLibrary(editionId: string): Promise<LibraryItem> {
  return authFetch<LibraryItem>(`/me/library/${editionId}`, {
    method: 'POST',
  })
}

export async function removeFromLibrary(editionId: string): Promise<void> {
  await authFetch<void>(`/me/library/${editionId}`, {
    method: 'DELETE',
  })
}
