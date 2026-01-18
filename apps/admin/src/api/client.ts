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

export interface SiteListItem {
  id: string
  code: string
  primaryDomain: string
  defaultLanguage: string
  theme: string
  adsEnabled: boolean
  indexingEnabled: boolean
  sitemapEnabled: boolean
  maxWordsPerPart: number
  domainCount: number
  workCount: number
}

export interface SiteDetail {
  id: string
  code: string
  primaryDomain: string
  defaultLanguage: string
  theme: string
  adsEnabled: boolean
  indexingEnabled: boolean
  sitemapEnabled: boolean
  featuresJson: string
  maxWordsPerPart: number
  createdAt: string
  updatedAt: string
  domains: SiteDomain[]
}

export interface SiteDomain {
  id: string
  domain: string
  isPrimary: boolean
}

export interface ReprocessResult {
  editionsProcessed: number
  chaptersSplit: number
  newPartsCreated: number
  totalChaptersAfter: number
  editions: ReprocessedEdition[]
}

export interface ReprocessedEdition {
  editionId: string
  title: string
  chaptersSplit: number
  newParts: number
  error: string | null
}

// Legacy interface for backwards compatibility
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
  hasPublishedBooks: boolean
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

export interface AuthorStats {
  total: number
  withPublishedBooks: number
  withoutPublishedBooks: number
  totalBooks: number
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
  hasPublishedBooks: boolean
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

export interface GenreStats {
  total: number
  withPublishedBooks: number
  withoutPublishedBooks: number
  totalEditions: number
}

export interface EditionGenre {
  id: string
  slug: string
  name: string
}

// SEO Crawl
export type SeoCrawlJobStatus = 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Cancelled'

export interface SeoCrawlJobListItem {
  id: string
  siteId: string
  siteCode: string
  status: SeoCrawlJobStatus
  totalUrls: number
  maxPages: number
  pagesCrawled: number
  errorsCount: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface SeoCrawlJobDetail {
  id: string
  siteId: string
  siteCode: string
  status: SeoCrawlJobStatus
  totalUrls: number
  maxPages: number
  concurrency: number
  crawlDelayMs: number
  userAgent: string
  pagesCrawled: number
  errorsCount: number
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface SeoCrawlJobStats {
  total: number
  status2xx: number
  status3xx: number
  status4xx: number
  status5xx: number
  missingTitle: number
  missingDescription: number
  missingH1: number
  noIndex: number
}

export interface SeoCrawlResult {
  id: string
  url: string
  urlType: string
  statusCode: number | null
  contentType: string | null
  htmlBytes: number | null
  title: string | null
  metaDescription: string | null
  h1: string | null
  canonical: string | null
  metaRobots: string | null
  xRobotsTag: string | null
  fetchedAt: string
  fetchError: string | null
}

export interface SeoCrawlPreview {
  totalUrls: number
  bookCount: number
  authorCount: number
  genreCount: number
}

export interface CreateSeoCrawlJobRequest {
  siteId: string
  maxPages?: number
  crawlDelayMs?: number
  concurrency?: number
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
  getEditions: async (params?: { status?: string; search?: string; language?: string; indexable?: boolean; limit?: number; offset?: number }): Promise<PaginatedResult<Edition>> => {
    const query = new URLSearchParams()
    if (params?.status) query.set('status', params.status)
    if (params?.search) query.set('search', params.search)
    if (params?.language) query.set('language', params.language)
    if (params?.indexable !== undefined) query.set('indexable', String(params.indexable))
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

  deleteEditionCover: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/editions/${id}/cover`, { method: 'DELETE' })
  },

  getSites: async (): Promise<SiteListItem[]> => {
    return fetchJson<SiteListItem[]>('/admin/sites')
  },

  getSite: async (id: string): Promise<SiteDetail> => {
    return fetchJson<SiteDetail>(`/admin/sites/${id}`)
  },

  updateSite: async (id: string, data: {
    primaryDomain?: string
    defaultLanguage?: string
    theme?: string
    adsEnabled?: boolean
    indexingEnabled?: boolean
    sitemapEnabled?: boolean
    featuresJson?: string
    maxWordsPerPart?: number
  }): Promise<void> => {
    await fetchVoid(`/admin/sites/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  reprocessChapters: async (siteId: string): Promise<ReprocessResult> => {
    return fetchJson<ReprocessResult>(`/admin/reprocess/split-existing?siteId=${siteId}`, {
      method: 'POST',
    })
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

  getAuthors: async (params: { siteId: string; search?: string; hasPublishedBooks?: boolean; offset?: number; limit?: number }): Promise<PaginatedResult<AuthorListItem>> => {
    const query = new URLSearchParams({ siteId: params.siteId })
    if (params.search) query.set('search', params.search)
    if (params.hasPublishedBooks !== undefined) query.set('hasPublishedBooks', String(params.hasPublishedBooks))
    if (params.offset) query.set('offset', String(params.offset))
    if (params.limit) query.set('limit', String(params.limit))
    return fetchJson<PaginatedResult<AuthorListItem>>(`/admin/authors?${query}`)
  },

  getAuthorStats: async (siteId: string): Promise<AuthorStats> => {
    return fetchJson<AuthorStats>(`/admin/authors/stats?siteId=${siteId}`)
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

  getGenres: async (params: { siteId: string; search?: string; indexable?: boolean; hasPublishedBooks?: boolean; offset?: number; limit?: number }): Promise<PaginatedResult<GenreListItem>> => {
    const query = new URLSearchParams({ siteId: params.siteId })
    if (params.search) query.set('search', params.search)
    if (params.indexable !== undefined) query.set('indexable', String(params.indexable))
    if (params.hasPublishedBooks !== undefined) query.set('hasPublishedBooks', String(params.hasPublishedBooks))
    if (params.offset) query.set('offset', String(params.offset))
    if (params.limit) query.set('limit', String(params.limit))
    return fetchJson<PaginatedResult<GenreListItem>>(`/admin/genres?${query}`)
  },

  getGenreStats: async (siteId: string): Promise<GenreStats> => {
    return fetchJson<GenreStats>(`/admin/genres/stats?siteId=${siteId}`)
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

  // SEO Crawl
  getSeoCrawlPreview: async (siteId: string): Promise<SeoCrawlPreview> => {
    return fetchJson<SeoCrawlPreview>(`/admin/seo-crawl/preview?siteId=${siteId}`)
  },

  getSeoCrawlJobs: async (params?: { siteId?: string; status?: SeoCrawlJobStatus; limit?: number; offset?: number }): Promise<PaginatedResult<SeoCrawlJobListItem>> => {
    const query = new URLSearchParams()
    if (params?.siteId) query.set('siteId', params.siteId)
    if (params?.status) query.set('status', params.status)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return fetchJson<PaginatedResult<SeoCrawlJobListItem>>(`/admin/seo-crawl/jobs${qs ? `?${qs}` : ''}`)
  },

  getSeoCrawlJob: async (id: string): Promise<SeoCrawlJobDetail> => {
    return fetchJson<SeoCrawlJobDetail>(`/admin/seo-crawl/jobs/${id}`)
  },

  createSeoCrawlJob: async (data: CreateSeoCrawlJobRequest): Promise<{ id: string }> => {
    return fetchJson<{ id: string }>('/admin/seo-crawl/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  startSeoCrawlJob: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/seo-crawl/jobs/${id}/start`, { method: 'POST' })
  },

  cancelSeoCrawlJob: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/seo-crawl/jobs/${id}/cancel`, { method: 'POST' })
  },

  getSeoCrawlJobStats: async (id: string): Promise<SeoCrawlJobStats> => {
    return fetchJson<SeoCrawlJobStats>(`/admin/seo-crawl/jobs/${id}/stats`)
  },

  getSeoCrawlResults: async (id: string, params?: { statusCodeMin?: number; statusCodeMax?: number; missingTitle?: boolean; missingDescription?: boolean; missingH1?: boolean; limit?: number; offset?: number }): Promise<PaginatedResult<SeoCrawlResult>> => {
    const query = new URLSearchParams()
    if (params?.statusCodeMin !== undefined) query.set('statusCodeMin', String(params.statusCodeMin))
    if (params?.statusCodeMax !== undefined) query.set('statusCodeMax', String(params.statusCodeMax))
    if (params?.missingTitle !== undefined) query.set('missingTitle', String(params.missingTitle))
    if (params?.missingDescription !== undefined) query.set('missingDescription', String(params.missingDescription))
    if (params?.missingH1 !== undefined) query.set('missingH1', String(params.missingH1))
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return fetchJson<PaginatedResult<SeoCrawlResult>>(`/admin/seo-crawl/jobs/${id}/results${qs ? `?${qs}` : ''}`)
  },

  getSeoCrawlExportUrl: (id: string): string => {
    return `${API_BASE}/admin/seo-crawl/jobs/${id}/export.csv`
  },
}
