import { authFetch } from './client'
import type { ChapterReviewDto } from '../types/api'
import { listInsights } from './v2'

/**
 * Insights — the conclusions an outside assistant wrote back into a book over MCP.
 *
 * TextStack does not host the conversation. The reasoning happens in Claude or
 * ChatGPT, where the reader already has their profile and their history; what
 * comes home is the result, hung on the book's spine. `chapterSlug` names the
 * chapter it is about, or is null for the whole book — that null one is the
 * конспект's overview.
 *
 * The server resolves each slug to its chapter number and title at read time and
 * returns them in reading order, so a client renders the list as it comes.
 */
export interface BookInsight {
  id: string
  editionId: string | null
  userBookId: string | null
  chapterSlug: string | null
  /** Null for a book-level insight, and for a slug that no longer resolves after a re-ingest. */
  chapterNumber: number | null
  chapterTitle: string | null
  /** Markdown. */
  text: string
  /** What was being worked out. This is what makes an insight worth returning to. */
  question: string | null
  source: string
  createdAt: string
  updatedAt: string
  /** The structured chapter review when this insight is one (ADR-016); `text` then holds its Markdown. */
  review?: ChapterReviewDto | null
}

/**
 * Everything already worked out about one book. Pass exactly one id. `v2`: the caller's switch
 * (`onV2()`): the legacy route answers 410 there. V2 keeps a user book's insights (no review, no
 * delete route); a catalog edition's are none (the catalog retired, #992).
 */
export function getBookInsights(
  target: { userBookId: string } | { editionId: string },
  v2 = false,
): Promise<BookInsight[]> {
  if (v2) {
    if (!('userBookId' in target)) return Promise.resolve([])
    const bookId = target.userBookId
    return inFlight(`v2:${bookId}`, async () => (await listInsights(bookId)).map(({ bookId, chapterKey, ...rest }) => ({
      ...rest, editionId: null, userBookId: bookId, chapterSlug: chapterKey,
    })))
  }
  const query = 'userBookId' in target
    ? `userBookId=${encodeURIComponent(target.userBookId)}`
    : `editionId=${encodeURIComponent(target.editionId)}`
  return inFlight(query, () => authFetch<BookInsight[]>(`/me/insights?${query}`))
}

// One request per book at a time — the book screen and BookInsightsSection both ask on mount.
// In-flight only (cleared on settle), so nothing is ever served stale.
const pending = new Map<string, Promise<BookInsight[]>>()
function inFlight(key: string, load: () => Promise<BookInsight[]>): Promise<BookInsight[]> {
  let p = pending.get(key)
  if (!p) {
    p = load().finally(() => pending.delete(key))
    pending.set(key, p)
  }
  return p
}
