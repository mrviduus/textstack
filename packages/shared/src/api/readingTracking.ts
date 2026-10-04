import { authFetch, buildQuery, jsonBody } from './client'
import type { ReadingStatsDto, DailyStatDto, AchievementDto, GoalDto } from '../types/api'

export function submitSession(data: {
  editionId?: string | null
  userBookId?: string | null
  durationSeconds: number
  wordsRead: number
  startPercent: number
  endPercent: number
  startedAt?: string
  endedAt?: string
}) {
  // Backend requires startedAt/endedAt — compute from duration if not provided
  const now = new Date()
  const payload = {
    ...data,
    startedAt: data.startedAt || new Date(now.getTime() - data.durationSeconds * 1000).toISOString(),
    endedAt: data.endedAt || now.toISOString(),
  }
  return authFetch<{ sessionId: string; newAchievements: string[] }>('/me/reading/sessions', jsonBody('POST', payload))
}

export function getStats(tz?: number) {
  return authFetch<ReadingStatsDto>(`/me/reading/stats${buildQuery({ tz })}`)
}

export function getDailyStats(params?: { from?: string; to?: string; tz?: number; year?: number }) {
  // Legacy: year param → convert to from/to range
  const from = params?.from || (params?.year ? `${params.year}-01-01T00:00:00Z` : undefined)
  const to = params?.to || (params?.year && !params?.from ? `${params.year}-12-31T23:59:59Z` : undefined)
  return authFetch<DailyStatDto[]>(`/me/reading/stats/daily${buildQuery({ from, to, tz: params?.tz })}`)
}

export function getAchievements() {
  return authFetch<AchievementDto[]>('/me/reading/achievements')
}

export function getGoals() {
  return authFetch<GoalDto[]>('/me/reading/goals')
}

export function createGoal(data: { type: string; target: number; year?: number; streakMinMinutes?: number }) {
  return authFetch<GoalDto>('/me/reading/goals', jsonBody('POST', {
    goalType: data.type,
    targetValue: data.target,
    year: data.year || new Date().getFullYear(),
    streakMinMinutes: data.streakMinMinutes,
  }))
}

export function deleteGoal(id: string) {
  return authFetch<void>(`/me/reading/goals/${id}`, { method: 'DELETE' })
}

// Book stats types
export interface GenreStatDto { name: string; slug: string; count: number }
export interface AuthorStatDto { name: string; slug: string; count: number }
export interface LanguageStatDto { language: string; count: number }
export interface BooksOverTimeDto { period: string; books: number; pages: number }
export interface BookLengthBucketDto { bucket: string; count: number }
export interface PaceStatDto { pace: string; count: number }
export interface ReadingTimeStatDto { name: string; slug: string; seconds: number }

export interface BookStatsResponse {
  booksFinished: number
  totalPages: number
  avgDaysToFinish: number
  genreStats: GenreStatDto[]
  authorStats: AuthorStatDto[]
  languageStats: LanguageStatDto[]
  booksOverTime: BooksOverTimeDto[]
  bookLengthDistribution: BookLengthBucketDto[]
  paceStats: PaceStatDto[]
  readingTimeByGenre: ReadingTimeStatDto[]
  readingTimeByAuthor: ReadingTimeStatDto[]
  availableYears: number[]
}

export function getBookStats(year?: number) {
  return authFetch<BookStatsResponse>(`/me/reading/book-stats${buildQuery({ year })}`)
}

/** Reading speed in words per minute. `isUserSpecific` is false when the
 *  server had too few sessions and fell back to a population default. */
export interface ReadingPaceDto {
  wpm: number
  sessionCount: number
  isUserSpecific: boolean
}

export function getReadingPace() {
  return authFetch<ReadingPaceDto>('/me/reading/pace')
}
