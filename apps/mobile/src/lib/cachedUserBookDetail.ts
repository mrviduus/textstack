import type { UserBookDetailResponse } from '@textstack/shared'
import type { CachedUserBookMeta, CachedUserChapter } from './offlineDb'

/**
 * Rebuild the detail payload for a downloaded upload from what the device
 * actually has, so the book's own screen still works with no connection.
 *
 * Deliberately conservative about what it claims. The cache stores what is
 * needed to READ the book, not everything the server returns, so description,
 * genre, year and the TOC tree come back empty rather than invented — the
 * screen renders nothing for those, which is the truth.
 *
 * Two fields are asserted rather than remembered, and both are load-bearing:
 *
 * - `status: 'Ready'`. The book is on the device, chapter by chapter; there is
 *   nothing left to process. A cached copy can only exist for a book that
 *   finished processing, because that is the only kind the download offers.
 * - `hasOriginalPdf: false`, whatever the upload was. The Original-layout viewer
 *   streams the PDF with Range requests and a Bearer token (ADR-012) and has no
 *   offline form, so offline a PDF reads as its extracted text. `meta.isPdf` is
 *   kept separately so the UI can say that out loud instead of quietly handing
 *   the reader a different-looking book.
 */
export function cachedUserBookDetail(
  meta: CachedUserBookMeta,
  chapters: CachedUserChapter[],
): UserBookDetailResponse {
  const cachedAtIso = new Date(meta.cachedAt).toISOString()
  return {
    id: meta.bookId,
    title: meta.title,
    slug: '',
    language: meta.language ?? 'en',
    author: meta.author,
    description: null,
    coverPath: meta.coverPath,
    genre: null,
    publishedYear: null,
    totalWordCount: meta.totalWordCount,
    status: 'Ready',
    errorMessage: null,
    chapters: chapters.map((ch, idx) => ({
      id: ch.chapterId,
      // The stored ordinal when there is one; position in the cached list
      // otherwise. Only ever used to sort and to label, never to address.
      chapterNumber: ch.chapterNumber ?? idx,
      slug: ch.chapterSlug,
      title: ch.title,
      wordCount: ch.wordCount,
      sourceStartPage: ch.sourceStartPage,
    })),
    toc: null,
    createdAt: cachedAtIso,
    updatedAt: cachedAtIso,
    completedAt: null,
    hasOriginalPdf: false,
  }
}
