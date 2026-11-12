/**
 * The V2 sync API (`/me/v2/*`, mapped only with `Features:V2Api` on) for both clients: one typed
 * function per route, the wire shapes of `backend/src/Contracts/V2/V2Dtos.cs` field by field.
 * The contract is docs/01-architecture/v2-sync-protocol.md. Platform-free: the caller's `initApi`
 * decides cookies (web) or Bearer (mobile); `authFetch` retries a 401 once and nothing else.
 *
 * `revision` is a number: a V2 revision is a per-row write count (an int64 on the server) that stays
 * far below `Number.MAX_SAFE_INTEGER`.
 *
 * Every failure is an `ApiError` whose `body` is the one V2 error shape ({@link V2Error}); read it
 * with {@link v2ErrorOf}. A 503 `v2_unavailable` means "sync paused": keep local data, try later.
 */
import { authFetch, authFetchResponse, ApiError, buildQuery, getApiConfig, jsonBody } from './client'
import { v2LocatorToPlace } from '../reader/v2Locators'
import { chapterAtFraction } from '../reader/bookProgress'

const V2 = '/me/v2'

// ---- Shapes -------------------------------------------------------------------------------------

/** "The 409 body": one shape for every 4xx and the 503. `current` is the row the write lost to. */
export interface V2Error {
  code: string
  message: string
  revision?: number | null
  current?: unknown
  /** The book's current file id, on reading-state and file codes. */
  fileId?: string
  currentFile?: V2BookFile
  /** The member an `invalid_payload` names. */
  field?: string
}

export interface V2Status {
  maxPartBytes: number
}

/**
 * The legacy user-book progress row (`GET /me/books/{id}/progress`), the shape both clients'
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
export type V2WriteOutcome = 'accepted' | 'dropped' | 'reload' | { adopted: UserBookProgressDto }

/** A sign-in's `merge` (V2 on, a guest merged): guest id → account id, only the ids that changed. */
export interface V2MergeMap {
  books?: Record<string, string>
  files?: Record<string, string>
  words?: Record<string, string>
}

/** The client's switch: whether this app start talks V2, and the part size the server takes. */
export interface V2Switch {
  enabled: boolean
  maxPartBytes: number
}

export const V2_OFF: V2Switch = { enabled: false, maxPartBytes: 0 }

/**
 * What a client offers on a V2 user book (`Features:V2Api` on). V2 holds no bookmarks, no
 * distractors, clusters, tutor, stats or tags (ADR-031 D6): web and mobile hide the same things
 * from this one table, and M6 deletes it. `false` = hidden.
 */
export const V2_FEATURES = {
  bookmarks: false,
  /** Flashcards only: multiple choice needs server-made distractors. */
  reviewModes: ['classic'] as const,
  clusters: false,
  tutor: false,
  /** Book actions offered on an upload. */
  bookActions: ['open', 'delete', 'finish'] as const,
  metadataEdit: false,
  enrich: false,
  retry: false,
  tags: false,
  collections: false,
  stats: false,
  insights: false,
  contentSearch: false,
  readLater: false,
  storageQuota: false,
  markAsKnown: false,
} as const

export type V2Feature = { [K in keyof typeof V2_FEATURES]: (typeof V2_FEATURES)[K] extends boolean ? K : never }[keyof typeof V2_FEATURES]

/** Whether the client offers `feature` on a user book: always with V2 off, else as `V2_FEATURES` says. */
export const v2Offers = (s: V2Switch, feature: V2Feature): boolean => !s.enabled || V2_FEATURES[feature]

/** One page of a change feed; pass `cursor` back while `hasMore`. */
export interface V2Feed<T> {
  items: T[]
  cursor: string | null
  hasMore: boolean
}

export type V2FeedName = 'library' | 'reading' | 'annotations' | 'vocabulary'

export interface V2BookFile {
  id: string
  sha256: string
  byteSize: number
  originalName: string
  format: string
  pageCount: number | null
  toc: unknown
  isCurrent: boolean
  hasContent: boolean
  createdAt: string
  contentRemovedAt: string | null
  /**
   * Transitional (dropped with the chapter reader at M6.4, #1118), on the library feed only, absent
   * when null: the latest extraction's status, the chapter count, the chapters' summed word counts.
   * A shelf reads these, never `/chapters`.
   */
  ingestion?: V2Ingestion
  chapterCount?: number | null
  wordCount?: number | null
}

