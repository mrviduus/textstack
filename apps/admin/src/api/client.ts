export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'

/// Origin that serves /storage (strip a trailing /api so podcast mp3 urls resolve).
export const mediaBase = API_BASE.replace(/\/api\/?$/, '')

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
  seoReady: boolean
}

export interface AdminStats {
  totalEditions: number
  publishedEditions: number
  draftEditions: number
  totalChapters: number
  totalAuthors: number
  totalUsers: number
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
  // SEO content blocks
  seoRelevanceText: string | null
  seoThemesJson: string | null
  seoFaqsJson: string | null
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

// Tools types
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

export interface ReimportResult {
  reimported: number
  skipped: number
  failed: number
  total: number
  results: ReimportBookResult[]
}

export interface ReimportBookResult {
  book: string
  editionId: string | null
  chapters: number
  images: number
  wasSkipped: boolean
  error: string | null
}

export interface SyncResult {
  total: number
  alreadyImported: number
  cloned: number
  imported: number
  failed: number
  books: SyncBookResult[]
}

export interface SyncBookResult {
  identifier: string
  status: string
  error: string | null
}

export interface RestoreResult {
  totalInDb: number
  alreadyHaveSource: number
  missingSource: number
  availableOnGitHub: number
  restored: number
  failed: number
  books: SyncBookResult[]
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
  seoReady: boolean
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
  canonicalOverride: string | null
  seoRelevanceText: string | null
  seoThemesJson: string | null
  seoFaqsJson: string | null
  externalLinksJson: string | null
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

// SSG Rebuild
export interface SsgPeriodicSettings {
  enabled: boolean
  intervalHours: number
}

export type SsgRebuildJobStatus = 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Cancelled'
export type SsgRebuildMode = 'Full' | 'Incremental' | 'Specific'

export interface SsgRebuildJobListItem {
  id: string
  siteId: string
  siteCode: string
  mode: SsgRebuildMode
  status: SsgRebuildJobStatus
  totalRoutes: number
  renderedCount: number
  failedCount: number
  concurrency: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface SsgRebuildJobDetail {
  id: string
  siteId: string
  siteCode: string
  mode: SsgRebuildMode
  status: SsgRebuildJobStatus
  totalRoutes: number
  renderedCount: number
  failedCount: number
  concurrency: number
  timeoutMs: number
  error: string | null
  bookSlugs: string[] | null
  authorSlugs: string[] | null
  genreSlugs: string[] | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface SsgRebuildJobStats {
  total: number
  successful: number
  failed: number
  bookRoutes: number
  authorRoutes: number
  genreRoutes: number
  staticRoutes: number
  avgRenderTimeMs: number
}

export interface SsgRebuildResult {
  id: string
  route: string
  routeType: string
  success: boolean
  renderTimeMs: number | null
  error: string | null
  renderedAt: string
}

export interface SsgRebuildPreview {
  totalRoutes: number
  bookCount: number
  authorCount: number
  genreCount: number
  staticCount: number
}

export interface CreateSsgRebuildJobRequest {
  siteId: string
  mode?: SsgRebuildMode
  concurrency?: number
  bookSlugs?: string[]
  authorSlugs?: string[]
  genreSlugs?: string[]
}

// Auto Publish
export type AutoPublishJobStatus = 'Queued' | 'Running' | 'GeneratingSeo' | 'AwaitingReview' | 'Publishing' | 'Completed' | 'Failed' | 'Cancelled'

export interface AutoPublishSettings {
  enabled: boolean
  booksPerDay: number
  hourUtc: number
  requireReview: boolean
  language: string
}

export interface AutoPublishJobListItem {
  id: string
  editionId: string
  editionTitle: string
  status: AutoPublishJobStatus
  generatedEditionSeo: boolean
  generatedAuthorSeo: boolean
  priority: boolean
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface AutoPublishJobDetail extends AutoPublishJobListItem {
  logOutput: string | null
}

export interface CandidateEdition {
  id: string
  title: string
  language: string | null
  chapterCount: number
  hasDescription: boolean
  hasRelevance: boolean
  hasThemes: boolean
  hasFaqs: boolean
  createdAt: string
}

// Session Settings
export interface SessionSettings {
  accessTokenExpiryMinutes: number
  refreshTokenExpiryDays: number
}

// AI Quality
export interface DailyCostPoint {
  date: string
  costUsd: number
}
export interface FeatureSummary {
  featureTag: string
  calls: number
  costUsd: number
  costPerDay: number
  p50LatencyMs: number
  p95LatencyMs: number
  errorRate: number
  tokensIn: number
  tokensOut: number
  dailyCost: DailyCostPoint[]
  latestEvalScore?: number | null
}
export interface EvalStatus {
  running: boolean
  startedAt: string | null
  lastError: string | null
}
export interface PodcastStatusDto {
  jobId: string
  status: 'Queued' | 'Running' | 'Succeeded' | 'Failed'
  audioUrl: string | null
  durationSeconds: number | null
}
export interface AiQualitySummary {
  from: string
  to: string
  totalCalls: number
  totalCostUsd: number
  features: FeatureSummary[]
}
export interface BudgetStatus {
  featureTag: string
  todaySpendUsd: number
  dailyBudgetUsd: number | null
  pctUsed: number
  mode: 'off' | 'fallback' | 'hardstop'
  fallbackKey: string | null
  inFallback: boolean
}
export interface TraceListItem {
  id: string
  featureTag: string
  modelId: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
  hasError: boolean
  createdAt: string
}
export interface TracesPage {
  total: number
  items: TraceListItem[]
}
export interface TraceDetail {
  id: string
  featureTag: string
  modelId: string
  systemPrompt: string | null
  messagesJson: string
  responseText: string | null
  toolCallsJson: string | null
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
  error: string | null
  userId: string | null
  createdAt: string
}
export interface AgentRunListItem {
  id: string
  agent: string
  userId?: string | null
  editionId?: string | null
  status: string
  goal: string
  iterations: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
  hasError: boolean
  createdAt: string
}
export interface AgentRunsPage {
  total: number
  items: AgentRunListItem[]
}
export interface AgentRunDetail {
  id: string
  agent: string
  userId?: string | null
  editionId?: string | null
  status: string
  goal: string
  output?: string | null
  stepsJson: string
  iterations: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
  error?: string | null
  createdAt: string
}
export interface EvalRun {
  id: string
  feature: string
  modelId: string
  judgeModelId: string
  score: number
  n: number
  breakdownJson: string | null
  gitSha: string | null
  createdAt: string
}
export interface CriticDefectEvalResult {
  catchRate: number
  falsePositiveRate: number
  n: number
  passed: boolean
  cases: {
    id: string
    defectType: string
    expectedAxis: string
    caught: boolean
    flagged: boolean
    parseFailed: boolean
  }[]
}
export interface CrewAbEvalResult {
  avgA: number
  avgB: number
  liftPct: number
  costRatio: number
  winRate: number
  n: number
  passed: boolean
  cases?: unknown[]
}
// AI-Agent-1: Enrichment agent eval (calibration / honest-unknown / genre+year accuracy)
export interface EnrichmentEvalResult {
  genreAccuracy: number
  yearAccuracy: number
  calibration: number
  honestUnknownRate: number
  avgToolCalls: number
  n: number
  cases: {
    title: string
    difficulty: string
    genreActual: string | null
    yearActual: number | null
    confidence: number
    toolCalls: number
    genreCorrect: boolean
    yearCorrect: boolean
    saidUnknown: boolean
  }[]
}
// AI-Agent-2: Tutor agent eval (due-coverage / weak-targeting / difficulty / thesis-alignment)
export interface TutorEvalResult {
  dueCoverage: number
  weakTargeting: number
  difficultyAppropriateness: number
  noHallucinationRate: number
  thesisAlignment: number
  avgToolCalls: number
  n: number
  cases: {
    name: string
    planned: number
    dueCoverage: number
    weakTargeting: number
    difficultyAppropriate: boolean
    noHallucination: boolean
    thesisAligned: boolean
    toolCalls: number
  }[]
}
// Shadow comparison
export interface ShadowPair {
  featureTag: string
  primaryModelId: string
  shadowModelId: string
  runs: number
  primaryP50LatencyMs: number
  shadowP50LatencyMs: number
  latencyDeltaMs: number
  primaryCostUsd: number
  shadowCostUsd: number
  costDeltaUsd: number
  projectedMonthlyCostDeltaUsd: number
  primaryTokensOut: number
  shadowTokensOut: number
  tokensOutDelta: number
  exactMatchRate: number
  avgLengthRatio: number
  bothPresentRate: number
  firstSeen: string
  lastSeen: string
}
export interface ShadowSummary {
  from: string
  to: string
  totalRuns: number
  pairs: ShadowPair[]
}
export interface ShadowSample {
  id: string
  primaryResponse: string | null
  shadowResponse: string | null
  primaryLatencyMs: number
  shadowLatencyMs: number
  primaryCostUsd: number
  shadowCostUsd: number
  primaryTokensOut: number
  shadowTokensOut: number
  exactMatch: boolean
  promptHash: string
  primaryTraceId: string | null
  shadowTraceId: string | null
  createdAt: string
}
export interface ShadowSamplesPage {
  total: number
  items: ShadowSample[]
}
// Drift detection (RLOps)
export type DriftAlertState = 'baseline' | 'ok' | 'warning' | 'alerting' | 'insufficient'
export interface DriftPoint {
  feature: string
  day: string // date "YYYY-MM-DD"
  driftScore: number | null
  sampleSize: number
  alertState: DriftAlertState
}
export interface ScheduledEvalPoint {
  feature: string
  modelId: string
  score: number
  n: number
  gitSha: string
  createdAt: string
}
// Model registry
export interface ModelRegistration {
  id: string
  featureTag: string
  providerKey: string
  modelId: string
  status: 'Primary' | 'Shadow' | 'Retired'
  createdAt: string
}
export interface ModelsRegistry {
  models: ModelRegistration[]
}
export interface ModelPromotionResult {
  featureTag: string
  newPrimary: ModelRegistration
  demotedToShadow: ModelRegistration | null
  action: 'Promote' | 'Rollback'
  adminUserId: string | null
  createdAt: string
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
  })
  if (res.status === 401) {
    window.location.href = '/login'
    throw new Error('Session expired')
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `API error: ${res.status}`)
  }
  return res.json()
}

async function fetchVoid(path: string, init?: RequestInit): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
  })
  if (res.status === 401) {
    window.location.href = '/login'
    throw new Error('Session expired')
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `API error: ${res.status}`)
  }
}

