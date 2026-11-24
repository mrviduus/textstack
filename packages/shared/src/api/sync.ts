/**
 * The V2 sync API (`/me/v2/*`) for both clients: one typed
 * function per route, the wire shapes of `backend/src/Contracts/Sync/SyncDtos.cs` field by field.
 * The contract is docs/internal/v2/v2-sync-protocol.md. Platform-free: the caller's `initApi`
 * decides cookies (web) or Bearer (mobile); `authFetch` retries a 401 once and nothing else.
 *
 * `revision` is a number: a V2 revision is a per-row write count (an int64 on the server) that stays
 * far below `Number.MAX_SAFE_INTEGER`.
 *
 * Every failure is an `ApiError` whose `body` is the one V2 error shape ({@link SyncError}); read it
 * with {@link syncErrorOf}. A 503 `v2_unavailable` means "sync paused": keep local data, try later.
 */
import { authFetch, authFetchResponse, ApiError, buildQuery, getApiConfig, jsonBody, networkError } from './client'
import { locatorToPlace } from '../reader/locators'
import { chapterAtFraction } from '../reader/bookProgress'

const V2 = '/me/v2'

// ---- Shapes -------------------------------------------------------------------------------------

/** "The 409 body": one shape for every 4xx and the 503. `current` is the row the write lost to. */
export interface SyncError {
  code: string
  message: string
  revision?: number | null
  current?: unknown
  /** The book's current file id, on reading-state and file codes. */
  fileId?: string
  currentFile?: BookFile
  /** The member an `invalid_payload` names. */
  field?: string
}

export interface SyncStatus {
  maxPartBytes: number
}

/**
 * The progress shape (from the retired `GET /me/books/{id}/progress`) both clients'
 * readers restore from; a V2 reading state is mapped onto it.
 */
export interface UserBookProgressDto {
  chapterSlug: string | null
  locator: string | null
  percent: number | null
  updatedAt: string | null
  /** Where the reader is IN THE TEXT, serialised (ADR-015). Prefer it over `locator`. */
  positionJson?: string | null
  /** Client clock of the kept write — compare local stamps with this, never `updatedAt`. */
  clientUpdatedAt?: string | null
}

/**
 * After a V2 reading-state write: `accepted` the server holds it (mark it synced); `dropped`
 * neither stored nor adopted (the local place stays unsynced); `reload` the book's file was
 * replaced; `adopted` the server's place replaces this one.
 */
export type WriteOutcome = 'accepted' | 'dropped' | 'reload' | { adopted: UserBookProgressDto }

/** A sign-in's `merge` (a guest merged): guest id → account id, only the ids that changed. */
export interface MergeMap {
  books?: Record<string, string>
  files?: Record<string, string>
  words?: Record<string, string>
}

/** The client's switch: whether this app start talks V2, and the part size the server takes. */
export interface SyncSwitch {
  enabled: boolean
  maxPartBytes: number
}

export const SYNC_OFF: SyncSwitch = { enabled: false, maxPartBytes: 0 }

/** One page of a change feed; pass `cursor` back while `hasMore`. */
export interface Feed<T> {
  items: T[]
  cursor: string | null
  hasMore: boolean
}

export type FeedName = 'library' | 'reading' | 'annotations' | 'vocabulary'

export interface BookFile {
  id: string
  sha256: string
  byteSize: number
  originalName: string
  format: string
  pageCount: number | null
  /** ADR-033 P3: the server keeps a TOC for this file version (`PUT …/toc`). */
  hasToc: boolean
  isCurrent: boolean
  hasContent: boolean
  createdAt: string
  contentRemovedAt: string | null
  /** On the library feed only, absent when null: the entries of the reader's TOC. A shelf reads it, never `/chapters`. */
  chapterCount?: number | null
}

export interface Book {
  id: string
  title: string
  author: string | null
  language: string | null
  description: string | null
  genre: string | null
  publishedYear: number | null
  tags: string[]
  checkpointSavingEnabled: boolean
  hasCover: boolean
  revision: number
  createdAt: string
  updatedAt: string
  removedAt: string | null
  currentFile: BookFile | null
}

/** A file version as a client sends it (`id` on import; on replace the path's id wins). */
export interface FileWrite {
  id?: string
  sha256: string
  byteSize: number
  originalName: string
  /** PDD "File version": what clients send, lowercase (ADR-032, #1128). */
  format: 'epub' | 'pdf' | 'mobi' | 'azw3' | 'fb2' | 'cbz'
  pageCount?: number | null
  toc?: unknown
}

