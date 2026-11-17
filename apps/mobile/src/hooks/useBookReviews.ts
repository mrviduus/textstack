import { useEffect, useState } from 'react'
import { insightsApi, reviewsBySlug, type BookInsight } from '@textstack/shared'

/**
 * The book's insights (`/me/v2/books/{id}/insights`) and which chapters have a structured review (ADR-016: one
 * call per screen — the screen passes `insights` down to `BookInsightsSection` rather than letting it fetch the
 * same rows again). Pass null to skip (book not loaded).
 *
 * `loading` is derived from which book the data belongs to — a flag set in the effect is still
 * false on the render where the book first appears, which flashed "not reviewed yet".
 */
export function useBookReviews(userBookId: string | null) {
  const [state, setState] = useState<{ key: string | null; insights: BookInsight[]; error: boolean }>(
    { key: null, insights: [], error: false })

  useEffect(() => {
    if (!userBookId) return
    let cancelled = false
    insightsApi.getBookInsights(userBookId)
      .then(rows => { if (!cancelled) setState({ key: userBookId, insights: rows, error: false }) })
      .catch(() => { if (!cancelled) setState({ key: userBookId, insights: [], error: true }) })
    return () => { cancelled = true }
  }, [userBookId])

  const current = userBookId !== null && state.key === userBookId
  const insights = current ? state.insights : []
  return {
    insights, reviews: reviewsBySlug(insights), loading: userBookId !== null && !current, error: current && state.error,
  }
}
