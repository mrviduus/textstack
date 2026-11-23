import type { UserBookDetailResponse } from '@textstack/shared'
import type { LibraryBook } from './reader/hostStorage'

/**
 * The detail payload for a book whose file is on this device (the V2 local library), so the book's
 * own screen still works with no connection: Read opens the retained file.
 *
 * Deliberately conservative about what it claims. The local library keeps what is needed to READ the
 * book, so description, genre, year, cover and chapters come back empty rather than invented — the
 * screen renders nothing for those, which is the truth. `status: 'Ready'` and `hasFile` are asserted:
 * the file is right here.
 */
export function cachedUserBookDetail(b: LibraryBook): UserBookDetailResponse {
  const at = new Date(b.importedAt).toISOString()
  return {
    id: b.id,
    title: b.title,
    slug: '',
    language: 'en',
    author: b.author || null,
    description: null,
    coverPath: null,
    genre: null,
    publishedYear: null,
    totalWordCount: null,
    status: 'Ready',
    errorMessage: null,
    chapters: [],
    toc: null,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    hasOriginalPdf: false,
    hasFile: true,
  }
}
