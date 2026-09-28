import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { fonts } from '../../theme/typography'
import type { VocabularyStatsDto } from '@textstack/shared'
import { WeeklyBudgetBar } from './WeeklyBudgetBar'

/**
 * Every control that shapes the word list, behind one entry.
 *
 * The screen used to put eight blocks between the reader and their first word:
 * a weekly budget bar, a settings chip, four to six stat tiles, an unlabelled
 * two-colour segment (it was a review-mode switch), two large buttons, six
 * filter chips, a search box and four sort chips — with "Mastered" wrapping to
 * a second line. QA counted them and pointed out this is the same illness
 * Library was treated for.
 *
 * Same treatment, then. What stays on the screen is what changes the next
 * action: one primary CTA, search, and the filter. Everything that only shapes
 * the view moves in here, and `LibraryViewSheet` is the model — down to the
 * grabber, the Done affordance and the checkmark on the active row.
 */

export type ReviewModeKey = 'blitz' | 'classic'

interface Props {
  visible: boolean
  reviewMode: ReviewModeKey
  sort: string
  sortOptions: readonly { key: string; label: string }[]
  stats: VocabularyStatsDto | null
  onSelectReviewMode: (next: ReviewModeKey) => void
  onSelectSort: (next: string) => void
  onOpenSettings: () => void
  onClose: () => void
}

function SectionHeading({ children }: { children: string }) {
  const { colors } = useTheme()
  return <Text style={[styles.heading, { color: colors.textSecondary }]}>{children.toUpperCase()}</Text>
}

function Row({
  icon, label, hint, active, onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  hint?: string
  active?: boolean
  onPress: () => void
}) {
  const { colors } = useTheme()
  return (
    <TouchableOpacity
      style={[styles.row, active && { backgroundColor: colors.primaryLight }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
    >
      <Ionicons name={icon} size={18} color={active ? colors.primary : colors.textSecondary} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.label, { color: active ? colors.primary : colors.text }]} numberOfLines={1}>
          {label}
        </Text>
        {hint && (
          <Text style={[styles.hint, { color: colors.textSecondary }]} numberOfLines={1}>{hint}</Text>
        )}
      </View>
      {active && <Ionicons name="checkmark" size={18} color={colors.primary} />}
    </TouchableOpacity>
  )
}

export function VocabViewSheet({
  visible, reviewMode, sort, sortOptions, stats,
  onSelectReviewMode, onSelectSort, onOpenSettings, onClose,
}: Props) {
  const { colors } = useTheme()

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close view options" />
      <View style={[styles.sheet, { backgroundColor: colors.background }]}>
        <View style={[styles.grabber, { backgroundColor: colors.border }]} />
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>View</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Done">
            <Text style={[styles.done, { color: colors.primary }]}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
          <SectionHeading>Review style</SectionHeading>
          {/* The old segment showed two icons and two words in a filled bar with
              no heading, which QA read as "an unnamed orange strip". Naming what
              it chooses between costs one line. */}
          <Row
            icon="flash"
            label="Blitz"
            hint="Multiple choice, fast"
            active={reviewMode === 'blitz'}
            onPress={() => onSelectReviewMode('blitz')}
          />
          <Row
            icon="layers"
            label="Flashcards"
            hint="Recall, then grade yourself"
            active={reviewMode === 'classic'}
            onPress={() => onSelectReviewMode('classic')}
          />

          <SectionHeading>Sort</SectionHeading>
          {sortOptions.map(s => (
            <Row
              key={s.key}
              icon="swap-vertical-outline"
              label={s.label}
              active={sort === s.key}
              onPress={() => onSelectSort(s.key)}
            />
          ))}

          {stats?.weeklyProgress && (
            <>
              <SectionHeading>This week</SectionHeading>
              <View style={styles.budgetWrap}>
                <WeeklyBudgetBar progress={stats.weeklyProgress} />
              </View>
            </>
          )}

          <SectionHeading>Settings</SectionHeading>
          <Row
            icon="settings-outline"
            label="Daily cap and reminders"
            onPress={() => { onClose(); onOpenSettings() }}
          />
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    maxHeight: '80%',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 12, paddingTop: 10,
  },
  grabber: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 10 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 8, paddingBottom: 8,
  },
  title: { fontFamily: fonts.serifBold, fontSize: 20 },
  done: { fontFamily: fonts.sansMedium, fontSize: 15 },
  heading: { fontFamily: fonts.sansMedium, fontSize: 11, letterSpacing: 0.6, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 8 },
  label: { fontFamily: fonts.sansMedium, fontSize: 15 },
  hint: { fontFamily: fonts.sans, fontSize: 12, marginTop: 1 },
  budgetWrap: { paddingHorizontal: 4 },
})
