import { authFetch } from './client'

// --- Types ---

export interface VocabWordDto {
  id: string
  word: string
  language: string
  translation: string | null
  definition: string | null
  editionId: string | null
  chapterId: string | null
  userBookId: string | null
  sentence: string | null
  bookTitle: string | null
  hint: string | null
  stage: number
  intervalDays: number
  consecutiveCorrect: number
  nextReviewAt: string
  lastReviewedAt: string | null
  totalReviews: number
  correctReviews: number
  createdAt: string
  updatedAt: string
}

export interface SaveWordRequest {
  word: string
  language: string
  translation?: string | null
  definition?: string | null
  editionId?: string | null
  chapterId?: string | null
  userBookId?: string | null
  sentence?: string | null
  bookTitle?: string | null
  nativeLanguage?: string | null
}

export interface UpdateWordRequest {
  translation?: string | null
  definition?: string | null
}

export interface ReviewCardDto {
  wordId: string
  word: string
  translation: string | null
  definition: string | null
  reviewMode: 'multiple_choice' | 'context'
  blankSentence: string | null
  originalSentence: string | null
  bookTitle: string | null
  hint: string | null
  explanation: string | null
  isNew: boolean
  options: string[] | null
  correctOptionIndex: number | null
}

export interface WeeklyProgressDto {
  used: number
  budget: number
  remaining: number
  resetAt: string
}

export interface ReviewQueueResponse {
  cards: ReviewCardDto[]
  totalDue: number
  weeklyProgress: WeeklyProgressDto | null
}

export interface VocabSettingsDto {
  dailyNewCap: number
  weeklyReviewBudget: number
  frequencyFilterEnabled: boolean
  clusteringEnabled: boolean
  autoRetireEnabled: boolean
}

export type SelfAssessment = 'forgot' | 'almost' | 'knew'

export interface SubmitReviewRequest {
  wordId: string
  isCorrect: boolean
  responseTimeMs: number
  selfAssessment?: SelfAssessment
  isPractice?: boolean
}

export interface SubmitReviewResponse {
  wordId: string
  previousStage: number
  newStage: number
  stageChanged: boolean
  nextIntervalDays: number
  nextReviewAt: string
  totalReviews: number
  correctReviews: number
}

export interface DailyCapDto {
  used: number
  cap: number
  remaining: number
}

export interface VocabStatsDto {
  totalWords: number
  byStage: {
    new: number
    recognition: number
    recall: number
    context: number
    mastered: number
  }
  dueNow: number
  retiredCount: number
  pendingCount: number
  lookupCount: number
  clusterCount: number
  dailyCap: DailyCapDto
  weeklyProgress: WeeklyProgressDto
  reviewedToday: number
  correctRateToday: number
  srsReviewedToday: number
  srsCorrectRateToday: number
  practicedToday: number
  practiceCorrectRateToday: number
  totalReviews: number
  overallCorrectRate: number
  streak: number
  wordsByBook: { editionId: string | null; userBookId: string | null; bookTitle: string; count: number }[]
}

export type SaveWordOutcome = 'srs' | 'pending' | 'lookup' | 'lookup_pending' | 'already_saved'

export interface SaveWordResponse {
  outcome: SaveWordOutcome
  word: VocabWordDto | null
  pendingId: string | null
  lookupId: string | null
  tapsRemaining: number | null
  reason: string | null
}

export interface WordLookupDto {
  id: string
  word: string
  language: string
  zipfRank: number | null
  tapCount: number
  sentence: string | null
  bookTitle: string | null
  editionId: string | null
  chapterId: string | null
  userBookId: string | null
  lastTranslation: string | null
  firstTappedAt: string
  lastTappedAt: string
}

export interface WordLookupListResponse {
  items: WordLookupDto[]
  total: number
}

export interface PendingVocabWordDto {
  id: string
  word: string
  language: string
  translation: string | null
  definition: string | null
  editionId: string | null
  chapterId: string | null
  userBookId: string | null
  sentence: string | null
  bookTitle: string | null
  priority: number
  source: string
  createdAt: string
}

export interface PendingListResponse {
  items: PendingVocabWordDto[]
  dailyUsed: number
  dailyCap: number
  dailyRemaining: number
}

// --- API Functions ---

