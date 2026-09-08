import { authFetch } from './client'

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
}

/** Everything already worked out about one book. Pass exactly one id. */
export function getBookInsights(
  target: { userBookId: string } | { editionId: string },
): Promise<BookInsight[]> {
  const query = 'userBookId' in target
    ? `userBookId=${encodeURIComponent(target.userBookId)}`
    : `editionId=${encodeURIComponent(target.editionId)}`
  return authFetch<BookInsight[]>(`/me/insights?${query}`)
}
