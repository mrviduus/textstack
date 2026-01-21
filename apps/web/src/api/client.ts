import { fetchJsonWithRetry, type FetchOptions } from '../lib/fetchWithRetry'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'

/** Build full URL for storage files (covers, photos) */
export function getStorageUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  return `${API_BASE}/storage/${path}`
}

async function fetchJson<T>(path: string, options?: FetchOptions): Promise<T> {
  return fetchJsonWithRetry<T>(`${API_BASE}${path}`, options)
}

export function createApi(language: string) {
  const langPrefix = `/${language}`

  return {
    getBooks: (params?: { limit?: number; offset?: number }) => {
      const query = new URLSearchParams()
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      const qs = query.toString()
      return fetchJson<{ total: number; items: import('../types/api').Edition[] }>(
        `${langPrefix}/books${qs ? `?${qs}` : ''}`
      )
    },

    getBook: (slug: string) => {
      return fetchJson<import('../types/api').BookDetail>(`${langPrefix}/books/${slug}`)
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
        `${langPrefix}/search?${query}`
      )
    },

    suggest: (q: string, params?: { limit?: number }) => {
      const query = new URLSearchParams({ q })
      if (params?.limit) query.set('limit', String(params.limit))
      return fetchJson<import('../types/api').Suggestion[]>(`${langPrefix}/search/suggest?${query}`)
    },

    getAuthors: (params?: { limit?: number; offset?: number; sort?: 'name' | 'recent' }) => {
      const query = new URLSearchParams()
      query.set('language', language)
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      if (params?.sort) query.set('sort', params.sort)
      return fetchJson<{ total: number; items: import('../types/api').Author[] }>(`/authors?${query}`)
    },

    getAuthor: (slug: string) => {
      return fetchJson<import('../types/api').AuthorDetail>(`/authors/${slug}`)
    },

    getGenres: () => {
      return fetchJson<{ total: number; items: import('../types/api').Genre[] }>(`/genres`)
    },

    getGenre: (slug: string) => {
      return fetchJson<import('../types/api').GenreDetail>(`/genres/${slug}`)
    },
  }
}

// Legacy API for backwards compatibility (uses default language)
export const api = createApi('uk')
