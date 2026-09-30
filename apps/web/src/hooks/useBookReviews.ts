import { useEffect, useState } from 'react'
import { reviewsBySlug, type BookInsight } from '@textstack/shared'
import { getBookInsights } from '../api/insights'

/**
 * The book's insights and, from them, which chapters have a structured review. One `/me/insights`
 * call — the same list `BookInsightsSection` renders (ADR-016: no separate read endpoint).
 * Pass null to skip (signed out, book not loaded yet).
 */
export function useBookReviews(target: { userBookId: string } | { editionId: string } | null) {
  const [insights, setInsights] = useState<BookInsight[]>([])
  const [loading, setLoading] = useState(!!target)
  const [error, setError] = useState(false)
  const key = target ? ('userBookId' in target ? `u:${target.userBookId}` : `e:${target.editionId}`) : null

  useEffect(() => {
    if (!target) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setError(false)
    getBookInsights(target)
      .then(rows => { if (!cancelled) setInsights(rows) })
      .catch(() => { if (!cancelled) setError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by id, not object identity
  }, [key])

  return { insights, reviews: reviewsBySlug(insights), loading, error }
}

/** Where a chapter's review summary lives (unprefixed; pass through LocalizedLink). */
export function chapterReviewPath(book: { userBookId: string } | { bookSlug: string }, chapterSlug: string): string {
  const slug = encodeURIComponent(chapterSlug)
  return 'userBookId' in book
    ? `/library/my/${book.userBookId}/review/${slug}`
    : `/books/${book.bookSlug}/review/${slug}`
}
