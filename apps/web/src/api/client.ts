import { fetchJsonWithRetry, type FetchOptions } from '../lib/fetchWithRetry'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'

/** Build full URL for storage files (covers, photos) */
export function getStorageUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  return `${API_BASE}/storage/${path}`
}

function getSiteFromHost(): string {
  const host = window.location.hostname

  // Production domain
  if (host === 'textstack.app' || host === 'www.textstack.app') return 'general'

  // Dev subdomains
  const subdomain = host.split('.')[0]
  if (subdomain === 'general') return 'general'

  return import.meta.env.VITE_SITE || 'general'
}

function addSiteParam(query: URLSearchParams): void {
  if (!query.has('site')) query.set('site', getSiteFromHost())
}

async function fetchJson<T>(path: string, options?: FetchOptions): Promise<T> {
  return fetchJsonWithRetry<T>(`${API_BASE}${path}`, options)
}

export function createApi(language: string) {
  const langPrefix = `/${language}`

  return {
    getBooks: (params?: { limit?: number; offset?: number }) => {
      const query = new URLSearchParams()
      addSiteParam(query)
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      return fetchJson<{ total: number; items: import('../types/api').Edition[] }>(
        `${langPrefix}/books?${query}`
      )
    },

    getBook: (slug: string) => {
      const query = new URLSearchParams()
      addSiteParam(query)
      return fetchJson<import('../types/api').BookDetail>(`${langPrefix}/books/${slug}?${query}`)
    },

    getChapter: (bookSlug: string, chapterSlug: string) => {
      const query = new URLSearchParams()
      addSiteParam(query)
      return fetchJson<import('../types/api').Chapter>(
        `${langPrefix}/books/${bookSlug}/chapters/${chapterSlug}?${query}`
      )
    },

    search: (q: string, params?: { limit?: number; offset?: number; highlight?: boolean }) => {
      const query = new URLSearchParams({ q })
      addSiteParam(query)
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      if (params?.highlight) query.set('highlight', 'true')
      return fetchJson<{ total: number; items: import('../types/api').SearchResult[] }>(
        `${langPrefix}/search?${query}`
      )
    },

    suggest: (q: string, params?: { limit?: number }) => {
      const query = new URLSearchParams({ q })
      addSiteParam(query)
      if (params?.limit) query.set('limit', String(params.limit))
      return fetchJson<import('../types/api').Suggestion[]>(`${langPrefix}/search/suggest?${query}`)
    },

    getAuthors: (params?: { limit?: number; offset?: number; sort?: 'name' | 'recent' }) => {
      const query = new URLSearchParams()
      addSiteParam(query)
      query.set('language', language)
      if (params?.limit) query.set('limit', String(params.limit))
      if (params?.offset) query.set('offset', String(params.offset))
      if (params?.sort) query.set('sort', params.sort)
      return fetchJson<{ total: number; items: import('../types/api').Author[] }>(`/authors?${query}`)
    },

    getAuthor: (slug: string) => {
      const query = new URLSearchParams()
      addSiteParam(query)
      return fetchJson<import('../types/api').AuthorDetail>(`/authors/${slug}?${query}`)
    },

    getGenres: () => {
      const query = new URLSearchParams()
      addSiteParam(query)
      return fetchJson<{ total: number; items: import('../types/api').Genre[] }>(`/genres?${query}`)
    },

    getGenre: (slug: string) => {
      const query = new URLSearchParams()
      addSiteParam(query)
      return fetchJson<import('../types/api').GenreDetail>(`/genres/${slug}?${query}`)
    },
  }
}

// Legacy API for backwards compatibility (uses default language)
export const api = createApi('uk')
