import { useState, useRef, useCallback } from 'react'
import { View, Text, Animated, StyleSheet, Pressable } from 'react-native'
import type { ReviewCardDto, SelfAssessment } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { PressableScale } from '../ui/PressableScale'
import { Ionicons } from '@expo/vector-icons'

const ASSESSMENTS: { key: SelfAssessment; label: string }[] = [
  { key: 'forgot', label: 'Forgot' },
  { key: 'almost', label: 'Almost' },
  { key: 'knew', label: 'Knew' },
]

interface Props {
  card: ReviewCardDto
  onAnswer: (isCorrect: boolean, responseTimeMs: number, selfAssessment: SelfAssessment) => void
  onSpeak?: (text: string) => void
  onFlip?: () => void
  disabled?: boolean
}

export function FlashCard({ card, onAnswer, onSpeak, onFlip, disabled }: Props) {
  const { colors } = useTheme()
  const [flipped, setFlipped] = useState(false)
  const [startTime] = useState(() => Date.now())
  const flipAnim = useRef(new Animated.Value(0)).current

  const handleFlip = useCallback(() => {
    if (flipped) return
    setFlipped(true)
    onFlip?.()
    Animated.spring(flipAnim, {
      toValue: 1,
      useNativeDriver: true,
      tension: 80,
      friction: 10,
    }).start()
  }, [flipped, onFlip, flipAnim])

  const handleAssess = useCallback((assessment: SelfAssessment) => {
    if (disabled) return
    onAnswer(assessment === 'knew', Date.now() - startTime, assessment)
  }, [disabled, onAnswer, startTime])

  const frontRotation = flipAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] })
  const backRotation = flipAnim.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '360deg'] })
  const frontOpacity = flipAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0, 0] })
  const backOpacity = flipAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0, 1] })

  const assessColors = { forgot: colors.error, almost: colors.warning, knew: colors.success }

  return (
    <View>
      <Pressable
        onPress={handleFlip}
        disabled={flipped}
        accessibilityRole="button"
        accessibilityLabel={flipped ? 'Card flipped — answer visible' : `Tap to reveal translation of ${card.word}`}
      >
        <View style={styles.cardContainer}>
          {/* Front */}
          <Animated.View style={[
            styles.face, { backgroundColor: colors.surface, borderColor: colors.border },
            { transform: [{ rotateY: frontRotation }], opacity: frontOpacity },
          ]}>
            <View style={styles.wordRow}>
              {onSpeak && (
                <PressableScale onPress={() => onSpeak(card.word)} style={styles.speakBtn}>
                  <Ionicons name="volume-high" size={20} color={colors.primary} />
                </PressableScale>
              )}
              <Text style={[styles.word, { color: colors.text }]}>{card.word}</Text>
            </View>
            {card.originalSentence && (
              <Text style={[styles.sentence, { color: colors.textSecondary }]}>{card.originalSentence}</Text>
            )}
            {card.bookTitle && (
              <Text style={[styles.book, { color: colors.textSecondary }]}>{card.bookTitle}</Text>
            )}
            {!flipped && (
              <Text style={[styles.tapHint, { color: colors.textSecondary }]}>Tap to flip</Text>
            )}
          </Animated.View>

          {/* Back */}
          <Animated.View style={[
            styles.face, styles.faceBack, { backgroundColor: colors.surface, borderColor: colors.border },
            { transform: [{ rotateY: backRotation }], opacity: backOpacity },
          ]}>
            <Text style={[styles.translation, { color: colors.text }]}>{card.translation || '\u2014'}</Text>
            {card.definition && (
              <Text style={[styles.definition, { color: colors.textSecondary }]}>{card.definition}</Text>
            )}
            {card.hint && (
              <Text style={[styles.hint, { color: colors.textSecondary }]}>{card.hint}</Text>
            )}
          </Animated.View>
        </View>
      </Pressable>

      {flipped && (
        <View style={styles.assessment}>
          <Text style={[styles.assessLabel, { color: colors.textSecondary }]}>Did you remember?</Text>
          <View style={styles.assessButtons}>
            {ASSESSMENTS.map(({ key, label }) => (
              <PressableScale
                key={key}
                onPress={() => handleAssess(key)}
                disabled={disabled}
                style={[styles.assessBtn, { backgroundColor: assessColors[key] }]}
                accessibilityLabel={label}
              >
                <Text style={styles.assessBtnText}>{label}{key === 'knew' ? ' \u2713' : ''}</Text>
              </PressableScale>
            ))}
          </View>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  cardContainer: { minHeight: 220 },
  face: {
    position: 'absolute', top: 0, left: 0, right: 0,
    borderRadius: 16, padding: 24, borderWidth: 1,
    backfaceVisibility: 'hidden', minHeight: 220,
    justifyContent: 'center',
  },
  faceBack: {},
  wordRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  speakBtn: { padding: 4 },
  word: { fontSize: 28, fontFamily: 'TextStack-Bold' },
  sentence: { fontSize: 14, fontFamily: 'SourceSans3-Regular', lineHeight: 20, marginBottom: 8 },
  book: { fontSize: 12, fontFamily: 'SourceSans3-Regular' },
  tapHint: { fontSize: 13, fontFamily: 'SourceSans3-Regular', textAlign: 'center', marginTop: 16 },
  translation: { fontSize: 24, fontFamily: 'TextStack-Bold', textAlign: 'center', marginBottom: 12 },
  definition: { fontSize: 14, fontFamily: 'SourceSans3-Regular', textAlign: 'center', lineHeight: 20, marginBottom: 8 },
  hint: { fontSize: 13, fontFamily: 'SourceSans3-Regular', textAlign: 'center', fontStyle: 'italic', lineHeight: 18 },
  assessment: { marginTop: 24, alignItems: 'center' },
  assessLabel: { fontSize: 14, fontFamily: 'SourceSans3-Medium', marginBottom: 12 },
  assessButtons: { flexDirection: 'row', gap: 12 },
  assessBtn: { borderRadius: 12, paddingVertical: 12, paddingHorizontal: 20 },
  assessBtnText: { color: '#fff', fontSize: 15, fontFamily: 'SourceSans3-Semibold', textAlign: 'center' },
})
