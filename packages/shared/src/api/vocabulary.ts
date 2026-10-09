import { authFetch, buildQuery, jsonBody } from './client'
import type { VocabularyWordDto, VocabularyStatsDto, VocabDailyStatDto, ReviewCardDto, SubmitReviewResponse, WeeklyProgressDto, VocabSettingsDto, SaveWordResponseDto, PendingListResponseDto, WordLookupListResponseDto, ClusterListResponseDto, ClusterBonusResponse } from '../types/api'

export function getWords(params?: { filter?: string; stage?: string; sort?: string; search?: string; limit?: number; offset?: number }) {
  // Backend uses 'stage' param (comma-separated stage numbers: 0,1,2,3,4)
  const stageValue = params?.stage || params?.filter
  return authFetch<{ total: number; items: VocabularyWordDto[] }>(
    `/me/vocabulary/words${buildQuery({ stage: stageValue, sort: params?.sort, search: params?.search, limit: params?.limit, offset: params?.offset })}`
  )
}

export function saveWord(data: {
  word: string
  translation?: string | null
  definition?: string | null
  sentence?: string | null
  bookTitle?: string | null
  language?: string | null
  editionId?: string | null
  chapterId?: string | null
  userBookId?: string | null
  // Required by the backend (native_language_required → 400). Web's local
  // client already sends it; shared/mobile must too or every save fails.
  nativeLanguage?: string | null
}) {
  return authFetch<SaveWordResponseDto>('/me/vocabulary/words', jsonBody('POST', data))
}

export function getPendingWords() {
  return authFetch<PendingListResponseDto>('/me/vocabulary/pending')
}

export function promotePendingWord(id: string) {
  return authFetch<VocabularyWordDto>(`/me/vocabulary/pending/${id}/promote`, { method: 'POST' })
}

export function dismissPendingWord(id: string) {
  return authFetch<void>(`/me/vocabulary/pending/${id}`, { method: 'DELETE' })
}

export function getLookups(params?: { limit?: number; offset?: number }) {
  return authFetch<WordLookupListResponseDto>(
    `/me/vocabulary/lookups${buildQuery({ limit: params?.limit, offset: params?.offset })}`
  )
}

export function promoteLookup(id: string) {
  return authFetch<VocabularyWordDto>(`/me/vocabulary/lookups/${id}/promote`, { method: 'POST' })
}

export function dismissLookup(id: string) {
  return authFetch<void>(`/me/vocabulary/lookups/${id}`, { method: 'DELETE' })
}

export function updateWord(id: string, data: { translation?: string; definition?: string }) {
  return authFetch<VocabularyWordDto>(`/me/vocabulary/words/${id}`, jsonBody('PATCH', data))
}

export function deleteWord(id: string) {
  return authFetch<void>(`/me/vocabulary/words/${id}`, { method: 'DELETE' })
}

export function getReviewQueue(limit?: number, practice?: boolean) {
  return authFetch<{ cards: ReviewCardDto[]; totalDue: number; weeklyProgress: WeeklyProgressDto | null }>(
    `/me/vocabulary/review${buildQuery({ limit, practice: practice ? true : undefined })}`
  )
}

export function getVocabSettings() {
  return authFetch<VocabSettingsDto>('/me/vocabulary/settings')
}

export function updateVocabSettings(data: VocabSettingsDto, signal?: AbortSignal) {
  return authFetch<VocabSettingsDto>('/me/vocabulary/settings', { ...jsonBody('PUT', data), signal })
}

export function unretireWord(id: string) {
  return authFetch<VocabularyWordDto>(`/me/vocabulary/words/${id}/unretire`, { method: 'POST' })
}

export function submitReview(data: { wordId: string; isCorrect: boolean; responseTimeMs: number; selfAssessment?: string; isPractice?: boolean }) {
  return authFetch<SubmitReviewResponse>('/me/vocabulary/review', jsonBody('POST', data))
}

export function getVocabularyStats() {
  return authFetch<VocabularyStatsDto>('/me/vocabulary/stats')
}

export function getVocabularyDailyStats(tz?: number, from?: string, to?: string) {
  const params = buildQuery({ tz, from, to })
  return authFetch<VocabDailyStatDto[]>(`/me/vocabulary/stats/daily${params}`)
}

export function getReaderVocab() {
  return authFetch<{ id: string; word: string; stage: number; translation?: string }[]>('/me/vocabulary/words/reader')
}

export function markAsKnown(id: string) {
  return authFetch<VocabularyWordDto>(`/me/vocabulary/words/${id}/known`, { method: 'PUT' })
}

export function getClusters() {
  return authFetch<ClusterListResponseDto>('/me/vocabulary/clusters')
}

export function startClusterBonus(id: string) {
  return authFetch<ClusterBonusResponse>(`/me/vocabulary/clusters/${id}/start-bonus`, { method: 'POST' })
}

export function dismissCluster(id: string) {
  return authFetch<void>(`/me/vocabulary/clusters/${id}/dismiss`, { method: 'POST' })
}

export function completeCluster(id: string) {
  return authFetch<void>(`/me/vocabulary/clusters/${id}/complete`, { method: 'POST' })
}