export interface V2Book {
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
  currentFile: V2BookFile | null
}

/** A file version as a client sends it (`id` on import; on replace the path's id wins). */
export interface V2FileWrite {
  id?: string
  sha256: string
  byteSize: number
  originalName: string
  /** PDD "File version": what clients send, lowercase (ADR-032, #1128). */
  format: 'epub' | 'pdf' | 'mobi' | 'azw3' | 'fb2' | 'cbz'
  pageCount?: number | null
  toc?: unknown
}

export interface V2ImportBook {
  title: string
  author?: string | null
  language?: string | null
  description?: string | null
  genre?: string | null
  publishedYear?: number | null
  tags?: string[]
  file: V2FileWrite & { id: string }
}

/** Merge-patch: an absent member keeps the stored value, null clears it. */
export interface V2PatchBook {
  expectedRevision: number
  title?: string
  author?: string | null
  language?: string | null
  description?: string | null
  genre?: string | null
  publishedYear?: number | null
  tags?: string[] | null
}

export interface V2FileReplacement {
  current: V2BookFile
  superseded: V2BookFile | null
}

/** The ADR-031 envelope. Only `epub-cfi` carries `quote` (and, on annotations, `prefix`/`suffix`). */
export interface V2Locator {
  version: 1
  scheme: 'epub-cfi' | 'pdf-page' | 'textstack-position-v1' | 'textstack-anchor-v1' | (string & {})
  value: unknown
  quote?: string
  prefix?: string
  suffix?: string
}

export interface V2ReadingStateWrite {
  /** null = first write; else the revision last read. */
  expectedRevision: number | null
  fileId: string
  currentLocator: V2Locator
  /** 0..1 */
  bookFraction: number
  frontierLocator?: V2Locator
  frontierFraction?: number
  completedAt?: string | null
  clientRecordedAt: string
}

export interface V2ReadingState {
  bookId: string
  fileId: string
  currentLocator: V2Locator
  bookFraction: number
  frontierLocator: V2Locator | null
  frontierFraction: number | null
  completedAt: string | null
  clientRecordedAt: string
  updatedAt: string
  revision: number
  resetRevision: number | null
}

export interface V2SessionWrite {
  bookId?: string | null
  startedAt: string
  endedAt: string
  durationSeconds: number
  wordsRead: number
  /** Fractions 0..1 (the column names are legacy). */
  startPercent: number
  endPercent: number
}

export interface V2Session extends Required<V2SessionWrite> {
  clientSessionId: string
  createdAt: string
}

export interface V2AnnotationWrite {
  /** null = create. */
  expectedRevision: number | null
  bookId: string
  /** Required with a locator: any version of this book. */
  fileId?: string | null
  selectedText: string
  noteText?: string | null
  locator?: V2Locator | null
  color: string
}

export interface V2Annotation {
  id: string
  bookId: string
  fileId: string | null
  selectedText: string
  noteText: string | null
  locator: V2Locator | null
  color: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  revision: number
}

export interface V2ExampleWrite {
  /** One per "save this sentence"; a retry of the same save reuses it. */
  operationId: string
  sentence: string
  contextualTranslation?: string | null
  bookId?: string | null
  fileId?: string | null
  chapterKey?: string | null
  bookTitle?: string | null
}

export interface V2WordSave {
  /** Client v4; when the key already exists the stored card's id wins and comes back. */
  id: string
  language: string
  word: string
  translation?: string | null
  definition?: string | null
  example?: V2ExampleWrite
}

