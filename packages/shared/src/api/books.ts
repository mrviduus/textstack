/**
 * The V2 side of the user-book API for both clients (#1121): the session epoch guard, the library
 * cache, a reading state as the legacy progress row, mark read / unread. Each app
 * keeps its DTO mapping and gives the caches, the epoch, where a reading state is kept (memory on
 * web; memory and storage on mobile).
 */
import * as syncApi from './sync'
import { ApiError } from './client'
import { resumeChapterOf } from './sync'
import type { Book, FileChapters, Locator, ReadingState, UserBookProgressDto } from './sync'
import { locatorToPlace } from '../reader/locators'

/** 'dropped': the store was reset meanwhile, the caller shows no change. */
export type MarkOutcome = 'done' | 'dropped'

export interface BooksPlatform {
  /** The last library pull, by book id: a book's current file. */
  books: Map<string, Book>
  /** A file's chapters, once its extraction succeeded (they never change after). */
  chapters: Map<string, FileChapters>
  /** The app's store epoch, bumped when its caches are emptied (sign-out, another account). */
  epoch: () => number
  /** Keep a reading state read or written. Runs in the tick its epoch was checked in. */
  keepState(s: ReadingState): unknown
  /** Forget a book's reading state: its file changed, or the server holds none. */
  forgetState(bookId: string): unknown
  /** Runs a library pull, shared with concurrent callers (mobile's single flight); default: runs it. */
  pullFlight?: (pull: () => Promise<Book[]>) => Promise<Book[]>
  /** After a library pull that was kept (mobile drops replaced files' local copies). */
  afterPull?: (items: Book[]) => Promise<void>
}

