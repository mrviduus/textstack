import type { UserBookDetailResponse, UserBookDto } from '@textstack/shared'
import type { LibraryBook } from './reader/hostStorage'
import type { BookPlace } from './reader/localLibrary'

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

/**
 * The Library's row for a book whose file is on this device, offline (#1532): its place from the local
 * library (`LocalLibrary.progress`), so the row shows how far in and the Continue pill appears with no
 * account or network. A place with no time of its own dates from the last open.
 */
export function cachedUserBook(b: LibraryBook, progress: BookPlace | undefined): UserBookDto {
  const at = progress ? progress.at || b.openedAt || b.importedAt : null
  return {
    id: b.id,
    title: b.title,
    author: b.author || null,
    language: 'en',
    coverPath: null,
    genre: null,
    totalWordCount: null,
    // Its file is here: readable.
    status: 'Ready',
    chapterCount: 0,
    createdAt: new Date(b.importedAt).toISOString(),
    completedAt: null,
    errorMessage: null,
    progressPercent: progress?.fraction ?? null,
    progressUpdatedAt: at ? new Date(at).toISOString() : null,
    progressChapterSlug: null,
    hasOriginalPdf: false,
  }
}
