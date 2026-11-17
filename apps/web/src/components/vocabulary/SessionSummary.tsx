import { REVIEW_BATCH_SIZES } from '@textstack/shared'

interface Props {
  reviewed: number
  correct: number
  elapsedMs: number
  batchSize: number
  wrongCount: number
  t: (key: string) => string
  onBack: () => void
  onAgain: () => void
  onRetryWrong: () => void
  onBatchChange: (size: number) => void
  /** Absent: the session has one mode (V2: flashcards), and no switch is shown. */
}

function getReward(rate: number, t: (k: string) => string) {
  if (rate === 100) return { tier: 'perfect' as const, message: t('vocabulary.review.perfectSession') }
  if (rate >= 80) return { tier: 'great' as const, message: t('vocabulary.review.excellent') }
  return { tier: 'good' as const, message: t('vocabulary.review.greatWork') }
}

function formatTime(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  return `${sec}s`
}

export function SessionSummary({
  reviewed, correct, elapsedMs, batchSize, wrongCount, t,
  onBack, onAgain, onRetryWrong, onBatchChange,
}: Props) {
  const rate = reviewed > 0 ? Math.round((correct / reviewed) * 100) : 0
  const reward = getReward(rate, t)

  return (
    <div className="review-summary">
      {/* Reward banner */}
      <div className={`review-summary__banner review-summary__banner--${reward.tier}`}>
        <span className="review-summary__banner-message">{reward.message}</span>
      </div>

      {/* Stats */}
      <div className="review-summary__stats-row">
        <span className="review-summary__stat-big">{reviewed}</span>
        <span className="review-summary__stat-label">{t('vocabulary.review.wordsReviewed')}</span>
        <span className="review-summary__stat-divider" />
        <span className="review-summary__stat-big">{rate}%</span>
        <span className="review-summary__stat-label">{t('vocabulary.review.correctRate')}</span>
        <span className="review-summary__stat-divider" />
        <span className="review-summary__stat-big">{formatTime(elapsedMs)}</span>
        <span className="review-summary__stat-label">Time</span>
      </div>

      {/* Batch size */}
      <div className="review-summary__section">
        <span className="review-summary__section-label">Length</span>
        <div className="review-summary__batch-row">
          {REVIEW_BATCH_SIZES.map(n => (
            <button
              key={n}
              className={`review-summary__batch-chip ${batchSize === n ? 'review-summary__batch-chip--active' : ''}`}
              onClick={() => onBatchChange(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="review-summary__actions">
        {wrongCount > 0 && (
          <button className="review-summary__btn review-summary__btn--retry" onClick={onRetryWrong}>
            Retry wrong words ({wrongCount})
          </button>
        )}
        <button className="review-summary__btn review-summary__btn--primary" onClick={onAgain}>
          Practice more
        </button>
        <button className="review-summary__btn review-summary__btn--link" onClick={onBack}>
          {t('vocabulary.review.backToVocab')}
        </button>
      </div>
    </div>
  )
}
