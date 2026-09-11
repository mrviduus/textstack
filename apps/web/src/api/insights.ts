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

  // A bare array, NOT `{ items: [...] }`. `GET /me/insights` returns `Results.Ok(dtos)` over a
  // List<BookInsightDto> (InsightsEndpoints.cs) — the envelope belongs to `/me/mcp/keys`, which is
  // where this line was copied from. Unwrapping `.items` here handed the component `undefined`, and
  // the very next render read `.length` off it: every signed-in book page threw, with or without
  // insights, in the change that was supposed to make this section appear at all.
  return authFetch<BookInsight[]>(`/me/insights?${query}`)
}
