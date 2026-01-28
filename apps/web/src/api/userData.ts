import { refreshToken } from './auth'

const API_BASE = import.meta.env.VITE_API_URL ?? ''

async function authFetch<T>(path: string, options?: RequestInit, retry = true): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
  })

  if (!res.ok) {
    if (res.status === 401 && retry) {
      try {
        await refreshToken()
        return authFetch<T>(path, options, false)
      } catch {
        throw new Error('Unauthorized')
      }
    }
    if (res.status === 401) throw new Error('Unauthorized')
    const text = await res.text()
    let error = `API error: ${res.status}`
    try {
      const json = JSON.parse(text)
      if (json.error) error = json.error
    } catch {}
    throw new Error(error)
  }

  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text)
}

// Bookmark types
export interface PublicBookmark {
  id: string
  editionId: string
  chapterId: string
  locator: string
  title: string | null
  createdAt: string
}

// Bookmark API
export async function getPublicBookmarks(editionId: string): Promise<PublicBookmark[]> {
  return authFetch<PublicBookmark[]>(`/me/bookmarks/${editionId}`)
}

export async function createPublicBookmark(data: {
  editionId: string
  chapterId: string
  locator: string
  title?: string
}): Promise<PublicBookmark> {
  return authFetch<PublicBookmark>('/me/bookmarks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deletePublicBookmark(id: string): Promise<void> {
  await authFetch<void>(`/me/bookmarks/${id}`, {
    method: 'DELETE',
  })
}
