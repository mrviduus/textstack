/**
 * The web app on V2 (`Features:V2Api`, #1025 M2.7): the probe, the session's V2 cache, and the V2
 * side of the user-book API — library, upload, the transitional chapter reader, reading state —
 * mapped onto the legacy shapes the pages already render, so `api/userBooks.ts` switches per call
 * and no consumer changes. Wire calls are `@textstack/shared`'s `v2Api`; the place and anchor
 * mappings are shared (`v2Locators`); this file only caches, maps and sequences.
 */
import {
  v2Api, ApiError, V2_OFF, clip, chapterAtFraction, placeToV2Locator, v2LocatorToPlace,
  type V2Book, type V2FileChapters, type V2Chapter, type V2ReadingState, type V2Annotation,
  type V2ReadingStateWrite, type V2FeedName, type V2Switch, type LegacyPlace,
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
  /** Per word: the card revision last read. */
  revisions: new Map<string, number>(),
  /** The annotations as last pulled or written, by id; and the books pulled at least once. */
  annotations: new Map<string, V2Annotation>(),
  pulled: new Set<string>(),
  /** One full pull per feed in flight. */
  inFlight: new Map<V2FeedName, Promise<{ items: unknown[] }>>(),
  reset() {
    for (const cache of [this.books, this.chapters, this.states, this.revisions, this.annotations, this.pulled, this.inFlight]) cache.clear()
  },
}

/** Tests only: a fresh app start (no probe, no session settled, an empty cache). */
export function resetV2ForTests() {
  probe = null
  known = V2_OFF
  rearmV2Session()
  v2Store.reset()
}

/** A full pull of a feed, shared by every caller while one is in flight (a reader open asks twice). */
export function pullFeed<T>(feed: V2FeedName): Promise<{ items: T[] }> {
  let pull = v2Store.inFlight.get(feed)
  if (!pull) {
    pull = v2Api.pullAll(feed).finally(() => v2Store.inFlight.delete(feed))
    v2Store.inFlight.set(feed, pull)
  }
  return pull as Promise<{ items: T[] }>
}

// ---- Library ------------------------------------------------------------------------------------

export async function pullV2Books(): Promise<V2Book[]> {
  const { items } = await pullFeed<V2Book>('library')
  v2Store.books.clear()
  for (const b of items) v2Store.books.set(b.id, b)
  return items
}

/** A live book of the user's, from the last pull or a fresh one; 404 when there is none. */
export async function v2Book(id: string): Promise<V2Book> {
  const b = v2Store.books.get(id) ?? (await pullV2Books(), v2Store.books.get(id))
  if (!b || b.removedAt) throw new ApiError(404, 'Book not found')
  return b
}

/** The current file's table of contents and extraction status (empty when it has no bytes). */
export async function v2Chapters(b: V2Book): Promise<V2FileChapters> {
  const file = b.currentFile
  if (!file) return { items: [], ingestion: null }
  const cached = v2Store.chapters.get(file.id)
  if (cached) return cached
  const toc = await v2Api.getChapters(b.id, file.id)
  if (toc.ingestion === 'succeeded') v2Store.chapters.set(file.id, toc)
  return toc
}

/** Forget what was cached for a book: its file changed (`file_replaced` / `unknown_file`). */
export function forgetV2Book(id: string) {
  const file = v2Store.books.get(id)?.currentFile
  if (file) v2Store.chapters.delete(file.id)
  v2Store.books.delete(id)
  v2Store.states.delete(id)
}

function status(toc: V2FileChapters): UserBook['status'] {
  if (toc.ingestion === 'queued' || toc.ingestion === 'processing') return 'Processing'
  return toc.ingestion === 'succeeded' ? 'Ready' : 'Failed'
}

const isPdf = (b: V2Book) => b.currentFile?.format === 'pdf' && b.currentFile.hasContent

const totalWords = (toc: V2FileChapters) =>
  toc.items.some((c) => c.wordCount != null) ? toc.items.reduce((s, c) => s + (c.wordCount ?? 0), 0) : null

