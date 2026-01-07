const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'

export interface IngestionJob {
  id: string
  editionId: string
  editionTitle: string
  status: 'Queued' | 'Processing' | 'Succeeded' | 'Failed'
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface UploadResponse {
  workId: string
  editionId: string
  bookFileId: string
  jobId: string
  message: string
}

export interface Edition {
  id: string
  slug: string
  title: string
  language: string
  status: 'Draft' | 'Published' | 'Deleted'
  chapterCount: number
  createdAt: string
  publishedAt: string | null
  authors: string
}

export interface AdminStats {
  totalEditions: number
  publishedEditions: number
  draftEditions: number
  totalChapters: number
  totalAuthors: number
}

export interface EditionDetail {
  id: string
  workId: string
  siteId: string
  slug: string
  title: string
  language: string
  description: string | null
  coverPath: string | null
  status: string
  isPublicDomain: boolean
  createdAt: string
  publishedAt: string | null
  chapters: Chapter[]
  authors: EditionAuthor[]
  genres: EditionGenre[]
  // SEO fields
  indexable: boolean
  seoTitle: string | null
  seoDescription: string | null
  canonicalOverride: string | null
}

export interface EditionAuthor {
  id: string
  slug: string
  name: string
  order: number
  role: string
}

export interface UpdateEditionAuthor {
  authorId: string
  role: string
}

export interface Chapter {
  id: string
  chapterNumber: number
  slug: string
  title: string
  wordCount: number | null
}

export interface ChapterDetail {
  id: string
  editionId: string
  chapterNumber: number
  slug: string | null
  title: string
  html: string
  wordCount: number | null
  createdAt: string
  updatedAt: string
}

export interface PaginatedResult<T> {
  total: number
  items: T[]
}

export interface Site {
  id: string
  code: string
  name: string
}

export interface AuthorSearchResult {
  id: string
  slug: string
  name: string
  bookCount: number
}

export interface AuthorListItem {
  id: string
  slug: string
  name: string
  photoPath: string | null
  bookCount: number
  createdAt: string
}

export interface AuthorDetail {
  id: string
  siteId: string
  slug: string
  name: string
  bio: string | null
  photoPath: string | null
  indexable: boolean
  seoTitle: string | null
  seoDescription: string | null
  bookCount: number
  createdAt: string
  books: AuthorBook[]
}

export interface AuthorBook {
  editionId: string
  slug: string
  title: string
  role: string
  status: string
}

export interface CreateAuthorResponse {
  id: string
  slug: string
  name: string
  isNew: boolean
}

// Genres
export interface GenreSearchResult {
  id: string
  slug: string
  name: string
  editionCount: number
}

export interface GenreListItem {
  id: string
  slug: string
  name: string
  description: string | null
  indexable: boolean
  editionCount: number
  updatedAt: string
}

export interface GenreDetail {
  id: string
  siteId: string
  slug: string
  name: string
  description: string | null
  indexable: boolean
  seoTitle: string | null
  seoDescription: string | null
  editionCount: number
  createdAt: string
  updatedAt: string
  editions: GenreEdition[]
}

export interface GenreEdition {
  editionId: string
  slug: string
  title: string
  status: string
}

export interface CreateGenreResponse {
  id: string
  slug: string
  name: string
  isNew: boolean
}

export interface EditionGenre {
  id: string
  slug: string
  name: string
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `API error: ${res.status}`)
  }
  return res.json()
}

async function fetchVoid(path: string, init?: RequestInit): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, init)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `API error: ${res.status}`)
  }
}

// Default site ID for general site (seeded)
const DEFAULT_SITE_ID = '11111111-1111-1111-1111-111111111111'