export interface ImportBook {
  title: string
  author?: string | null
  language?: string | null
  description?: string | null
  genre?: string | null
  publishedYear?: number | null
  tags?: string[]
  file: FileWrite & { id: string }
}

/** Merge-patch: an absent member keeps the stored value, null clears it. */
export interface PatchBook {
  expectedRevision: number
  title?: string
  author?: string | null
  language?: string | null
  description?: string | null
  genre?: string | null
  publishedYear?: number | null
  tags?: string[] | null
}

export interface FileReplacement {
  current: BookFile
  superseded: BookFile | null
}

/** The ADR-031 envelope. Only `epub-cfi` carries `quote` (and, on annotations, `prefix`/`suffix`). */
export interface Locator {
  version: 1
  scheme: 'epub-cfi' | 'pdf-page' | 'page-name' | 'textstack-position-v1' | 'textstack-anchor-v1' | (string & {})
  value: unknown
  quote?: string
  prefix?: string
  suffix?: string
}

export interface ReadingStateWrite {
  /** null = first write; else the revision last read. */
  expectedRevision: number | null
  fileId: string
  currentLocator: Locator
  /** 0..1 */
  bookFraction: number
  frontierLocator?: Locator
  frontierFraction?: number
  completedAt?: string | null
  clientRecordedAt: string
}

export interface ReadingState {
  bookId: string
  fileId: string
  currentLocator: Locator
  bookFraction: number
  frontierLocator: Locator | null
  frontierFraction: number | null
  completedAt: string | null
  clientRecordedAt: string
  updatedAt: string
  revision: number
  resetRevision: number | null
}

export interface SessionWrite {
  bookId?: string | null
  startedAt: string
  endedAt: string
  durationSeconds: number
  wordsRead: number
  /** Fractions 0..1 (the column names are legacy). */
  startPercent: number
  endPercent: number
}

export interface Session extends Required<SessionWrite> {
  clientSessionId: string
  createdAt: string
}

export interface AnnotationWrite {
  /** null = create. */
  expectedRevision: number | null
  bookId: string
  /** Required with a locator: any version of this book. */
  fileId?: string | null
  selectedText: string
  noteText?: string | null
  locator?: Locator | null
  color: string
}

export interface Annotation {
  id: string
  bookId: string
  fileId: string | null
  selectedText: string
  noteText: string | null
  locator: Locator | null
  color: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  revision: number
}

export interface ExampleWrite {
  /** One per "save this sentence"; a retry of the same save reuses it. */
  operationId: string
  sentence: string
  contextualTranslation?: string | null
  bookId?: string | null
  fileId?: string | null
  chapterKey?: string | null
  bookTitle?: string | null
}

export interface WordSave {
  /** Client v4; when the key already exists the stored card's id wins and comes back. */
  id: string
  language: string
  word: string
  translation?: string | null
  definition?: string | null
  example?: ExampleWrite
}

export interface Example {
  id: string
  operationId: string
  sentence: string
  contextualTranslation: string | null
  bookId: string | null
  fileId: string | null
  chapterKey: string | null
  bookTitle: string | null
  createdAt: string
}

export interface Word {
  id: string
  language: string
  word: string
  translation: string | null
  definition: string | null
  stage: number
  intervalDays: number
  consecutiveCorrect: number
  nextReviewAt: string
  lastReviewedAt: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  retiredAt: string | null
  revision: number
  examples: Example[]
  /** On a save only: whether its example was added or replayed. */
  example?: 'added' | 'replayed'
}

/** Merge-patch, as {@link PatchBook}. */
export interface PatchWord {
  expectedRevision: number
  translation?: string | null
  definition?: string | null
}

export interface ReviewWrite {
  /** One per answer. */
  operationId: string
  wordId: string
  reviewMode: string
  isCorrect: boolean
  responseTimeMs?: number | null
  clientRecordedAt: string
}

export interface Review {
  id: string
  operationId: string
  wordId: string
  reviewMode: string
  isCorrect: boolean
  responseTimeMs: number | null
  stageBefore: number
  stageAfter: number
  clientRecordedAt: string
  createdAt: string
}

export interface RecordedReview {
  review: Review
  word: Word
}

/** An entry of the reader's TOC (ADR-033). `chapterNumber` orders, never displays. */
export interface ChapterHeading {
  chapterKey: string
  chapterNumber: number
  title: string
}

/** A file's chapters: the reader's TOC, empty until a reader syncs it. */
export interface FileChapters {
  items: ChapterHeading[]
}

