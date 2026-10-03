import { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, SafeAreaView, KeyboardAvoidingView, Platform } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, Stack, useLocalSearchParams } from 'expo-router'
import { REVIEW_BATCH_SIZES, DEFAULT_BATCH_SIZE, vocabularyApi } from '@textstack/shared'
import type { SelfAssessment, ReviewMode } from '@textstack/shared'
import { useTheme } from '../../src/context/ThemeContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { useTts } from '../../src/hooks/useTts'
import { useHaptics } from '../../src/hooks/useHaptics'
import { useVocabularyReview } from '../../src/hooks/useVocabularyReview'
import { reviewModeFromParam } from '../../src/lib/reviewMode'
import { LoadingScreen } from '../../src/components/ui/LoadingScreen'
import { PressableScale } from '../../src/components/ui/PressableScale'
import { MultipleChoiceCard } from '../../src/components/vocabulary/MultipleChoiceCard'
import { FlashCard } from '../../src/components/vocabulary/FlashCard'
import { NewWordCard } from '../../src/components/vocabulary/NewWordCard'
import { ReviewFeedback } from '../../src/components/vocabulary/ReviewFeedback'
import { SessionSummary } from '../../src/components/vocabulary/SessionSummary'
import { WeeklyBudgetBar } from '../../src/components/vocabulary/WeeklyBudgetBar'

