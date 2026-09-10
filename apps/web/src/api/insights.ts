import { authFetch } from './client'
import type { BookInsight } from '@textstack/shared'

/**
 * Conclusions an outside assistant wrote back into a book.
 *
 * <p><b>Why this exists next to an identical module in `@textstack/shared`.</b> The shared API client
 * is initialised by `initApi()`, and only the mobile app calls it — the web app has its own
 * `authFetch` because its token lives in a cookie (`credentials: 'include'`), not in a header. So
 * every shared `api/` call made from the web throws "API not initialized" before it reaches the
 * network.</p>
 *
 * <p>`BookInsightsSection` imported the shared one, swallowed the rejection with `.catch(() => {})`
 * — correct posture for a supplementary panel — and then returned null because the list was empty.
 * The result was a конспект section that had never rendered on the web at all, silently, for as long
 * as it had existed. It is the destination of the whole handoff, so it failing invisibly is the worst
 * shape that bug could have taken.</p>
 */
export type InsightTarget = { userBookId: string } | { editionId: string }

export async function getBookInsights(target: InsightTarget): Promise<BookInsight[]> {
  const query = 'userBookId' in target
    ? `userBookId=${encodeURIComponent(target.userBookId)}`
    : `editionId=${encodeURIComponent(target.editionId)}`

  const res = await authFetch<{ items: BookInsight[] }>(`/me/insights?${query}`)
  return res.items
}
