const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'

export interface User {
  id: string
  email: string
  name: string | null
  picture: string | null
  createdAt: string
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
    if (res.status === 401) {
      throw new Error('Unauthorized')
    }
    throw new Error(`API error: ${res.status}`)
  }

  // Handle empty response (logout)
  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text)
}

export async function loginWithGoogle(idToken: string): Promise<AuthResponse> {
  return authFetch<AuthResponse>('/auth/google', {
    method: 'POST',
    body: JSON.stringify({ idToken }),
  })
}

export async function refreshToken(): Promise<AuthResponse> {
  return authFetch<AuthResponse>('/auth/refresh', {
    method: 'POST',
  })
}

export async function logout(): Promise<void> {
  await authFetch<void>('/auth/logout', {
    method: 'POST',
  })
}

export async function getCurrentUser(): Promise<AuthResponse> {
  return authFetch<AuthResponse>('/auth/me')
}

// Reading Progress API
export interface ReadingProgressDto {
  editionId: string
  chapterId: string
  chapterSlug: string | null
  locator: string
  percent: number | null
  updatedAt: string
}

export interface UpsertProgressRequest {
  chapterId: string
  locator: string
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
    body: JSON.stringify(data),
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
  coverPath: string | null
  createdAt: string
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