// Default site ID for general site (seeded in migrations)
// Single site architecture - this is the only public site
export const DEFAULT_SITE_ID = '11111111-1111-1111-1111-111111111111'

// Book Quality
export type BookQualityJobStatus = 'Queued' | 'Validating' | 'Fixing' | 'Completed' | 'Failed' | 'Cancelled'

export interface BookQualityJobListItem {
  id: string
  editionId: string | null
  userBookId: string | null
  status: BookQualityJobStatus
  issuesFound: number | null
  issuesFixed: number | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  editionTitle: string | null
  userBookTitle: string | null
}

export interface BookQualityJobDetail extends BookQualityJobListItem {
  issuesJson: string | null
  logOutput: string | null
  contentChaptersCleaned: number | null
  contentChaptersRejected: number | null
  contentChaptersSkipped: number | null
}

export interface BookQualitySettings {
  autoQueueAfterIngestion: boolean
  autoQueueForUserBooks: boolean
}

// User Uploads
export interface UserUploadListItem {
  id: string
  title: string
  author: string | null
  language: string
  status: 'Processing' | 'Ready' | 'Failed'
  chapterCount: number
  totalWordCount: number | null
  fileSize: number
  sourceFormat: string | null
  originalFileName: string | null
  userEmail: string
  isGuest: boolean
  errorMessage: string | null
  createdAt: string
  takedownAt: string | null
  takedownReason: string | null
}

