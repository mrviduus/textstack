/**
 * The web app's V2 client (#1025 M2.7): the probe, the session's V2 cache, and the user-book API —
 * library, upload, the transitional chapter reader, reading state — mapped onto the shapes the
 * pages render (`api/userBooks.ts` is its front). Wire calls are `@textstack/shared`'s `syncApi`; the place and anchor
 * mappings are shared (`locators`), and so are the book client and the upload sequence
 * (`createBooks`, `uploadFile`, #1121); this file caches, maps and gives them its IO.
 */
import {
  syncApi, ApiError, SYNC_OFF, ingestionStatus, shelfFileSummary, isShelfBook, resumeChapterOf, placeToLocator, createBooks, uploadFile, FileUploadError, mb,
  type Book, type FileChapters, type FileChapter, type ReadingState, type Annotation, type Word,
  type ReadingStateWrite, type SyncSwitch, type ProgressWrite,
} from '@textstack/shared'
import { API_BASE } from './client'
import { settleV2Session, v2SessionSettled, rearmV2Session } from '../lib/v2Session'
import { describeBook } from '../lib/describeBook'
import type { UserBook, UserBookDetail, UserChapter, UploadResponse, UserBookProgress } from './userBooks'

// ---- The switch ---------------------------------------------------------------------------------

let probe: Promise<SyncSwitch> | null = null
let known: SyncSwitch = SYNC_OFF
/** The server answered this start's probe: `known` is its answer, not the default. */
let answered = false
/**
 * `GET /me/v2/status`, once per app start, started by the session (AuthContext, the moment a user
 * is set): 200 on (with the part size uploads use), 404 / 503 / offline off for this start (an
 * upload asks again). Only a 401 is asked again with the next session.
 */
export function startV2Probe(): Promise<SyncSwitch> {
  settleV2Session()
  probe ??= syncApi.probeSync().then(
    (s) => {
      answered = true
      return (known = s)
    },
    () => { probe = null; return SYNC_OFF },
  )
  return probe
}

export { settleV2Session }

/** The probe's answer: waits for the session bootstrap and an in-flight probe; off without a session. */
export async function v2Status(): Promise<SyncSwitch> {
  if (!probe) await v2SessionSettled()
  return probe ?? SYNC_OFF
}

/** The probe's answer if this start has one, else null (not asked yet, or in flight): the reader route picks at once. */
export const v2Answer = (): boolean | null => (answered ? known.enabled : null)

// ---- The session's V2 cache ---------------------------------------------------------------------

/**
 * Everything this tab caches from V2, per signed-in account: `reset()` on sign-out and on an
 * account change, so the next account never reads the previous one's books. ponytail: memory
 * only, a full pull per load; R6 is the local store.
 */
export const v2Store = {
  /** The last library pull, by book id: a book's current file. */
  books: new Map<string, Book>(),
  /** A file's chapters, once its extraction succeeded (they never change after). */
  chapters: new Map<string, FileChapters>(),
  /** Per book: the reading-state revision last read or written, and its file. */
  states: new Map<string, { revision: number | null; fileId: string; bookFraction: number }>(),
  /** The vocabulary cards last read or written, by id (the shared V2 vocabulary's). */
  cards: new Map<string, Word>(),
  /** The annotations as last pulled or written, by id; and the books pulled at least once. */
  annotations: new Map<string, Annotation>(),
  pulled: new Set<string>(),
  /** Bumped by `reset()`: an answer that outlived it is the previous account's (`whileCurrent`). */
  epoch: 0,
  reset() {
    for (const cache of [this.books, this.chapters, this.states, this.cards, this.annotations, this.pulled]) cache.clear()
    syncApi.forgetPulls()
    this.epoch++
  },
}

/** Tests only: a fresh app start (no probe, no session settled, an empty cache). */
export function resetV2ForTests() {
  probe = null
  known = SYNC_OFF
  answered = false
  rearmV2Session()
  v2Store.reset()
}

/** A full pull of a feed, shared by every caller while one is in flight (`@textstack/shared`). */
export const pullFeed = syncApi.pullFeed

const remember = (s: ReadingState) => v2Store.states.set(s.bookId, { revision: s.revision, fileId: s.fileId, bookFraction: s.bookFraction })

