import { refreshToken } from './auth'
import { fetchJsonWithRetry, type FetchOptions } from '../lib/fetchWithRetry'

export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'
const STORAGE_BASE = import.meta.env.VITE_STORAGE_URL || API_BASE

/** Build full URL for storage files (covers, photos) */
export function getStorageUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  return `${STORAGE_BASE}/storage/${path}`
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

/** Authenticated fetch w/ auto token refresh on 401, error message parsing */
export async function authFetch<T>(path: string, options?: RequestInit, retry = true): Promise<T> {
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
        throw new ApiError(401, 'Unauthorized')
      }
    }
    if (res.status === 401) throw new ApiError(401, 'Unauthorized')
    const text = await res.text()
    let error = `API error: ${res.status}`
    try {
      const json = JSON.parse(text)
      if (json.error) error = json.error
    } catch {}
    throw new ApiError(res.status, error)
  }

  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text)
}

async function fetchJson<T>(path: string, options?: FetchOptions): Promise<T> {
  return fetchJsonWithRetry<T>(`${API_BASE}${path}`, options)
}

export function createApi(language: string) {
  const langPrefix = `/${language}`

  return {
    getBooks: (params?: { limit?: number; offset?: number; search?: string; genre?: string; sort?: string }) => {
      const query = new URLSearchParams()
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      if (params?.search) query.set('search', params.search)
      if (params?.genre) query.set('genre', params.genre)
      if (params?.sort) query.set('sort', params.sort)
      const qs = query.toString()
      return fetchJson<{ total: number; items: import('../types/api').Edition[] }>(
        `${langPrefix}/books${qs ? `?${qs}` : ''}`
      )
    },

    getBook: (slug: string) => {
      return fetchJson<import('../types/api').BookDetail>(`${langPrefix}/books/${slug}`)
    },

    getPodcast: (slug: string) => {
      return fetchJson<import('../types/api').PodcastStatusDto>(`${langPrefix}/books/${slug}/podcast`)
    },

    getChapter: (bookSlug: string, chapterSlug: string) => {
      return fetchJson<import('../types/api').Chapter>(
        `${langPrefix}/books/${bookSlug}/chapters/${chapterSlug}`
      )
    },

    search: (q: string, params?: { limit?: number; offset?: number; highlight?: boolean }) => {
      const query = new URLSearchParams({ q })
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      if (params?.highlight) query.set('highlight', 'true')
      return fetchJson<{ total: number; items: import('../types/api').SearchResult[] }>(
        `${langPrefix}/search?${query}`,
        { timeout: 15000 }
      )
    },

    suggest: (q: string, params?: { limit?: number }) => {
      const query = new URLSearchParams({ q })
      if (params?.limit) query.set('limit', String(params.limit))
      return fetchJson<import('../types/api').Suggestion[]>(
        `${langPrefix}/search/suggest?${query}`,
        { timeout: 15000 }
      )
    },

    getAuthors: (params?: { limit?: number; offset?: number; sort?: 'name' | 'recent'; search?: string }) => {
      const query = new URLSearchParams()
      query.set('language', language)
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      if (params?.sort) query.set('sort', params.sort)
      if (params?.search) query.set('search', params.search)
      return fetchJson<{ total: number; items: import('../types/api').Author[] }>(`/authors?${query}`)
    },

    getAuthor: (slug: string) => {
      return fetchJson<import('../types/api').AuthorDetail>(`/authors/${slug}`)
    },

    getGenres: (params?: { language?: string }) => {
      const query = new URLSearchParams()
      if (params?.language) query.set('language', params.language)
      const qs = query.toString()
      return fetchJson<{ total: number; items: import('../types/api').Genre[] }>(`/genres${qs ? `?${qs}` : ''}`)
    },

    getGenre: (slug: string) => {
      return fetchJson<import('../types/api').GenreDetail>(`/genres/${slug}`)
    },
  }
}

// Legacy API for backwards compatibility (uses default language)
export const api = createApi('en')
