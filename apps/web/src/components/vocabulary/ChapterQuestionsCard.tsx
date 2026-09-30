import { useEffect, useState } from 'react'
import { useTranslation } from '../../hooks/useTranslation'
import { getDueReviewQuestions } from '../../api/reviewQuestions'
import { LocalizedLink } from '../LocalizedLink'

/**
 * "Chapter questions · N due · Start" on the Practice page (chapter-review.md §11) — its own queue,
 * next to the word practice card. Renders nothing while nothing is due (or the count fails), so a
 * reader who never reviewed a chapter never sees it.
 */
export function ChapterQuestionsCard() {
  const { t } = useTranslation()
  const [due, setDue] = useState(0)

  useEffect(() => {
    let cancelled = false
    getDueReviewQuestions(1).then(r => { if (!cancelled) setDue(r.totalDue) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (due === 0) return null
  return (
    <div className="practice-page__card chapter-questions-card">
      <div className="chapter-questions-card__text">
        <strong>{t('chapterReview.questions.title')}</strong>
        <span className="chapter-questions-card__due">{t('chapterReview.questions.due', { count: due })}</span>
      </div>
      <LocalizedLink to="/review/questions" className="practice-page__start-btn chapter-questions-card__start">
        {t('chapterReview.questions.start')}
      </LocalizedLink>
    </div>
  )
}
