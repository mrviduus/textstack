/**
 * Profile "Reading" block (#1366): streaks, a period switch, its totals and bars (plain Views).
 * Hidden offline or when the first request fails; once something loaded, a failed period says so in a
 * line. Refetched on every focus (the tab never unmounts); the caller keys it by user id, so a session
 * switch starts it over. Shown to guests too: a guest is a real session.
 */
import { useCallback, useState } from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import {
  syncApi, READING_STATS_PERIODS, formatReadingMinutes, formatStreakDays, readingStatsBarLabels,
  type ReadingStatsDto, type ReadingStatsPeriod,
} from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useOnline } from '../../hooks/useOnline'
import { fonts } from '../../theme/typography'

const CHART_HEIGHT = 80

export function ReadingStatsBlock() {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const online = useOnline()
  const [period, setPeriod] = useState<ReadingStatsPeriod>('week')
  /** The shown period's answer; cleared on a switch so old bars never sit under the new button. */
  const [stats, setStats] = useState<ReadingStatsDto | null>(null)
  /** The last answer of any period: the streaks, and whether the block has ever loaded. */
  const [last, setLast] = useState<ReadingStatsDto | null>(null)
  const [failed, setFailed] = useState(false)

  useFocusEffect(useCallback(() => {
    if (!online) return
    let live = true
    syncApi.readingStats(period).then(
      s => { if (live) { setStats(s); setLast(s); setFailed(false) } },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [period, online]))

  const choose = (p: ReadingStatsPeriod) => {
    if (p === period) return
    setStats(null)
    setFailed(false)
    setPeriod(p)
  }

  if (!online) return null
  if (!last) return failed ? null : <View style={[styles.skeleton, { backgroundColor: colors.surface }]} accessibilityLabel={t('profile.stats.title')} />

  const figure = (value: string | number, caption: string) => (
    <View style={styles.figure}>
      <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.caption, { color: colors.textSecondary }]}>{caption}</Text>
    </View>
  )

  let body
  if (stats) {
    const labels = readingStatsBarLabels(stats, t)
    const max = Math.max(1, ...stats.bars.map(b => b.minutes))
    body = (
      <>
        <View style={styles.row}>
          {figure(formatReadingMinutes(stats.minutes, t), t('profile.stats.timeRead'))}
          {figure(stats.daysRead, t('profile.stats.daysRead'))}
        </View>
        <View style={styles.chart} accessibilityLabel={t('profile.stats.chartLabel')}>
          {stats.bars.map((b, i) => (
            <View key={b.start} style={styles.col}>
              <View style={[styles.track, { borderBottomColor: colors.border }]}>
                {b.minutes > 0 && (
                  <View style={[styles.bar, { height: Math.max(2, (b.minutes / max) * CHART_HEIGHT), backgroundColor: colors.primary }]} />
                )}
              </View>
              <Text style={[styles.label, { color: colors.textSecondary }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{labels[i]}</Text>
            </View>
          ))}
        </View>
      </>
    )
  } else if (failed) {
    body = <Text style={[styles.caption, { color: colors.textSecondary }]}>{t('profile.stats.loadFailed')}</Text>
  } else {
    body = <View style={[styles.chartSkeleton, { backgroundColor: colors.surface }]} />
  }

  return (
    <View style={styles.block}>
      <Text style={[styles.title, { color: colors.textSecondary }]}>{t('profile.stats.title')}</Text>
      <View style={styles.row}>
        {figure(formatStreakDays(last.currentStreak, t), t('profile.stats.currentStreak'))}
        {figure(formatStreakDays(last.bestStreak, t), t('profile.stats.bestStreak'))}
      </View>
      <View style={[styles.switch, { backgroundColor: colors.surface, borderColor: colors.border }]} accessibilityLabel={t('profile.stats.periodLabel')}>
        {READING_STATS_PERIODS.map(p => {
          const on = p.period === period
          return (
            <TouchableOpacity
              key={p.period}
              style={[styles.segment, on && { backgroundColor: colors.background }]}
              onPress={() => choose(p.period)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.segmentText, { color: on ? colors.text : colors.textSecondary }, on && { fontFamily: fonts.sansMedium }]}>{t(p.key)}</Text>
            </TouchableOpacity>
          )
        })}
      </View>
      {body}
    </View>
  )
}

const styles = StyleSheet.create({
  block: { paddingHorizontal: 16, marginTop: 20 },
  skeleton: { marginHorizontal: 16, marginTop: 20, height: 180, borderRadius: 10 },
  chartSkeleton: { height: CHART_HEIGHT + 60, borderRadius: 8 },
  title: { fontFamily: fonts.sansMedium, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  row: { flexDirection: 'row', marginBottom: 12 },
  figure: { flex: 1 },
  value: { fontFamily: fonts.sansMedium, fontSize: 18 },
  caption: { fontFamily: fonts.sans, fontSize: 12, marginTop: 2 },
  switch: { flexDirection: 'row', borderRadius: 8, borderWidth: 1, padding: 3, marginBottom: 12 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: 6 },
  segmentText: { fontFamily: fonts.sans, fontSize: 13 },
  chart: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  col: { flex: 1, alignItems: 'center', minWidth: 0 },
  track: { width: '100%', height: CHART_HEIGHT, justifyContent: 'flex-end', borderBottomWidth: StyleSheet.hairlineWidth },
  bar: { width: '100%', borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  label: { fontFamily: fonts.sans, fontSize: 9, marginTop: 4, width: '100%', textAlign: 'center' },
})
