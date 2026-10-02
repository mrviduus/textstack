import { useEffect, useState, useCallback, useRef } from 'react'
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, TextInput as TextInputNative,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Stack, useRouter } from 'expo-router'
import { readingTrackingApi, vocabularyApi, isOfflineError, plural } from '@textstack/shared'
import type { ReadingStatsDto, DailyStatDto, AchievementDto, GoalDto, VocabularyStatsDto, VocabDailyStatDto } from '@textstack/shared'
import type { BookStatsResponse } from '@textstack/shared'
import { ACHIEVEMENTS, ALL_ACHIEVEMENT_CODES } from '@textstack/shared'
import { useAuth } from '../../src/context/AuthContext'
import { useTheme } from '../../src/context/ThemeContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { useToast } from '../../src/context/ToastContext'
import { fonts } from '../../src/theme/typography'
import { useReconnectCount } from '../../src/hooks/useOnline'
import { useRefocusEffect } from '../../src/hooks/useRefocusEffect'
import { SkeletonLoader } from '../../src/components/ui/SkeletonLoader'
import { EmptyState } from '../../src/components/ui/EmptyState'
import { FilterChips } from '../../src/components/ui/FilterChips'
import { TabBar } from '../../src/components/ui/TabBar'
import { resolveListScreenState } from '../../src/lib/listScreenState'

type StatsTab = 'overview' | 'books' | 'time' | 'achievements'

