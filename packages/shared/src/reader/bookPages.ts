/** Words on a printed page — the estimate used when the real page count is unknown. */
export const WORDS_PER_PAGE = 250

/**
 * The page count a book detail shows. A PDF knows its real page count
 * (`pageCount`, from the stored page ranges) — show that, exactly. Anything
 * else is an estimate from the word count, rendered with a "~".
 */
export function bookPages(book: {
  pageCount?: number | null
  totalWordCount?: number | null
}): { pages: number; exact: boolean } | null {
  if (book.pageCount && book.pageCount > 0) return { pages: book.pageCount, exact: true }
  if (book.totalWordCount && book.totalWordCount > 0)
    return { pages: Math.max(1, Math.round(book.totalWordCount / WORDS_PER_PAGE)), exact: false }
  return null
}