/** The shared V2 book client (`@textstack/shared` books) on this tab's store; `whileCurrent` is its epoch guard (#1155). */
const v2 = createBooks({
  books: v2Store.books,
  chapters: v2Store.chapters,
  epoch: () => v2Store.epoch,
  keepState: remember,
  forgetState: (id) => v2Store.states.delete(id),
  // The book first, so the body names its current file.
  progressBody: async (bookId, data) => {
    if (!v2Store.books.has(bookId)) await v2Book(bookId)
    return v2ProgressBody(bookId, data)
  },
})
export const {
  resetSince, whileCurrent, pullBooks: pullV2Books, liveBook: v2Book, bookChapters: v2Chapters, removeBook: removeV2Book,
  originalFileUrl: v2FileUrl, saveProgress: saveV2Progress, completeBook: completeV2Book, uncompleteBook: uncompleteV2Book,
} = v2
const { rememberState, toProgress } = v2

// ---- Library ------------------------------------------------------------------------------------

const isPdf = (b: Book) => b.currentFile?.format === 'pdf' && b.currentFile.hasContent

const totalWords = (toc: FileChapters) =>
  toc.items.some((c) => c.wordCount != null) ? toc.items.reduce((s, c) => s + (c.wordCount ?? 0), 0) : null

/** The fields the shelf row and the book page share. */
function baseBook(b: Book) {
  return {
    id: b.id,
    title: b.title,
    slug: '',
    language: b.language ?? 'en',
    author: b.author,
    description: b.description,
    coverPath: b.hasCover ? syncApi.coverUrl(b.id, b.updatedAt) : null,
    genre: b.genre,
    errorMessage: null,
    createdAt: b.createdAt,
    hasOriginalPdf: isPdf(b),
  }
}

/**
 * The uploads shelf: live books only, each with its status and the reader's place — two feed pulls,
 * no per-book call: the feed's file carries the extraction summary (#1118); `/chapters` is the reader's.
 */
export async function getV2UserBooks(): Promise<UserBook[]> {
  const [list, reading] = await Promise.all([pullV2Books(), pullFeed<ReadingState>('reading')])
  const stateOf = new Map(reading.items.map((s) => [s.bookId, s]))
  return list.filter(isShelfBook).map((b): UserBook => {
    const file = b.currentFile
    const state = stateOf.get(b.id)
    return {
      ...baseBook(b),
      ...shelfFileSummary(file),
      completedAt: state?.completedAt ?? null,
      progressPercent: state ? state.bookFraction : null,
      progressUpdatedAt: state?.updatedAt ?? null,
      progressChapterSlug: state ? resumeChapterOf(state, file ? v2Store.chapters.get(file.id)?.items : undefined) : null,
      tags: b.tags,
    }
  })
}

/** The book page and the reader's book: the chapter list is the current file's. */
export async function getV2UserBook(id: string): Promise<UserBookDetail> {
  const b = await v2Book(id)
  // ponytail: one reading-state read per book open for `completedAt`; the library feed could carry it (#1118).
  const [toc, state] = await Promise.all([v2Chapters(b), syncApi.getReadingState(id).catch(() => null)])
  return {
    ...baseBook(b),
    status: ingestionStatus(toc.ingestion, !!b.currentFile?.hasContent),
    totalWordCount: totalWords(toc),
    publishedYear: b.publishedYear,
    // The chapter key is the chapter's id and slug on V2: highlights and vocabulary name it.
    chapters: toc.items.map((c) => ({ id: c.chapterKey, chapterNumber: c.chapterNumber, slug: c.chapterKey, title: c.title, wordCount: c.wordCount })),
    toc: null,
    updatedAt: b.updatedAt,
    completedAt: state?.completedAt ?? null,
    pageCount: b.currentFile?.pageCount ?? null,
    hasFile: !!b.currentFile?.hasContent,
  }
}

const heading = (h: FileChapter['previous']) => h && { chapterNumber: h.chapterNumber, slug: h.chapterKey, title: h.title }

export async function getV2UserBookChapter(bookId: string, chapterKey: string): Promise<UserChapter> {
  const b = await v2Book(bookId)
  if (!b.currentFile) throw new ApiError(404, 'Chapter not found')
  const ch = await syncApi.getChapter(bookId, b.currentFile.id, chapterKey)
  return {
    id: ch.chapterKey, chapterNumber: ch.chapterNumber, slug: ch.chapterKey, title: ch.title, html: ch.html,
    wordCount: ch.wordCount, previous: heading(ch.previous), next: heading(ch.next),
  }
}

/**
 * A V2 file's bytes for the V2 reader (#1225): online only, no cache. The shared client's call (cookie, 401
 * refresh + retry once, ApiError on non-2xx, a network failure as its `isNetworkError` ApiError).
 */
