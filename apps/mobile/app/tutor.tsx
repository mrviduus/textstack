import { useEffect } from 'react'
import { View, Text, StyleSheet, SafeAreaView, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, Stack } from 'expo-router'
import { useTheme } from '../src/context/ThemeContext'
import { useLanguage } from '../src/context/LanguageContext'
import { useAuth } from '../src/context/AuthContext'
import { useTts } from '../src/hooks/useTts'
import { useHaptics } from '../src/hooks/useHaptics'
import { useTutorSession } from '../src/hooks/useTutorSession'
import { capabilitiesFor } from '../src/lib/capabilities'
import { fonts } from '../src/theme/typography'
import { EmptyState } from '../src/components/ui/EmptyState'
import { PressableScale } from '../src/components/ui/PressableScale'
import { FlashCard } from '../src/components/vocabulary/FlashCard'
import { MultipleChoiceCard } from '../src/components/vocabulary/MultipleChoiceCard'
import { TutorPlanView } from '../src/components/vocabulary/TutorPlanView'
import { exerciseLabel } from '../src/lib/agents'

// Smart session (Learning Tutor, AI-Agent-2). Layers the tutor's PLANNING + reasoning over the existing
// flashcard. Flow: plan view (the showcase) → study (reuse FlashCard) → feedback re-plan → summary.
// Accounts only: paid inference behind an IP-only rate limit,
// and guest sessions are free to mint. Plain SRS review stays open to a guest — it costs nothing.
export default function TutorScreen() {
  const { colors } = useTheme()
  const { t, language } = useLanguage()
  const { user } = useAuth()
  const router = useRouter()
  const tutor = useTutorSession()
  const { toggle: toggleTts } = useTts()
  const haptics = useHaptics()

  const { canUseAi } = capabilitiesFor(user)

  const handleSpeak = (text: string) => toggleTts(text, { lang: language })
  const goBack = () => router.back()

  // Auto-plan once on mount, for a session that is allowed to spend a plan.
  // Without the capability check a guest would fire the tutor's planning call on
  // mount and then be shown the sign-in wall below — billed inference nobody reads.
  useEffect(() => {
    if (canUseAi) tutor.start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const screen = <Stack.Screen options={{ title: t('tutor.title'), headerShown: true }} />

  // No account — signed out, or a guest.
  if (!canUseAi) {
    return (
      <>
        {screen}
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          <EmptyState
            icon="compass-outline"
            title={t('tutor.signIn.title')}
            subtitle={t('tutor.signIn.subtitle')}
            buttonLabel={t('tutor.signIn.cta')}
            onButtonPress={() => router.replace('/(auth)/login')}
          />
        </SafeAreaView>
      </>
    )
  }

  // Planning / idle
  if (tutor.phase === 'planning' || tutor.phase === 'idle') {
    return (
      <>
        {screen}
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          <View style={styles.planning}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.planningText, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
              {t('tutor.planning')}
            </Text>
          </View>
        </SafeAreaView>
      </>
    )
  }

  // Error (retry re-plans a fresh session, or re-submits pending feedback — see hook)
  if (tutor.phase === 'error') {
    return (
      <>
        {screen}
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          <EmptyState
            icon="warning-outline"
            title={t('tutor.error.title')}
            subtitle={tutor.error || t('tutor.error.subtitle')}
            buttonLabel={t('tutor.error.retry')}
            onButtonPress={() => tutor.retry()}
          />
        </SafeAreaView>
      </>
    )
  }

  // Empty (nothing due — first plan came back empty)
  if (tutor.phase === 'empty') {
    return (
      <>
        {screen}
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          <EmptyState
            icon="checkmark-done-outline"
            title={t('tutor.empty.title')}
            subtitle={tutor.readingNudge || t('tutor.empty.subtitle')}
            buttonLabel={t('tutor.empty.cta')}
            onButtonPress={() => router.replace('/(tabs)/search')}
          />
        </SafeAreaView>
      </>
    )
  }

  // Summary
  if (tutor.phase === 'summary') {
    const { studied, correct } = tutor.stats
    const rate = studied > 0 ? Math.round((correct / studied) * 100) : 0
    return (
      <>
        {screen}
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          <View style={styles.summary}>
            <Ionicons name="checkmark-done-circle" size={64} color={colors.primary} />
            <Text style={[styles.summaryTitle, { color: colors.text, fontFamily: fonts.serifBold }]}>
              {t('tutor.summary.done')}
            </Text>
            <View style={styles.summaryStats}>
              <View style={styles.summaryStat}>
                <Text style={[styles.summaryValue, { color: colors.text, fontFamily: fonts.serifBold }]}>{studied}</Text>
                <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
                  {t('tutor.summary.studied')}
                </Text>
              </View>
              <View style={styles.summaryStat}>
                <Text style={[styles.summaryValue, { color: colors.text, fontFamily: fonts.serifBold }]}>{rate}%</Text>
                <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
                  {t('tutor.summary.accuracy')}
                </Text>
              </View>
            </View>
            {!!tutor.readingNudge && (
              <View style={[styles.nudge, { backgroundColor: colors.primaryLight }]}>
                <Text style={styles.nudgeIcon} accessibilityElementsHidden>📖</Text>
                <Text style={[styles.nudgeText, { color: colors.text, fontFamily: fonts.sans }]} numberOfLines={3}>
                  {tutor.readingNudge}
                </Text>
              </View>
            )}
            <PressableScale
              onPress={goBack}
              style={[styles.summaryBtn, { backgroundColor: colors.primary }]}
              accessibilityRole="button"
              accessibilityLabel={t('tutor.summary.back')}
            >
              <Text style={[styles.summaryBtnText, { fontFamily: fonts.sansBold }]}>{t('tutor.summary.back')}</Text>
            </PressableScale>
          </View>
        </SafeAreaView>
      </>
    )
  }

  // plan + study phases need an active turn
  if (!tutor.turn) return screen

  // Plan showcase
  if (tutor.phase === 'plan') {
    return (
      <>
        {screen}
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          {tutor.adjusted && (
            <View style={[styles.adjustedNote, { backgroundColor: colors.primaryLight }]}>
              <Ionicons name="sparkles-outline" size={14} color={colors.primary} />
              <Text style={[styles.adjustedText, { color: colors.primary, fontFamily: fonts.sansMedium }]}>
                {t('tutor.plan.adjustedNote')}
              </Text>
            </View>
          )}
          <TutorPlanView
            rationale={tutor.turn.rationale}
            plan={tutor.turn.plan}
            readingNudge={tutor.turn.readingNudge}
            adjusted={tutor.adjusted}
            t={t}
            onStart={tutor.beginStudy}
          />
        </SafeAreaView>
      </>
    )
  }

  // Study phase
  const entry = tutor.currentEntry
  if (!entry) return screen
  const queue = tutor.turn.queue
  const progress = queue.length > 0 ? (tutor.currentIndex / queue.length) * 100 : 0

  const handleAnswer = (isCorrect: boolean, responseTimeMs: number) => {
    haptics.play(isCorrect ? 'correct' : 'wrong')
    tutor.answer(isCorrect, responseTimeMs)
  }

  return (
    <>
      <Stack.Screen
        options={{ title: `${t('tutor.title')} (${tutor.currentIndex + 1}/${queue.length})`, headerShown: true }}
      />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        {/* Progress */}
        <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
          <View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: colors.primary }]} />
        </View>

        {/* Per-card reasoning — the tutor explains WHY this card */}
        <View style={[styles.whyRow, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
          <View style={[styles.whyBadge, { backgroundColor: colors.primaryLight }]}>
            <Text style={[styles.whyBadgeText, { color: colors.primary, fontFamily: fonts.sansMedium }]}>
              {exerciseLabel(entry.item.exerciseType, t)}
            </Text>
          </View>
          <Text style={[styles.whyText, { color: colors.textSecondary, fontFamily: fonts.sans }]} numberOfLines={3}>
            {entry.item.why}
          </Text>
        </View>

        <View style={styles.cardArea}>
          {/* The exercise the tutor planned, actually rendered. `recognition` and `context` arrive
              with four options (the cloze prompt is what separates them); `recall` arrives with none,
              because grading yourself is the point of that stage. Chosen from the payload rather than
              the type string, so a card can never claim options it does not carry. */}
          {entry.card.options ? (
            <MultipleChoiceCard
              key={entry.item.wordId + tutor.currentIndex}
              card={entry.card}
              onAnswer={(isCorrect, responseTimeMs) => handleAnswer(isCorrect, responseTimeMs)}
              onSpeak={handleSpeak}
            />
          ) : (
            <FlashCard
              key={entry.item.wordId + tutor.currentIndex}
              card={entry.card}
              onAnswer={(isCorrect, responseTimeMs) => handleAnswer(isCorrect, responseTimeMs)}
              onSpeak={handleSpeak}
              onFlip={() => haptics.play('flip')}
            />
          )}
        </View>
      </SafeAreaView>
    </>
  )
}

const styles = StyleSheet.create({
  planning: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  planningText: { fontSize: 14, textAlign: 'center' },
  progressTrack: { height: 3 },
  progressFill: { height: '100%' },
  whyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  whyBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  whyBadgeText: { fontSize: 11 },
  whyText: { flex: 1, fontSize: 13, lineHeight: 18 },
  cardArea: { flex: 1, padding: 20, justifyContent: 'center' },

  adjustedNote: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 16, marginTop: 12, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  adjustedText: { fontSize: 12 },

  summary: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  summaryTitle: { fontSize: 22, marginTop: 16 },
  summaryStats: { flexDirection: 'row', gap: 40, marginTop: 24 },
  summaryStat: { alignItems: 'center' },
  summaryValue: { fontSize: 32 },
  summaryLabel: { fontSize: 12, marginTop: 2 },
  nudge: { flexDirection: 'row', gap: 8, borderRadius: 14, padding: 14, alignItems: 'flex-start', marginTop: 24, alignSelf: 'stretch' },
  nudgeIcon: { fontSize: 16 },
  nudgeText: { flex: 1, fontSize: 14, lineHeight: 20 },
  summaryBtn: { marginTop: 28, paddingVertical: 14, paddingHorizontal: 32, borderRadius: 12, alignSelf: 'stretch', alignItems: 'center' },
  summaryBtnText: { color: '#fff', fontSize: 16 },
})
