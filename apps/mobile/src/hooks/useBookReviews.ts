import { useEffect, useState } from 'react'
import { insightsApi, reviewsBySlug, type BookInsight } from '@textstack/shared'

/**
 * The book's insights and which chapters have a structured review (ADR-016: one `/me/insights`
 * call, no separate read endpoint). Pass null to skip (signed out, book not loaded).
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
    insightsApi.getBookInsights(target)
      .then(rows => { if (!cancelled) setInsights(rows) })
      .catch(() => { if (!cancelled) setError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by id, not object identity
  }, [key])

  return { insights, reviews: reviewsBySlug(insights), loading, error }
}
