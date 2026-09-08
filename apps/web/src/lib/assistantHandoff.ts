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
  /** 0–100, if known. */
  progressPercent?: number | null
  /** Where the reader stopped, if known. */
  chapterTitle?: string | null
}

/** The opening message, written from the reader's side. */
export function buildHandoffBrief(book: HandoffBook): string {
  const lines: string[] = []

  const author = book.author ? ` by ${book.author}` : ''
  lines.push(`I'm reading "${book.title}"${author}.`)

  const where: string[] = []
  if (typeof book.progressPercent === 'number' && book.progressPercent > 0)
    where.push(`about ${Math.round(book.progressPercent)}% in`)
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
