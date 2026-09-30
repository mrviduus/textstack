import { useEffect, useState } from 'react'
import { reviewsBySlug, type BookInsight } from '@textstack/shared'
import { getBookInsights } from '../api/insights'

/**
 * The book's insights and, from them, which chapters have a structured review. One `/me/insights`
 * call — the same list `BookInsightsSection` renders (ADR-016: no separate read endpoint); the two
 * share one request through the in-flight dedupe in `api/insights.ts`.
 * Pass null to skip (signed out, book not loaded yet).
 *
 * `loading` is derived from WHICH target the data belongs to, not from a flag set in the effect:
 * a flag is still false on the render where the target first appears, and for that one frame the
 * summary page rendered "not reviewed yet" with a Review button for a chapter that has a review.
 */
// One empty array, so a consumer memoizing on `insights` doesn't recompute every render while loading.
const NO_INSIGHTS: BookInsight[] = []

export function useBookReviews(target: { userBookId: string } | { editionId: string } | null) {
  const key = target ? ('userBookId' in target ? `u:${target.userBookId}` : `e:${target.editionId}`) : null
  const [state, setState] = useState<{ key: string | null; insights: BookInsight[]; error: boolean }>(
    { key: null, insights: [], error: false })

  useEffect(() => {
    if (!target) return
    let cancelled = false
    getBookInsights(target)
      .then(rows => { if (!cancelled) setState({ key, insights: rows, error: false }) })
      .catch(() => { if (!cancelled) setState({ key, insights: [], error: true }) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by id, not object identity
  }, [key])

  const current = key !== null && state.key === key
  const insights = current ? state.insights : NO_INSIGHTS
  return { insights, reviews: reviewsBySlug(insights), loading: key !== null && !current, error: current && state.error }
}

/** Where a chapter's review summary lives (unprefixed; pass through LocalizedLink). */
export function chapterReviewPath(book: { userBookId: string } | { bookSlug: string }, chapterSlug: string): string {
  const slug = encodeURIComponent(chapterSlug)
  return 'userBookId' in book
    ? `/library/my/${book.userBookId}/review/${slug}`
    : `/books/${book.bookSlug}/review/${slug}`
}
