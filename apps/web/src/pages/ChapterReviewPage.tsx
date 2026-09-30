import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  insightDateLabel, nextChapterAfter, resolveReviewHighlights, type ChapterReviewBlock,
} from '@textstack/shared'
import { useApi } from '../hooks/useApi'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from '../hooks/useTranslation'
import { useBookReviews, chapterReviewPath } from '../hooks/useBookReviews'
import { getUserBook } from '../api/userBooks'
import { getPublicHighlights, getUserBookHighlights, type PublicHighlight } from '../api/userData'
import { SeoHead } from '../components/SeoHead'
import { LocalizedLink } from '../components/LocalizedLink'
import { ReviewChapterButton } from '../components/library/ReviewChapterButton'

/**
 * One chapter's review, as it came back from the reader's assistant (chapter-review.md §12).
 * Routes: `/:lang/books/:bookSlug/review/:chapterSlug` (catalog) and
 * `/:lang/library/my/:id/review/:chapterSlug` (upload). Signed-in only, noindex, never prerendered.
 *
 * Titles only — `chapter_number` is an ordering key, not an ordinal (CLAUDE.md).
 */
interface ReviewBook {
  title: string
  author: string | null
  target: { userBookId: string } | { editionId: string; bookSlug: string }
  chapters: { slug: string | null; title: string }[]
}

