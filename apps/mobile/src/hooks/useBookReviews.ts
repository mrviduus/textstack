import { useCallback, useEffect, useState } from 'react'
import { insightsApi, reviewsBySlug, type BookInsight } from '@textstack/shared'

/**
 * The book's insights and which chapters have a structured review (ADR-016: one `/me/insights`
 * call per screen — the screen passes `insights` + `removeInsight` down to `BookInsightsSection`
 * rather than letting it fetch the same rows again). Pass null to skip (signed out, book not loaded).
 *
 * `loading` is derived from which target the data belongs to — a flag set in the effect is still
 * false on the render where the target first appears, which flashed "not reviewed yet".
 */
export function useBookReviews(target: { userBookId: string } | { editionId: string } | null) {
  const key = target ? ('userBookId' in target ? `u:${target.userBookId}` : `e:${target.editionId}`) : null
  const [state, setState] = useState<{ key: string | null; insights: BookInsight[]; error: boolean }>(
    { key: null, insights: [], error: false })

  useEffect(() => {
    if (!target) return
    let cancelled = false
    insightsApi.getBookInsights(target)
      .then(rows => { if (!cancelled) setState({ key, insights: rows, error: false }) })
      .catch(() => { if (!cancelled) setState({ key, insights: [], error: true }) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by id, not object identity
  }, [key])

  const removeInsight = useCallback((id: string) => {
    setState(prev => ({ ...prev, insights: prev.insights.filter(i => i.id !== id) }))
  }, [])

  const current = key !== null && state.key === key
  const insights = current ? state.insights : []
  return {
    insights, reviews: reviewsBySlug(insights), loading: key !== null && !current, error: current && state.error, removeInsight,
  }
}