export interface V2Example {
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

export interface V2Word {
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
  examples: V2Example[]
  /** On a save only: whether its example was added or replayed. */
  example?: 'added' | 'replayed'
}

/** Merge-patch, as {@link V2PatchBook}. */
export interface V2PatchWord {
  expectedRevision: number
  translation?: string | null
  definition?: string | null
}

export interface V2ReviewWrite {
  /** One per answer. */
  operationId: string
  wordId: string
  reviewMode: string
  isCorrect: boolean
  responseTimeMs?: number | null
  clientRecordedAt: string
}

export interface V2Review {
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

export interface V2RecordedReview {
  review: V2Review
  word: V2Word
}

/** Transitional (dropped at M6.4). `chapterNumber` orders, never displays. */
export interface V2ChapterHeading {
  chapterKey: string
  chapterNumber: number
  title: string
  wordCount: number | null
}

export type V2Ingestion = 'queued' | 'processing' | 'succeeded' | 'failed' | null

export interface V2FileChapters {
  items: V2ChapterHeading[]
  /** The file's latest extraction job; items stay empty while it runs. */
  ingestion: V2Ingestion
}

export interface V2Chapter extends V2ChapterHeading {
  html: string
  previous: V2ChapterHeading | null
  next: V2ChapterHeading | null
}

// ---- The uploads shelf (transitional, #1118) ----------------------------------------------------

/** An extraction's status as the legacy book status: queued and processing are one state to a reader. */
export function ingestionStatus(ingestion: V2Ingestion | undefined): 'Processing' | 'Ready' | 'Failed' {
  if (ingestion === 'queued' || ingestion === 'processing') return 'Processing'
  return ingestion === 'succeeded' ? 'Ready' : 'Failed'
}

/** A shelf row's status and counts, from the library feed's file alone: a shelf never calls `/chapters`. */
export const shelfFileSummary = (file: V2BookFile | null | undefined) => ({
  status: ingestionStatus(file?.ingestion),
  chapterCount: file?.chapterCount ?? 0,
  totalWordCount: file?.wordCount ?? null,
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
export function resumeChapterOf(state: V2ReadingState, toc: V2ChapterHeading[] | undefined): string | null {
  const place = v2LocatorToPlace(state.currentLocator)
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
export function v2ErrorOf(e: unknown): V2Error | null {
  if (!(e instanceof ApiError)) return null
  const body = e.body as Partial<V2Error> | undefined
  return body && typeof body.code === 'string' ? (body as V2Error) : null
}

/** The status probe, once per app start with a session: 200 = on; 404 (unmapped), 503 or offline = off. A 401 rethrows: no session, ask again once there is one. */
export async function probeV2(): Promise<{ enabled: boolean; maxPartBytes: number }> {
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

export const getStatus = () => authFetch<V2Status>(`${V2}/status`)

export const getChanges = <T>(feed: V2FeedName, cursor?: string | null, limit?: number) =>
  authFetch<V2Feed<T>>(`${V2}/${feed}/changes${buildQuery({ cursor, limit })}`)

/** Every row of a feed from `cursor` (null = from the start) to the end; the cursor to resume from. */
export async function pullAll<T>(feed: V2FeedName, cursor: string | null = null): Promise<{ items: T[]; cursor: string | null }> {
  const items: T[] = []
  for (;;) {
    const page = await getChanges<T>(feed, cursor)
    items.push(...page.items)
    cursor = page.cursor ?? cursor
    if (!page.hasMore) return { items, cursor }
  }
}

const inFlight = new Map<V2FeedName, Promise<{ items: unknown[]; cursor: string | null }>>()

/** A full pull of a feed, shared by every caller while one is in flight (a reader open asks twice). */
export function pullFeed<T>(feed: V2FeedName): Promise<{ items: T[]; cursor: string | null }> {
  let pull = inFlight.get(feed)
  if (!pull) {
    pull = pullAll(feed).finally(() => inFlight.delete(feed))
    inFlight.set(feed, pull)
  }
  return pull as Promise<{ items: T[]; cursor: string | null }>
}

/** Sign-out / another account / tests: a pull in flight belongs to the previous session. */
export const forgetPulls = () => inFlight.clear()

export const findBySha256 = (sha256: string) => orNull(authFetch<V2Book>(`${V2}/books/by-sha256/${sha256}`))
export const importBook = (bookId: string, body: V2ImportBook) => authFetch<V2Book>(book(bookId), jsonBody('PUT', body))
export const patchBook = (bookId: string, body: V2PatchBook) => authFetch<V2Book>(book(bookId), jsonBody('PATCH', body))
export const replaceFile = (bookId: string, fileId: string, body: { replacesFileId: string | null; file: V2FileWrite }) =>
  authFetch<V2FileReplacement>(file(bookId, fileId), jsonBody('PUT', body))
export const removeBook = (bookId: string) => authFetch<void>(book(bookId), { method: 'DELETE' })
export const restoreBook = (bookId: string) => authFetch<void>(`${book(bookId)}/restore`, { method: 'POST' })

/** One part of a file's bytes; fetch sends the `Content-Length` the route requires. */
export const putPart = (bookId: string, fileId: string, index: number, bytes: Blob | ArrayBuffer | Uint8Array) =>
  authFetch<{ index: number; size: number }>(`${file(bookId, fileId)}/parts/${index}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes as BodyInit,
  })
export const partPath = (bookId: string, fileId: string, index: number) => `${file(bookId, fileId)}/parts/${index}`
export const completeContent = (bookId: string, fileId: string, partCount: number) =>
  authFetch<V2BookFile>(`${file(bookId, fileId)}/content`, jsonBody('POST', { partCount }))
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
  const res = await authFetchResponse(`${file(bookId, fileId)}/content`, signal ? { signal } : undefined)
  /** Only the body read itself is the network. */
  const network = async <T>(read: Promise<T>): Promise<T> => {
    try {
      return await read
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') throw e
      const err = new ApiError(0, e instanceof Error ? e.message : String(e))
      err.isNetworkError = true
      throw err
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
  authFetch<V2Book>(`${book(bookId)}/cover`, { method: 'PUT', headers: { 'Content-Type': contentType }, body: bytes as BodyInit })
export const readingStateUrl = (bookId: string) => `${getApiConfig().baseUrl}${book(bookId)}/reading-state`
/** The cover; `updatedAt` busts the year-long cache after a change. */
export const coverUrl = (bookId: string, updatedAt: string) =>
  `${getApiConfig().baseUrl}${book(bookId)}/cover?v=${encodeURIComponent(updatedAt)}`

export const getChapters = (bookId: string, fileId: string) => authFetch<V2FileChapters>(`${file(bookId, fileId)}/chapters`)
export const getChapter = (bookId: string, fileId: string, chapterKey: string) =>
  authFetch<V2Chapter>(`${file(bookId, fileId)}/chapters/${encodeURIComponent(chapterKey)}`)

/** null: the book has no reading state yet (the next write is a first write). */
export const getReadingState = (bookId: string, signal?: AbortSignal) =>
  orNull(authFetch<V2ReadingState>(`${book(bookId)}/reading-state`, { signal }))
export const putReadingState = (bookId: string, body: V2ReadingStateWrite) =>
  authFetch<V2ReadingState>(`${book(bookId)}/reading-state`, jsonBody('PUT', body))
export const resetReadingState = (bookId: string, expectedRevision: number | null) =>
  authFetch<V2ReadingState>(`${book(bookId)}/reading-state/reset`, jsonBody('POST', { expectedRevision }))
/** Idempotent by `clientSessionId`: a replay answers 200 with the stored row. */
export const putSession = (clientSessionId: string, body: V2SessionWrite) =>
  authFetch<V2Session>(`${V2}/reading/sessions/${clientSessionId}`, jsonBody('PUT', body))

/** The annotation's URL, for a keepalive write that outlives the page (the web V2 reader, #1226). */
export const annotationUrl = (id: string) => `${getApiConfig().baseUrl}${V2}/annotations/${id}`
export const putAnnotation = (id: string, body: V2AnnotationWrite) => authFetch<V2Annotation>(`${V2}/annotations/${id}`, jsonBody('PUT', body))
export const deleteAnnotation = (id: string) => authFetch<V2Annotation>(`${V2}/annotations/${id}`, { method: 'DELETE' })

export const saveWord = (body: V2WordSave) => authFetch<V2Word>(`${V2}/vocabulary/words`, jsonBody('PUT', body))
export const getWord = (id: string) => authFetch<V2Word>(`${V2}/vocabulary/words/${id}`)
export const patchWord = (id: string, body: V2PatchWord) => authFetch<V2Word>(`${V2}/vocabulary/words/${id}`, jsonBody('PATCH', body))
export const deleteWord = (id: string) => authFetch<V2Word>(`${V2}/vocabulary/words/${id}`, { method: 'DELETE' })
export const restoreWord = (id: string, expectedRevision: number) =>
  authFetch<V2Word>(`${V2}/vocabulary/words/${id}/restore`, jsonBody('POST', { expectedRevision }))
export const addExample = (wordId: string, body: V2ExampleWrite) =>
  authFetch<V2Example>(`${V2}/vocabulary/words/${wordId}/examples`, jsonBody('POST', body))
export const getDue = (limit?: number) => authFetch<V2Word[]>(`${V2}/vocabulary/due${buildQuery({ limit })}`)
export const recordReview = (body: V2ReviewWrite) => authFetch<V2RecordedReview>(`${V2}/vocabulary/reviews`, jsonBody('POST', body))