export function ChapterReviewPage() {
  const { bookSlug, id, chapterSlug = '' } = useParams<{ bookSlug?: string; id?: string; chapterSlug: string }>()
  const api = useApi()
  const { t } = useTranslation()
  const { isAuthenticated, isLoading: authLoading, openAuthModal } = useAuth()
  const [book, setBook] = useState<ReviewBook | null>(null)
  const [bookError, setBookError] = useState(false)
  const [highlights, setHighlights] = useState<PublicHighlight[] | null>(null)

  useEffect(() => {
    if (!isAuthenticated) return
    let cancelled = false
    setBookError(false)
    const load: Promise<ReviewBook> = bookSlug
      ? api.getBook(bookSlug).then(b => ({
          title: b.title,
          author: b.authors.map(a => a.name).join(', ') || null,
          target: { editionId: b.id, bookSlug: b.slug },
          chapters: b.chapters.map(c => ({ slug: c.slug, title: c.title })),
        }))
      : getUserBook(id!).then(b => ({
          title: b.title,
          author: b.author,
          target: { userBookId: b.id },
          chapters: b.chapters.map(c => ({ slug: c.slug, title: c.title })),
        }))
    load.then(b => { if (!cancelled) setBook(b) }).catch(() => { if (!cancelled) setBookError(true) })
    return () => { cancelled = true }
  }, [bookSlug, id, api, isAuthenticated])

  const insightTarget = book ? ('userBookId' in book.target ? { userBookId: book.target.userBookId } : { editionId: book.target.editionId }) : null
  const { insights, reviews, loading, error } = useBookReviews(insightTarget)

  useEffect(() => {
    if (!book) return
    let cancelled = false
    const load = 'userBookId' in book.target ? getUserBookHighlights(book.target.userBookId) : getPublicHighlights(book.target.editionId)
    // Null on failure, not []: an empty list would label every quote "highlight removed".
    load.then(h => { if (!cancelled) setHighlights(h) }).catch(() => {})
    return () => { cancelled = true }
  }, [book])

  const seo = <SeoHead title={t('chapterReview.summary.title')} noindex />

  if (!authLoading && !isAuthenticated) {
    return (
      <div className="chapter-review">
        {seo}
        <div className="chapter-review__empty">
          <p>{t('chapterReview.summary.signIn')}</p>
          <button type="button" className="review-chapter__btn" onClick={openAuthModal}>{t('mcp.connect.signInCta')}</button>
        </div>
      </div>
    )
  }
  if (bookError || error) {
    return <div className="chapter-review">{seo}<p className="chapter-review__empty">{t('chapterReview.summary.loadFailed')}</p></div>
  }
  if (!book || loading) return <div className="chapter-review">{seo}</div>

  const insight = reviews.get(chapterSlug)
  const chapter = book.chapters.find(c => c.slug === chapterSlug)
  if (!chapter && !insight) {
    return <div className="chapter-review">{seo}<p className="chapter-review__empty">{t('chapterReview.summary.notFound')}</p></div>
  }

  const chapterTitle = chapter?.title ?? insight?.chapterTitle ?? chapterSlug
  const briefBook = {
    title: book.title,
    author: book.author,
    ...('userBookId' in book.target ? { bookId: book.target.userBookId } : { editionId: book.target.editionId }),
  }
  const pathBook = 'userBookId' in book.target ? { userBookId: book.target.userBookId } : { bookSlug: book.target.bookSlug }
  const backTo = 'userBookId' in book.target ? `/library/my/${book.target.userBookId}` : `/books/${book.target.bookSlug}`
  const next = nextChapterAfter(book.chapters, chapterSlug)
  const review = insight?.review

  // Closed threads carry only ids; their text lives in the earlier review that opened them.
  const threadText = new Map(insights.flatMap(i => i.review?.openThreads ?? []).map(th => [th.id, th.text]))
  const closed = (review?.closedThreadIds ?? []).map(tid => threadText.get(tid)).filter((x): x is string => !!x)

  return (
    <div className="chapter-review">
      {seo}
      <LocalizedLink to={backTo} className="chapter-review__back">← {book.title}</LocalizedLink>
      <div className="chapter-review__head">
        <h1 className="chapter-review__title">{chapterTitle}</h1>
        {insight && insightDateLabel(insight) && (
          <time className="chapter-review__date" dateTime={insight.updatedAt}>
            {t('chapterReview.summary.reviewedOn', { date: insightDateLabel(insight)! })}
          </time>
        )}
      </div>

      {!review ? (
        <div className="chapter-review__empty">
          <h2>{t('chapterReview.summary.emptyTitle')}</h2>
          <p>{t('chapterReview.summary.emptyLead')}</p>
          <ReviewChapterButton {...briefBook} chapterSlug={chapterSlug} chapterTitle={chapterTitle} />
        </div>
      ) : (
        <>
          {review.recall && (
            <section className="chapter-review__recall">
              <span className="chapter-review__label">{t('chapterReview.summary.recall')}</span>
              <p>{review.recall}</p>
            </section>
          )}

          {review.blocks.map((block, i) => (
            <ReviewBlockCard key={i} index={i} block={block} highlights={highlights} />
          ))}

          {review.applications.length > 0 && (
            <section className="chapter-review__section">
              <h2>{t('chapterReview.summary.applications')}</h2>
              <ul>{review.applications.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </section>
          )}

          {review.openThreads.length > 0 && (
            <section className="chapter-review__section">
              <h2>{t('chapterReview.summary.openThreads', { count: review.openThreads.length })}</h2>
              <ul>{review.openThreads.map(th => <li key={th.id}>{th.text}</li>)}</ul>
            </section>
          )}

          {closed.length > 0 && (
            <section className="chapter-review__section">
              <h2>{t('chapterReview.summary.closedThreads')}</h2>
              <ul>{closed.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </section>
          )}

          <div className="chapter-review__actions">
            <ReviewChapterButton
              {...briefBook}
              chapterSlug={chapterSlug}
              chapterTitle={chapterTitle}
              label={t('chapterReview.summary.again')}
            />
          </div>
        </>
      )}

      {next?.slug && (
        <div className="chapter-review__actions">
          {reviews.has(next.slug) ? (
            <LocalizedLink to={chapterReviewPath(pathBook, next.slug)} className="chapter-review-action">
              {t('chapterReview.summary.next', { title: next.title })}
            </LocalizedLink>
          ) : (
            <ReviewChapterButton
              {...briefBook}
              chapterSlug={next.slug}
              chapterTitle={next.title}
              label={t('chapterReview.summary.next', { title: next.title })}
            />
          )}
        </div>
      )}
    </div>
  )
}

function ReviewBlockCard({ index, block, highlights }: {
  index: number
  block: ChapterReviewBlock
  highlights: PublicHighlight[] | null
}) {
  const { t } = useTranslation()
  const [shown, setShown] = useState(false)
  const quotes = highlights ? resolveReviewHighlights(block.highlightIds, highlights) : null

  return (
    <article className="chapter-review__card">
      <h2>{index + 1}. {block.title}</h2>
      <span className="chapter-review__label">{t('chapterReview.summary.problem')}</span>
      <p>{block.problem}</p>
      <span className="chapter-review__label">{t('chapterReview.summary.why')}</span>
      <p>{block.rootCause}</p>
      <div className="chapter-review__rule">★ {t('chapterReview.summary.rule')}: {block.rule}</div>

      <span className="chapter-review__label">{t('chapterReview.summary.highlights')}</span>
      {block.highlightIds.length === 0 ? (
        <p>{t('chapterReview.summary.noHighlights')}</p>
      ) : quotes && (
        <ul className="chapter-review__quotes">
          {quotes.map(q => (
            <li key={q.id}>
              {q.text ?? <span className="chapter-review__removed">{t('chapterReview.summary.highlightRemoved')}</span>}
            </li>
          ))}
        </ul>
      )}

      <span className="chapter-review__label">{t('chapterReview.summary.check')}</span>
      <p>{block.question.prompt}</p>
      <button type="button" className="review-chapter__btn" onClick={() => setShown(s => !s)} aria-expanded={shown}>
        {shown ? t('chapterReview.summary.hide') : t('chapterReview.summary.show')}
      </button>
      {shown && <p className="chapter-review__answer">{block.question.answer}</p>}
    </article>
  )
}
