import { useEffect, useState } from 'react'
import type { DueReviewQuestion, ReviewSelfAssessment } from '@textstack/shared'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from '../hooks/useTranslation'
import { answerReviewQuestion, getDueReviewQuestions } from '../api/reviewQuestions'
import { SeoHead } from '../components/SeoHead'
import { LocalizedLink } from '../components/LocalizedLink'

// Literal keys (not a template) so the shared catalogue's orphan check can see them.
const ASSESSMENTS: [ReviewSelfAssessment, string][] = [
  ['forgot', 'chapterReview.questions.forgot'],
  ['almost', 'chapterReview.questions.almost'],
  ['knew', 'chapterReview.questions.knew'],
]

/**
 * Chapter questions session (chapter-review.md §11): prompt → Show answer → answer, ★ rule,
 * book · chapter → Forgot / Almost / Knew → next. Route `/:lang/review/questions` — signed-in,
 * noindex, not prerendered. The word SRS is a different queue and is not touched here.
 */
export function ChapterQuestionReviewPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const { t } = useTranslation()
  const [items, setItems] = useState<DueReviewQuestion[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [index, setIndex] = useState(0)
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [answerFailed, setAnswerFailed] = useState(false)

  useEffect(() => {
    if (!isAuthenticated) return
    getDueReviewQuestions(20).then(r => setItems(r.items)).catch(() => setLoadFailed(true))
  }, [isAuthenticated])

  const seo = <SeoHead title={t('chapterReview.questions.title')} noindex />
  const back = <LocalizedLink to="/vocabulary" className="review-chapter__btn">{t('chapterReview.questions.back')}</LocalizedLink>
  const shell = (body: React.ReactNode) => <div className="chapter-review question-review">{seo}{body}</div>

  if (!authLoading && !isAuthenticated) return shell(<p className="chapter-review__empty">{t('chapterReview.questions.signIn')}</p>)
  if (loadFailed) return shell(<div className="chapter-review__empty"><p>{t('chapterReview.questions.loadFailed')}</p>{back}</div>)
  if (!items) return shell(<p className="chapter-review__empty">{t('common.loading')}</p>)
  if (items.length === 0) return shell(<div className="chapter-review__empty"><p>{t('chapterReview.questions.empty')}</p>{back}</div>)
  if (index >= items.length) {
    return shell(
      <div className="chapter-review__empty">
        <h2>{t('chapterReview.questions.doneTitle')}</h2>
        <p>{t('chapterReview.questions.doneLead', { count: items.length })}</p>
        {back}
      </div>,
    )
  }

  const q = items[index]
  const answer = async (a: ReviewSelfAssessment) => {
    if (busy) return
    setBusy(true)
    setAnswerFailed(false)
    try {
      await answerReviewQuestion(q.id, a)
      setShown(false)
      setIndex(i => i + 1)
    } catch {
      setAnswerFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return shell(
    <>
      <div className="question-review__progress">{index + 1} / {items.length}</div>
      <article className="chapter-review__card question-review__card">
        {q.blockTitle && <span className="chapter-review__label">{q.blockTitle}</span>}
        <p className="question-review__prompt">{q.prompt}</p>
        {!shown ? (
          <button type="button" className="review-chapter__btn" onClick={() => setShown(true)}>
            {t('chapterReview.questions.showAnswer')}
          </button>
        ) : (
          <>
            <p className="chapter-review__answer">{q.answer}</p>
            {q.rule && <div className="chapter-review__rule">★ {q.rule}</div>}
            <p className="question-review__source">{q.bookTitle}{q.chapterTitle ? ` · ${q.chapterTitle}` : ''}</p>
            <div className="question-review__assess">
              {ASSESSMENTS.map(([a, key]) => (
                <button
                  key={a}
                  type="button"
                  className={`flash-card__assess flash-card__assess--${a}`}
                  disabled={busy}
                  onClick={() => answer(a)}
                >
                  {t(key)}
                </button>
              ))}
            </div>
            {answerFailed && <p className="question-review__error" role="alert">{t('chapterReview.questions.answerFailed')}</p>}
          </>
        )}
      </article>
    </>,
  )
}
