import { authFetch } from './client'

// --- Types ---

export interface SubmitSessionRequest {
  editionId?: string | null
  userBookId?: string | null
  startedAt: string
  endedAt: string
  durationSeconds: number
  wordsRead: number
  startPercent: number
  endPercent: number
}

export interface SubmitSessionResponse {
  sessionId: string
  newAchievements: string[]
}

export interface SessionDto {
  id: string
  editionId: string | null
  userBookId: string | null
  startedAt: string
  endedAt: string
  durationSeconds: number
  wordsRead: number
  startPercent: number
  endPercent: number
}

export interface ReadingStats {
  totalSeconds: number
  totalWords: number
  booksFinished: number
  currentStreak: number
  longestStreak: number
  streakMinMinutes: number
  avgDailyMinutes: number
  avgWordsPerMinute: number
  todaySeconds: number
  todayVocabReviews: number
  weekSeconds: number
  monthSeconds: number
  dailyGoal: { target: number; today: number; met: boolean } | null
}

export interface DailyStatDto {
  date: string
  totalSeconds: number
  totalWords: number
  sessionCount: number
}

export interface GoalDto {
  id: string
  goalType: string
  targetValue: number
  year: number
  streakMinMinutes: number
  updatedAt: string
}

export interface CreateGoalRequest {
  goalType: string
  targetValue: number
  year: number
  streakMinMinutes?: number
}

export interface AchievementDto {
  code: string
  unlockedAt: string
}

// --- API Functions ---

export async function submitSession(data: SubmitSessionRequest): Promise<SubmitSessionResponse> {
  // tz: the server counts the streak and time-of-day achievements in the reader's day, not UTC's.
  return authFetch<SubmitSessionResponse>(`/me/reading/sessions?tz=${-new Date().getTimezoneOffset()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function getSessions(from?: string, to?: string): Promise<SessionDto[]> {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const qs = params.toString()
  return authFetch<SessionDto[]>(`/me/reading/sessions${qs ? `?${qs}` : ''}`)
}

export async function getStats(tz?: number): Promise<ReadingStats> {
  const params = new URLSearchParams()
  if (tz != null) params.set('tz', String(tz))
  return authFetch<ReadingStats>(`/me/reading/stats?${params}`)
}

export async function getDailyStats(from?: string, to?: string, tz?: number): Promise<DailyStatDto[]> {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  if (tz != null) params.set('tz', String(tz))
  return authFetch<DailyStatDto[]>(`/me/reading/stats/daily?${params}`)
}

export async function getGoals(): Promise<GoalDto[]> {
  return authFetch<GoalDto[]>('/me/reading/goals')
}

export async function createGoal(data: CreateGoalRequest): Promise<GoalDto> {
  return authFetch<GoalDto>('/me/reading/goals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deleteGoal(id: string): Promise<void> {
  await authFetch<void>(`/me/reading/goals/${id}`, { method: 'DELETE' })
}

export async function getAchievements(): Promise<AchievementDto[]> {
  return authFetch<AchievementDto[]>('/me/reading/achievements')
}

// --- Book Stats ---

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

export interface ReadingPaceDto {
  wpm: number
  sessionCount: number
  isUserSpecific: boolean
}

export async function getReadingPace(): Promise<ReadingPaceDto> {
  return authFetch<ReadingPaceDto>('/me/reading/pace')
}

export interface GoalSummaryDto { type: 'daily_minutes' | 'books_per_year'; current: number; target: number }
export interface LibrarySummaryDto {
  pagesThisMonth: number
  minutesThisMonth: number
  currentStreak: number
  streakMinMinutes: number
  booksFinishedYtd: number
  goal: GoalSummaryDto | null
}

export async function getLibrarySummary(tz?: number): Promise<LibrarySummaryDto> {
  const params = new URLSearchParams()
  if (tz != null) params.set('tz', String(tz))
  const qs = params.toString()
  return authFetch<LibrarySummaryDto>(`/me/reading/library-summary${qs ? `?${qs}` : ''}`)
}

export async function getBookStats(year?: number): Promise<BookStatsResponse> {
  const params = new URLSearchParams()
  if (year) params.set('year', String(year))
  const qs = params.toString()
  return authFetch<BookStatsResponse>(`/me/reading/book-stats${qs ? `?${qs}` : ''}`)
}