export default function VocabularyReviewScreen() {
  const { colors } = useTheme()
  const { language, t } = useLanguage()
  const router = useRouter()
  const params = useLocalSearchParams<{ limit?: string; reviewMode?: string; cluster?: string; practice?: string }>()
  const clusterId = typeof params.cluster === 'string' ? params.cluster : null
  const practiceMode = params.practice === '1' || params.practice === 'true'
  // The mode this session starts in, as a plain value — the point being that it
  // is NOT hook state. See `reviewModeFromParam` for the failure that made this
  // necessary (#558); web derives it the same way and for the same reason.
  const initialReviewMode = reviewModeFromParam(params.reviewMode)

  const [batchSize, setBatchSize] = useState(() => {
    const v = parseInt(params.limit || String(DEFAULT_BATCH_SIZE), 10)
    return (REVIEW_BATCH_SIZES as readonly number[]).includes(v) ? v : DEFAULT_BATCH_SIZE
  })

  const review = useVocabularyReview()
  const { speak: speakTts, toggle: toggleTts } = useTts()
  // The setting lives with the account now, beside the other vocabulary settings, because it
  // governs these cards and not the reader. Defaults to speaking while the fetch is in flight —
  // the same value a new account gets, so the first card of a session is not silent by accident.
  const [autoSpeak, setAutoSpeak] = useState(true)
  useEffect(() => {
    let cancelled = false
    vocabularyApi.getVocabSettings()
      .then(s => { if (!cancelled) setAutoSpeak(s.autoSpeakCards ?? true) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  const haptics = useHaptics()
  const sessionStartRef = useRef(Date.now())

  // Start session.
  //
  // There used to be a second mount effect above this one that dispatched
  // `review.setReviewMode(params.reviewMode)`. It is gone, and its removal is
  // the fix: `startSession`/`startClusterSession` already call `setReviewMode`
  // with whatever they are handed, so there is now exactly one writer of the
  // mode during startup and nothing for React's batching to resolve in the
  // wrong order. What is passed is `initialReviewMode`, a value derived from
  // the params above — deliberately not `review.reviewMode`, which at mount is
  // the closure's copy of the hook default and never the param.
  useEffect(() => {
    sessionStartRef.current = Date.now()
    if (clusterId) {
      review.startClusterSession(clusterId, initialReviewMode)
    } else {
      review.startSession(batchSize, initialReviewMode, practiceMode)
    }
    // `review` is stable per-hook; `initialReviewMode` is a plain string, so
    // listing it is a value comparison and cannot loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchSize, clusterId, practiceMode, initialReviewMode])

  // Say the word when its card appears.
  //
  // The speaker button has always been there and has always worked, but nothing
  // ever spoke on its own — so on a screen whose whole purpose is learning a
  // word, hearing it was something you had to know to ask for. Owner's call to
  // make it the default; the toggle lives beside "Auto-save words on tap".
  //
  // Keyed on the card, so it happens once per card and not again when the
  // answer is revealed, the mode changes, or the screen re-renders for any of
  // the other reasons it does.
  const spokenCardRef = useRef<string | null>(null)
  const currentWord = review.currentCard?.word
  const currentWordId = review.currentCard?.wordId
  useEffect(() => {
    if (!autoSpeak) return
    if (!currentWord || !currentWordId) return
    if (spokenCardRef.current === currentWordId) return
    spokenCardRef.current = currentWordId
    // speak, not toggle: toggle would stop the audio if a previous card's
    // playback happened to still be running, which is silence where the reader
    // asked for sound.
    void speakTts(currentWord, { lang: language })
  }, [currentWord, currentWordId, autoSpeak, speakTts, language])

  // Haptic on session-complete — must be in an effect, not render, or
  // it re-fires on every re-render while the summary is visible.
  const sessionComplete = review.isSessionComplete || !review.hasCards
  useEffect(() => {
    if (sessionComplete && !review.loading) {
      haptics.play('complete')
      if (review.activeClusterId) {
        vocabularyApi.completeCluster(review.activeClusterId).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionComplete, review.loading])

  const handleAnswer = async (isCorrect: boolean, responseTimeMs: number, selfAssessment?: SelfAssessment) => {
    haptics.play(isCorrect ? 'correct' : 'wrong')
    await review.submitAnswer(isCorrect, responseTimeMs, selfAssessment)
  }

  const handleFlip = () => haptics.play('flip')

  const handleAgain = () => {
    sessionStartRef.current = Date.now()
    review.startSession(batchSize, review.reviewMode, practiceMode)
  }

  const handlePracticeAnyway = () => {
    router.replace({
      pathname: '/vocabulary/review',
      params: { ...params, practice: '1' },
    } as any)
  }

  // Loading
  if (review.loading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Practice', headerShown: true }} />
        <LoadingScreen />
      </>
    )
  }

  const budgetReached = !practiceMode && !review.hasCards && (review.weeklyProgress?.remaining ?? 1) <= 0

  // Budget-reached empty state — served when the backend returned no cards
  // because the weekly budget is exhausted (not because nothing is due).
  // Practice mode bypasses the budget entirely so this branch never fires there.
  if (budgetReached) {
    return (
      <>
        <Stack.Screen options={{ title: 'Practice', headerShown: true }} />
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          {review.weeklyProgress && <WeeklyBudgetBar progress={review.weeklyProgress} />}
          <View style={styles.budgetReached}>
            <Ionicons name="checkmark-done-circle" size={64} color={colors.primary} />
            <Text style={[styles.budgetReachedTitle, { color: colors.text }]}>
              {t('vocabulary.banner.budgetReached')}
            </Text>
            <Text style={[styles.budgetReachedSubtitle, { color: colors.textSecondary }]}>
              {t('vocabulary.weeklyBudget.emptyStateSubtitle')}
            </Text>
            <PressableScale
              onPress={handlePracticeAnyway}
              style={[styles.budgetReachedCta, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.budgetReachedCtaText}>
                {t('vocabulary.practice.cta')}
              </Text>
            </PressableScale>
            <PressableScale
              onPress={() => router.back()}
              style={styles.budgetReachedSecondary}
            >
              <Text style={[styles.budgetReachedSecondaryText, { color: colors.textSecondary }]}>
                {t('vocabulary.weeklyBudget.backToReading')}
              </Text>
            </PressableScale>
          </View>
        </SafeAreaView>
      </>
    )
  }

  // Session complete (haptic fires from the effect above, not here)
  if (sessionComplete) {
    return (
      <>
        <Stack.Screen options={{ title: review.hasCards ? 'Session Complete' : 'Practice', headerShown: true }} />
        <SessionSummary
          reviewed={review.sessionStats.reviewed}
          correct={review.sessionStats.correct}
          elapsedMs={Date.now() - sessionStartRef.current}
          reviewMode={review.reviewMode}
          dueCount={review.totalDue}
          batchSize={batchSize}
          onAgain={handleAgain}
          onBack={() => router.back()}
          onBatchChange={setBatchSize}
          onModeChange={(m: ReviewMode) => review.setReviewMode(m)}
        />
      </>
    )
  }

  const card = review.currentCard!
  const progress = review.cards.length > 0 ? (review.currentIndex / review.cards.length) * 100 : 0

  return (
    <>
      <Stack.Screen options={{
        title: practiceMode
          ? `Practice (${review.currentIndex + 1}/${review.cards.length}) · Free`
          : `Practice (${review.currentIndex + 1}/${review.cards.length})`,
        headerShown: true,
        headerRight: () => (
          <View style={styles.headerRight}>
            <PressableScale onPress={haptics.toggle} style={styles.headerBtn}>
              <Ionicons
                name={haptics.isEnabled() ? 'hand-left' : 'hand-left-outline'}
                size={20}
                color={haptics.isEnabled() ? colors.primary : colors.textSecondary}
              />
            </PressableScale>
          </View>
        ),
      }} />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {!practiceMode && review.weeklyProgress && <WeeklyBudgetBar progress={review.weeklyProgress} />}

          {/* Progress */}
          <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
            <View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: colors.primary }]} />
          </View>

          {/* Mode badge */}
          <View style={styles.badgeRow}>
            <View style={[styles.modeBadge, { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }]}>
              <Ionicons name={review.reviewMode === 'blitz' ? 'flash' : 'layers'} size={12} color={colors.textSecondary} />
              <Text style={[styles.modeBadgeText, { color: colors.textSecondary }]}>
                {review.reviewMode === 'blitz' ? 'Blitz' : 'Flashcards'}
              </Text>
            </View>
            {practiceMode && (
              <View style={[styles.modeBadge, { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.primary }]}>
                <Ionicons name="infinite" size={12} color={colors.primary} />
                <Text style={[styles.modeBadgeText, { color: colors.primary }]}>
                  {t('vocabulary.practice.title')}
                </Text>
              </View>
            )}
          </View>

          {/* Card area */}
          <View style={styles.cardArea}>
            {review.showingNewWord ? (
              <NewWordCard
                card={card}
                onContinue={review.dismissNewWord}
                onSpeak={(t) => toggleTts(t, { lang: language })}
              />
            ) : review.answerRevealed && review.lastResult ? (
              <ReviewFeedback
                card={card}
                result={review.lastResult}
                isCorrect={review.lastAnswerCorrect}
                reviewMode={review.reviewMode}
                onSpeak={(t) => toggleTts(t, { lang: language })}
                onNext={review.nextCard}
              />
            ) : review.reviewMode === 'classic' ? (
              <FlashCard
                card={card}
                onAnswer={(isCorrect, responseTimeMs, selfAssessment) =>
                  handleAnswer(isCorrect, responseTimeMs, selfAssessment)
                }
                onSpeak={(t) => toggleTts(t, { lang: language })}
                onFlip={handleFlip}
                disabled={review.submitting}
              />
            ) : (
              <MultipleChoiceCard
                card={card}
                onAnswer={(isCorrect, responseTimeMs) => handleAnswer(isCorrect, responseTimeMs)}
                onSpeak={(t) => toggleTts(t, { lang: language })}
                disabled={review.submitting}
              />
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </>
  )
}

const styles = StyleSheet.create({
  headerRight: { flexDirection: 'row', gap: 8 },
  headerBtn: { padding: 4 },
  progressTrack: { height: 3 },
  progressFill: { height: '100%' },
  badgeRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 8 },
  modeBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  modeBadgeText: { fontSize: 11, fontFamily: 'Inter-Medium' },
  cardArea: { flex: 1, padding: 20, justifyContent: 'center' },
  budgetReached: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  budgetReachedTitle: { fontSize: 18, fontFamily: 'Inter-Medium', marginTop: 16, textAlign: 'center' },
  budgetReachedSubtitle: { fontSize: 14, marginTop: 8, textAlign: 'center' },
  budgetReachedCta: { marginTop: 24, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 },
  budgetReachedCtaText: { color: '#fff', fontFamily: 'Inter-Medium' },
  budgetReachedSecondary: { marginTop: 12, paddingHorizontal: 20, paddingVertical: 8 },
  budgetReachedSecondaryText: { fontSize: 13, fontFamily: 'Inter-Regular' },
})