export const adminApi = {
  uploadBook: async (params: {
    file: File
    title: string
    language: string
    siteId?: string
    description?: string
    authorIds?: string[]
    genreId?: string
  }): Promise<UploadResponse> => {
    const formData = new FormData()
    formData.append('file', params.file)
    formData.append('siteId', params.siteId || DEFAULT_SITE_ID)
    formData.append('title', params.title)
    formData.append('language', params.language)
    if (params.description) formData.append('description', params.description)
    if (params.authorIds?.length) formData.append('authorIds', params.authorIds.join(','))
    if (params.genreId) formData.append('genreId', params.genreId)

    return fetchJson<UploadResponse>('/admin/books/upload', {
      method: 'POST',
      body: formData,
    })
  },

  getJobs: async (): Promise<IngestionJob[]> => {
    return fetchJson<IngestionJob[]>('/admin/ingestion/jobs')
  },

  getJob: async (id: string): Promise<IngestionJob> => {
    return fetchJson<IngestionJob>(`/admin/ingestion/jobs/${id}`)
  },

  // Stats
  getStats: async (params?: { siteId?: string }): Promise<AdminStats> => {
    const query = new URLSearchParams()
    if (params?.siteId) query.set('siteId', params.siteId)
    const qs = query.toString()
    return fetchJson<AdminStats>(`/admin/stats${qs ? `?${qs}` : ''}`)
  },

  // Editions
  getEditions: async (params?: { status?: string; search?: string; language?: string; limit?: number; offset?: number }): Promise<PaginatedResult<Edition>> => {
    const query = new URLSearchParams()
    if (params?.status) query.set('status', params.status)
    if (params?.search) query.set('search', params.search)
    if (params?.language) query.set('language', params.language)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return fetchJson<PaginatedResult<Edition>>(`/admin/editions${qs ? `?${qs}` : ''}`)
  },

  getEdition: async (id: string): Promise<EditionDetail> => {
    return fetchJson<EditionDetail>(`/admin/editions/${id}`)
  },

  updateEdition: async (id: string, data: {
    title: string
    description?: string | null
    indexable?: boolean
    seoTitle?: string | null
    seoDescription?: string | null
    canonicalOverride?: string | null
    authors?: UpdateEditionAuthor[] | null
    genreIds?: string[] | null
  }): Promise<void> => {
    await fetchVoid(`/admin/editions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  deleteEdition: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/editions/${id}`, { method: 'DELETE' })
  },

  publishEdition: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/editions/${id}/publish`, { method: 'POST' })
  },

  unpublishEdition: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/editions/${id}/unpublish`, { method: 'POST' })
  },

  uploadEditionCover: async (id: string, file: File): Promise<{ coverPath: string }> => {
    const formData = new FormData()
    formData.append('file', file)
    return fetchJson<{ coverPath: string }>(`/admin/editions/${id}/cover`, {
      method: 'POST',
      body: formData,
    })
  },

  getSites: async (): Promise<Site[]> => {
    return fetchJson<Site[]>('/admin/sites')
  },

  // Authors
  searchAuthors: async (siteId: string, query?: string, limit?: number): Promise<AuthorSearchResult[]> => {
    const params = new URLSearchParams({ siteId })
    if (query) params.set('q', query)
    if (limit) params.set('limit', String(limit))
    return fetchJson<AuthorSearchResult[]>(`/admin/authors/search?${params}`)
  },

  createAuthor: async (siteId: string, name: string): Promise<CreateAuthorResponse> => {
    return fetchJson<CreateAuthorResponse>('/admin/authors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, name }),
    })
  },

  getAuthors: async (params: { siteId: string; search?: string; offset?: number; limit?: number }): Promise<PaginatedResult<AuthorListItem>> => {
    const query = new URLSearchParams({ siteId: params.siteId })
    if (params.search) query.set('search', params.search)
    if (params.offset) query.set('offset', String(params.offset))
    if (params.limit) query.set('limit', String(params.limit))
    return fetchJson<PaginatedResult<AuthorListItem>>(`/admin/authors?${query}`)
  },

  getAuthor: async (id: string): Promise<AuthorDetail> => {
    return fetchJson<AuthorDetail>(`/admin/authors/${id}`)
  },

  updateAuthor: async (id: string, data: {
    name: string
    bio?: string | null
    indexable?: boolean
    seoTitle?: string | null
    seoDescription?: string | null
  }): Promise<void> => {
    await fetchVoid(`/admin/authors/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  deleteAuthor: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/authors/${id}`, { method: 'DELETE' })
  },

  uploadAuthorPhoto: async (id: string, file: File): Promise<{ photoPath: string }> => {
    const formData = new FormData()
    formData.append('file', file)
    return fetchJson<{ photoPath: string }>(`/admin/authors/${id}/photo`, {
      method: 'POST',
      body: formData,
    })
  },

  // Genres
  searchGenres: async (siteId: string, query?: string, limit?: number): Promise<GenreSearchResult[]> => {
    const params = new URLSearchParams({ siteId })
    if (query) params.set('q', query)
    if (limit) params.set('limit', String(limit))
    return fetchJson<GenreSearchResult[]>(`/admin/genres/search?${params}`)
  },

  createGenre: async (siteId: string, name: string): Promise<CreateGenreResponse> => {
    return fetchJson<CreateGenreResponse>('/admin/genres', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, name }),
    })
  },

  getGenres: async (params: { siteId: string; search?: string; indexable?: boolean; offset?: number; limit?: number }): Promise<PaginatedResult<GenreListItem>> => {
    const query = new URLSearchParams({ siteId: params.siteId })
    if (params.search) query.set('search', params.search)
    if (params.indexable !== undefined) query.set('indexable', String(params.indexable))
    if (params.offset) query.set('offset', String(params.offset))
    if (params.limit) query.set('limit', String(params.limit))
    return fetchJson<PaginatedResult<GenreListItem>>(`/admin/genres?${query}`)
  },

  getGenre: async (id: string): Promise<GenreDetail> => {
    return fetchJson<GenreDetail>(`/admin/genres/${id}`)
  },

  updateGenre: async (id: string, data: {
    name: string
    description?: string | null
    indexable?: boolean
    seoTitle?: string | null
    seoDescription?: string | null
  }): Promise<void> => {
    await fetchVoid(`/admin/genres/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  deleteGenre: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/genres/${id}`, { method: 'DELETE' })
  },

  // Chapters
  getChapter: async (id: string): Promise<ChapterDetail> => {
    return fetchJson<ChapterDetail>(`/admin/chapters/${id}`)
  },

  updateChapter: async (id: string, data: { title: string; html: string }): Promise<void> => {
    await fetchVoid(`/admin/chapters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  deleteChapter: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/chapters/${id}`, { method: 'DELETE' })
  },
}