export function createBooks({ books, chapters, epoch, keepState, forgetState, pullFlight, afterPull }: BooksPlatform) {
  /** Taken at a call's start: whether the store was reset since (signed out, another account). */
  function resetSince(): () => boolean {
    const started = epoch()
    return () => epoch() !== started
  }

  /**
   * `work`'s answer, or null when the store was reset while it ran: nothing of the previous account's
   * lands in the next one's store (#1151, #1155). A failure that outlived the reset is the previous
   * account's too: null, not thrown, so no 409 handling writes it back. `keep` writes the answer away
   * in the same tick as the check, so no reset lands between the two. `reset` is taken when the
   * caller started, when awaits before `work` belong to the same call.
   */
  async function whileCurrent<T>(work: Promise<T>, keep?: (value: T) => unknown, reset = resetSince()): Promise<T | null> {
    try {
      const value = await work
      if (reset()) return null
      await keep?.(value)
      return value
    } catch (e) {
      if (!reset()) throw e
      return null
    }
  }

  /** A reading state read or written, kept; null (and nothing kept) when the store was reset meanwhile. */
  const rememberState = (work: Promise<ReadingState | null>, reset?: () => boolean) =>
    whileCurrent(work, (s) => (s ? keepState(s) : undefined), reset)

  /** The pull reports whether it was kept by its answer: a kept pull's items array is in here, a
   *  dropped pull answers a fresh `[]`. Shared by every caller of one flight, joined late or not. */
  const keptAnswers = new WeakSet<Book[]>()

  /** The library feed, whole; the books are kept only when no reset landed while it was pulled. */
  function pullBooks(): Promise<Book[]> {
    const pull = async () => {
      const feed = await whileCurrent(syncApi.pullFeed<Book>('library'), ({ items }) => {
        books.clear()
        for (const b of items) books.set(b.id, b)
        keptAnswers.add(items)
      })
      if (!feed) return []
      await afterPull?.(feed.items)
      return feed.items
    }
    return pullFlight ? pullFlight(pull) : pull()
  }

  /**
   * A live book of the user's, from the last pull or a fresh one; 404 only when a completed pull
   * lacks it. A pull a store reset dropped proves nothing (#1174: clients remember a 404 as
   * "deleted"), so that is a retryable 503.
   */
  async function liveBook(id: string): Promise<Book> {
    let b = books.get(id)
    if (!b) {
      if (!keptAnswers.has(await pullBooks())) throw new ApiError(503, 'Library pull interrupted, retry')
      b = books.get(id)
    }
    if (!b || b.removedAt) throw new ApiError(404, 'Book not found')
    return b
  }

  /** The current file's table of contents (empty with no file, or until a reader syncs it; only a non-empty one is cached). */
  async function bookChapters(b: Book): Promise<FileChapters> {
    const file = b.currentFile
    if (!file) return { items: [] }
    const cached = chapters.get(file.id)
    if (cached) return cached
    const toc = await whileCurrent(syncApi.getChapters(b.id, file.id), (t) => t.items.length > 0 && chapters.set(file.id, t))
    return toc ?? { items: [] }
  }

  /** Forget what was known of a book: its file changed (`file_replaced` / `unknown_file`). */
  async function forgetBook(id: string) {
    const file = books.get(id)?.currentFile
    if (file) chapters.delete(file.id)
    books.delete(id)
    await forgetState(id)
  }

  async function removeBook(id: string): Promise<void> {
    await syncApi.removeBook(id)
    await forgetBook(id)
  }

  /** The original PDF, Range-capable; '' until the book is known (the reader loads it first). */
  function originalFileUrl(id: string): string {
    const file = books.get(id)?.currentFile
    return file ? syncApi.contentUrl(id, file.id) : ''
  }

  /** A V2 state as the legacy progress row the reader restores from. An `epub-cfi` resumes by fraction. */
  async function toProgress(s: ReadingState): Promise<UserBookProgressDto> {
    const place = locatorToPlace(s.currentLocator)
    const chapterSlug = resumeChapterOf(s, place ? [] : (await bookChapters(await liveBook(s.bookId))).items)
    return {
      chapterSlug,
      locator: place?.locator ?? null,
      percent: s.bookFraction,
      updatedAt: s.updatedAt,
      positionJson: place?.positionJson ?? null,
      clientUpdatedAt: s.clientRecordedAt,
    }
  }

  /**
   * Mark read on V2: the state as it stands (or the book's start), with `completedAt`. The start names no chapter
   * (ADR-033: a chapter key needs the file's synced TOC): page 1 of a PDF, else a bare CFI resumed by fraction.
   */
  async function completeBook(bookId: string): Promise<MarkOutcome> {
    const reset = resetSince()
    const b = await liveBook(bookId)
    const state = await syncApi.getReadingState(bookId)
    const sameFile = state && state.fileId === b.currentFile?.id
    // Signed out meanwhile: no write under the next account, and no 'nothing to mark' from its empty store.
    if (reset()) return 'dropped'
    if (!b.currentFile) throw new ApiError(409, 'Nothing to mark read yet')
    const start: Locator = b.currentFile.format === 'pdf'
      ? { version: 1, scheme: 'pdf-page', value: { page: 1 } }
      : { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/2)' }
    const currentLocator = sameFile ? state.currentLocator : start
    const now = new Date().toISOString()
    const written = await rememberState(syncApi.putReadingState(bookId, {
      expectedRevision: sameFile ? state.revision : null,
      fileId: b.currentFile.id,
      currentLocator,
      bookFraction: sameFile ? state.bookFraction : 0,
      completedAt: now,
      clientRecordedAt: now,
    }), reset)
    return written ? 'done' : 'dropped'
  }

  /** Mark unread on V2: a reset clears completion and the frontier, the place stays (PDD rule 5). */
  async function uncompleteBook(bookId: string): Promise<MarkOutcome> {
    const reset = resetSince()
    const state = await syncApi.getReadingState(bookId)
    if (reset()) return 'dropped'
    if (!state) return 'done'
    return (await rememberState(syncApi.resetReadingState(bookId, state.revision), reset)) ? 'done' : 'dropped'
  }

  return {
    resetSince, whileCurrent, rememberState, pullBooks, liveBook, bookChapters, forgetBook, removeBook, originalFileUrl,
    toProgress, completeBook, uncompleteBook,
  }
}
