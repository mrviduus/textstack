import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useTranslation } from '../hooks/useTranslation'
import { useTutorSession } from '../hooks/useTutorSession'
import { useTts } from '../hooks/useTts'
import { useSoundEffects } from '../hooks/useSoundEffects'
import { FlashCard } from '../components/vocabulary/FlashCard'
import { TutorPlanView } from '../components/vocabulary/TutorPlanView'
import { exerciseLabel, exerciseBadgeClass } from '../components/vocabulary/tutorLabels'
import { SeoHead } from '../components/SeoHead'
import { EmptyState } from '../components/EmptyState'

// Smart session (Learning Tutor, AI-Agent-2). Layers the tutor's PLANNING + reasoning over the existing
// vocabulary-review card. Flow: plan view (the showcase) → study (reuse FlashCard) → feedback re-plan → summary.
export function TutorSessionPage() {
  const { user } = useAuth()
  const { language } = useLanguage()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const tutor = useTutorSession()
  const { speak } = useTts()
  const { play: playSound } = useSoundEffects()

  const handleSpeak = (text: string) => speak(text, language)
  const goBack = () => navigate(`/${language}/vocabulary`)

  useEffect(() => {
    if (user) tutor.start()
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) {
    return (
      <div className="vocab-page tutor-page">
        <EmptyState
          icon="🧭"
          title={t('tutor.signIn.title')}
          subtitle={t('tutor.signIn.subtitle')}
          buttonLabel={t('tutor.signIn.ctaBrowse')}
          buttonTo="/books"
        />
      </div>
    )
  }

  if (tutor.phase === 'planning' || tutor.phase === 'idle') {
    return (
      <div className="vocab-page tutor-page">
        <SeoHead title={t('tutor.title')} noindex />
        <div className="tutor-planning">
          <div className="tutor-planning__spinner" aria-hidden />
          <p className="tutor-planning__text">{t('tutor.planning')}</p>
        </div>
      </div>
    )
  }

  if (tutor.phase === 'error') {
    return (
      <div className="vocab-page tutor-page">
        <EmptyState
          icon="⚠️"
          title={t('tutor.error.title')}
          subtitle={tutor.error || t('tutor.error.subtitle')}
          buttonLabel={t('tutor.error.retry')}
          onButtonClick={() => tutor.retry()}
        />
      </div>
    )
  }

  if (tutor.phase === 'empty') {
    return (
      <div className="vocab-page tutor-page">
        <EmptyState
          icon="✅"
          title={t('tutor.empty.title')}
          subtitle={tutor.readingNudge || t('tutor.empty.subtitle')}
          buttonLabel={t('tutor.empty.cta')}
          buttonTo="/books"
        />
        <button className="tutor-link-btn" onClick={goBack}>{t('tutor.summary.back')}</button>
      </div>
    )
  }

  if (tutor.phase === 'summary') {
    const { studied, correct } = tutor.stats
    const rate = studied > 0 ? Math.round((correct / studied) * 100) : 0
    return (
      <div className="vocab-page tutor-page">
        <SeoHead title={t('tutor.title')} noindex />
        <div className="tutor-summary">
          <div className="tutor-summary__banner">{t('tutor.summary.done')}</div>
          <div className="tutor-summary__stats">
            <div className="tutor-summary__stat">
              <span className="tutor-summary__stat-value">{studied}</span>
              <span className="tutor-summary__stat-label">{t('tutor.summary.studied')}</span>
            </div>
            <div className="tutor-summary__stat">
              <span className="tutor-summary__stat-value">{rate}%</span>
              <span className="tutor-summary__stat-label">{t('tutor.summary.accuracy')}</span>
            </div>
          </div>
          {tutor.readingNudge && (
            <div className="tutor-plan__nudge tutor-summary__nudge">
              <span className="tutor-plan__nudge-icon" aria-hidden>📖</span>
              <p className="tutor-plan__nudge-text tutor-clamp tutor-clamp--3">{tutor.readingNudge}</p>
            </div>
          )}
          <button className="tutor-plan__start" onClick={goBack}>{t('tutor.summary.back')}</button>
        </div>
      </div>
    )
  }

  // plan + study phases need an active turn
  if (!tutor.turn) return null

  if (tutor.phase === 'plan') {
    return (
      <div className="vocab-page tutor-page">
        <SeoHead title={t('tutor.title')} noindex />
        {tutor.adjusted && (
          <div className="tutor-adjusted-note">{t('tutor.plan.adjustedNote')}</div>
        )}
        <TutorPlanView
          rationale={tutor.turn.rationale}
          plan={tutor.turn.plan}
          readingNudge={tutor.turn.readingNudge}
          adjusted={tutor.adjusted}
          t={t}
          onStart={tutor.beginStudy}
        />
      </div>
    )
  }

  // study phase
  const entry = tutor.currentEntry
  if (!entry) return null
  const queue = tutor.turn.queue

  const handleAnswer = (isCorrect: boolean, responseTimeMs: number) => {
    playSound(isCorrect ? 'correct' : 'wrong')
    tutor.answer(isCorrect, responseTimeMs)
  }

  return (
    <div className="vocab-page tutor-page">
      <SeoHead title={t('tutor.title')} noindex />
      <div className="review-progress">
        <div className="review-progress__bar">
          <div
            className="review-progress__fill"
            style={{ width: `${(tutor.currentIndex / queue.length) * 100}%` }}
          />
        </div>
        <span className="review-progress__text">
          {tutor.currentIndex + 1} / {queue.length}
        </span>
      </div>

      <div className="tutor-study__why">
        <span className={exerciseBadgeClass(entry.item.exerciseType)}>
          {exerciseLabel(entry.item.exerciseType, t)}
        </span>
        <span className="tutor-study__why-text tutor-clamp tutor-clamp--3">{entry.item.why}</span>
      </div>

      <FlashCard
        key={entry.item.wordId + tutor.currentIndex}
        card={entry.card}
        onAnswer={handleAnswer}
        onSpeak={handleSpeak}
        onFlip={() => playSound('flip')}
        t={t}
      />
    </div>
  )
}