/** The fields the shelf row and the book page share. */
function baseBook(b: V2Book, toc: V2FileChapters) {
  return {
    id: b.id,
    title: b.title,
    slug: '',
    language: b.language ?? 'en',
    author: b.author,
    description: b.description,
    coverPath: b.hasCover ? v2Api.coverUrl(b.id, b.updatedAt) : null,
    genre: b.genre,
    status: status(toc),
    errorMessage: null,
    totalWordCount: totalWords(toc),
    createdAt: b.createdAt,
    hasOriginalPdf: isPdf(b),
  }
}

/** The chapter a stored state resumes in: its own; none for a PDF page; by fraction for an epub-cfi. */
function resumeChapter(state: V2ReadingState, toc: V2FileChapters): string | null {
  const place = v2LocatorToPlace(state.currentLocator)
  return place ? place.chapterSlug : chapterAtFraction(toc.items, state.bookFraction)
}

/** The uploads shelf: live books only, each with its status and the reader's place. */
export async function getV2UserBooks(): Promise<UserBook[]> {
  const [list, reading] = await Promise.all([pullV2Books(), pullFeed<V2ReadingState>('reading')])
  const stateOf = new Map(reading.items.map((s) => [s.bookId, s]))
  const live = list.filter((b) => !b.removedAt)
  // ponytail: one chapters call per book per load (status + chapter count); a status on the feed if libraries grow.
  // One failing call (content removed, a 503) costs that book its status, never the shelf.
  const tocs = await Promise.allSettled(live.map(v2Chapters))
  return live.map((b, i): UserBook => {
    const settledToc = tocs[i]
    const toc: V2FileChapters = settledToc.status === 'fulfilled' ? settledToc.value : { items: [], ingestion: null }
    const state = stateOf.get(b.id)
    return {
      ...baseBook(b, toc),
      chapterCount: toc.items.length,
      completedAt: state?.completedAt ?? null,
      progressPercent: state ? state.bookFraction : null,
      progressUpdatedAt: state?.updatedAt ?? null,
      progressChapterSlug: state ? resumeChapter(state, toc) : null,
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
    ...baseBook(b, toc),
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

export async function removeV2Book(id: string): Promise<void> {
  await v2Api.removeBook(id)
  forgetV2Book(id)
}

/** The original PDF, Range-capable; '' until the book is known (the reader loads it first). */
export function v2FileUrl(id: string): string {
  const file = v2Store.books.get(id)?.currentFile
  return file ? v2Api.contentUrl(id, file.id) : ''
}

// ---- Reading state ------------------------------------------------------------------------------

const remember = (s: V2ReadingState) => v2Store.states.set(s.bookId, { revision: s.revision, fileId: s.fileId, bookFraction: s.bookFraction })

/** A V2 state as the legacy progress row the reader restores from. */
async function toProgress(s: V2ReadingState): Promise<UserBookProgress> {
  const place = v2LocatorToPlace(s.currentLocator)
  const chapterSlug = place ? place.chapterSlug : chapterAtFraction((await v2Chapters(await v2Book(s.bookId))).items, s.bookFraction)
  return {
    chapterSlug,
    locator: place?.locator ?? null,
    percent: s.bookFraction,
    updatedAt: s.updatedAt,
    positionJson: place?.positionJson ?? null,
    clientUpdatedAt: s.clientRecordedAt,
  }
}

/** The reader's read: null = no state yet, undefined = no answer (as `readUserBookProgress`). */
export async function readV2Progress(bookId: string, signal?: AbortSignal): Promise<UserBookProgress | null | undefined> {
  try {
    const s = await v2Api.getReadingState(bookId, signal)
    if (!s) {
      v2Store.states.delete(bookId)
      return null
    }
    remember(s)
    return await toProgress(s)
  } catch (e) {
    return e instanceof ApiError && e.status === 404 ? null : undefined
  }
}

export interface ProgressWrite extends LegacyPlace {
  percent?: number
  updatedAt?: string
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
    // The client's clock as the write was made; it is already this device's now, so within MAX_CLIENT_SKEW_MS of it.
    clientRecordedAt: data.updatedAt ?? new Date().toISOString(),
  }
}

/**
 * What the reader does after a V2 write: `accepted` mark it synced; `dropped` leave the local
 * place unsynced (sent again with the next save); `reload` the book's file was replaced; or adopt
 * the server's place.
 */
export type V2WriteOutcome = 'accepted' | 'dropped' | 'reload' | { adopted: UserBookProgress }

/**
 * One reading-state write under the revision rule. Lost (409): `stale_revision` adopts the server's
 * row (a lost write takes the server's place); `reset` writes this place again on the new revision;
 * `file_replaced` asks for a reload; `unknown_file` refetches the book and writes once more;
 * `chapter_not_found` drops the write — while the file is still extracting it is sent again later,
 * after that its chapter keys changed (the TOC is fetched again; the reader resumes from the
 * fraction). Anything else throws: the caller keeps the write for its next save.
 */
export async function saveV2Progress(bookId: string, data: ProgressWrite, retried = false): Promise<V2WriteOutcome> {
  if (!v2Store.books.has(bookId)) await v2Book(bookId)
  const body = v2ProgressBody(bookId, data)
  if (!body) return 'dropped'
  try {
    remember(await v2Api.putReadingState(bookId, body))
    return 'accepted'
  } catch (e) {
    const err = v2Api.v2ErrorOf(e)
    const current = err?.current as V2ReadingState | null | undefined
    switch (err?.code) {
      case 'stale_revision':
        if (!current) {
          v2Store.states.delete(bookId)
          return 'dropped'
        }
        remember(current)
        return { adopted: await toProgress(current) }
      case 'reset':
        if (current) remember(current)
        remember(await v2Api.putReadingState(bookId, { ...body, expectedRevision: current?.revision ?? null }))
        return 'accepted'
      case 'file_replaced':
        forgetV2Book(bookId)
        return 'reload'
      case 'unknown_file':
        // The book's file is not the one we named: fetch the book again and write once more.
        forgetV2Book(bookId)
        return retried ? 'dropped' : saveV2Progress(bookId, data, true)
      case 'chapter_not_found': {
        const file = v2Store.books.get(bookId)?.currentFile
        if (file) v2Store.chapters.delete(file.id)
        return 'dropped'
      }
      default:
        throw e
    }
  }
}

/** After a keepalive write landed: its answer is the new revision. */
export const rememberV2State = (s: V2ReadingState) => remember(s)

/** Mark read on V2: the state as it stands (or the book's start), at the end, with `completedAt`. */
export async function completeV2Book(bookId: string): Promise<void> {
  const b = await v2Book(bookId)
  const state = await v2Api.getReadingState(bookId)
  const first = (await v2Chapters(b)).items[0]?.chapterKey
  const sameFile = state && state.fileId === b.currentFile?.id
  const currentLocator = sameFile ? state.currentLocator : placeToV2Locator({ chapterSlug: first ?? null })
  if (!b.currentFile || !currentLocator) throw new ApiError(409, 'Nothing to mark read yet')
  remember(await v2Api.putReadingState(bookId, {
    expectedRevision: sameFile ? state.revision : null,
    fileId: b.currentFile.id,
    currentLocator,
    bookFraction: sameFile ? state.bookFraction : 0,
    completedAt: new Date().toISOString(),
    clientRecordedAt: new Date().toISOString(),
  }))
}

/** Mark unread on V2: a reset clears completion and the frontier, the place stays (PDD rule 5). */
export async function uncompleteV2Book(bookId: string): Promise<void> {
  const state = await v2Api.getReadingState(bookId)
  if (state) remember(await v2Api.resetReadingState(bookId, state.revision))
}

// ---- Upload -------------------------------------------------------------------------------------

/** A V2 upload the reader must hear about; `code` picks the message (`upload.v2.*`). */
export class V2UploadError extends Error {
  constructor(readonly code: 'content_mismatch' | 'quota_exceeded', readonly quota?: { used: number; limit: number }) {
    super(code)
  }
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`

/** The reader-facing message of a failed V2 upload; null when the error is not one of these. */
export function v2UploadMessage(err: unknown, t: (key: string, vars?: Record<string, string | number>) => string): string | null {
  if (!(err instanceof V2UploadError)) return null
  if (err.code === 'content_mismatch') return t('upload.v2.contentMismatch')
  return t('upload.v2.quotaExceeded', { used: megabytes(err.quota?.used ?? 0), limit: megabytes(err.quota?.limit ?? 0) })
}

/** Lowercase hex SHA-256 of the file: the browser's own digest, the whole file in memory (≤ 500 MB). */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(await file.arrayBuffer()))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

type SendPart = (url: string, part: Blob, onLoaded: (loaded: number) => void) => Promise<unknown>

/**
 * An upload on V2 (PDD "File sync upload protocol"): hash, look the bytes up, import the metadata,
 * send the parts, complete. The same bytes already in the library open that book (`existing`), its bytes sent first if it has none.
 * `content_mismatch` re-hashes (same hash: send again once; changed: tell the reader);
 * `incomplete_upload` re-sends every part once; `quota_exceeded` carries `used/limit`. `sendPart` is the XHR sender with its progress and retry.
 * ponytail: no cover (`PUT /cover` needs an EPUB parse on the client), the title is the file name.
 */
export async function uploadV2Book(
  file: File,
  maxPartBytes: number,
  sendPart: SendPart,
  onProgress?: (percent: number) => void,
): Promise<UploadResponse & { existing?: boolean }> {
  const format = file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'epub'
  const sha256 = await sha256Hex(file)
  // The same bytes already in the library: open that book. If its bytes never arrived (an earlier
  // upload broke after the import), this upload sends them to it, then opens it.
  const reuse = async (b: V2Book) => {
    const fileId = b.currentFile?.id
    if (fileId && !b.currentFile!.hasContent) await sendBytes(file, sha256, b.id, fileId, maxPartBytes, sendPart, onProgress)
    return { userBookId: b.id, jobId: '', status: 'existing', existing: true, hasOriginalPdf: b.currentFile?.format === 'pdf' }
  }
  const existing = await v2Api.findBySha256(sha256)
  if (existing) return reuse(existing)

  const bookId = crypto.randomUUID()
  const fileId = crypto.randomUUID()
  const title = clip(file.name.replace(/\.(epub|pdf)$/i, '').trim() || file.name, 500)
  try {
    await v2Api.importBook(bookId, { title, file: { id: fileId, sha256, byteSize: file.size, originalName: clip(file.name, 500), format } })
  } catch (e) {
    const err = v2Api.v2ErrorOf(e)
    if (err?.code === 'duplicate_file') return reuse(err.current as V2Book)
    throw e
  }
  await sendBytes(file, sha256, bookId, fileId, maxPartBytes, sendPart, onProgress)
  return { userBookId: bookId, jobId: '', status: 'Processing', hasOriginalPdf: format === 'pdf' }
}

/** The parts, then the complete, with the retries `uploadV2Book` names. */
async function sendBytes(
  file: File, sha256: string, bookId: string, fileId: string, maxPartBytes: number,
  sendPart: SendPart, onProgress?: (percent: number) => void,
): Promise<void> {
  const partBytes = Math.max(1, maxPartBytes)
  const partCount = Math.max(1, Math.ceil(file.size / partBytes))
  const sendAll = async () => {
    for (let i = 0; i < partCount; i++) {
      const start = i * partBytes
      await sendPart(`${API_BASE}${v2Api.partPath(bookId, fileId, i)}`, file.slice(start, start + partBytes),
        (loaded) => onProgress?.(((start + loaded) / file.size) * 100))
    }
  }
  // One second round: every part again after `incomplete_upload` (a part went missing), or after
  // `content_mismatch` when the file still hashes the same (the bytes broke in flight). A file that
  // changed while it was read is the reader's to pick again.
  for (let retried = false; ; retried = true) {
    await sendAll()
    try {
      await v2Api.completeContent(bookId, fileId, partCount)
      break
    } catch (e) {
      const err = v2Api.v2ErrorOf(e)
      if (err?.code === 'quota_exceeded') throw new V2UploadError('quota_exceeded', err.current as { used: number; limit: number })
      const again = !retried && (err?.code === 'incomplete_upload'
        || (err?.code === 'content_mismatch' && (await sha256Hex(file)) === sha256))
      if (again) continue
      throw err?.code === 'content_mismatch' ? new V2UploadError('content_mismatch') : e
    }
  }
}