export default function StatsScreen() {
  // See `listScreenState.ts`: `isLoading` is the stored-session read, and
  // `isAuthenticated` is false throughout it. Without passing it through, every
  // cold start opens on "Sign in to track your reading…" and then replaces it.
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth()
  const { colors } = useTheme()
  const { t } = useLanguage()
  const router = useRouter()
  const [tab, setTab] = useState<StatsTab>('overview')
  const [stats, setStats] = useState<ReadingStatsDto | null>(null)
  const [daily, setDaily] = useState<DailyStatDto[]>([])
  const [achievements, setAchievements] = useState<AchievementDto[]>([])
  const [goals, setGoals] = useState<GoalDto[]>([])
  const [bookStats, setBookStats] = useState<BookStatsResponse | null>(null)
  const [vocabStats, setVocabStats] = useState<VocabularyStatsDto | null>(null)
  const [vocabDaily, setVocabDaily] = useState<VocabDailyStatDto[]>([])
  const [year, setYear] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<'offline' | 'failed' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const reconnects = useReconnectCount()
  const [refreshing, setRefreshing] = useState(false)
  // Generation counter — stats screen can refocus mid-fetch (push to
  // Goals detail → back) or change the `year` filter quickly; without
  // this, a stale 7-way response would overwrite the fresh one.
  const genRef = useRef(0)

  const loadData = useCallback(async () => {
    // Seven /me/* endpoints. Signed out, every one of them 401s, and a 401 is
    // not an offline error — so the screen reported "Something went wrong on our
    // side" to a reader whose only problem was not having an account.
    if (!isAuthenticated) { setLoading(false); return }
    const gen = ++genRef.current
    try {
      const tz = -new Date().getTimezoneOffset()
      const [s, d, a, g, bs, vs, vd] = await Promise.all([
        readingTrackingApi.getStats(),
        readingTrackingApi.getDailyStats(),
        readingTrackingApi.getAchievements(),
        readingTrackingApi.getGoals().catch(() => [] as GoalDto[]),
        readingTrackingApi.getBookStats(year).catch(() => null as BookStatsResponse | null),
        vocabularyApi.getVocabularyStats().catch(() => null as VocabularyStatsDto | null),
        vocabularyApi.getVocabularyDailyStats(tz).catch(() => [] as VocabDailyStatDto[]),
      ])
      if (gen !== genRef.current) return
      setStats(s)
      setDaily(d)
      setAchievements(a)
      setGoals(g)
      setBookStats(bs)
      setVocabStats(vs)
      setVocabDaily(vd)
      if (gen === genRef.current) setLoadError(null)
    } catch (e) {
      if (gen === genRef.current) {
        console.warn('Stats load error:', e)
        // `stats` stays null on failure, and the empty check below requires it
        // to be non-null — so a failed load fell through to the main body and
        // rendered the whole screen as zeroes. Numbers are a worse lie than an
        // empty state, because they look like an answer.
        setLoadError(isOfflineError(e) ? 'offline' : 'failed')
      }
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [isAuthenticated, year])

  // reconnects + attempt: come back on the network returning, and on request.
  // `setLoading(true)` first because `loadData` does not: this effect re-runs
  // when auth finishes restoring (`loadData` closes over `isAuthenticated`), and
  // at that moment `loading` is already false — the bootstrap pass early-returned
  // through it. Without this the screen would show its empty state for the length
  // of seven /me/* requests. The focus refresh and pull-to-refresh below
  // deliberately do NOT set it, so a refresh keeps the numbers on screen.
  useEffect(() => { setLoading(true); loadData() }, [loadData, reconnects, attempt])
  // Refresh on RE-focus only — the effect above owns the first load. A
  // focus callback keyed on `loading` re-fired when `loading` flipped false,
  // a second copy of all seven requests on every open.
  useRefocusEffect(() => { if (!loading) loadData() })

  const onRefresh = async () => {
    setRefreshing(true)
    await loadData()
    setRefreshing(false)
  }

  // `hasItems` is "a stats payload arrived", not "the numbers are non-zero" —
  // the zero-reading case is its own empty state further down and reads
  // differently from a failure.
  const screenState = resolveListScreenState({
    isAuthLoading,
    isAuthenticated,
    loading,
    loadError,
    hasItems: stats !== null,
  })

  if (screenState === 'signin') {
    return (
      <>
        <Stack.Screen options={{ title: 'Reading Stats', headerShown: true }} />
        <View style={[styles.center, { backgroundColor: colors.background }]}>
          <EmptyState
            icon="bar-chart-outline"
            title={t('stats.title')}
            subtitle={t('stats.signInPrompt')}
            buttonLabel="Sign In"
            onButtonPress={() => router.push('/(auth)/login')}
          />
        </View>
      </>
    )
  }

  if (screenState === 'loading') {
    return (
      <>
        <Stack.Screen options={{ title: 'Reading Stats', headerShown: true }} />
        <ScrollView style={{ flex: 1, backgroundColor: colors.background }}>
          {/* Overview skeleton */}
          <View style={[styles.section, { borderBottomColor: colors.border }]}>
            <SkeletonLoader width={100} height={18} style={{ marginBottom: 12 }} />
            <View style={styles.statsGrid}>
              {Array.from({ length: 6 }).map((_, i) => (
                <View key={i} style={[styles.statCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <SkeletonLoader width={16} height={16} borderRadius={8} style={{ marginBottom: 4 }} />
                  <SkeletonLoader width={40} height={18} style={{ marginBottom: 4 }} />
                  <SkeletonLoader width={50} height={11} />
                </View>
              ))}
            </View>
          </View>
          {/* Heatmap skeleton */}
          <View style={[styles.section, { borderBottomColor: colors.border }]}>
            <SkeletonLoader width={100} height={18} style={{ marginBottom: 12 }} />
            <SkeletonLoader height={80} borderRadius={6} />
          </View>
          {/* Achievements skeleton */}
          <View style={[styles.section, { borderBottomColor: colors.border }]}>
            <SkeletonLoader width={140} height={18} style={{ marginBottom: 12 }} />
            <View style={styles.achievementRow}>
              {Array.from({ length: 4 }).map((_, i) => (
                <View key={i} style={[styles.achievementItem, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <SkeletonLoader width={22} height={22} borderRadius={4} style={{ marginBottom: 4 }} />
                  <SkeletonLoader width="70%" height={13} style={{ marginBottom: 4 }} />
                  <SkeletonLoader width="90%" height={11} />
                </View>
              ))}
            </View>
          </View>
        </ScrollView>
      </>
    )
  }

  if (screenState === 'offline' || screenState === 'failed') {
    return (
      <>
        <Stack.Screen options={{ title: 'Reading Stats', headerShown: true }} />
        <View style={[styles.center, { backgroundColor: colors.background }]}>
          <EmptyState
            icon={screenState === 'offline' ? 'cloud-offline-outline' : 'alert-circle-outline'}
            title={screenState === 'offline' ? t('library.offline.title') : t('library.loadFailed.title')}
            subtitle={screenState === 'offline' ? t('library.offline.body') : t('library.loadFailed.body')}
            buttonLabel={t('common.retry')}
            onButtonPress={() => { setLoading(true); setAttempt(a => a + 1) }}
          />
        </View>
      </>
    )
  }

  const unlockedSet = new Set(achievements.map(a => a.code))
  // The four branches above leave `empty` and `list`, and this screen handles
  // both here rather than letting them fall through to a body that only survives
  // because every child is `stats && …`-guarded.
  //
  // `empty` is the machine's ("settled, no error, no payload" — `hasItems` is
  // `stats !== null`) and `hasNoReading` is this screen's own ("a payload that
  // says zero"). They are different facts and the same screen: there is nothing
  // to chart, come back after reading. Below this line `screenState` can only be
  // `list`, which is the one the body was written for.
  const hasNoReading = stats !== null && stats.totalSeconds === 0 && daily.length === 0

  if (screenState === 'empty' || hasNoReading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Reading Stats', headerShown: true }} />
        <EmptyState
          icon="bar-chart-outline"
          title={t('stats.emptyTitle')}
          subtitle={t('stats.emptySubtitle')}
        />
      </>
    )
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Reading Stats', headerShown: true }} />
      <View style={{ backgroundColor: colors.background, flex: 1 }}>
        {/* Tabs */}
        <TabBar
          tabs={[
            { key: 'overview', label: 'Overview' },
            { key: 'books', label: 'Books' },
            { key: 'time', label: 'Time' },
            { key: 'achievements', label: 'Achievements' },
          ]}
          activeTab={tab}
          onTabChange={(key) => setTab(key as StatsTab)}
        />

        {/* Year filter for books/time tabs */}
        {(tab === 'books' || tab === 'time') && bookStats?.availableYears && bookStats.availableYears.length > 0 && (
          <FilterChips
            options={[
              { key: '', label: 'All Time' },
              ...bookStats.availableYears.map(y => ({ key: String(y), label: String(y) })),
            ]}
            selected={year != null ? String(year) : ''}
            onSelect={(key) => setYear(key ? (year === Number(key) ? undefined : Number(key)) : undefined)}
          />
        )}

        <ScrollView
          style={{ flex: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {tab === 'overview' && (
            <>
              {/* The vocabulary streak card. It used to render outside this branch, under a comment
                  claiming it was "always visible above tabs" — it is inside the ScrollView and below
                  the TabBar, so it was not above anything; it simply occupied the top of all four
                  tabs. At ~550pt (a 120pt chart plus a 365-cell heatmap) that is more than half the
                  viewport, and on Achievements the first achievement sat below the fold. It belongs
                  to Overview, which is where the reader's other totals are. Web renders it once too,
                  but genuinely above its tab bar — a layout a phone does not have room for. */}
              {vocabStats && vocabStats.totalWords > 0 && (
                <VocabStreakCard vocabStats={vocabStats} dailyStats={vocabDaily} />
              )}
              {stats && <TodaySummary stats={stats} daily={daily} />}
              {stats && <OverviewSection stats={stats} />}
              {stats?.dailyGoal && <DailyGoalSection goal={stats.dailyGoal} />}
              <GoalsSection goals={goals} onUpdate={loadData} />
              <WeeklyChartSection daily={daily} />
              <HeatmapSection daily={daily} />
            </>
          )}

          {tab === 'books' && <BooksTabSection bookStats={bookStats} />}

          {tab === 'time' && <TimeTabSection bookStats={bookStats} stats={stats} />}

          {tab === 'achievements' && <AchievementsSection unlockedSet={unlockedSet} achievements={achievements} />}

          <View style={{ height: 40 }} />
        </ScrollView>
      </View>
    </>
  )
}

// --- Today Summary ---

function TodaySummary({ stats, daily }: { stats: ReadingStatsDto; daily: DailyStatDto[] }) {
  const { colors } = useTheme()
  const todayKey = new Date().toISOString().split('T')[0]
  const todayData = daily.find(d => d.date.substring(0, 10) === todayKey)
  const todaySec = stats.todaySeconds || 0
  const todayWords = todayData?.totalWords || 0
  const h = Math.floor(todaySec / 3600)
  const m = Math.round((todaySec % 3600) / 60)
  const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`

  return (
    <View style={[styles.section, { borderBottomColor: colors.border }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontFamily: fonts.sansMedium, fontSize: 14, color: colors.textSecondary }}>Today</Text>
        <Text style={{ fontFamily: fonts.sansMedium, fontSize: 14, color: colors.text }}>
          {timeStr}
          {todayWords > 0 && ` · ${formatNumber(todayWords)} ${plural(todayWords, 'word', 'words', '{noun}')}`}
          {stats.dailyGoal && ` · ${Math.round((stats.dailyGoal.today / Math.max(stats.dailyGoal.target, 1)) * 100)}%`}
        </Text>
      </View>
      {(stats.currentStreak || 0) > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
          <Ionicons name="flame-outline" size={14} color={colors.primary} />
          {/* Attributive, so the noun stays singular however long the streak: "12-day streak",
              never "12-days". plural() would be the wrong tool here — the hyphen is the fix. */}
          <Text style={{ fontFamily: fonts.sansMedium, fontSize: 13, color: colors.primary }}>
            {stats.currentStreak}-day streak
          </Text>
        </View>
      )}
    </View>
  )
}

// --- Overview ---

function OverviewSection({ stats }: { stats: ReadingStatsDto }) {
  const { colors } = useTheme()
  const totalHours = Math.floor(stats.totalSeconds / 3600)
  const totalMin = Math.round((stats.totalSeconds % 3600) / 60)

  return (
    <View style={[styles.section, { borderBottomColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>Overview</Text>
      <View style={styles.statsGrid}>
        <StatCard label="Total Time" value={totalHours > 0 ? `${totalHours}h ${totalMin}m` : `${totalMin}m`} icon="time-outline" />
        <StatCard label="Words Read" value={formatNumber(stats.totalWords)} icon="book-outline" />
        <StatCard label="Books Finished" value={String(stats.booksFinished)} icon="checkmark-done-outline" />
        <StatCard label="Current Streak" value={`${stats.currentStreak}d`} highlight={stats.currentStreak > 0} icon="flame-outline" />
        <StatCard label="Longest Streak" value={`${stats.longestStreak}d`} icon="trophy-outline" />
        <StatCard label="Avg WPM" value={String(stats.avgWordsPerMinute || 0)} icon="speedometer-outline" />
      </View>
    </View>
  )
}

function StatCard({ label, value, highlight, icon }: { label: string; value: string; highlight?: boolean; icon?: string }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.statCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {icon && <Ionicons name={icon as any} size={16} color={highlight ? colors.primary : colors.textSecondary} style={{ marginBottom: 4 }} />}
      <Text style={[styles.statCardValue, { color: highlight ? colors.primary : colors.text, fontFamily: fonts.serifBold }]}>{value}</Text>
      <Text style={[styles.statCardLabel, { color: colors.textSecondary, fontFamily: fonts.sans }]}>{label}</Text>
    </View>
  )
}

// --- Daily goal ---

function DailyGoalSection({ goal }: { goal: NonNullable<ReadingStatsDto['dailyGoal']> }) {
  const { colors } = useTheme()
  const pct = Math.min(100, Math.round((goal.today / goal.target) * 100))
  return (
    <View style={[styles.section, { borderBottomColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>Daily Goal</Text>
      <View style={[styles.goalCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.goalRow}>
          <Text style={[styles.goalText, { color: colors.text, fontFamily: fonts.sansMedium }]}>{Math.round(goal.today)}m / {goal.target}m</Text>
          <Text style={[styles.goalPct, { color: goal.met ? colors.success : colors.primary, fontFamily: fonts.sansMedium }]}>{pct}%</Text>
        </View>
        <View style={[styles.goalTrack, { backgroundColor: colors.border }]}>
          <View style={[styles.goalFill, { width: `${pct}%`, backgroundColor: goal.met ? colors.success : colors.primary }]} />
        </View>
        {goal.met && (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 8, gap: 4 }}>
            <Ionicons name="checkmark-circle" size={16} color={colors.success} />
            <Text style={{ fontSize: 13, color: colors.success, fontFamily: fonts.sansMedium }}>Goal met today!</Text>
          </View>
        )}
      </View>
    </View>
  )
}

// --- Weekly Chart ---

function WeeklyChartSection({ daily }: { daily: DailyStatDto[] }) {
  const { colors } = useTheme()
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const dayMap = new Map<string, number>()
  for (const d of daily) dayMap.set(d.date.substring(0, 10), d.totalSeconds)

  const bars: { label: string; seconds: number }[] = []
  const today = new Date()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().substring(0, 10)
    bars.push({ label: days[d.getDay()], seconds: dayMap.get(key) || 0 })
  }

  const maxSeconds = Math.max(...bars.map(b => b.seconds), 1)
  const chartHeight = 100

  return (
    <View style={[styles.section, { borderBottomColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>This Week</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', height: chartHeight, paddingHorizontal: 4 }}>
        {bars.map((b, i) => {
          const pct = b.seconds / maxSeconds
          const barH = Math.max(pct * (chartHeight - 20), b.seconds > 0 ? 4 : 0)
          const mins = Math.round(b.seconds / 60)
          return (
            <View key={i} style={{ alignItems: 'center', flex: 1 }}>
              {mins > 0 && (
                <Text style={{ fontFamily: fonts.sans, fontSize: 9, color: colors.textSecondary, marginBottom: 2 }}>
                  {mins}m
                </Text>
              )}
              <View style={{ width: '60%', height: barH, backgroundColor: colors.primary, borderRadius: 3 }} />
              <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textSecondary, marginTop: 4 }}>
                {b.label}
              </Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}

// --- Heatmap ---

function HeatmapSection({ daily }: { daily: DailyStatDto[] }) {
  const { colors } = useTheme()
  const today = new Date()
  const dayMap = new Map<string, number>()
  for (const d of daily) dayMap.set(d.date.substring(0, 10), d.totalSeconds)

  // 90 days, build grid
  const cells: { date: string; seconds: number }[] = []
  for (let i = 89; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().substring(0, 10)
    cells.push({ date: key, seconds: dayMap.get(key) || 0 })
  }

  return (
    <View style={[styles.section, { borderBottomColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>Last 90 Days</Text>
      <View style={styles.heatmapGrid}>
        {cells.map(c => (
          <View
            key={c.date}
            style={[styles.heatmapCell, { backgroundColor: heatColor(c.seconds) }]}
          />
        ))}
      </View>
      <View style={styles.heatmapLegend}>
        <Text style={[styles.legendText, { color: colors.textSecondary, fontFamily: fonts.sans }]}>Less</Text>
        {[0, 300, 1200, 1800].map(s => (
          <View key={s} style={[styles.heatmapCell, styles.legendCell, { backgroundColor: heatColor(s) }]} />
        ))}
        <Text style={[styles.legendText, { color: colors.textSecondary, fontFamily: fonts.sans }]}>More</Text>
      </View>
    </View>
  )
}

function heatColor(seconds: number): string {
  if (seconds === 0) return '#F3F4F6'
  if (seconds < 600) return '#D4A574'
  if (seconds < 1800) return '#C4704B'
  return '#8B4513'
}

// --- Achievements ---

function AchievementsSection({
  unlockedSet, achievements,
}: {
  unlockedSet: Set<string>
  achievements: AchievementDto[]
}) {
  const { colors } = useTheme()
  const categories = ['milestone', 'streak', 'time', 'special']

  return (
    <View style={[styles.section, { borderBottomColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>
        Achievements ({achievements.length}/{ALL_ACHIEVEMENT_CODES.length})
      </Text>
      {categories.map(cat => {
        const codes = ALL_ACHIEVEMENT_CODES.filter(c => ACHIEVEMENTS[c].category === cat)
        return (
          <View key={cat} style={styles.achievementCategory}>
            <Text style={[styles.achievementCatTitle, { color: colors.textSecondary, fontFamily: fonts.sansMedium }]}>
              {cat.charAt(0).toUpperCase() + cat.slice(1)}
            </Text>
            <View style={styles.achievementRow}>
              {codes.map(code => {
                const def = ACHIEVEMENTS[code]
                const unlocked = unlockedSet.has(code)
                const unlockedAt = achievements.find(a => a.code === code)?.unlockedAt
                return (
                  <View key={code} style={[styles.achievementItem, { backgroundColor: colors.surface, borderColor: colors.border }, !unlocked && styles.achievementLocked]}>
                    <Text style={styles.achievementEmoji}>{def.emoji}</Text>
                    <Text style={[styles.achievementName, { color: colors.text, fontFamily: fonts.sansMedium }, !unlocked && { color: colors.textSecondary }]} numberOfLines={1}>
                      {def.name}
                    </Text>
                    <Text style={[styles.achievementDesc, { color: colors.textSecondary, fontFamily: fonts.sans }]} numberOfLines={2}>
                      {def.description}
                    </Text>
                    {unlocked && unlockedAt && (
                      <Text style={{ fontSize: 10, color: colors.textSecondary, fontFamily: fonts.sans, marginTop: 4 }}>
                        {new Date(unlockedAt).toLocaleDateString()}
                      </Text>
                    )}
                  </View>
                )
              })}
            </View>
          </View>
        )
      })}
    </View>
  )
}

// --- Goals ---

function GoalsSection({ goals, onUpdate }: { goals: GoalDto[]; onUpdate: () => void }) {
  const { colors } = useTheme()
  const { show: showToast } = useToast()
  const [showForm, setShowForm] = useState(false)
  const [goalType, setGoalType] = useState<'daily_minutes' | 'books_per_year'>('daily_minutes')
  const [target, setTarget] = useState('')
  const [streakMin, setStreakMin] = useState('')
  const [saving, setSaving] = useState(false)

  const handleCreate = async () => {
    const val = parseInt(target)
    if (!val || val <= 0) return
    setSaving(true)
    const smm = parseInt(streakMin)
    try {
      await readingTrackingApi.createGoal({ type: goalType, target: val, streakMinMinutes: smm > 0 ? smm : undefined })
      setShowForm(false)
      setTarget('')
      setStreakMin('')
      onUpdate()
    } catch (e) {
      console.warn('Create goal failed:', e)
      showToast({ message: 'Could not create goal. Try again.', variant: 'error' })
    } finally {
      // Always release the saving lock — silent catch used to leave it
      // stuck at `true`, disabling the Save button forever.
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await readingTrackingApi.deleteGoal(id)
      onUpdate()
    } catch (e) {
      console.warn('Delete goal failed:', e)
      showToast({ message: 'Could not delete goal. Try again.', variant: 'error' })
    }
  }

  return (
    <View style={[styles.section, { borderBottomColor: colors.border }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold, marginBottom: 0 }]}>Goals</Text>
        {!showForm && (
          <TouchableOpacity onPress={() => setShowForm(true)}>
            <Ionicons name="add-circle-outline" size={24} color={colors.primary} />
          </TouchableOpacity>
        )}
      </View>

      {goals.map(g => (
        <View key={g.id} style={[styles.goalCard, { backgroundColor: colors.surface, borderColor: colors.border, marginBottom: 8 }]}>
          <View style={styles.goalRow}>
            <Text style={[styles.goalText, { color: colors.text, fontFamily: fonts.sansMedium }]}>
              {g.goalType === 'daily_minutes' ? `${g.targetValue} min/day` : `${g.targetValue} books/year`}
            </Text>
            <TouchableOpacity onPress={() => handleDelete(g.id)}>
              <Ionicons name="trash-outline" size={18} color={colors.error} />
            </TouchableOpacity>
          </View>
        </View>
      ))}

      {goals.length === 0 && !showForm && (
        <Text style={{ fontSize: 13, color: colors.textSecondary, fontFamily: fonts.sans }}>
          No goals set. Tap + to create one.
        </Text>
      )}

      {showForm && (
        <View style={[styles.goalCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            {(['daily_minutes', 'books_per_year'] as const).map(t => (
              <TouchableOpacity
                key={t}
                onPress={() => setGoalType(t)}
                style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: goalType === t ? colors.primaryLight : 'transparent' }}
              >
                <Text style={{ fontFamily: fonts.sansMedium, fontSize: 13, color: goalType === t ? colors.primary : colors.textSecondary }}>
                  {t === 'daily_minutes' ? 'Daily Minutes' : 'Books/Year'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
              <Text style={{ position: 'absolute', right: 12, top: 10, fontSize: 12, color: colors.textSecondary, fontFamily: fonts.sans }}>
                {goalType === 'daily_minutes' ? 'min' : 'books'}
              </Text>
              <View style={{ flexDirection: 'row' }}>
                <TextInputNative
                  style={{ flex: 1, fontFamily: fonts.sans, fontSize: 14, color: colors.text }}
                  value={target}
                  onChangeText={setTarget}
                  keyboardType="numeric"
                  placeholder={goalType === 'daily_minutes' ? '30' : '12'}
                  placeholderTextColor={colors.textSecondary}
                />
              </View>
            </View>
            <TouchableOpacity
              onPress={handleCreate}
              disabled={saving}
              style={{ backgroundColor: colors.primary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 }}
            >
              <Text style={{ color: '#fff', fontFamily: fonts.sansMedium, fontSize: 14 }}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowForm(false)}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          {goalType === 'daily_minutes' && (
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.textSecondary }}>Streak threshold:</Text>
              <View style={{ flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, maxWidth: 100 }}>
                <TextInputNative
                  style={{ fontFamily: fonts.sans, fontSize: 14, color: colors.text }}
                  value={streakMin}
                  onChangeText={setStreakMin}
                  keyboardType="numeric"
                  placeholder="5"
                  placeholderTextColor={colors.textSecondary}
                />
              </View>
              <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.textSecondary }}>min</Text>
            </View>
          )}
        </View>
      )}
    </View>
  )
}

// --- Books Tab ---

function BooksTabSection({ bookStats }: { bookStats: BookStatsResponse | null }) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  if (!bookStats) return <Text style={{ padding: 16, color: colors.textSecondary, fontFamily: fonts.sans }}>{t('stats.noBookStats')}</Text>

  return (
    <View style={{ padding: 16 }}>
      {/* Summary */}
      <View style={styles.statsGrid}>
        <StatCard label="Books Finished" value={String(bookStats.booksFinished)} icon="checkmark-done-outline" />
        <StatCard label="Total Pages" value={formatNumber(bookStats.totalPages)} icon="document-text-outline" />
        <StatCard label="Avg Days/Book" value={String(bookStats.avgDaysToFinish)} icon="calendar-outline" />
      </View>

      {/* Genre breakdown */}
      {bookStats.genreStats.length > 0 && (
        <View style={{ marginTop: 20 }}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>By Genre</Text>
          {bookStats.genreStats.map(g => (
            <BarRow key={g.slug} label={g.name} value={g.count} max={bookStats.genreStats[0].count} />
          ))}
        </View>
      )}

      {/* Author breakdown */}
      {bookStats.authorStats.length > 0 && (
        <View style={{ marginTop: 20 }}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>By Author</Text>
          {bookStats.authorStats.map(a => (
            <BarRow key={a.slug} label={a.name} value={a.count} max={bookStats.authorStats[0].count} />
          ))}
        </View>
      )}

      {/* Language breakdown */}
      {bookStats.languageStats.length > 0 && (
        <View style={{ marginTop: 20 }}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>By Language</Text>
          {bookStats.languageStats.map(l => (
            <BarRow key={l.language} label={l.language.toUpperCase()} value={l.count} max={bookStats.languageStats[0].count} />
          ))}
        </View>
      )}

      {/* Books over time */}
      {bookStats.booksOverTime.length > 0 && (
        <View style={{ marginTop: 20 }}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>Books Over Time</Text>
          {bookStats.booksOverTime.map(b => (
            <BarRow key={b.period} label={b.period} value={b.books} suffix={`(${formatNumber(b.pages)} pg)`} max={Math.max(...bookStats.booksOverTime.map(x => x.books))} />
          ))}
        </View>
      )}

      {/* Book length distribution */}
      {bookStats.bookLengthDistribution.length > 0 && (
        <View style={{ marginTop: 20 }}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>Book Length</Text>
          {bookStats.bookLengthDistribution.map(b => (
            <BarRow key={b.bucket} label={b.bucket} value={b.count} max={Math.max(...bookStats.bookLengthDistribution.map(x => x.count))} />
          ))}
        </View>
      )}

    </View>
  )
}

// --- Time Tab ---

function TimeTabSection({ bookStats, stats }: { bookStats: BookStatsResponse | null; stats: ReadingStatsDto | null }) {
  const { colors } = useTheme()

  const totalH = stats ? Math.floor(stats.totalSeconds / 3600) : 0
  const totalM = stats ? Math.round((stats.totalSeconds % 3600) / 60) : 0
  const weekH = stats ? Math.floor((stats.weekSeconds || 0) / 3600) : 0
  const weekM = stats ? Math.round(((stats.weekSeconds || 0) % 3600) / 60) : 0
  const monthH = stats ? Math.floor((stats.monthSeconds || 0) / 3600) : 0
  const monthM = stats ? Math.round(((stats.monthSeconds || 0) % 3600) / 60) : 0

  return (
    <View style={{ padding: 16 }}>
      {/* Time summary */}
      <View style={styles.statsGrid}>
        <StatCard label="Total Time" value={totalH > 0 ? `${totalH}h ${totalM}m` : `${totalM}m`} icon="time-outline" />
        <StatCard label="This Week" value={weekH > 0 ? `${weekH}h ${weekM}m` : `${weekM}m`} icon="calendar-outline" />
        <StatCard label="This Month" value={monthH > 0 ? `${monthH}h ${monthM}m` : `${monthM}m`} icon="today-outline" />
      </View>

      {/* Pace distribution */}
      {bookStats && bookStats.paceStats.length > 0 && (
        <View style={{ marginTop: 20 }}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>Reading Pace</Text>
          {bookStats.paceStats.map(p => (
            <BarRow key={p.pace} label={p.pace} value={p.count} max={Math.max(...bookStats.paceStats.map(x => x.count))} />
          ))}
        </View>
      )}

      {/* Reading time by genre */}
      {bookStats && bookStats.readingTimeByGenre.length > 0 && (
        <View style={{ marginTop: 20 }}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>Time by Genre</Text>
          {bookStats.readingTimeByGenre.map(g => (
            <BarRow key={g.slug} label={g.name} value={Math.round(g.seconds / 60)} suffix="min" max={Math.round(bookStats.readingTimeByGenre[0].seconds / 60)} />
          ))}
        </View>
      )}

      {/* Reading time by author */}
      {bookStats && bookStats.readingTimeByAuthor.length > 0 && (
        <View style={{ marginTop: 20 }}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>Time by Author</Text>
          {bookStats.readingTimeByAuthor.map(a => (
            <BarRow key={a.slug} label={a.name} value={Math.round(a.seconds / 60)} suffix="min" max={Math.round(bookStats.readingTimeByAuthor[0].seconds / 60)} />
          ))}
        </View>
      )}
    </View>
  )
}

// --- Bar Row (reusable chart row) ---

function BarRow({ label, value, max, suffix }: { label: string; value: number; max: number; suffix?: string }) {
  const { colors } = useTheme()
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <View style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
        <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.text, flex: 1 }} numberOfLines={1}>{label}</Text>
        <Text style={{ fontFamily: fonts.sansMedium, fontSize: 13, color: colors.primary }}>{value}{suffix ? ` ${suffix}` : ''}</Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden' }}>
        <View style={{ height: '100%', width: `${pct}%`, backgroundColor: colors.primary, borderRadius: 3 }} />
      </View>
    </View>
  )
}

// --- Vocab Streak Card ---

const VOCAB_DAILY_GOAL = 10

function getLast7VocabDays(dailyStats: VocabDailyStatDto[]): VocabDailyStatDto[] {
  const today = new Date()
  const result: VocabDailyStatDto[] = []
  const statsMap = new Map(dailyStats.map(d => [d.date.split('T')[0], d]))
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().split('T')[0]
    result.push(statsMap.get(key) || { date: key, wordsAdded: 0, reviewCount: 0, correctCount: 0, practiceCount: 0, srsCount: 0 })
  }
  return result
}

function VocabStreakCard({ vocabStats, dailyStats }: { vocabStats: VocabularyStatsDto; dailyStats: VocabDailyStatDto[] }) {
  const { colors } = useTheme()
  const streak = vocabStats.streak
  const last7 = getLast7VocabDays(dailyStats)
  const maxVal = Math.max(...last7.map(d => d.wordsAdded + d.reviewCount), VOCAB_DAILY_GOAL, 1)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  const [heatMode, setHeatMode] = useState<'combined' | 'added' | 'reviewed'>('combined')
  const statsMap = new Map(dailyStats.map(d => [d.date.split('T')[0], d]))
  const today = new Date()
  const cells: { date: string; value: number }[] = []
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().split('T')[0]
    const stat = statsMap.get(key)
    let value = 0
    if (stat) {
      if (heatMode === 'added') value = stat.wordsAdded
      else if (heatMode === 'reviewed') value = stat.reviewCount
      else value = stat.wordsAdded + stat.reviewCount
    }
    cells.push({ date: key, value })
  }
  const heatMax = Math.max(...cells.map(c => c.value), 1)
  const getHeatColor = (v: number) => {
    if (v === 0) return colors.border
    const r = v / heatMax
    if (r < 0.25) return '#d4a574'
    if (r < 0.5) return '#c4884e'
    if (r < 0.75) return colors.primary
    return '#8b4513'
  }

  const totalAdded = dailyStats.reduce((s, d) => s + d.wordsAdded, 0)
  const totalReviewed = dailyStats.reduce((s, d) => s + d.reviewCount, 0)

  return (
    <View style={[vocabStyles.container, { backgroundColor: colors.primary }]}>
      {/* Header */}
      <Text style={vocabStyles.title}>
        {streak > 0 ? `Keep Up Your ${streak} Day Streak` : 'Start Your Streak!'}
      </Text>
      <Text style={vocabStyles.subtitle}>
        Review {VOCAB_DAILY_GOAL} flashcards every day to keep your streak going.
      </Text>

      {/* Legend */}
      <View style={vocabStyles.legend}>
        <View style={vocabStyles.legendItem}>
          <View style={[vocabStyles.legendDot, { backgroundColor: '#22c55e' }]} />
          <Text style={vocabStyles.legendText}>Added</Text>
        </View>
        <View style={vocabStyles.legendItem}>
          <View style={[vocabStyles.legendDot, { backgroundColor: 'rgba(255,255,255,0.7)' }]} />
          <Text style={vocabStyles.legendText}>Reviewed</Text>
        </View>
      </View>

      {/* Weekly chart */}
      <View style={vocabStyles.chartRow}>
        {last7.map((day, i) => {
          const addedH = maxVal > 0 ? (day.wordsAdded / maxVal) * 80 : 0
          const reviewedH = maxVal > 0 ? (day.reviewCount / maxVal) * 80 : 0
          const date = new Date(day.date)
          const active = day.reviewCount > 0 || day.wordsAdded > 0
          return (
            <View key={i} style={vocabStyles.barCol}>
              <View style={vocabStyles.barWrapper}>
                <View style={[vocabStyles.bar, { height: Math.max(reviewedH, reviewedH > 0 ? 3 : 0), backgroundColor: 'rgba(255,255,255,0.7)' }]} />
                <View style={[vocabStyles.bar, { height: Math.max(addedH, addedH > 0 ? 3 : 0), backgroundColor: '#22c55e' }]} />
              </View>
              <Text style={vocabStyles.dayLabel}>{days[date.getDay()]}</Text>
              <Ionicons name={active ? 'flame' : 'flame-outline'} size={14} color={active ? '#fff' : 'rgba(255,255,255,0.3)'} />
            </View>
          )
        })}
      </View>

      {/* Goal line label */}
      <Text style={vocabStyles.goalLabel}>Goal: {VOCAB_DAILY_GOAL}/day</Text>

      {/* Yearly heatmap */}
      <View style={[vocabStyles.heatmapCard, { backgroundColor: colors.surface }]}>
        <Text style={[vocabStyles.heatmapTitle, { color: colors.text }]}>Long Term Progress</Text>
        <View style={vocabStyles.heatmapTabs}>
          {(['combined', 'added', 'reviewed'] as const).map(m => (
            <TouchableOpacity
              key={m}
              style={[vocabStyles.heatmapTab, heatMode === m && { backgroundColor: colors.primary }]}
              onPress={() => setHeatMode(m)}
            >
              <Text style={[vocabStyles.heatmapTabText, { color: heatMode === m ? '#fff' : colors.textSecondary }]}>
                {m === 'combined' ? 'Combined' : m === 'added' ? 'Added' : 'Reviewed'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={vocabStyles.heatmapGrid}>
          {cells.map((cell, i) => (
            <View key={i} style={[vocabStyles.heatmapCell, { backgroundColor: getHeatColor(cell.value) }]} />
          ))}
        </View>
        <Text style={[vocabStyles.heatmapSummary, { color: colors.textSecondary }]}>
          {plural(totalAdded, 'word', 'words', '{n} {noun} added')} · {plural(totalReviewed, 'word', 'words', '{n} {noun} reviewed')}
        </Text>
      </View>
    </View>
  )
}

const vocabStyles = StyleSheet.create({
  container: {
    margin: 16,
    borderRadius: 16,
    padding: 20,
  },
  title: {
    fontSize: 20,
    fontFamily: fonts.serifBold,
    color: '#fff',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: fonts.sans,
    color: 'rgba(255,255,255,0.85)',
    marginBottom: 16,
  },
  legend: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 10,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 2,
  },
  legendText: {
    fontSize: 11,
    fontFamily: fonts.sans,
    color: 'rgba(255,255,255,0.85)',
  },
  chartRow: {
    flexDirection: 'row',
    gap: 6,
    height: 120,
    alignItems: 'flex-end',
    marginBottom: 8,
  },
  barCol: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
  },
  barWrapper: {
    flex: 1,
    width: '100%',
    justifyContent: 'flex-end',
    gap: 1,
  },
  bar: {
    width: '100%',
    borderRadius: 3,
  },
  dayLabel: {
    fontSize: 10,
    fontFamily: fonts.sansMedium,
    color: 'rgba(255,255,255,0.7)',
  },
  goalLabel: {
    fontSize: 11,
    fontFamily: fonts.sans,
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'right',
    marginBottom: 16,
  },
  heatmapCard: {
    borderRadius: 12,
    padding: 16,
  },
  heatmapTitle: {
    fontSize: 17,
    fontFamily: fonts.serifBold,
    marginBottom: 10,
  },
  heatmapTabs: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
  },
  heatmapTab: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  heatmapTabText: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
  },
  heatmapGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
  },
  heatmapCell: {
    width: 8,
    height: 8,
    borderRadius: 1.5,
  },
  heatmapSummary: {
    fontSize: 12,
    fontFamily: fonts.sans,
    marginTop: 10,
  },
})

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // Tabs
  tabRow: { flexDirection: 'row', borderBottomWidth: 1 },
  tabItem: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabLabel: { fontFamily: fonts.sansMedium, fontSize: 13 },

  // Year filter
  yearRow: { paddingHorizontal: 16, paddingVertical: 8, gap: 6 },
  yearChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  yearChipText: { fontFamily: fonts.sansMedium, fontSize: 12 },

  // Sections
  section: { padding: 16, borderBottomWidth: 1 },
  sectionTitle: { fontSize: 17, marginBottom: 12 },

  // Stats grid
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statCard: {
    width: '31%',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
  },
  statCardValue: { fontSize: 18 },
  statCardLabel: { fontSize: 11, marginTop: 4 },

  // Goal
  goalCard: {
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
  },
  goalRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  goalText: { fontSize: 15 },
  goalPct: { fontSize: 15 },
  goalTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  goalFill: { height: '100%', borderRadius: 3 },

  // Heatmap
  heatmapGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
  },
  heatmapCell: {
    width: 14,
    height: 14,
    borderRadius: 2,
  },
  heatmapLegend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
    justifyContent: 'flex-end',
  },
  legendCell: { width: 12, height: 12 },
  legendText: { fontSize: 10 },

  // Achievements
  achievementCategory: { marginBottom: 12 },
  achievementCatTitle: { fontSize: 13, marginBottom: 8 },
  achievementRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  achievementItem: {
    width: '47%',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
  },
  achievementLocked: { opacity: 0.4 },
  achievementEmoji: { fontSize: 22, marginBottom: 4 },
  achievementName: { fontSize: 13 },
  achievementDesc: { fontSize: 11, marginTop: 2 },
})
