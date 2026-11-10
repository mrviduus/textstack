/**
 * The V2 side of the user-book API for both clients (#1121): the session epoch guard, the library
 * cache, a reading state as the legacy progress row, the revision rule, mark read / unread. Each app
 * keeps its DTO mapping and gives the caches, the epoch, where a reading state is kept (memory on
 * web; memory and storage on mobile) and how a write's body is made.
 */
import * as v2Api from './v2'
import { ApiError } from './client'
import { resumeChapterOf } from './v2'
import type { V2Book, V2FileChapters, V2ReadingState, V2ReadingStateWrite, V2WriteOutcome, UserBookProgressDto } from './v2'
import { placeToV2Locator, v2LocatorToPlace, type LegacyPlace } from '../reader/v2Locators'

export interface ProgressWrite extends LegacyPlace {
  percent?: number
  updatedAt?: string
}

/** 'dropped': the store was reset meanwhile, the caller shows no change. */
export type V2MarkOutcome = 'done' | 'dropped'

export interface V2BooksPlatform {
  /** The last library pull, by book id: a book's current file. */
  books: Map<string, V2Book>
  /** A file's chapters, once its extraction succeeded (they never change after). */
  chapters: Map<string, V2FileChapters>
  /** The app's store epoch, bumped when its caches are emptied (sign-out, another account). */
  epoch: () => number
  /** Keep a reading state read or written. Runs in the tick its epoch was checked in. */
  keepState(s: V2ReadingState): unknown
  /** Forget a book's reading state: its file changed, or the server holds none. */
  forgetState(bookId: string): unknown
  /** A reading-state write's PUT body; null when there is nothing to write on. */
  progressBody(bookId: string, data: ProgressWrite): Promise<V2ReadingStateWrite | null>
  /** Runs a library pull, shared with concurrent callers (mobile's single flight); default: runs it. */
  pullFlight?: (pull: () => Promise<V2Book[]>) => Promise<V2Book[]>
  /** After a library pull that was kept (mobile drops replaced files' local copies). */
  afterPull?: (items: V2Book[]) => Promise<void>
  /** Keep an adopted place, in the tick its epoch was checked in (mobile: the device's progress record). */
  keepAdopted?: (s: V2ReadingState, p: UserBookProgressDto) => unknown
}

