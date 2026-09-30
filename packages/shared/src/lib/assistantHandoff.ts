/**
 * "Discuss with an assistant" — the handoff out of TextStack and into a real chat.
 *
 * We are not building the chat. The reader's assistant already has their profile,
 * their memory and a year of conversation, and none of that can be copied here.
 * So the button is a LINK: it opens a new conversation in Claude or ChatGPT with
 * an opening message already written.
 *
 * The reader SEES this message, so it is written for them: one sentence and a
 * compact id line. How to work with the book (find it, check earlier insights,
 * read, save conclusions) is the MCP server's `instructions`, sent at initialize
 * (`McpBridgeCore.Instructions`). Until 2026-09-30 the brief carried tool names
 * and "if you have the TextStack connector…", which read as internals on a phone.
 */

/** Clips an unbounded string (a title) so the id line after it always survives the cap. */
export const clipText = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`)

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
   * The catalog book's slug. Required alongside `editionId`, not instead of it: a catalog book needs
   * BOTH identifiers because the tools disagree about which one they take. `get_book` and
   * `get_chapter` are keyed by slug (`"required": ["slug"]`, `additionalProperties: false`), while
   * `save_insight` and `get_my_insights` are keyed by `editionId`. Handing an assistant only the
   * editionId — which this did until 2026-09-10 — produced a brief naming tools that would reject
   * every call made from it, so the catalog Discuss button never worked at all.
   */
  slug?: string
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

/**
 * The id line: `(TextStack: book <id>)` for an upload, `(TextStack: catalog <slug>, edition <id>)`
 * for a catalog book, which needs both (read tools take the slug, insight tools the editionId).
 * The vocabulary — book / catalog / edition / chapter — is explained in the server instructions.
 */
export function textStackIdLine(ids: { bookId?: string; editionId?: string; slug?: string; chapterSlug?: string }): string | null {
  const parts: string[] = []
  if (ids.bookId) parts.push(`book ${ids.bookId}`)
  else {
    if (ids.slug) parts.push(`catalog ${clipText(ids.slug, 200)}`)
    if (ids.editionId) parts.push(`edition ${ids.editionId}`)
  }
  if (parts.length === 0) return null
  if (ids.chapterSlug) parts.push(`chapter ${clipText(ids.chapterSlug, 300)}`)
  return `(TextStack: ${parts.join(', ')})`
}

/** The opening message, written from the reader's side. */
export function buildHandoffBrief(book: HandoffBook): string {
  const author = book.author ? ` by ${clipText(book.author, 120)}` : ''
  const where: string[] = []
  // Rounds to a whole percent, and only says anything at all once there is a
  // whole percent to say: "about 0% in" is worse than silence.
  const pct = typeof book.progressFraction === 'number'
    ? Math.round(book.progressFraction * 100)
    : 0
  if (pct > 0) where.push(`about ${pct}% in`)
  if (book.chapterTitle) where.push(`at "${clipText(book.chapterTitle, 200)}"`)
  const tail = where.length > 0 ? ` I'm ${where.join(', ')}.` : ''

  const lines = [`Let's discuss "${clipText(book.title, 200)}"${author} in TextStack.${tail}`]
  const id = textStackIdLine(book)
  if (id) lines.push('', id)

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