export const fetchV2FileBytes = syncApi.getContent

// ---- Reading state ------------------------------------------------------------------------------

/**
 * The reader's read: null = no state yet, undefined = no answer (as `readUserBookProgress`) — also
 * when the store was reset meanwhile: the answer was the previous account's.
 */
export async function readV2Progress(bookId: string, signal?: AbortSignal): Promise<UserBookProgress | null | undefined> {
  const reset = resetSince()
  try {
    const s = await syncApi.getReadingState(bookId, signal)
    if (reset()) return undefined
    if (!s) {
      v2Store.states.delete(bookId)
      return null
    }
    remember(s)
    const progress = await toProgress(s)
    return reset() ? undefined : progress
  } catch (e) {
    return !reset() && e instanceof ApiError && e.status === 404 ? null : undefined
  }
}

/**
 * The PUT body for a write, synchronously (the keepalive flush); null when the book is not known
 * yet. On the book's current file: a state read on a superseded version is not written to again
 * (that answers `file_replaced`, and a reload would read it again) — the write is a first write
 * on the current file.
 */
export function v2ProgressBody(bookId: string, data: ProgressWrite): ReadingStateWrite | null {
  const current = v2Store.books.get(bookId)?.currentFile?.id
  const known = v2Store.states.get(bookId)
  const onKnown = !!known && (!current || known.fileId === current)
  const fileId = onKnown ? known!.fileId : current
  const currentLocator = placeToLocator(data)
  if (!fileId || !currentLocator) return null
  return {
    expectedRevision: onKnown ? known!.revision : null,
    fileId,
    currentLocator,
    // No percent yet (the chapter list has not loaded): the fraction last read, never 0 over it.
    bookFraction: Math.min(1, Math.max(0, data.percent ?? known?.bookFraction ?? 0)),
    // The client's clock as the write was made, never later than now (MAX_CLIENT_SKEW_MS is the server's bound; as mobile).
    clientRecordedAt: new Date(Math.min(Date.parse(data.updatedAt ?? '') || Date.now(), Date.now())).toISOString(),
  }
}

export type { WriteOutcome, MarkOutcome, ProgressWrite } from '@textstack/shared'
export { FileUploadError }

/** A keepalive write's answer (null: not landed) is the new revision, unless the store was reset meanwhile. */
export const rememberV2State = (answer: Promise<ReadingState | null>) => rememberState(answer)

// ---- Upload -------------------------------------------------------------------------------------

/** The reader-facing message of a failed V2 upload; null when the error is not one of these. */
export function v2UploadMessage(err: unknown, t: (key: string, vars?: Record<string, string | number>) => string): string | null {
  if (!(err instanceof FileUploadError)) return null
  if (err.code === 'content_mismatch') return t('upload.v2.contentMismatch')
  return t('upload.v2.quotaExceeded', { used: mb(err.quota?.used ?? 0), limit: mb(err.quota?.limit ?? 0) })
}

/** Lowercase hex SHA-256 of the file: the browser's own digest, the whole file in memory (≤ 500 MB). */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(await file.arrayBuffer()))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

type SendPart = (url: string, part: Blob, onLoaded: (loaded: number) => void) => Promise<unknown>

/**
 * An upload on V2: the shared sequence (`@textstack/shared` upload) over this tab's IO — the
 * browser's digest, the file's details read by the reader page (`describeBook`), `Blob.slice` parts through `sendPart` (the XHR sender with its progress and retry).
 */
export async function uploadV2Book(
  file: File,
  maxPartBytes: number,
  sendPart: SendPart,
  onProgress?: (percent: number) => void,
): Promise<UploadResponse & { existing?: boolean }> {
  const { bookId, format, found } = await uploadFile(file, maxPartBytes, {
    newId: () => crypto.randomUUID(),
    hash: () => sha256Hex(file),
    describe: () => describeBook(file),
    sendPart: ({ bookId, fileId, index, start, end }) => sendPart(`${API_BASE}${syncApi.partPath(bookId, fileId, index)}`, file.slice(start, end),
      (loaded) => onProgress?.(((start + loaded) / file.size) * 100)),
  })
  return found
    ? { userBookId: bookId, jobId: '', status: 'existing', existing: true, hasOriginalPdf: found.currentFile?.format === 'pdf' }
    : { userBookId: bookId, jobId: '', status: 'Processing', hasOriginalPdf: format === 'pdf' }
}
