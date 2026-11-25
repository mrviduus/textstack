/**
 * Profile "Reading" block (#1366): streaks, a period switch, its totals and bars (plain Views).
 * Hidden offline or when the request fails. Shown to guests too: a guest is a real session.
 */
import { useEffect, useState } from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
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
  const [stats, setStats] = useState<ReadingStatsDto | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!online) return
    let live = true
    setFailed(false)
    syncApi.readingStats(period).then(
      s => { if (live) setStats(s) },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [period, online])

  if (!online || failed) return null
  if (!stats) return <View style={[styles.skeleton, { backgroundColor: colors.surface }]} accessibilityLabel={t('profile.stats.title')} />

  const labels = readingStatsBarLabels(stats, t)
  const max = Math.max(1, ...stats.bars.map(b => b.minutes))
  const figure = (value: string | number, caption: string) => (
    <View style={styles.figure}>
      <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.caption, { color: colors.textSecondary }]}>{caption}</Text>
    </View>
  )

  return (
    <View style={styles.block}>
      <Text style={[styles.title, { color: colors.textSecondary }]}>{t('profile.stats.title')}</Text>
      <View style={styles.row}>
        {figure(formatStreakDays(stats.currentStreak, t), t('profile.stats.currentStreak'))}
        {figure(formatStreakDays(stats.bestStreak, t), t('profile.stats.bestStreak'))}
      </View>
      <View style={[styles.switch, { backgroundColor: colors.surface, borderColor: colors.border }]} accessibilityLabel={t('profile.stats.periodLabel')}>
        {READING_STATS_PERIODS.map(p => {
          const on = p.period === period
          return (
            <TouchableOpacity
              key={p.period}
              style={[styles.segment, on && { backgroundColor: colors.background }]}
              onPress={() => setPeriod(p.period)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.segmentText, { color: on ? colors.text : colors.textSecondary }, on && { fontFamily: fonts.sansMedium }]}>{t(p.key)}</Text>
            </TouchableOpacity>
          )
        })}
      </View>
      <View style={styles.row}>
        {figure(formatReadingMinutes(stats.minutes, t), t('profile.stats.timeRead'))}
        {figure(stats.daysRead, t('profile.stats.daysRead'))}
      </View>
      <View style={styles.chart} accessibilityLabel={t('profile.stats.chartLabel')}>
        {stats.bars.map((b, i) => (
          <View key={b.start} style={styles.col}>
            <View style={styles.track}>
              <View style={[styles.bar, { height: Math.max(2, (b.minutes / max) * CHART_HEIGHT), backgroundColor: colors.primary }]} />
            </View>
            <Text style={[styles.label, { color: colors.textSecondary }]}>{labels[i]}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  block: { paddingHorizontal: 16, marginTop: 20 },
  skeleton: { marginHorizontal: 16, marginTop: 20, height: 180, borderRadius: 10 },
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
  track: { width: '100%', height: CHART_HEIGHT, justifyContent: 'flex-end' },
  bar: { width: '100%', borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  label: { fontFamily: fonts.sans, fontSize: 10, marginTop: 4, height: 14, width: 28, textAlign: 'center' },
})