// ---- The uploads shelf (transitional, #1118) ----------------------------------------------------

/** A file's status: ready when its bytes are in. The reader parses the file itself (ADR-033). */
const fileStatus = (hasContent: boolean): 'Processing' | 'Ready' | 'Failed' => (hasContent ? 'Ready' : 'Failed')

/**
 * A book the shelf lists: live, with a file. A book with no file is a legacy catalog save the ETL
 * carried (origin `catalog`; the feed has no origin): the owner reads only uploads, so it stays in the
 * DB and off the shelf. Every upload, clip and import has a file from its first write.
 */
export const isShelfBook = (b: Book) => !b.removedAt && b.currentFile !== null

/** A shelf row's status and counts, from the library feed's file alone: a shelf never calls `/chapters`. */
export const shelfFileSummary = (file: BookFile | null | undefined) => ({
  status: fileStatus(!!file?.hasContent),
  chapterCount: file?.chapterCount ?? 0,
  totalWordCount: null,
})

/**
 * The chapter a reading state resumes in: its own; none for a PDF page; for an `epub-cfi`, by
 * fraction over `toc`. The reader passes the file's TOC; a shelf only a TOC it already read (the
 * book page, the reader) — it calls no `/chapters`.
 * ponytail: so on the shelf an `epub-cfi` row without one gets no chapter, no "Continue" until the book is opened.
 * Nobody hits it today: no shipped reader writes `epub-cfi` (the transitional readers write
 * `textstack-position-v1` / `pdf-page`); it becomes real when the V2 reader does (R5) — then put the
 * chapter on the feed or fetch the TOC for those rows only.
 */
export function resumeChapterOf(state: ReadingState, toc: ChapterHeading[] | undefined): string | null {
  const place = locatorToPlace(state.currentLocator)
  return place ? place.chapterSlug : chapterAtFraction(toc ?? [], state.bookFraction)
}

// ---- Errors -------------------------------------------------------------------------------------

/**
 * A V2 call dropped because the app's store was reset mid-call (sign-out, another account, #1151):
 * nothing was sent or remembered for the next account. A caller says nothing about it.
 */
export class SessionChangedError extends Error {
  constructor() {
    super('Signed out before the change was saved')
  }
}

/** The V2 body of a failed call, or null (network failure, or not a V2 answer). */
export function syncErrorOf(e: unknown): SyncError | null {
  if (!(e instanceof ApiError)) return null
  const body = e.body as Partial<SyncError> | undefined
  return body && typeof body.code === 'string' ? (body as SyncError) : null
}

/** The status probe, once per app start with a session: 200 = on; 404 (unmapped), 503 or offline = off. A 401 rethrows: no session, ask again once there is one. */
export async function probeSync(): Promise<{ enabled: boolean; maxPartBytes: number }> {
  try {
    return { enabled: true, maxPartBytes: (await getStatus()).maxPartBytes }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw e
    return { enabled: false, maxPartBytes: 0 }
  }
}

/** A read that answers 404 for "none": null instead of an error. */
async function orNull<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

const book = (bookId: string) => `${V2}/books/${bookId}`
const file = (bookId: string, fileId: string) => `${book(bookId)}/files/${fileId}`

// ---- Routes -------------------------------------------------------------------------------------

export const getStatus = () => authFetch<SyncStatus>(`${V2}/status`)

export const getChanges = <T>(feed: FeedName, cursor?: string | null, limit?: number) =>
  authFetch<Feed<T>>(`${V2}/${feed}/changes${buildQuery({ cursor, limit })}`)

/** Every row of a feed from `cursor` (null = from the start) to the end; the cursor to resume from. */
export async function pullAll<T>(feed: FeedName, cursor: string | null = null): Promise<{ items: T[]; cursor: string | null }> {
  const items: T[] = []
  for (;;) {
    const page = await getChanges<T>(feed, cursor)
    items.push(...page.items)
    cursor = page.cursor ?? cursor
    if (!page.hasMore) return { items, cursor }
  }
}

const inFlight = new Map<FeedName, Promise<{ items: unknown[]; cursor: string | null }>>()

/** A full pull of a feed, shared by every caller while one is in flight (a reader open asks twice). */
export function pullFeed<T>(feed: FeedName): Promise<{ items: T[]; cursor: string | null }> {
  let pull = inFlight.get(feed)
  if (!pull) {
    // Only its own entry: after forgetPulls() the next account's pull may sit under this key.
    const mine: Promise<{ items: unknown[]; cursor: string | null }> = pullAll(feed).finally(() => { if (inFlight.get(feed) === mine) inFlight.delete(feed) })
    pull = mine
    inFlight.set(feed, pull)
  }
  return pull as Promise<{ items: T[]; cursor: string | null }>
}

