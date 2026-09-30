import { createContext, useContext } from 'react'
import type { ReviewedMark } from '@textstack/shared'
import { useTranslation } from '../../hooks/useTranslation'
import { LocalizedLink } from '../LocalizedLink'

/**
 * Which highlights a chapter review cited (chapter-review.md §12, reader badges). ReaderPage fetches
 * `/me/insights` once and provides the map; the HTML overlay, the PDF layer and both highlight popups
 * read it here instead of threading a prop through four components. No provider = no badges.
 */
export interface ReviewedMarks {
  /** Keyed by lower-cased highlight id (`reviewedHighlightMarks`). */
  marks: Map<string, ReviewedMark>
  /** Unprefixed summary-page path for a reviewed chapter. */
  reviewPath: (chapterSlug: string) => string
}

export const ReviewedMarksContext = createContext<ReviewedMarks | null>(null)

export function useReviewedMarks(): ReviewedMarks | null {
  return useContext(ReviewedMarksContext)
}

export function isReviewed(marks: ReviewedMarks | null, highlightId: string): boolean {
  return !!marks?.marks.has(highlightId.toLowerCase())
}

/** The popup's top row for a reviewed highlight: "✓ Reviewed · block", "★ rule", "Open review →". */
export function ReviewedRow({ highlightId }: { highlightId: string }) {
  const ctx = useReviewedMarks()
  const { t } = useTranslation()
  const mark = ctx?.marks.get(highlightId.toLowerCase())
  if (!ctx || !mark) return null
  return (
    <div className="reviewed-row" data-testid="reviewed-row">
      <div className="reviewed-row__title">✓ {t('chapterReview.reviewed')} · {mark.blockTitle}</div>
      <div className="reviewed-row__rule">★ {mark.rule}</div>
      <LocalizedLink to={ctx.reviewPath(mark.chapterSlug)} className="reviewed-row__link">
        {t('chapterReview.openReview')}
      </LocalizedLink>
    </div>
  )
}
