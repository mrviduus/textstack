import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useTranslation } from '../hooks/useTranslation'
import { completeCluster, type SelfAssessment } from '../api/vocabulary'
import { useVocabularyReview, type ReviewMode } from '../hooks/useVocabularyReview'
import { useTts } from '../hooks/useTts'
import { useSoundEffects } from '../hooks/useSoundEffects'
import { REVIEW_BATCH_SIZES, DEFAULT_BATCH_SIZE } from '@textstack/shared'
import { MultipleChoiceCard } from '../components/vocabulary/MultipleChoiceCard'
import { FlashCard } from '../components/vocabulary/FlashCard'
import { NewWordCard } from '../components/vocabulary/NewWordCard'
import { ReviewFeedback } from '../components/vocabulary/ReviewFeedback'
import { SessionSummary } from '../components/vocabulary/SessionSummary'
import { WeeklyBudgetBar } from '../components/vocabulary/WeeklyBudgetBar'
import { EmptyState } from '../components/EmptyState'

export function VocabularyReviewPage() {
  const { user } = useAuth()
  const { language } = useLanguage()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialReviewMode = (searchParams.get('reviewMode') as ReviewMode) || 'classic'
  const clusterIdParam = searchParams.get('cluster')
  const practiceMode = searchParams.get('practice') === '1' || searchParams.get('practice') === 'true'
  const initialBatchSize = useMemo(() => {
    const v = parseInt(searchParams.get('limit') || String(DEFAULT_BATCH_SIZE), 10)
    return (REVIEW_BATCH_SIZES as readonly number[]).includes(v) ? v : DEFAULT_BATCH_SIZE
  }, [searchParams])
  const [batchSize, setBatchSize] = useState(initialBatchSize)
  const sessionStartRef = useRef(Date.now())

  const review = useVocabularyReview()
  const { speak } = useTts()
  const { play: playSound, toggle: toggleSound, isEnabled: isSoundEnabled } = useSoundEffects()
  const [soundOn, setSoundOn] = useState(() => isSoundEnabled())
  const handleSpeak = (text: string) => speak(text, language)
  const goBack = () => navigate(`/${language}/vocabulary`)

  useEffect(() => {
    if (user) {
      sessionStartRef.current = Date.now()
      if (clusterIdParam) {
        review.startClusterSession(clusterIdParam, initialReviewMode)
      } else {
        review.startSession(initialBatchSize, initialReviewMode, undefined, practiceMode)
      }
    }
  }, [user, initialReviewMode, clusterIdParam, practiceMode]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAnswer = (isCorrect: boolean, responseTimeMs: number, selfAssessment?: SelfAssessment) => {
    playSound(isCorrect ? 'correct' : 'wrong')
    review.submitAnswer(isCorrect, responseTimeMs, selfAssessment)
  }

  const handleToggleSound = () => setSoundOn(toggleSound())

  useEffect(() => {
    if (review.isSessionComplete) {
      playSound('complete')
      if (review.activeClusterId) {
        completeCluster(review.activeClusterId).catch(() => {})
      }
    }
  }, [review.isSessionComplete]) // eslint-disable-line react-hooks/exhaustive-deps

  const budgetReached = !practiceMode && (review.weeklyProgress?.remaining ?? 1) <= 0

  // Redirect to vocabulary if no cards available AND user hasn't hit weekly cap.
  // When cap is reached, we show a dedicated "weekly goal" empty state instead.
  useEffect(() => {
    if (!review.loading && !review.hasCards && !review.error && user && !budgetReached) {
      navigate(`/${language}/vocabulary`, { replace: true })
    }
  }, [review.loading, review.hasCards, review.error, user, language, navigate, budgetReached])

  if (!user) {
    return (
      <div className="vocab-page">
        <EmptyState
          icon="🎴"
          title={t('practice.empty.title')}
          subtitle={t('practice.empty.subtitle')}
          buttonLabel={t('practice.empty.cta')}
          buttonTo="/books"
        />
      </div>
    )
  }

  if (review.loading) {
    return (
      <div className="vocab-page">
        <p className="vocab-loading">{t('common.loading')}</p>
      </div>
    )
  }

  if (review.error) {
    return (
      <div className="vocab-page">
        <p className="vocab-loading">{review.error}</p>
      </div>
    )
  }

  if (!review.hasCards) {
    if (budgetReached) {
      return (
        <div className="vocab-page">
          {review.weeklyProgress && <WeeklyBudgetBar progress={review.weeklyProgress} />}
          <EmptyState
            icon="🎯"
            title={t('vocabulary.banner.budgetReached')}
            subtitle={t('vocabulary.weeklyBudget.emptyStateSubtitle')}
            buttonLabel={t('vocabulary.practice.cta')}
            buttonTo={`/${language}/vocabulary/review?practice=1`}
          />
        </div>
      )
    }
    return null // redirect effect handles this
  }

  if (review.isSessionComplete) {
    return (
      <div className="vocab-page">
        <SessionSummary
          reviewed={review.sessionStats.reviewed}
          correct={review.sessionStats.correct}
          elapsedMs={Date.now() - sessionStartRef.current}
          reviewMode={review.reviewMode}
          batchSize={batchSize}
          wrongCount={review.wrongCards.length}
          t={t}
          onBack={goBack}
          onAgain={() => {
            sessionStartRef.current = Date.now()
            review.startSession(batchSize, review.reviewMode)
          }}
          onRetryWrong={() => {
            sessionStartRef.current = Date.now()
            review.retryWrong()
          }}
          onBatchChange={setBatchSize}
          onModeChange={(m: ReviewMode) => review.setReviewMode(m)}
        />
      </div>
    )
  }

  const { currentCard, currentIndex, cards, reviewMode, showingNewWord, answerRevealed, lastResult, lastAnswerCorrect, submitting } = review

  return (
    <div className="vocab-page">
      <div className="review-header">
        <button className="review-sound-toggle" onClick={handleToggleSound} title={soundOn ? t('vocabulary.review.soundOff') : t('vocabulary.review.soundOn')}>
          <SoundIcon on={soundOn} />
        </button>
      </div>

      {!practiceMode && review.weeklyProgress && <WeeklyBudgetBar progress={review.weeklyProgress} />}

      <div className="review-progress">
        <div className="review-progress__bar">
          <div
            className="review-progress__fill"
            style={{ width: `${(currentIndex / cards.length) * 100}%` }}
          />
        </div>
        <span className="review-progress__text">
          {currentIndex + 1} / {cards.length}
        </span>
      </div>

      {currentCard && showingNewWord && (
        <NewWordCard card={currentCard} onContinue={review.dismissNewWord} onSpeak={handleSpeak} t={t} />
      )}

      {currentCard && !showingNewWord && !answerRevealed && (
        reviewMode === 'classic' ? (
          <FlashCard
            card={currentCard}
            onAnswer={handleAnswer}
            onSpeak={handleSpeak}
            onFlip={() => playSound('flip')}
            t={t}
            disabled={submitting}
          />
        ) : (
          <MultipleChoiceCard
            card={currentCard}
            onAnswer={handleAnswer}
            onSpeak={handleSpeak}
            t={t}
            disabled={submitting}
          />
        )
      )}

      {currentCard && answerRevealed && lastResult && (
        reviewMode === 'classic' ? (
          <div className="review-feedback-mini">
            <div className={`review-feedback-mini__badge review-feedback-mini__badge--${lastAnswerCorrect ? 'correct' : 'wrong'}`}>
              {lastAnswerCorrect ? t('vocabulary.review.correct') : t('vocabulary.review.wrong')}
            </div>
            {lastResult.stageChanged && (
              <span className="review-feedback-mini__stage">
                {t(`vocabulary.stages.${lastResult.previousStage}`)} → {t(`vocabulary.stages.${lastResult.newStage}`)}
              </span>
            )}
            <button className="review-feedback__next" onClick={review.nextCard}>
              {t('vocabulary.review.next')}
            </button>
          </div>
        ) : (
          <ReviewFeedback
            card={currentCard}
            result={lastResult}
            isCorrect={lastAnswerCorrect}
            onSpeak={handleSpeak}
            t={t}
            onNext={review.nextCard}
          />
        )
      )}
    </div>
  )
}

function SoundIcon({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      {on ? (
        <>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </>
      ) : (
        <line x1="23" y1="9" x2="17" y2="15" />
      )}
    </svg>
  )
}
