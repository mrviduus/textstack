import type { ReviewCardDto, SubmitReviewResponse } from '../../api/vocabulary'
import { SpeakButton } from './SpeakButton'

interface Props {
  card: ReviewCardDto
  result: SubmitReviewResponse
  isCorrect: boolean
  onSpeak?: (text: string) => void
  t: (key: string) => string
  onNext: () => void
}

export function ReviewFeedback({ card, result, isCorrect, onSpeak, t, onNext }: Props) {
  const stageName = (stage: number) => t(`vocabulary.stages.${stage}`) || `Stage ${stage}`

  return (
    <div className={`review-feedback review-feedback--${isCorrect ? 'correct' : 'wrong'}`}>
      <div className="review-feedback__badge">
        <span className="review-feedback__icon">{isCorrect ? '✓' : '✗'}</span>
        <span className="review-feedback__message">
          {isCorrect ? t('vocabulary.review.correct') : t('vocabulary.review.wrong')}
        </span>
      </div>

      <div className="review-feedback__body">
        <div className="review-feedback__word-row">
          {onSpeak && <SpeakButton onClick={() => onSpeak(card.word)} size={18} />}
          <span className="review-feedback__word">{card.word}</span>
          {card.translation && (
            <span className="review-feedback__translation">— {card.translation}</span>
          )}
        </div>

        {!isCorrect && (
          <div className="review-feedback__answer">
            <span className="review-feedback__label">{t('vocabulary.review.correctAnswer')}:</span>{' '}
            <span className="review-feedback__correct-word">{card.word}</span>
          </div>
        )}

        {card.originalSentence && (
          <p className="review-feedback__sentence">
            {card.originalSentence}
            {card.bookTitle && <span className="review-feedback__book"> — {card.bookTitle}</span>}
          </p>
        )}

        {card.definition && (
          <p className="review-feedback__definition">{card.definition}</p>
        )}

        {result.stageChanged && (
          <div className="review-feedback__stage">
            {stageName(result.previousStage)} → {stageName(result.newStage)}
          </div>
        )}
      </div>

      <button className="review-feedback__next" onClick={onNext}>
        {t('vocabulary.review.next')}
      </button>
    </div>
  )
}
