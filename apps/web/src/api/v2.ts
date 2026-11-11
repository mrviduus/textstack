/**
 * The web app on V2 (`Features:V2Api`, #1025 M2.7): the probe, the session's V2 cache, and the V2
 * side of the user-book API — library, upload, the transitional chapter reader, reading state —
 * mapped onto the legacy shapes the pages already render, so `api/userBooks.ts` switches per call
 * and no consumer changes. Wire calls are `@textstack/shared`'s `v2Api`; the place and anchor
 * mappings are shared (`v2Locators`), and so are the book client and the upload sequence
 * (`createV2Books`, `uploadV2File`, #1121); this file caches, maps and gives them its IO.
 */
import {
  v2Api, ApiError, V2_OFF, getApiConfig, ingestionStatus, shelfFileSummary, resumeChapterOf, placeToV2Locator, createV2Books, uploadV2File, V2UploadError, mb,
  type V2Book, type V2FileChapters, type V2Chapter, type V2ReadingState, type V2Annotation, type V2Word,
  type V2ReadingStateWrite, type V2Switch, type ProgressWrite,
} from '@textstack/shared'
import { API_BASE } from './client'
import { settleV2Session, v2SessionSettled, rearmV2Session } from '../lib/v2Session'
import type { UserBook, UserBookDetail, UserChapter, UploadResponse, UserBookProgress } from './userBooks'

// ---- The switch ---------------------------------------------------------------------------------

let probe: Promise<V2Switch> | null = null
let known: V2Switch = V2_OFF
/**
 * `GET /me/v2/status`, once per app start, started by the session (AuthContext, the moment a user
 * is set): 200 on, 404 (unmapped) / 503 / offline off for this start (sync stays legacy). Only a
 * 401 is asked again with the next session.
 */
export function startV2Probe(): Promise<V2Switch> {
  settleV2Session()
  probe ??= v2Api.probeV2().then(
    (s) => (known = s),
    () => { probe = null; return V2_OFF },
  )
  return probe
}

export { settleV2Session }

/** The probe's answer: waits for the session bootstrap and an in-flight probe; off without a session. */
export async function v2Status(): Promise<V2Switch> {
  if (!probe) await v2SessionSettled()
  return probe ?? V2_OFF
}

/** The probe's answer once it has settled (off before): for the synchronous paths. */
export const v2Enabled = () => known.enabled

/** Every call site checks one thing: `if (await onV2()) …`. */
export const onV2 = async () => (await v2Status()).enabled

// ---- The session's V2 cache ---------------------------------------------------------------------

/**
 * Everything this tab caches from V2, per signed-in account: `reset()` on sign-out and on an
 * account change, so the next account never reads the previous one's books. ponytail: memory
 * only, a full pull per load; R6 is the local store.
 */
export const v2Store = {
  /** The last library pull, by book id: a book's current file. */
  books: new Map<string, V2Book>(),
  /** A file's chapters, once its extraction succeeded (they never change after). */
  chapters: new Map<string, V2FileChapters>(),
  /** Per book: the reading-state revision last read or written, and its file. */
  states: new Map<string, { revision: number | null; fileId: string; bookFraction: number }>(),
  /** The vocabulary cards last read or written, by id (the shared V2 vocabulary's). */
  cards: new Map<string, V2Word>(),
  /** The annotations as last pulled or written, by id; and the books pulled at least once. */
  annotations: new Map<string, V2Annotation>(),
  pulled: new Set<string>(),
  /** Bumped by `reset()`: an answer that outlived it is the previous account's (`whileCurrent`). */
  epoch: 0,
  reset() {
    for (const cache of [this.books, this.chapters, this.states, this.cards, this.annotations, this.pulled]) cache.clear()
    v2Api.forgetPulls()
    this.epoch++
  },
}

/** Tests only: a fresh app start (no probe, no session settled, an empty cache). */
export function resetV2ForTests() {
  probe = null
  known = V2_OFF
  rearmV2Session()
  v2Store.reset()
}

/** A full pull of a feed, shared by every caller while one is in flight (`@textstack/shared`). */
export const pullFeed = v2Api.pullFeed

const remember = (s: V2ReadingState) => v2Store.states.set(s.bookId, { revision: s.revision, fileId: s.fileId, bookFraction: s.bookFraction })

