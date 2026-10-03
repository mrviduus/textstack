import { View, Text, StyleSheet } from 'react-native'
import type { ReviewCardDto, SubmitReviewResponse } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { PressableScale } from '../ui/PressableScale'
import { Ionicons } from '@expo/vector-icons'
import type { ReviewMode } from '../../hooks/useVocabularyReview'

const STAGE_NAMES = ['New', 'Recognition', 'Recall', 'Context', 'Mastered']

interface Props {
  card: ReviewCardDto
  result: SubmitReviewResponse
  isCorrect: boolean
  reviewMode: ReviewMode
  onSpeak?: (text: string) => void
  onNext: () => void
}

export function ReviewFeedback({ card, result, isCorrect, reviewMode, onSpeak, onNext }: Props) {
  const { colors } = useTheme()

  // Mini feedback for classic mode.
  // Previously the whole card was `alignItems: 'center'` which made the Next
  // button shrink to text-width — tap target looked tiny (B-78). Pull the
  // button out of that center-alignment with `alignSelf: 'stretch'` so it
  // fills the card width, and bump padding to match the blitz-mode CTA.
  if (reviewMode === 'classic') {
    return (
      <View style={[styles.mini, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={[styles.miniBadge, { backgroundColor: isCorrect ? colors.success + '20' : colors.error + '20' }]}>
          <Text style={[styles.miniBadgeText, { color: isCorrect ? colors.success : colors.error }]}>
            {isCorrect ? 'Correct' : 'Wrong'}
          </Text>
        </View>
        {result.stageChanged && (
          <Text style={[styles.stageChange, { color: colors.textSecondary }]}>
            {STAGE_NAMES[result.previousStage]} → {STAGE_NAMES[result.newStage]}
          </Text>
        )}
        <PressableScale
          onPress={onNext}
          style={[styles.miniNextBtn, { backgroundColor: colors.primary }]}
          accessibilityRole="button"
          accessibilityLabel="Next card"
        >
          <Text style={styles.nextBtnText}>Next</Text>
        </PressableScale>
      </View>
    )
  }

  // Full feedback for blitz mode
  const definition = card.definition

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={[styles.badge, { backgroundColor: isCorrect ? colors.success + '20' : colors.error + '20' }]}>
        <Ionicons
          name={isCorrect ? 'checkmark-circle' : 'close-circle'}
          size={24}
          color={isCorrect ? colors.success : colors.error}
        />
        <Text style={[styles.badgeText, { color: isCorrect ? colors.success : colors.error }]}>
          {isCorrect ? 'Correct' : 'Wrong'}
        </Text>
      </View>

      <View style={styles.wordRow}>
        {onSpeak && (
          <PressableScale onPress={() => onSpeak(card.word)} style={styles.speakBtn}>
            <Ionicons name="volume-high" size={20} color={colors.primary} />
          </PressableScale>
        )}
        <Text style={[styles.word, { color: colors.text }]}>{card.word}</Text>
        <Text style={[styles.translation, { color: colors.textSecondary }]}>
          {card.translation || '\u2014'}
        </Text>
      </View>

      {!isCorrect && (
        <Text style={[styles.correctLabel, { color: colors.success }]}>
          Correct: {card.word}
        </Text>
      )}

      {card.originalSentence && (
        <View style={styles.sentenceRow}>
          <Text style={[styles.sentence, { color: colors.textSecondary }]}>{card.originalSentence}</Text>
          {card.bookTitle && (
            <Text style={[styles.book, { color: colors.textSecondary }]}>{card.bookTitle}</Text>
          )}
        </View>
      )}

      {definition && (
        <Text style={[styles.definition, { color: colors.text }]}>{definition}</Text>
      )}

      {result.stageChanged && (
        <View style={[styles.stageRow, { borderTopColor: colors.border }]}>
          <Text style={[styles.stageChange, { color: colors.textSecondary }]}>
            {STAGE_NAMES[result.previousStage]} → {STAGE_NAMES[result.newStage]}
          </Text>
        </View>
      )}

      <PressableScale onPress={onNext} style={[styles.nextBtn, { backgroundColor: colors.primary }]}>
        <Text style={styles.nextBtnText}>Next</Text>
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, padding: 24, borderWidth: 1 },
  mini: { borderRadius: 16, padding: 20, borderWidth: 1, alignItems: 'center', gap: 12 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 16 },
  miniBadge: { borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  badgeText: { fontSize: 16, fontFamily: 'Inter-SemiBold' },
  miniBadgeText: { fontSize: 15, fontFamily: 'Inter-SemiBold' },
  wordRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  speakBtn: { padding: 4 },
  word: { fontSize: 20, fontFamily: 'Inter-SemiBold' },
  translation: { fontSize: 16, fontFamily: 'Inter-Regular' },
  correctLabel: { fontSize: 14, fontFamily: 'Inter-SemiBold', marginBottom: 8 },
  sentenceRow: { marginBottom: 12 },
  sentence: { fontSize: 14, fontFamily: 'Inter-Regular', lineHeight: 20, fontStyle: 'italic' },
  book: { fontSize: 12, fontFamily: 'Inter-Regular', marginTop: 4 },
  definition: { fontSize: 14, fontFamily: 'Inter-Regular', lineHeight: 20, marginBottom: 12 },
  stageRow: { borderTopWidth: 1, paddingTop: 12, marginBottom: 12 },
  stageChange: { fontSize: 13, fontFamily: 'Inter-Medium' },
  nextBtn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  // Mini variant: stretch across the card so tap target is full-width,
  // matching the visual weight of the blitz-mode CTA.
  miniNextBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: 8,
  },
  nextBtnText: { color: '#fff', fontSize: 16, fontFamily: 'Inter-SemiBold' },
})
