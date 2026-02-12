const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'

async function authFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!res.ok) {
    if (res.status === 401) throw new Error('Unauthorized')
    throw new Error(`API error: ${res.status}`)
  }

  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text)
}

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
  return authFetch<SubmitSessionResponse>('/me/reading/sessions', {
    method: 'POST',
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
    body: JSON.stringify(data),
  })
}

export async function deleteGoal(id: string): Promise<void> {
  await authFetch<void>(`/me/reading/goals/${id}`, { method: 'DELETE' })
}

export async function getAchievements(): Promise<AchievementDto[]> {
  return authFetch<AchievementDto[]>('/me/reading/achievements')
}
