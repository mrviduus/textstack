import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { fonts } from '../../theme/typography'
import { getVocabLevel } from '@textstack/shared'
import type { VocabularyStatsDto } from '@textstack/shared'

/**
 * One card that says what to do next, replacing four blocks that said how
 * things are going.
 *
 * It stands in for the stats tiles (Total / Due / Mastered / Streak / Level /
 * Practiced), the two large buttons, and the weekly budget bar — roughly half
 * the chrome QA counted above the first word. The tiles were not wrong, they
 * were just answering a question nobody had asked yet: a reader opening this
 * screen wants to review, and only then wants to know how it is going.
 *
 * So the count of due words is the headline, practising them is the button, and
 * the rest is one quiet line underneath. Numbers that do not change the next
 * action do not get a tile.
 */

interface Props {
  stats: VocabularyStatsDto | null
  dueCount: number
  onPractice: () => void
  /** Absent: no tutor here (V2, V2_FEATURES). */
  onSmartSession?: () => void
  smartSessionLabel: string
}

export function VocabSummaryCard({ stats, dueCount, onPractice, onSmartSession, smartSessionLabel }: Props) {
  const { colors } = useTheme()
  if (!stats || stats.totalWords === 0) return null

  const mastered = stats.byStage.mastered || 0
  const level = getVocabLevel(mastered)

  // Only what a reader would act on. A streak of zero is not an achievement to
  // report, and a level of zero is not a level.
  const facts = [
    `${stats.totalWords} saved`,
    mastered > 0 ? `${mastered} mastered` : null,
    stats.streak > 0 ? `${stats.streak}-day streak` : null,
    level.level > 0 ? level.label : null,
  ].filter(Boolean).join(' · ')

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.headline, { color: colors.text }]}>
        {dueCount > 0 ? `${dueCount} ${dueCount === 1 ? 'word' : 'words'} to review` : 'Nothing due right now'}
      </Text>
      <Text style={[styles.facts, { color: colors.textSecondary }]} numberOfLines={1}>{facts}</Text>

      <View style={styles.actions}>
        {dueCount > 0 && (
          <TouchableOpacity
            style={[styles.primary, { backgroundColor: colors.primary }]}
            onPress={onPractice}
            accessibilityRole="button"
          >
            <Ionicons name="school-outline" size={17} color="#fff" />
            <Text style={styles.primaryText}>Practice</Text>
          </TouchableOpacity>
        )}
        {onSmartSession && <TouchableOpacity
          style={[styles.secondary, { borderColor: colors.primary }]}
          onPress={onSmartSession}
          accessibilityRole="button"
          accessibilityLabel={smartSessionLabel}
        >
          <Ionicons name="sparkles-outline" size={16} color={colors.primary} />
          <Text style={[styles.secondaryText, { color: colors.primary }]} numberOfLines={1}>
            {smartSessionLabel}
          </Text>
        </TouchableOpacity>}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 14,
    marginTop: 10,
    marginBottom: 4,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  headline: { fontFamily: fonts.serifBold, fontSize: 19 },
  facts: { fontFamily: fonts.sans, fontSize: 12, marginTop: 3 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  primary: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 11, borderRadius: 8,
  },
  primaryText: { fontFamily: fonts.sansMedium, fontSize: 15, color: '#fff' },
  secondary: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 11, borderRadius: 8, borderWidth: 1,
  },
  secondaryText: { fontFamily: fonts.sansMedium, fontSize: 14 },
})
