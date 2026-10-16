import { useEffect, useRef } from 'react'
import { View, Text, StyleSheet, Animated } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { PressableScale } from '../ui/PressableScale'
import { Ionicons } from '@expo/vector-icons'
import { REVIEW_BATCH_SIZES, plural } from '@textstack/shared'
import type { ReviewMode } from '@textstack/shared'

type RewardTier = 'perfect' | 'great' | 'good' | 'keep'

function getReward(rate: number): { tier: RewardTier; message: string } {
  if (rate === 100) return { tier: 'perfect', message: 'Perfect session!' }
  if (rate >= 80) return { tier: 'great', message: 'Excellent work!' }
  if (rate >= 60) return { tier: 'good', message: 'Good progress!' }
  return { tier: 'keep', message: 'Keep practicing!' }
}

interface Props {
  reviewed: number
  correct: number
  elapsedMs: number
  reviewMode: ReviewMode
  dueCount: number
  batchSize: number
  onAgain: () => void
  onBack: () => void
  onBatchChange: (size: number) => void
  onModeChange: (mode: ReviewMode) => void
}

export function SessionSummary({
  reviewed, correct, elapsedMs, reviewMode, dueCount, batchSize,
  onAgain, onBack, onBatchChange, onModeChange,
}: Props) {
  const { colors } = useTheme()
  const translateY = useRef(new Animated.Value(-30)).current
  const opacity = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.spring(translateY, { toValue: 0, useNativeDriver: true, tension: 60, friction: 8 }).start()
    Animated.timing(opacity, { toValue: 1, duration: 400, useNativeDriver: true }).start()
  }, [])

  const isEmpty = reviewed === 0
  const rate = reviewed > 0 ? Math.round((correct / reviewed) * 100) : 0
  const reward = getReward(rate)
  const elapsedSec = Math.round(elapsedMs / 1000)
  const timeText = elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` : `${elapsedSec}s`

  const tierColors: Record<RewardTier, string> = {
    perfect: colors.success,
    great: colors.primary,
    good: colors.warning,
    keep: colors.textSecondary,
  }
  const tierColor = tierColors[reward.tier]

  if (isEmpty) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Ionicons name="checkmark-circle-outline" size={56} color={colors.success} />
        <Text style={[styles.title, { color: colors.text }]}>All caught up!</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>No words due for review.</Text>
        <PressableScale
          onPress={onBack}
          style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
          accessibilityRole="button"
          accessibilityLabel="Back to Vocabulary"
        >
          <Text style={styles.primaryBtnText}>Back to Vocabulary</Text>
        </PressableScale>
      </View>
    )
  }

  return (
    <Animated.View style={[styles.container, { backgroundColor: colors.background, transform: [{ translateY }], opacity }]}>
      {/* Banner */}
      <View style={[styles.banner, { backgroundColor: tierColor + '20' }]}>
        <Text style={[styles.bannerText, { color: tierColor }]}>{reward.message}</Text>
      </View>

      {/* Stats */}
      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={[styles.statBig, { color: colors.text }]}>{reviewed}</Text>
          <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Reviewed</Text>
        </View>
        <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
        <View style={styles.stat}>
          <Text style={[styles.statBig, { color: tierColor }]}>{rate}%</Text>
          <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Correct</Text>
        </View>
        <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
        <View style={styles.stat}>
          <Text style={[styles.statBig, { color: colors.text }]}>{timeText}</Text>
          <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Time</Text>
        </View>
      </View>

      {/* Mode toggle */}
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>Review Style</Text>
        <View style={[styles.toggle, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {(['blitz', 'classic'] as ReviewMode[]).map(m => (
            <PressableScale
              key={m}
              onPress={() => onModeChange(m)}
              style={[styles.toggleItem, reviewMode === m && { backgroundColor: colors.primary }]}
              accessibilityRole="button"
              accessibilityLabel={m === 'blitz' ? 'Blitz mode' : 'Flashcards mode'}
              accessibilityState={{ selected: reviewMode === m }}
            >
              <Ionicons
                name={m === 'blitz' ? 'flash' : 'layers'}
                size={14}
                color={reviewMode === m ? '#fff' : colors.textSecondary}
              />
              <Text style={[styles.toggleText, { color: reviewMode === m ? '#fff' : colors.textSecondary }]}>
                {m === 'blitz' ? 'Blitz' : 'Flashcards'}
              </Text>
            </PressableScale>
          ))}
        </View>
      </View>

      {/* Batch size */}
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>Batch Size</Text>
        <View style={styles.batchRow}>
          {REVIEW_BATCH_SIZES.map(n => (
            <PressableScale
              key={n}
              onPress={() => onBatchChange(n)}
              style={[
                styles.batchChip,
                { borderColor: batchSize === n ? colors.primary : colors.border },
                batchSize === n && { backgroundColor: colors.primaryLight },
              ]}
              accessibilityRole="button"
              accessibilityLabel={plural(n, 'card', 'cards', 'Batch of {n} {noun}')}
              accessibilityState={{ selected: batchSize === n }}
            >
              <Text style={[styles.batchText, { color: batchSize === n ? colors.primary : colors.textSecondary }]}>
                {n}
              </Text>
            </PressableScale>
          ))}
        </View>
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <PressableScale
          onPress={onAgain}
          style={[styles.actionBtn, { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel={`Practice again${dueCount > 0 ? `, ${dueCount} due` : ''}`}
        >
          <Ionicons name="refresh-outline" size={18} color={colors.primary} />
          <Text style={[styles.actionBtnText, { color: colors.primary }]}>
            Practice Again{dueCount > 0 ? ` (${dueCount} due)` : ''}
          </Text>
        </PressableScale>

        <PressableScale
          onPress={onBack}
          style={[styles.actionBtn, { backgroundColor: colors.primary }]}
          accessibilityRole="button"
          accessibilityLabel="Back to Vocabulary"
        >
          <Text style={[styles.actionBtnText, { color: '#fff' }]}>Back to Vocabulary</Text>
        </PressableScale>
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: 'center', alignItems: 'center' },
  banner: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 24, marginBottom: 24 },
  bannerText: { fontSize: 20, fontFamily: 'SourceSans3-Semibold', textAlign: 'center' },
  title: { fontSize: 22, fontFamily: 'TextStack-Bold', marginTop: 16, textAlign: 'center' },
  subtitle: { fontSize: 14, fontFamily: 'SourceSans3-Regular', marginTop: 8, textAlign: 'center', marginBottom: 24 },
  statsRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  stat: { flex: 1, alignItems: 'center' },
  statBig: { fontSize: 28, fontFamily: 'SourceSans3-Semibold' },
  statLabel: { fontSize: 12, fontFamily: 'SourceSans3-Regular', marginTop: 4 },
  statDivider: { width: 1, height: 32, marginHorizontal: 8 },
  practiceNote: { fontSize: 12, fontFamily: 'SourceSans3-Medium', marginBottom: 16 },
  section: { width: '100%', marginBottom: 16 },
  sectionLabel: { fontSize: 12, fontFamily: 'SourceSans3-Medium', marginBottom: 8 },
  toggle: { flexDirection: 'row', borderRadius: 10, borderWidth: 1, overflow: 'hidden' },
  toggleItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 9 },
  toggleText: { fontSize: 14, fontFamily: 'SourceSans3-Medium' },
  batchRow: { flexDirection: 'row', gap: 8 },
  batchChip: { borderRadius: 10, borderWidth: 1, paddingVertical: 8, paddingHorizontal: 20 },
  batchText: { fontSize: 14, fontFamily: 'SourceSans3-Medium' },
  actions: { width: '100%', gap: 10, marginTop: 8 },
  actionBtn: { borderRadius: 12, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  actionBtnText: { fontSize: 16, fontFamily: 'SourceSans3-Semibold' },
  primaryBtn: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32, marginTop: 16 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontFamily: 'SourceSans3-Semibold' },
})