/** The shared V2 book client (`@textstack/shared` v2Books) on this tab's store; `whileCurrent` is its epoch guard (#1155). */
const v2 = createV2Books({
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
  resetSince, whileCurrent, pullV2Books, v2Book, v2Chapters, removeV2Book, v2FileUrl,
  saveV2Progress, completeV2Book, uncompleteV2Book,
} = v2
const { rememberState, toProgress } = v2

// ---- Library ------------------------------------------------------------------------------------

const isPdf = (b: V2Book) => b.currentFile?.format === 'pdf' && b.currentFile.hasContent

const totalWords = (toc: V2FileChapters) =>
  toc.items.some((c) => c.wordCount != null) ? toc.items.reduce((s, c) => s + (c.wordCount ?? 0), 0) : null

/** The fields the shelf row and the book page share. */
function baseBook(b: V2Book) {
  return {
    id: b.id,
    title: b.title,
    slug: '',
    language: b.language ?? 'en',
    author: b.author,
    description: b.description,
    coverPath: b.hasCover ? v2Api.coverUrl(b.id, b.updatedAt) : null,
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
  const [list, reading] = await Promise.all([pullV2Books(), pullFeed<V2ReadingState>('reading')])
  const stateOf = new Map(reading.items.map((s) => [s.bookId, s]))
  return list.filter((b) => !b.removedAt).map((b): UserBook => {
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
  const [toc, state] = await Promise.all([v2Chapters(b), v2Api.getReadingState(id).catch(() => null)])
  return {
    ...baseBook(b),
    status: ingestionStatus(toc.ingestion),
    totalWordCount: totalWords(toc),
    publishedYear: b.publishedYear,
    // The chapter key is the chapter's id and slug on V2: highlights and vocabulary name it.
    chapters: toc.items.map((c) => ({ id: c.chapterKey, chapterNumber: c.chapterNumber, slug: c.chapterKey, title: c.title, wordCount: c.wordCount })),
    toc: null,
    updatedAt: b.updatedAt,
    completedAt: state?.completedAt ?? null,
    pageCount: b.currentFile?.pageCount ?? null,
  }
}

const heading = (h: V2Chapter['previous']) => h && { chapterNumber: h.chapterNumber, slug: h.chapterKey, title: h.title }

export async function getV2UserBookChapter(bookId: string, chapterKey: string): Promise<UserChapter> {
  const b = await v2Book(bookId)
  if (!b.currentFile) throw new ApiError(404, 'Chapter not found')
  const ch = await v2Api.getChapter(bookId, b.currentFile.id, chapterKey)
  return {
    id: ch.chapterKey, chapterNumber: ch.chapterNumber, slug: ch.chapterKey, title: ch.title, html: ch.html,
    wordCount: ch.wordCount, previous: heading(ch.previous), next: heading(ch.next),
  }
}

/**
 * A V2 file's bytes for the V2 reader (#1225): online only, no cache. Cookie-authed as every call here, with
 * authFetch's rule: a 401 refreshes the cookie and retries once. Anything but 2xx is an ApiError.
 */
export async function fetchV2FileBytes(bookId: string, fileId: string): Promise<ArrayBuffer> {
  const { onUnauthorized, credentials } = getApiConfig()
  const get = () => fetch(v2Api.contentUrl(bookId, fileId), { credentials })
  let res = await get()
  if (res.status === 401 && (await onUnauthorized()) === '') res = await get()
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`)
  return res.arrayBuffer()
}

// ---- Reading state ------------------------------------------------------------------------------

/**
 * The reader's read: null = no state yet, undefined = no answer (as `readUserBookProgress`) — also
 * when the store was reset meanwhile: the answer was the previous account's.
 */
export async function readV2Progress(bookId: string, signal?: AbortSignal): Promise<UserBookProgress | null | undefined> {
  const reset = resetSince()
  try {
    const s = await v2Api.getReadingState(bookId, signal)
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
export function v2ProgressBody(bookId: string, data: ProgressWrite): V2ReadingStateWrite | null {
  const current = v2Store.books.get(bookId)?.currentFile?.id
  const known = v2Store.states.get(bookId)
  const onKnown = !!known && (!current || known.fileId === current)
  const fileId = onKnown ? known!.fileId : current
  const currentLocator = placeToV2Locator(data)
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

export type { V2WriteOutcome, V2MarkOutcome, ProgressWrite } from '@textstack/shared'
export { V2UploadError }

/** A keepalive write's answer (null: not landed) is the new revision, unless the store was reset meanwhile. */
export const rememberV2State = (answer: Promise<V2ReadingState | null>) => rememberState(answer)

// ---- Upload -------------------------------------------------------------------------------------

/** The reader-facing message of a failed V2 upload; null when the error is not one of these. */
export function v2UploadMessage(err: unknown, t: (key: string, vars?: Record<string, string | number>) => string): string | null {
  if (!(err instanceof V2UploadError)) return null
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
 * An upload on V2: the shared sequence (`@textstack/shared` v2Upload) over this tab's IO — the
 * browser's digest, `Blob.slice` parts through `sendPart` (the XHR sender with its progress and retry).
 */
export async function uploadV2Book(
  file: File,
  maxPartBytes: number,
  sendPart: SendPart,
  onProgress?: (percent: number) => void,
): Promise<UploadResponse & { existing?: boolean }> {
  const { bookId, format, found } = await uploadV2File(file, maxPartBytes, {
    newId: () => crypto.randomUUID(),
    hash: () => sha256Hex(file),
    sendPart: ({ bookId, fileId, index, start, end }) => sendPart(`${API_BASE}${v2Api.partPath(bookId, fileId, index)}`, file.slice(start, end),
      (loaded) => onProgress?.(((start + loaded) / file.size) * 100)),
  })
  return found
    ? { userBookId: bookId, jobId: '', status: 'existing', existing: true, hasOriginalPdf: found.currentFile?.format === 'pdf' }
    : { userBookId: bookId, jobId: '', status: 'Processing', hasOriginalPdf: format === 'pdf' }
}