export interface UserUploadStats {
  total: number
  processing: number
  ready: number
  failed: number
  guestUploads: number
  registeredUploads: number
  totalStorageBytes: number
}

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
  getEditions: async (params?: { status?: string; search?: string; language?: string; indexable?: boolean; seoReady?: boolean; limit?: number; offset?: number; sort?: string; sortOrder?: string }): Promise<PaginatedResult<Edition>> => {
    const query = new URLSearchParams()
    if (params?.status) query.set('status', params.status)
    if (params?.search) query.set('search', params.search)
    if (params?.language) query.set('language', params.language)
    if (params?.indexable !== undefined) query.set('indexable', String(params.indexable))
    if (params?.seoReady !== undefined) query.set('seoReady', String(params.seoReady))
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    if (params?.sort) query.set('sort', params.sort)
    if (params?.sortOrder) query.set('sortOrder', params.sortOrder)
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
    // SEO content blocks
    seoRelevanceText?: string | null
    seoThemesJson?: string | null
    seoFaqsJson?: string | null
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

  getAuthors: async (params: { siteId: string; search?: string; hasPublishedBooks?: boolean; seoReady?: boolean; offset?: number; limit?: number; sort?: string; sortOrder?: string }): Promise<PaginatedResult<AuthorListItem>> => {
    const query = new URLSearchParams({ siteId: params.siteId })
    if (params.search) query.set('search', params.search)
    if (params.hasPublishedBooks !== undefined) query.set('hasPublishedBooks', String(params.hasPublishedBooks))
    if (params.seoReady !== undefined) query.set('seoReady', String(params.seoReady))
    if (params.offset) query.set('offset', String(params.offset))
    if (params.limit) query.set('limit', String(params.limit))
    if (params.sort) query.set('sort', params.sort)
    if (params.sortOrder) query.set('sortOrder', params.sortOrder)
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
    canonicalOverride?: string | null
    seoRelevanceText?: string | null
    seoThemesJson?: string | null
    seoFaqsJson?: string | null
    externalLinksJson?: string | null
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

  deleteAuthorPhoto: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/authors/${id}/photo`, { method: 'DELETE' })
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

  // Tools
  reprocessAllEditions: async (siteId: string): Promise<ReprocessResult> => {
    return fetchJson<ReprocessResult>(`/admin/reprocess/all?siteId=${siteId}`, {
      method: 'POST',
    })
  },

  reimportTextStack: async (siteId: string, path?: string): Promise<ReimportResult> => {
    return fetchJson<ReimportResult>('/admin/reimport/textstack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, path }),
    })
  },

  syncStandardEbooks: async (siteId: string, limit?: number): Promise<SyncResult> => {
    return fetchJson<SyncResult>('/admin/sync/standardebooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, limit: limit || null }),
    })
  },

  restoreStandardEbooksSources: async (siteId: string, limit?: number): Promise<RestoreResult> => {
    return fetchJson<RestoreResult>('/admin/restore/standardebooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, limit: limit || null }),
    })
  },

  // SSG Rebuild
  getSsgSettings: async (): Promise<SsgPeriodicSettings> => {
    return fetchJson<SsgPeriodicSettings>('/admin/ssg/settings')
  },

  updateSsgSettings: async (data: SsgPeriodicSettings): Promise<void> => {
    await fetchVoid('/admin/ssg/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  getSsgRebuildPreview: async (siteId: string, mode?: SsgRebuildMode): Promise<SsgRebuildPreview> => {
    const query = new URLSearchParams({ siteId })
    if (mode) query.set('mode', mode)
    return fetchJson<SsgRebuildPreview>(`/admin/ssg/preview?${query}`)
  },

  getSsgRebuildJobs: async (params?: { siteId?: string; status?: SsgRebuildJobStatus; limit?: number; offset?: number }): Promise<PaginatedResult<SsgRebuildJobListItem>> => {
    const query = new URLSearchParams()
    if (params?.siteId) query.set('siteId', params.siteId)
    if (params?.status) query.set('status', params.status)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return fetchJson<PaginatedResult<SsgRebuildJobListItem>>(`/admin/ssg/jobs${qs ? `?${qs}` : ''}`)
  },

  getSsgRebuildJob: async (id: string): Promise<SsgRebuildJobDetail> => {
    return fetchJson<SsgRebuildJobDetail>(`/admin/ssg/jobs/${id}`)
  },

  createSsgRebuildJob: async (data: CreateSsgRebuildJobRequest): Promise<{ id: string }> => {
    return fetchJson<{ id: string }>('/admin/ssg/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  startSsgRebuildJob: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/ssg/jobs/${id}/start`, { method: 'POST' })
  },

  cancelSsgRebuildJob: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/ssg/jobs/${id}/cancel`, { method: 'POST' })
  },

  getSsgRebuildJobStats: async (id: string): Promise<SsgRebuildJobStats> => {
    return fetchJson<SsgRebuildJobStats>(`/admin/ssg/jobs/${id}/stats`)
  },

  getSsgRebuildResults: async (id: string, params?: { failed?: boolean; routeType?: string; limit?: number; offset?: number }): Promise<PaginatedResult<SsgRebuildResult>> => {
    const query = new URLSearchParams()
    if (params?.failed !== undefined) query.set('failed', String(params.failed))
    if (params?.routeType) query.set('routeType', params.routeType)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return fetchJson<PaginatedResult<SsgRebuildResult>>(`/admin/ssg/jobs/${id}/results${qs ? `?${qs}` : ''}`)
  },

  // Session Settings
  getSessionSettings: async (): Promise<SessionSettings> => {
    return fetchJson<SessionSettings>('/admin/settings/session')
  },

  updateSessionSettings: async (data: Partial<SessionSettings>): Promise<SessionSettings> => {
    return fetchJson<SessionSettings>('/admin/settings/session', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  // Auto Publish
  getAutoPublishSettings: async (): Promise<AutoPublishSettings> => {
    return fetchJson<AutoPublishSettings>('/admin/autopublish/settings')
  },

  updateAutoPublishSettings: async (data: AutoPublishSettings): Promise<void> => {
    await fetchVoid('/admin/autopublish/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  getAutoPublishJobs: async (params?: { limit?: number; offset?: number; status?: string }): Promise<PaginatedResult<AutoPublishJobListItem>> => {
    const query = new URLSearchParams()
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    if (params?.status) query.set('status', params.status)
    const qs = query.toString()
    return fetchJson<PaginatedResult<AutoPublishJobListItem>>(`/admin/autopublish/jobs${qs ? `?${qs}` : ''}`)
  },

  getAutoPublishJob: async (id: string): Promise<AutoPublishJobDetail> => {
    return fetchJson<AutoPublishJobDetail>(`/admin/autopublish/jobs/${id}`)
  },

  approveAutoPublishJob: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/autopublish/jobs/${id}/approve`, { method: 'POST' })
  },

  rejectAutoPublishJob: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/autopublish/jobs/${id}/reject`, { method: 'POST' })
  },

  retryAutoPublishJob: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/autopublish/jobs/${id}/retry`, { method: 'POST' })
  },

  triggerAutoPublish: async (): Promise<{ id: string }> => {
    return fetchJson<{ id: string }>('/admin/autopublish/trigger', { method: 'POST' })
  },

  queueAutoPublishEdition: async (editionId: string): Promise<{ id: string }> => {
    return fetchJson<{ id: string }>(`/admin/autopublish/queue/${editionId}`, { method: 'POST' })
  },

  getAutoPublishCandidates: async (limit?: number): Promise<CandidateEdition[]> => {
    const qs = limit ? `?limit=${limit}` : ''
    return fetchJson<CandidateEdition[]>(`/admin/autopublish/candidates${qs}`)
  },

  // User Uploads
  getUserUploads: async (params?: { status?: string; userType?: string; search?: string; limit?: number; offset?: number }): Promise<PaginatedResult<UserUploadListItem>> => {
    const query = new URLSearchParams()
    if (params?.status) query.set('status', params.status)
    if (params?.userType) query.set('userType', params.userType)
    if (params?.search) query.set('search', params.search)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return fetchJson<PaginatedResult<UserUploadListItem>>(`/admin/user-uploads${qs ? `?${qs}` : ''}`)
  },

  getUserUploadStats: async (): Promise<UserUploadStats> => {
    return fetchJson<UserUploadStats>('/admin/user-uploads/stats')
  },

  deleteUserUpload: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/user-uploads/${id}`, { method: 'DELETE' })
  },

  takedownUserUpload: async (id: string, reason: string): Promise<void> => {
    await fetchVoid(`/admin/user-uploads/${id}/takedown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
  },

  // Book Quality
  getBookQualitySettings: async (): Promise<BookQualitySettings> => {
    return fetchJson<BookQualitySettings>('/admin/quality/settings')
  },

  updateBookQualitySettings: async (data: BookQualitySettings): Promise<void> => {
    await fetchVoid('/admin/quality/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  getBookQualityJobs: async (params?: { limit?: number; offset?: number; status?: string }): Promise<PaginatedResult<BookQualityJobListItem>> => {
    const query = new URLSearchParams()
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    if (params?.status) query.set('status', params.status)
    const qs = query.toString()
    return fetchJson<PaginatedResult<BookQualityJobListItem>>(`/admin/quality/jobs${qs ? `?${qs}` : ''}`)
  },

  getBookQualityJob: async (id: string): Promise<BookQualityJobDetail> => {
    return fetchJson<BookQualityJobDetail>(`/admin/quality/jobs/${id}`)
  },

  createBookQualityJob: async (data: { editionId?: string; userBookId?: string }): Promise<{ id: string }> => {
    return fetchJson<{ id: string }>('/admin/quality/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  cancelBookQualityJob: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/quality/jobs/${id}/cancel`, { method: 'POST' })
  },

  retryBookQualityJob: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/quality/jobs/${id}/retry`, { method: 'POST' })
  },

  // AI Quality
  getAiQualitySummary: async (params?: { from?: string; to?: string; feature?: string }): Promise<AiQualitySummary> => {
    const query = new URLSearchParams()
    if (params?.from) query.set('from', params.from)
    if (params?.to) query.set('to', params.to)
    if (params?.feature) query.set('feature', params.feature)
    const qs = query.toString()
    return fetchJson<AiQualitySummary>(`/admin/ai-quality/summary${qs ? `?${qs}` : ''}`)
  },

  getBudgets: async (): Promise<BudgetStatus[]> => {
    return fetchJson<BudgetStatus[]>('/admin/ai-quality/budgets')
  },

  getAiTraces: async (params?: { feature?: string; q?: string; limit?: number; offset?: number }): Promise<TracesPage> => {
    const query = new URLSearchParams()
    if (params?.feature) query.set('feature', params.feature)
    if (params?.q) query.set('q', params.q)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return fetchJson<TracesPage>(`/admin/ai-quality/traces${qs ? `?${qs}` : ''}`)
  },

  getAiTrace: async (id: string): Promise<TraceDetail> => {
    return fetchJson<TraceDetail>(`/admin/ai-quality/traces/${id}`)
  },

  getAgentRuns: async (params?: { agent?: string; limit?: number; offset?: number }): Promise<AgentRunsPage> => {
    const query = new URLSearchParams()
    if (params?.agent) query.set('agent', params.agent)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return fetchJson<AgentRunsPage>(`/admin/ai-quality/agent-runs${qs ? `?${qs}` : ''}`)
  },

  getAgentRun: async (id: string): Promise<AgentRunDetail> => {
    return fetchJson<AgentRunDetail>(`/admin/ai-quality/agent-runs/${id}`)
  },

  getAiEvals: async (params?: { feature?: string; limit?: number }): Promise<EvalRun[]> => {
    const query = new URLSearchParams()
    if (params?.feature) query.set('feature', params.feature)
    if (params?.limit) query.set('limit', String(params.limit))
    const qs = query.toString()
    return fetchJson<EvalRun[]>(`/admin/ai-quality/evals${qs ? `?${qs}` : ''}`)
  },

  runAiEvals: async (body: { features?: string[]; judge?: 'ollama' | 'openai' }): Promise<void> => {
    await fetchJson('/admin/ai-quality/evals/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  getAiEvalStatus: async (): Promise<EvalStatus> => {
    return fetchJson<EvalStatus>('/admin/ai-quality/evals/status')
  },

  runCriticDefectEval: async (): Promise<CriticDefectEvalResult> => {
    return fetchJson<CriticDefectEvalResult>('/admin/ai-quality/evals/criticdefects/run', {
      method: 'POST',
    })
  },

  runCrewAbEval: async (): Promise<CrewAbEvalResult> => {
    return fetchJson<CrewAbEvalResult>('/admin/ai-quality/evals/crew-ab/run', {
      method: 'POST',
    })
  },

  // AI-Agent eval gates (synchronous; each calls the paid model over the golden set).
  // Enrichment uses the backend's Enrichment:ConfidenceThreshold default — no client param.
  runEnrichmentEval: async (): Promise<EnrichmentEvalResult> => {
    return fetchJson<EnrichmentEvalResult>('/admin/ai-quality/enrichment/eval', {
      method: 'POST',
    })
  },


  runTutorEval: async (): Promise<TutorEvalResult> => {
    return fetchJson<TutorEvalResult>('/admin/ai-quality/tutor/eval', {
      method: 'POST',
    })
  },

  getShadowSummary: async (params: { from?: string; to?: string; feature?: string }): Promise<ShadowSummary> => {
    const query = new URLSearchParams()
    if (params.from) query.set('from', params.from)
    if (params.to) query.set('to', params.to)
    if (params.feature) query.set('feature', params.feature)
    const qs = query.toString()
    return fetchJson<ShadowSummary>(`/admin/ai-quality/shadow/summary${qs ? `?${qs}` : ''}`)
  },

  getShadowSamples: async (params: { feature: string; primaryModelId: string; shadowModelId: string; limit?: number; offset?: number }): Promise<ShadowSamplesPage> => {
    const query = new URLSearchParams()
    query.set('feature', params.feature)
    query.set('primaryModelId', params.primaryModelId)
    query.set('shadowModelId', params.shadowModelId)
    if (params.limit) query.set('limit', String(params.limit))
    if (params.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return fetchJson<ShadowSamplesPage>(`/admin/ai-quality/shadow/samples${qs ? `?${qs}` : ''}`)
  },

  getDrift: async (params?: { feature?: string; days?: number }): Promise<DriftPoint[]> => {
    const query = new URLSearchParams()
    if (params?.feature) query.set('feature', params.feature)
    if (params?.days) query.set('days', String(params.days))
    const qs = query.toString()
    return fetchJson<DriftPoint[]>(`/admin/ai-quality/drift${qs ? `?${qs}` : ''}`)
  },

  getEvalTrend: async (params?: { feature?: string; limit?: number }): Promise<ScheduledEvalPoint[]> => {
    const query = new URLSearchParams()
    if (params?.feature) query.set('feature', params.feature)
    if (params?.limit) query.set('limit', String(params.limit))
    const qs = query.toString()
    return fetchJson<ScheduledEvalPoint[]>(`/admin/ai-quality/drift/eval-trend${qs ? `?${qs}` : ''}`)
  },

  getModels: async (): Promise<ModelsRegistry> => {
    return fetchJson<ModelsRegistry>('/admin/ai-quality/models')
  },

  promoteModel: async (id: string): Promise<ModelPromotionResult> => {
    return fetchJson<ModelPromotionResult>(`/admin/ai-quality/models/${id}/promote`, {
      method: 'POST',
    })
  },

  rollbackModel: async (feature: string): Promise<ModelPromotionResult> => {
    return fetchJson<ModelPromotionResult>(`/admin/ai-quality/models/${encodeURIComponent(feature)}/rollback`, {
      method: 'POST',
    })
  },

  // Podcasts
  generatePodcast: async (editionId: string, lang?: string, force?: boolean): Promise<PodcastStatusDto> => {
    return fetchJson<PodcastStatusDto>('/admin/podcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editionId, lang, force }),
    })
  },

  getPodcastStatus: async (editionId: string): Promise<PodcastStatusDto | null> => {
    try {
      return await fetchJson<PodcastStatusDto>(`/admin/podcasts/${editionId}`)
    } catch {
      return null // 404 = not generated yet
    }
  },

  // ── SEO Backfill ──
  getSeoCoverage: async (): Promise<SeoCoverageStat[]> => {
    return fetchJson<SeoCoverageStat[]>('/admin/seo/coverage')
  },

  getSeoGaps: async (params: { entityType: string; language?: string; limit?: number }): Promise<SeoGapRow[]> => {
    const qs = new URLSearchParams({ entityType: params.entityType })
    if (params.language) qs.set('language', params.language)
    if (params.limit !== undefined) qs.set('limit', String(params.limit))
    return fetchJson<SeoGapRow[]>(`/admin/seo/gaps?${qs}`)
  },

  getSeoTemplates: async (params?: { entityType?: string; onlyActive?: boolean }): Promise<SeoTemplateListItem[]> => {
    const qs = new URLSearchParams()
    if (params?.entityType) qs.set('entityType', params.entityType)
    if (params?.onlyActive !== undefined) qs.set('onlyActive', params.onlyActive.toString())
    const tail = qs.toString()
    return fetchJson<SeoTemplateListItem[]>(`/admin/seo/templates${tail ? `?${tail}` : ''}`)
  },

  getSeoTemplate: async (id: string): Promise<SeoTemplateDetail> => {
    return fetchJson<SeoTemplateDetail>(`/admin/seo/templates/${id}`)
  },

  createSeoTemplate: async (data: SeoTemplateUpsert): Promise<{ id: string; version: number }> => {
    return fetchJson(`/admin/seo/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  updateSeoTemplate: async (id: string, data: SeoTemplateUpsert): Promise<{ id: string; version: number }> => {
    return fetchJson(`/admin/seo/templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  deactivateSeoTemplate: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/seo/templates/${id}`, { method: 'DELETE' })
  },

  previewSeoTemplate: async (id: string, entityId: string): Promise<SeoTemplatePreview> => {
    return fetchJson<SeoTemplatePreview>(`/admin/seo/templates/${id}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityId }),
    })
  },

  getSeoJobs: async (params?: { status?: string; entityType?: string; offset?: number; limit?: number }): Promise<{ total: number; items: SeoBackfillJobListItem[] }> => {
    const qs = new URLSearchParams()
    if (params?.status) qs.set('status', params.status)
    if (params?.entityType) qs.set('entityType', params.entityType)
    if (params?.offset !== undefined) qs.set('offset', params.offset.toString())
    if (params?.limit !== undefined) qs.set('limit', params.limit.toString())
    const tail = qs.toString()
    return fetchJson(`/admin/seo/jobs${tail ? `?${tail}` : ''}`)
  },

  getSeoJob: async (id: string): Promise<SeoBackfillJobDetail> => {
    return fetchJson<SeoBackfillJobDetail>(`/admin/seo/jobs/${id}`)
  },

  approveSeoJob: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/seo/jobs/${id}/approve`, { method: 'POST' })
  },

  revertSeoJob: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/seo/jobs/${id}/revert`, { method: 'POST' })
  },

  retrySeoJob: async (id: string): Promise<void> => {
    await fetchVoid(`/admin/seo/jobs/${id}/retry`, { method: 'POST' })
  },

  queueSeoEntity: async (data: { entityType: string; entityId: string; fields: string[]; language?: string; requireReview?: boolean }): Promise<{ jobId: string }> => {
    return fetchJson(`/admin/seo/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  getSeoSettings: async (): Promise<SeoBackfillSettings> => {
    return fetchJson<SeoBackfillSettings>('/admin/seo/settings')
  },

  updateSeoSettings: async (data: Partial<SeoBackfillSettings>): Promise<void> => {
    await fetchVoid('/admin/seo/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

}

// SEO Backfill types
export interface SeoCoverageStat {
  entityType: string
  fieldType: string
  total: number
  populated: number
  missing: number
}

export interface SeoGapRow {
  entityType: string
  entityId: string
  label: string
  language: string
  missingFields: string[]
}

export interface SeoTemplateListItem {
  id: string
  entityType: string
  fieldType: string
  languageCode: string
  name: string
  description: string | null
  model: string
  maxTokens: number
  temperature: number
  trustLevel: string
  version: number
  isActive: boolean
  updatedAt: string
}

export interface SeoTemplateDetail extends SeoTemplateListItem {
  promptTemplate: string
  outputSchema: string
  createdAt: string
}

export interface SeoTemplateUpsert {
  entityType: string
  fieldType: string
  languageCode: string
  name: string
  description?: string
  promptTemplate: string
  outputSchema: string
  model?: string
  maxTokens?: number
  temperature?: number
  trustLevel?: string
}

export interface SeoTemplatePreview {
  rendered: string
  missingPlaceholders: string[]
  values: Record<string, string | null>
}

export interface SeoBackfillJobListItem {
  id: string
  entityType: string
  entityId: string
  targetFields: string[]
  status: string
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  triggeredBy: string
  requiresReview: boolean
}

export interface SeoBackfillJobDetail extends SeoBackfillJobListItem {
  templateIds: string[]
  templateVersions: number[]
  inputSnapshot: string | null
  renderedPrompts: string | null
  rawOutputs: string | null
  generatedContent: string | null
  beforeSnapshot: string | null
  afterSnapshot: string | null
  approvedByUserId: string | null
  approvedAt: string | null
}

export interface SeoBackfillSettings {
  enabled: boolean
  jobsPerRun: number
  intervalSeconds: number
  languageFilter: string[]
  entityTypeFilter: string[]
  ssgRebuildBatchMinutes: number
}