/** Sign-out / another account / tests: a pull in flight belongs to the previous session. */
export const forgetPulls = () => inFlight.clear()

export const findBySha256 = (sha256: string) => orNull(authFetch<Book>(`${V2}/books/by-sha256/${sha256}`))
export const importBook = (bookId: string, body: ImportBook) => authFetch<Book>(book(bookId), jsonBody('PUT', body))
export const patchBook = (bookId: string, body: PatchBook) => authFetch<Book>(book(bookId), jsonBody('PATCH', body))
export const replaceFile = (bookId: string, fileId: string, body: { replacesFileId: string | null; file: FileWrite }) =>
  authFetch<FileReplacement>(file(bookId, fileId), jsonBody('PUT', body))
export const removeBook = (bookId: string) => authFetch<void>(book(bookId), { method: 'DELETE' })
export const restoreBook = (bookId: string) => authFetch<void>(`${book(bookId)}/restore`, { method: 'POST' })

/** One part of a file's bytes; fetch sends the `Content-Length` the route requires. */
export const putPart = (bookId: string, fileId: string, index: number, bytes: Blob | ArrayBuffer | Uint8Array) =>
  authFetch<{ index: number; size: number }>(`${file(bookId, fileId)}/parts/${index}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes as BodyInit,
  })
export const partPath = (bookId: string, fileId: string, index: number) => `${file(bookId, fileId)}/parts/${index}`
export const completeContent = (bookId: string, fileId: string, partCount: number) =>
  authFetch<BookFile>(`${file(bookId, fileId)}/content`, jsonBody('POST', { partCount }))
export const removeContent = (bookId: string, fileId: string) => authFetch<void>(`${file(bookId, fileId)}/content`, { method: 'DELETE' })
/** The bytes, Range-capable; cookies or a Bearer header authenticate it as any call. */
export const contentUrl = (bookId: string, fileId: string) => `${getApiConfig().baseUrl}${file(bookId, fileId)}/content`
/**
 * The whole file's bytes (the web V2 reader, #1225): authFetch's auth, refresh and errors, no JSON parse.
 * `onProgress(loaded, total)` as the body streams in (#1227); `total` is `Content-Length`, null when absent.
 * `signal` cancels it (the caller's own AbortError, rethrown as is). A body read that breaks off is the network
 * failure it is (`isNetworkError`), as a request that never started; any other failure (an allocation, an
 * `onProgress` throw) keeps its own cause.
 */
export async function getContent(
  bookId: string, fileId: string, onProgress?: (loaded: number, total: number | null) => void, signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const res = await authFetchResponse(`${file(bookId, fileId)}/content`, signal ? { signal } : undefined).catch((e: unknown) => {
    // Cancelled before the headers: the caller's abort, not "offline".
    throw signal?.aborted ? signal.reason ?? e : e
  })
  /** Only the body read itself is the network. */
  const network = async <T>(read: Promise<T>): Promise<T> => {
    try {
      return await read
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') throw e
      throw networkError(e)
    }
  }
  if (!onProgress || !res.body) return network(res.arrayBuffer())
  const total = Number(res.headers.get('Content-Length')) || null
  const reader = res.body.getReader()
  // With a length, filled in place (one copy of the book in memory); chunks only without one or past it
  // (a Content-Length that is not the decoded body's).
  const whole = total ? new ArrayBuffer(total) : null
  let filled = whole && new Uint8Array(whole)
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await network(reader.read())
    if (done) break
    if (filled && loaded + value.length <= filled.length) filled.set(value, loaded)
    else {
      if (filled) chunks.push(filled.subarray(0, loaded))
      filled = null
      chunks.push(value)
    }
    loaded += value.length
    onProgress(loaded, total)
  }
  if (whole && filled) return loaded === whole.byteLength ? whole : whole.slice(0, loaded)
  const out = new Uint8Array(loaded)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out.buffer
}
export const putCover = (bookId: string, bytes: Blob | ArrayBuffer | Uint8Array, contentType: 'image/jpeg' | 'image/png' | 'image/webp') =>
  authFetch<Book>(`${book(bookId)}/cover`, { method: 'PUT', headers: { 'Content-Type': contentType }, body: bytes as BodyInit })
export const readingStateUrl = (bookId: string) => `${getApiConfig().baseUrl}${book(bookId)}/reading-state`
/** The cover; `updatedAt` busts the year-long cache after a change. */
export const coverUrl = (bookId: string, updatedAt: string) =>
  `${getApiConfig().baseUrl}${book(bookId)}/cover?v=${encodeURIComponent(updatedAt)}`

export const getChapters = (bookId: string, fileId: string) => authFetch<FileChapters>(`${file(bookId, fileId)}/chapters`)
/** ADR-033 P3: the file's TOC (shared `tocForServer`'s entries), overwritten; 204. */
export const putFileToc = (bookId: string, fileId: string, toc: { key: string; title: string; depth: number; fraction: number }[]) =>
  authFetch<void>(`${file(bookId, fileId)}/toc`, jsonBody('PUT', toc))

/** null: the book has no reading state yet (the next write is a first write). */
export const getReadingState = (bookId: string, signal?: AbortSignal) =>
  orNull(authFetch<ReadingState>(`${book(bookId)}/reading-state`, { signal }))
export const putReadingState = (bookId: string, body: ReadingStateWrite) =>
  authFetch<ReadingState>(`${book(bookId)}/reading-state`, jsonBody('PUT', body))
export const resetReadingState = (bookId: string, expectedRevision: number | null) =>
  authFetch<ReadingState>(`${book(bookId)}/reading-state/reset`, jsonBody('POST', { expectedRevision }))
/** Idempotent by `clientSessionId`: a replay answers 200 with the stored row. */
export const putSession = (clientSessionId: string, body: SessionWrite) =>
  authFetch<Session>(`${V2}/reading/sessions/${clientSessionId}`, jsonBody('PUT', body))

/**
 * A chapter the reader shares with their assistant (#1316; v2-sync-protocol "Endpoints", shares). `operationId`
 * makes a retry of the same payload answer the first share; another payload under it is 409 `operation_conflict`.
 * `chapterText` is at most 200 KB as UTF-8 (the server refuses more).
 */
export interface ShareWrite {
  operationId: string
  fileId: string | null
  chapterKey: string
  chapterTitle: string | null
  chapterText: string
  notes: unknown[]
  language: string | null
}
export interface Share { id: string; bookId: string; chapterKey: string; createdAt: string }
export const shareChapter = (bookId: string, body: ShareWrite) => authFetch<Share>(`${book(bookId)}/shares`, jsonBody('POST', body))

/** A saved insight (`InsightDto`), in reading order; chapter number and title from the book's current file. No delete route. */
export interface Insight {
  id: string
  bookId: string
  chapterKey: string | null
  chapterNumber: number | null
  chapterTitle: string | null
  text: string
  question: string | null
  source: string
  createdAt: string
  updatedAt: string
}
export const listInsights = (bookId: string) => authFetch<Insight[]>(`${book(bookId)}/insights`)

/** The annotation's URL, for a keepalive write that outlives the page (the web V2 reader, #1226). */
export const annotationUrl = (id: string) => `${getApiConfig().baseUrl}${V2}/annotations/${id}`
export const putAnnotation = (id: string, body: AnnotationWrite) => authFetch<Annotation>(`${V2}/annotations/${id}`, jsonBody('PUT', body))
export const deleteAnnotation = (id: string) => authFetch<Annotation>(`${V2}/annotations/${id}`, { method: 'DELETE' })

export const saveWord = (body: WordSave) => authFetch<Word>(`${V2}/vocabulary/words`, jsonBody('PUT', body))
export const getWord = (id: string) => authFetch<Word>(`${V2}/vocabulary/words/${id}`)
export const patchWord = (id: string, body: PatchWord) => authFetch<Word>(`${V2}/vocabulary/words/${id}`, jsonBody('PATCH', body))
export const deleteWord = (id: string) => authFetch<Word>(`${V2}/vocabulary/words/${id}`, { method: 'DELETE' })
export const restoreWord = (id: string, expectedRevision: number) =>
  authFetch<Word>(`${V2}/vocabulary/words/${id}/restore`, jsonBody('POST', { expectedRevision }))
export const addExample = (wordId: string, body: ExampleWrite) =>
  authFetch<Example>(`${V2}/vocabulary/words/${wordId}/examples`, jsonBody('POST', body))
export const getDue = (limit?: number) => authFetch<Word[]>(`${V2}/vocabulary/due${buildQuery({ limit })}`)
export const recordReview = (body: ReviewWrite) => authFetch<RecordedReview>(`${V2}/vocabulary/reviews`, jsonBody('POST', body))
