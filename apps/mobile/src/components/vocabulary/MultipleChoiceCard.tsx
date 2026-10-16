import { View, Text, StyleSheet } from 'react-native'
import type { ReviewCardDto } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useCardAnswer } from '../../hooks/useCardAnswer'
import { PressableScale } from '../ui/PressableScale'
import { Ionicons } from '@expo/vector-icons'

interface Props {
  card: ReviewCardDto
  onAnswer: (isCorrect: boolean, responseTimeMs: number) => void
  onSpeak?: (text: string) => void
  disabled?: boolean
}

export function MultipleChoiceCard({ card, onAnswer, onSpeak, disabled }: Props) {
  const { colors } = useTheme()
  const { submitted, submitChoice } = useCardAnswer(onAnswer, disabled)

  const isCloze = !!card.blankSentence
  const prompt = card.blankSentence || card.definition || card.translation || card.word

  const getOptionStyle = (idx: number) => {
    if (!submitted) return { backgroundColor: colors.surface, borderColor: colors.border }
    if (idx === card.correctOptionIndex)
      return { backgroundColor: colors.success + '20', borderColor: colors.success }
    if (idx !== card.correctOptionIndex)
      return { backgroundColor: colors.error + '15', borderColor: colors.border }
    return { backgroundColor: colors.surface, borderColor: colors.border }
  }

  const getOptionTextColor = (idx: number) => {
    if (!submitted) return colors.text
    if (idx === card.correctOptionIndex) return colors.success
    return colors.textSecondary
  }

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.promptRow}>
        {onSpeak && (
          <PressableScale onPress={() => onSpeak(card.word)} style={styles.speakBtn}>
            <Ionicons name="volume-high" size={20} color={colors.primary} />
          </PressableScale>
        )}
        <Text style={[styles.prompt, isCloze && styles.promptCloze, { color: colors.text }]}>{prompt}</Text>
      </View>

      {card.hint && !isCloze && (
        <Text style={[styles.hint, { color: colors.textSecondary }]}>{card.hint}</Text>
      )}

      <View style={styles.options}>
        {(card.options || []).map((opt, idx) => (
          <PressableScale
            key={idx}
            onPress={() => submitChoice(idx === card.correctOptionIndex)}
            disabled={submitted || disabled}
            style={[styles.option, getOptionStyle(idx)]}
            accessibilityRole="button"
            accessibilityLabel={`Option ${idx + 1}: ${opt}`}
            accessibilityState={{ disabled: submitted || disabled }}
          >
            <Text style={[styles.optionText, { color: getOptionTextColor(idx) }]}>{opt}</Text>
          </PressableScale>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, padding: 24, borderWidth: 1 },
  promptRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  speakBtn: { padding: 4 },
  prompt: { fontSize: 17, fontFamily: 'SourceSans3-Medium', flex: 1, lineHeight: 24 },
  promptCloze: { fontStyle: 'italic' },
  hint: { fontSize: 13, fontFamily: 'SourceSans3-Regular', marginBottom: 16, lineHeight: 18 },
  options: { gap: 10 },
  option: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, borderWidth: 1 },
  optionText: { fontSize: 16, fontFamily: 'SourceSans3-Medium', textAlign: 'center' },
})
