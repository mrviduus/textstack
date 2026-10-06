import { useMemo } from 'react'
import { reviewedHighlightMarks } from '@textstack/shared'
import { useBookReviews, chapterReviewPath } from './useBookReviews'
import type { ReviewedMarks } from '../components/reader/ReviewedMarks'
import type { ReaderMode } from './useReaderChapter'

interface Params {
  mode: ReaderMode
  isAuthenticated: boolean
  /** Upload id from the route (`:id`). */
  id: string | undefined
  /** Catalog edition id. */
  editionId: string | undefined
  bookSlug: string | undefined
}

/**
 * Chapter reviews for the open book (chapter-review.md §12): one /me/insights read
 * per book, signed-in only. Feeds the reviewed-highlight badges and the end-of-chapter Discuss.
 */
export function useReaderReviews({ mode, isAuthenticated, id, editionId, bookSlug }: Params) {
  const reviewTarget = !isAuthenticated ? null
    : mode === 'userbook' ? (id ? { userBookId: id } : null)
    : (editionId ? { editionId } : null)
  const { insights: reviewInsights, reviews: chapterReviews } = useBookReviews(reviewTarget)
  const reviewedMarks = useMemo<ReviewedMarks>(() => ({
    marks: reviewedHighlightMarks(reviewInsights),
    reviewPath: (slug: string) => mode === 'userbook'
      ? chapterReviewPath({ userBookId: id ?? '' }, slug)
      : chapterReviewPath({ bookSlug: bookSlug ?? '' }, slug),
  }), [reviewInsights, mode, id, bookSlug])
  return { reviewTarget, chapterReviews, reviewedMarks }
}
