/** The page count a book detail shows: a PDF's real count (`pageCount`) exactly,
 *  else an estimate from the word count (~250 words a page), shown with a "~". */
export function bookPages(book: {
  pageCount?: number | null
  totalWordCount?: number | null
}): { pages: number; exact: boolean } | null {
  if (book.pageCount && book.pageCount > 0) return { pages: book.pageCount, exact: true }
  if (book.totalWordCount && book.totalWordCount > 0)
    return { pages: Math.max(1, Math.round(book.totalWordCount / 250)), exact: false }
  return null
}
