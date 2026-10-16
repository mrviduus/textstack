import { View, Text, StyleSheet } from 'react-native'
import type { ReviewCardDto } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { PressableScale } from '../ui/PressableScale'
import { Ionicons } from '@expo/vector-icons'

interface Props {
  card: ReviewCardDto
  onContinue: () => void
  onSpeak?: (text: string) => void
}

export function NewWordCard({ card, onContinue, onSpeak }: Props) {
  const { colors } = useTheme()

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={[styles.badge, { backgroundColor: colors.primaryLight }]}>
        <Text style={[styles.badgeText, { color: colors.primary }]}>NEW WORD</Text>
      </View>

      <View style={styles.wordRow}>
        {onSpeak && (
          <PressableScale onPress={() => onSpeak(card.word)} style={styles.speakBtn}>
            <Ionicons name="volume-high" size={22} color={colors.primary} />
          </PressableScale>
        )}
        <Text style={[styles.word, { color: colors.text }]}>{card.word}</Text>
      </View>

      {card.originalSentence && (
        <Text style={[styles.sentence, { color: colors.textSecondary }]}>{card.originalSentence}</Text>
      )}

      {card.translation && (
        <View style={styles.meaningRow}>
          <Text style={[styles.meaningLabel, { color: colors.textSecondary }]}>Meaning:</Text>
          <Text style={[styles.meaningValue, { color: colors.text }]}>{card.translation}</Text>
        </View>
      )}

      {(card.explanation || card.definition) && (
        <View style={[styles.explanationBox, { backgroundColor: colors.background }]}>
          <Text style={[styles.explanation, { color: colors.textSecondary }]}>
            {card.explanation || card.definition}
          </Text>
        </View>
      )}

      <PressableScale
        onPress={onContinue}
        style={[styles.continueBtn, { backgroundColor: colors.primary }]}
        accessibilityRole="button"
        accessibilityLabel="Continue to next card"
      >
        <Text style={styles.continueBtnText}>Continue</Text>
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, padding: 24, borderWidth: 1 },
  badge: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 16 },
  badgeText: { fontSize: 11, fontFamily: 'SourceSans3-Semibold', letterSpacing: 1 },
  wordRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  speakBtn: { padding: 4 },
  word: { fontSize: 28, fontFamily: 'TextStack-Bold' },
  sentence: { fontSize: 14, fontFamily: 'SourceSans3-Regular', lineHeight: 20, marginBottom: 12, fontStyle: 'italic' },
  meaningRow: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  meaningLabel: { fontSize: 14, fontFamily: 'SourceSans3-Medium' },
  meaningValue: { fontSize: 14, fontFamily: 'SourceSans3-Semibold', flex: 1 },
  explanationBox: { borderRadius: 10, padding: 14, marginBottom: 20 },
  explanation: { fontSize: 14, fontFamily: 'SourceSans3-Regular', lineHeight: 20 },
  continueBtn: { borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  continueBtnText: { color: '#fff', fontSize: 16, fontFamily: 'SourceSans3-Semibold' },
})