export async function saveWord(data: SaveWordRequest): Promise<SaveWordResponse> {
  return authFetch<SaveWordResponse>('/me/vocabulary/words', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function getPendingWords(): Promise<PendingListResponse> {
  return authFetch<PendingListResponse>('/me/vocabulary/pending')
}

export async function promotePendingWord(id: string): Promise<VocabWordDto> {
  return authFetch<VocabWordDto>(`/me/vocabulary/pending/${id}/promote`, { method: 'POST' })
}

export async function dismissPendingWord(id: string): Promise<void> {
  await authFetch<void>(`/me/vocabulary/pending/${id}`, { method: 'DELETE' })
}

export async function getLookups(params?: { limit?: number; offset?: number }): Promise<WordLookupListResponse> {
  const query = new URLSearchParams()
  if (params?.limit) query.set('limit', String(params.limit))
  if (params?.offset) query.set('offset', String(params.offset))
  const qs = query.toString()
  return authFetch<WordLookupListResponse>(`/me/vocabulary/lookups${qs ? `?${qs}` : ''}`)
}

export async function promoteLookup(id: string): Promise<VocabWordDto> {
  return authFetch<VocabWordDto>(`/me/vocabulary/lookups/${id}/promote`, { method: 'POST' })
}

export async function dismissLookup(id: string): Promise<void> {
  await authFetch<void>(`/me/vocabulary/lookups/${id}`, { method: 'DELETE' })
}

export async function getWords(params?: {
  stage?: string
  language?: string
  editionId?: string
  search?: string
  sort?: string
  reviewedSince?: string
  limit?: number
  offset?: number
}): Promise<{ total: number; items: VocabWordDto[] }> {
  const query = new URLSearchParams()
  if (params?.stage) query.set('stage', params.stage)
  if (params?.language) query.set('language', params.language)
  if (params?.editionId) query.set('editionId', params.editionId)
  if (params?.search) query.set('search', params.search)
  if (params?.sort) query.set('sort', params.sort)
  if (params?.reviewedSince) query.set('reviewedSince', params.reviewedSince)
  if (params?.limit) query.set('limit', String(params.limit))
  if (params?.offset) query.set('offset', String(params.offset))
  const qs = query.toString()
  return authFetch<{ total: number; items: VocabWordDto[] }>(`/me/vocabulary/words${qs ? `?${qs}` : ''}`)
}

export async function deleteWord(id: string): Promise<void> {
  await authFetch<void>(`/me/vocabulary/words/${id}`, { method: 'DELETE' })
}

export async function deleteAllWords(): Promise<{ deleted: number }> {
  return authFetch<{ deleted: number }>('/me/vocabulary/words', { method: 'DELETE' })
}

export async function updateWord(id: string, data: UpdateWordRequest): Promise<VocabWordDto> {
  return authFetch<VocabWordDto>(`/me/vocabulary/words/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function getReviewQueue(limit?: number, includeAll?: boolean, practice?: boolean): Promise<ReviewQueueResponse> {
  const params = new URLSearchParams()
  if (limit) params.set('limit', String(limit))
  if (includeAll) params.set('includeAll', 'true')
  if (practice) params.set('practice', 'true')
  const qs = params.toString()
  return authFetch<ReviewQueueResponse>(`/me/vocabulary/review${qs ? `?${qs}` : ''}`)
}

export async function submitReview(data: SubmitReviewRequest): Promise<SubmitReviewResponse> {
  return authFetch<SubmitReviewResponse>('/me/vocabulary/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function getVocabStats(): Promise<VocabStatsDto> {
  return authFetch<VocabStatsDto>('/me/vocabulary/stats')
}

export interface VocabDailyStatDto {
  date: string
  wordsAdded: number
  reviewCount: number
  correctCount: number
  practiceCount: number
  srsCount: number
}

export async function getVocabDailyStats(tz?: number): Promise<VocabDailyStatDto[]> {
  const params = new URLSearchParams()
  if (tz != null) params.set('tz', String(tz))
  const qs = params.toString()
  return authFetch<VocabDailyStatDto[]>(`/me/vocabulary/stats/daily${qs ? `?${qs}` : ''}`)
}

// --- Reader vocab (lightweight) ---

export interface ReaderVocabWordDto {
  id: string
  word: string
  stage: number
  translation?: string
}

export async function getReaderVocab(): Promise<ReaderVocabWordDto[]> {
  return authFetch<ReaderVocabWordDto[]>('/me/vocabulary/words/reader')
}

export async function markAsKnown(id: string): Promise<VocabWordDto> {
  return authFetch<VocabWordDto>(`/me/vocabulary/words/${id}/known`, { method: 'PUT' })
}

// --- Anti-spiral (Phase 1) ---

export async function getVocabSettings(): Promise<VocabSettingsDto> {
  return authFetch<VocabSettingsDto>('/me/vocabulary/settings')
}

export async function updateVocabSettings(data: VocabSettingsDto): Promise<VocabSettingsDto> {
  return authFetch<VocabSettingsDto>('/me/vocabulary/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function unretireWord(id: string): Promise<VocabWordDto> {
  return authFetch<VocabWordDto>(`/me/vocabulary/words/${id}/unretire`, { method: 'POST' })
}

// --- Anti-spiral F3: thematic clusters ---

export interface WordClusterDto {
  id: string
  title: string
  theme: string | null
  editionId: string | null
  userBookId: string | null
  bookTitle: string | null
  memberCount: number
  cohesionScore: number
  isConfirmed: boolean
  createdAt: string
}

export interface ClusterBonusResponse {
  clusterId: string
  title: string
  cards: ReviewCardDto[]
}

export async function getClusters(): Promise<{ items: WordClusterDto[] }> {
  return authFetch<{ items: WordClusterDto[] }>('/me/vocabulary/clusters')
}

export async function startClusterBonus(id: string): Promise<ClusterBonusResponse> {
  return authFetch<ClusterBonusResponse>(`/me/vocabulary/clusters/${id}/start-bonus`, { method: 'POST' })
}

export async function dismissCluster(id: string): Promise<void> {
  await authFetch<void>(`/me/vocabulary/clusters/${id}/dismiss`, { method: 'POST' })
}

export async function completeCluster(id: string): Promise<void> {
  await authFetch<void>(`/me/vocabulary/clusters/${id}/complete`, { method: 'POST' })
}

// --- Concept clusters (AI-060) ---

export interface ConceptCluster {
  id: string
  title: string
  theme: string | null
  memberCount: number
  cohesionScore: number
  words: string[]
}

export async function getConcepts(): Promise<ConceptCluster[]> {
  const res = await authFetch<{ items: ConceptCluster[] }>('/me/vocabulary/concepts')
  return res.items
}
