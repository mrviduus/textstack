/**
 * "Discuss with an assistant" — the handoff out of TextStack and into a real chat.
 *
 * We are not building the chat. The reader's assistant already has their profile,
 * their memory and a year of conversation, and none of that can be copied here.
 * So the button is a LINK: it opens a new conversation in Claude or ChatGPT with
 * an opening message already written.
 *
 * Two halves, deliberately independent:
 *   • With the TextStack connector attached, the assistant can read the book and
 *     write conclusions back (get_my_book / get_my_chapter / save_insight).
 *   • Without it, this is still a real conversation about a real book — the reader
 *     just carries the outcome back by hand.
 * The brief says so, so a connected client uses the tools and an unconnected one
 * does not sit there claiming it cannot help.
 */

/**
 * How much of the brief we are willing to put in a URL.
 *
 * Browsers and the receiving apps both tolerate far more than this, but the safe
 * floor across the chain (address bar, redirects, server logs) is about 2000
 * characters for the whole URL — and percent-encoding roughly doubles spaces and
 * punctuation. 1200 characters of message leaves room for the origin and the
 * encoding overhead. This is why the brief is a BRIEF: the book does not travel
 * in the link, the connector fetches it.
 */
export const MAX_BRIEF_CHARS = 1200

export interface HandoffBook {
  title: string
  author?: string | null
  /** UserBook id — what the MCP tools key on. Omitted for a catalog book. */
  bookId?: string
  /** Edition id for a catalog book. */
  editionId?: string
  /**
   * How far in, as a FRACTION of the book: 0..1, the way progress is stored
   * everywhere else in this codebase ("the server stores a book-wide fraction",
   * `progressPayload.ts`).
   *
   * Named for the unit on purpose. The first version of this took "0–100",
   * every caller had a 0..1 fraction to hand, and `Math.round(0.42)` put
   * "about 0% in" into the brief — silently, because it only shows when the
   * reader has progress and the first test had none. Percent-vs-fraction is the
   * recurring defect in this repository (ADR-011 added `percentUnit` for the
   * same reason); the field carries the unit in its name so the next caller
   * cannot make the same trade.
   */
  progressFraction?: number | null
  /** Where the reader stopped, if known. */
  chapterTitle?: string | null
}

/** The opening message, written from the reader's side. */
export function buildHandoffBrief(book: HandoffBook): string {
  const lines: string[] = []

  const author = book.author ? ` by ${book.author}` : ''
  lines.push(`I'm reading "${book.title}"${author}.`)

  const where: string[] = []
  // Rounds to a whole percent, and only says anything at all once there is a
  // whole percent to say: "about 0% in" is worse than silence.
  const pct = typeof book.progressFraction === 'number'
    ? Math.round(book.progressFraction * 100)
    : 0
  if (pct > 0) where.push(`about ${pct}% in`)
  if (book.chapterTitle) where.push(`currently at "${book.chapterTitle}"`)
  if (where.length > 0) lines.push(`I'm ${where.join(', ')}.`)

  lines.push('')
  lines.push(
    'Help me think it through: what I understood, what I did not, and what is worth marking. ' +
    'Ask me questions rather than summarising at me.')

  // The identifier and the tool names. A connected client acts on this; an
  // unconnected one ignores it and the conversation still works.
  const id = book.bookId
    ? `bookId ${book.bookId}`
    : book.editionId
      ? `editionId ${book.editionId}`
      : null
  if (id) {
    lines.push('')
    lines.push(
      `If you have the TextStack connector, this book is ${id}. ` +
      (book.bookId
        ? 'Read it with get_my_book and get_my_chapter, and check get_my_insights first in case we have discussed it before. '
        : 'Read it with get_book and get_chapter, and check get_my_insights first in case we have discussed it before. ')
      + 'When we are done, write the conclusions back with save_insight so I find them in the book later.')
  }

  const brief = lines.join('\n')
  return brief.length <= MAX_BRIEF_CHARS ? brief : brief.slice(0, MAX_BRIEF_CHARS).trimEnd()
}

export type Assistant = 'claude' | 'chatgpt'

/** The new-conversation URL for one assistant, with the brief prefilled. */
export function handoffUrl(assistant: Assistant, brief: string): string {
  const q = encodeURIComponent(brief)
  return assistant === 'claude'
    ? `https://claude.ai/new?q=${q}`
    : `https://chatgpt.com/?q=${q}`
}