export function createV2Books({ books, chapters, epoch, keepState, forgetState, progressBody, pullFlight, afterPull, keepAdopted }: V2BooksPlatform) {
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
  const rememberState = (work: Promise<V2ReadingState | null>, reset?: () => boolean) =>
    whileCurrent(work, (s) => (s ? keepState(s) : undefined), reset)

  /** Pulls whose books were kept: `v2Book` tells a completed pull from one a reset dropped. */
  let keptPulls = 0

  /** The library feed, whole; the books are kept only when no reset landed while it was pulled. */
  function pullV2Books(): Promise<V2Book[]> {
    const pull = async () => {
      const feed = await whileCurrent(v2Api.pullFeed<V2Book>('library'), ({ items }) => {
        books.clear()
        for (const b of items) books.set(b.id, b)
        keptPulls++
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
  async function v2Book(id: string): Promise<V2Book> {
    let b = books.get(id)
    if (!b) {
      const before = keptPulls
      await pullV2Books()
      if (keptPulls === before) throw new ApiError(503, 'Library pull interrupted, retry')
      b = books.get(id)
    }
    if (!b || b.removedAt) throw new ApiError(404, 'Book not found')
    return b
  }

  /** The current file's table of contents and extraction status (empty when it has no bytes). */
  async function v2Chapters(b: V2Book): Promise<V2FileChapters> {
    const file = b.currentFile
    if (!file) return { items: [], ingestion: null }
    const cached = chapters.get(file.id)
    if (cached) return cached
    const toc = await whileCurrent(v2Api.getChapters(b.id, file.id), (t) => t.ingestion === 'succeeded' && chapters.set(file.id, t))
    return toc ?? { items: [], ingestion: null }
  }

  /** Forget what was known of a book: its file changed (`file_replaced` / `unknown_file`). */
  async function forgetV2Book(id: string) {
    const file = books.get(id)?.currentFile
    if (file) chapters.delete(file.id)
    books.delete(id)
    await forgetState(id)
  }

  async function removeV2Book(id: string): Promise<void> {
    await v2Api.removeBook(id)
    await forgetV2Book(id)
  }

  /** The original PDF, Range-capable; '' until the book is known (the reader loads it first). */
  function v2FileUrl(id: string): string {
    const file = books.get(id)?.currentFile
    return file ? v2Api.contentUrl(id, file.id) : ''
  }

  /** A V2 state as the legacy progress row the reader restores from. An `epub-cfi` resumes by fraction. */
  async function toProgress(s: V2ReadingState): Promise<UserBookProgressDto> {
    const place = v2LocatorToPlace(s.currentLocator)
    const chapterSlug = resumeChapterOf(s, place ? [] : (await v2Chapters(await v2Book(s.bookId))).items)
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
   * One reading-state write under the revision rule (PDD "The revision rule"). Lost (409):
   * `stale_revision` adopts the server's row (a lost write takes the server's place); `reset` writes
   * this place again on the new revision; `file_replaced` forgets the book and asks for a reload;
   * `unknown_file` refetches the book and writes once more; `chapter_not_found` drops the write (its
   * chapter keys changed: the TOC is fetched again, the reader resumes from the fraction). Anything
   * else throws: the caller keeps the write for its next save. A reset at any point drops the write.
   */
  async function saveV2Progress(bookId: string, data: ProgressWrite, retried = false): Promise<V2WriteOutcome> {
    const reset = resetSince()
    const body = await progressBody(bookId, data)
    if (!body) return 'dropped'
    const put = async (b: V2ReadingStateWrite) => ((await rememberState(v2Api.putReadingState(bookId, b), reset)) ? 'accepted' : 'dropped')
    try {
      return await put(body)
    } catch (e) {
      // Only reached with no reset so far: whileCurrent swallows a failure that outlived one.
      const err = v2Api.v2ErrorOf(e)
      const current = err?.current as V2ReadingState | null | undefined
      switch (err?.code) {
        case 'stale_revision': {
          if (!current) {
            await forgetState(bookId)
            return 'dropped'
          }
          if (!(await rememberState(Promise.resolve(current), reset))) return 'dropped'
          // Signed out while the server's chapter resolves: no place, and no local record, for the next account.
          const adopted = await whileCurrent(toProgress(current), keepAdopted && ((p) => keepAdopted(current, p)), reset)
          return adopted ? { adopted } : 'dropped'
        }
        case 'reset':
          if (current) await keepState(current)
          return put({ ...body, expectedRevision: current?.revision ?? null })
        case 'file_replaced':
          await forgetV2Book(bookId)
          return 'reload'
        case 'unknown_file':
          // The book's file is not the one we named: fetch the book again and write once more.
          await forgetV2Book(bookId)
          return retried ? 'dropped' : saveV2Progress(bookId, data, true)
        case 'chapter_not_found': {
          const file = books.get(bookId)?.currentFile
          if (file) chapters.delete(file.id)
          return 'dropped'
        }
        default:
          throw e
      }
    }
  }

  /** Mark read on V2: the state as it stands (or the book's start), at the end, with `completedAt`. */
  async function completeV2Book(bookId: string): Promise<V2MarkOutcome> {
    const reset = resetSince()
    const b = await v2Book(bookId)
    const state = await v2Api.getReadingState(bookId)
    const sameFile = state && state.fileId === b.currentFile?.id
    // The book's start only when there is no place on this file: a TOC fetch never fails a mark-read that needs none.
    const first = sameFile ? null : (await v2Chapters(b)).items[0]?.chapterKey
    // Signed out meanwhile: no write under the next account, and no 'nothing to mark' from its empty store.
    if (reset()) return 'dropped'
    const currentLocator = sameFile ? state.currentLocator : placeToV2Locator({ chapterSlug: first ?? null })
    if (!b.currentFile || !currentLocator) throw new ApiError(409, 'Nothing to mark read yet')
    const now = new Date().toISOString()
    const written = await rememberState(v2Api.putReadingState(bookId, {
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
  async function uncompleteV2Book(bookId: string): Promise<V2MarkOutcome> {
    const reset = resetSince()
    const state = await v2Api.getReadingState(bookId)
    if (reset()) return 'dropped'
    if (!state) return 'done'
    return (await rememberState(v2Api.resetReadingState(bookId, state.revision), reset)) ? 'done' : 'dropped'
  }

  return {
    resetSince, whileCurrent, rememberState, pullV2Books, v2Book, v2Chapters, forgetV2Book, removeV2Book, v2FileUrl,
    toProgress, saveV2Progress, completeV2Book, uncompleteV2Book,
  }
}
