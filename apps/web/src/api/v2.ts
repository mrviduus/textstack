/**
 * The web app on V2 (`Features:V2Api`, #1025 M2.7): the probe, and the V2 side of the user-book
 * API — library, upload, the transitional chapter reader, reading state — mapped onto the legacy
 * shapes the pages already render, so `api/userBooks.ts` switches per call and no consumer changes.
 * Wire calls are `@textstack/shared`'s `v2Api`; this file only maps and sequences.
 */
import {
  v2Api, ApiError, chapterAtFraction, clip, v2PositionLocator, v2ResumeChapter as resumeChapter,
  type V2Book, type V2FileChapters, type V2Chapter, type V2ReadingState,
  type V2ReadingStateWrite,
} from '@textstack/shared'
import { API_BASE } from './client'
import type { UserBook, UserBookDetail, UserChapter, UploadResponse, UserBookProgress } from './userBooks'

// The locator helpers both clients use live in `@textstack/shared` (reader/v2Locators).
export { chapterAtFraction, clip, v2PositionLocator as v2Locator }

// ---- The switch ---------------------------------------------------------------------------------

export interface V2Switch {
  enabled: boolean
  maxPartBytes: number
}

export const V2_OFF: V2Switch = { enabled: false, maxPartBytes: 0 }

let probe: Promise<V2Switch> | null = null
let known: V2Switch = V2_OFF

/**
 * `GET /me/v2/status`, once per app start, started by the session (AuthContext, the moment a user
 * is set): 200 on, 404 (unmapped) / 503 / offline off for this start (sync stays legacy). Only a
 * 401 is asked again with the next session.
 */
export function startV2Probe(): Promise<V2Switch> {
  probe ??= v2Api.probeV2().then(
    (s) => (known = s),
    () => { probe = null; return V2_OFF },
  )
  return probe
}

/** The probe's answer; off while no session has started it. */
export const v2Status = (): Promise<V2Switch> => probe ?? Promise.resolve(V2_OFF)

/** The probe's answer once it has settled (off before): for the synchronous paths. */
export const v2Enabled = () => known.enabled

/** Tests only: forget the probe. */
export function resetV2ForTests() {
  probe = null
  known = V2_OFF
}

/** Every call site checks one thing: `if (await onV2()) …`. */
export const onV2 = async () => (await v2Status()).enabled

// ---- Library ------------------------------------------------------------------------------------

// The last library pull, by book id: the reader, the upload and the reading state find a book's
// current file here. ponytail: a full pull per library load and no local store; R6 is the local library.
const books = new Map<string, V2Book>()
// A file's chapters, once its extraction succeeded (they never change after).
const chapters = new Map<string, V2FileChapters>()

export async function pullV2Books(): Promise<V2Book[]> {
  const { items } = await v2Api.pullAll<V2Book>('library')
  books.clear()
  for (const b of items) books.set(b.id, b)
  return items
}

/** A live book of the user's, from the last pull or a fresh one; 404 when there is none. */
export async function v2Book(id: string): Promise<V2Book> {
  const b = books.get(id) ?? (await pullV2Books(), books.get(id))
  if (!b || b.removedAt) throw new ApiError(404, 'Book not found')
  return b
}

/** The book of the last pull, synchronously (null when not pulled yet). */
export const cachedV2Book = (id: string) => books.get(id) ?? null

/** The current file's table of contents and extraction status (empty when it has no bytes). */
export async function v2Chapters(b: V2Book): Promise<V2FileChapters> {
  const file = b.currentFile
  if (!file) return { items: [], ingestion: null }
  const known = chapters.get(file.id)
  if (known) return known
  const toc = await v2Api.getChapters(b.id, file.id)
  if (toc.ingestion === 'succeeded') chapters.set(file.id, toc)
  return toc
}

/** Forget what was cached for a book: its file changed (`file_replaced` / `unknown_file`). */
export function forgetV2Book(id: string) {
  const file = books.get(id)?.currentFile
  if (file) chapters.delete(file.id)
  books.delete(id)
  states.delete(id)
}

function status(toc: V2FileChapters): UserBook['status'] {
  if (toc.ingestion === 'queued' || toc.ingestion === 'processing') return 'Processing'
  return toc.ingestion === 'succeeded' ? 'Ready' : 'Failed'
}

const isPdf = (b: V2Book) => b.currentFile?.format === 'pdf' && b.currentFile.hasContent

/** The cover route, versioned by `updatedAt` (`getUserBookCoverUrl` passes a `/me/v2/` path through). */
const coverPath = (b: V2Book) => (b.hasCover ? `/me/v2/books/${b.id}/cover?v=${encodeURIComponent(b.updatedAt)}` : null)

/** The uploads shelf: live books only, each with its status and the reader's place. */
export async function getV2UserBooks(): Promise<UserBook[]> {
  const [list, reading] = await Promise.all([pullV2Books(), v2Api.pullAll<V2ReadingState>('reading')])
  const stateOf = new Map(reading.items.map((s) => [s.bookId, s]))
  // ponytail: one chapters call per book per load (status + chapter count); a status on the feed if libraries grow.
  return Promise.all(list.filter((b) => !b.removedAt).map(async (b): Promise<UserBook> => {
    const toc = await v2Chapters(b)
    const state = stateOf.get(b.id)
    return {
      id: b.id,
      title: b.title,
      slug: '',
      language: b.language ?? 'en',
      author: b.author,
      description: b.description,
      coverPath: coverPath(b),
      genre: b.genre,
      status: status(toc),
      errorMessage: null,
      chapterCount: toc.items.length,
      totalWordCount: totalWords(toc),
      createdAt: b.createdAt,
      completedAt: state?.completedAt ?? null,
      progressPercent: state ? state.bookFraction : null,
      progressUpdatedAt: state?.updatedAt ?? null,
      progressChapterSlug: state ? resumeChapter(state, toc) : null,
      tags: b.tags,
      hasOriginalPdf: isPdf(b),
    }
  }))
}

const totalWords = (toc: V2FileChapters) =>
  toc.items.some((c) => c.wordCount != null) ? toc.items.reduce((s, c) => s + (c.wordCount ?? 0), 0) : null

/** The book page and the reader's book: the chapter list is the current file's. */
export async function getV2UserBook(id: string): Promise<UserBookDetail> {
  const b = await v2Book(id)
  const toc = await v2Chapters(b)
  return {
    id: b.id,
    title: b.title,
    slug: '',
    language: b.language ?? 'en',
    author: b.author,
    description: b.description,
    coverPath: coverPath(b),
    genre: b.genre,
    publishedYear: b.publishedYear,
    totalWordCount: totalWords(toc),
    status: status(toc),
    errorMessage: null,
    // The chapter key is the chapter's id and slug on V2: highlights and vocabulary name it.
    chapters: toc.items.map((c) => ({ id: c.chapterKey, chapterNumber: c.chapterNumber, slug: c.chapterKey, title: c.title, wordCount: c.wordCount })),
    toc: null,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    completedAt: null,
    hasOriginalPdf: isPdf(b),
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
  const file = books.get(id)?.currentFile
  return file ? v2Api.contentUrl(id, file.id) : ''
}

// ---- Reading state ------------------------------------------------------------------------------

/** Per book: the revision last read or written, and the file it is on. */
const states = new Map<string, { revision: number | null; fileId: string }>()

const remember = (s: V2ReadingState) => states.set(s.bookId, { revision: s.revision, fileId: s.fileId })

/** A V2 state as the legacy progress row the reader restores from. */
async function toProgress(s: V2ReadingState): Promise<UserBookProgress> {
  const { scheme, value } = s.currentLocator
  const page = scheme === 'pdf-page' ? (value as { page: number }).page : null
  const toc = scheme === 'epub-cfi' ? await v2Chapters(await v2Book(s.bookId)) : { items: [], ingestion: null }
  return {
    chapterSlug: resumeChapter(s, toc),
    locator: page != null ? `page:${page}` : null,
    percent: s.bookFraction,
    updatedAt: s.updatedAt,
    // A position with an anchor is the TextPosition the reader serialized; scroll-only has none.
    positionJson: scheme === 'textstack-position-v1' && (value as { anchor?: unknown }).anchor ? JSON.stringify(value) : null,
    clientUpdatedAt: s.clientRecordedAt,
  }
}

/** The reader's read: null = no state yet, undefined = no answer (as `readUserBookProgress`). */
export async function readV2Progress(bookId: string, signal?: AbortSignal): Promise<UserBookProgress | null | undefined> {
  try {
    const s = await v2Api.getReadingState(bookId, signal)
    if (!s) {
      states.delete(bookId)
      return null
    }
    remember(s)
    return await toProgress(s)
  } catch (e) {
    return e instanceof ApiError && e.status === 404 ? null : undefined
  }
}

export interface ProgressWrite {
  chapterSlug: string | null
  locator?: string
  percent?: number
  updatedAt?: string
  positionJson?: string
}

/** The PUT body for a write, synchronously (the keepalive flush); null when the book is not known yet. */
export function v2ProgressBody(bookId: string, data: ProgressWrite): V2ReadingStateWrite | null {
  const known = states.get(bookId)
  const fileId = known?.fileId ?? books.get(bookId)?.currentFile?.id
  const currentLocator = v2PositionLocator(data)
  if (!fileId || !currentLocator) return null
  return {
    expectedRevision: known?.revision ?? null,
    fileId,
    currentLocator,
    bookFraction: Math.min(1, Math.max(0, data.percent ?? 0)),
    // The client's clock as the write was made; it is already this device's now, so within MAX_CLIENT_SKEW_MS of it.
    clientRecordedAt: data.updatedAt ?? new Date().toISOString(),
  }
}

/** What the reader does after a V2 write: adopt the server's place, or reload a replaced book. */
export interface V2WriteOutcome {
  adopted?: UserBookProgress
  reload?: boolean
}

/**
 * One reading-state write under the revision rule. Lost (409): `stale_revision` adopts the server's
 * row (a lost write takes the server's place); `reset` writes this place again on the new revision;
 * `file_replaced` asks for a reload; `unknown_file` forgets the book (the next write refetches it);
 * `chapter_not_found` drops the write (the file's chapters changed). Anything else throws: the
 * caller keeps the write for its next save.
 */
export async function saveV2Progress(bookId: string, data: ProgressWrite): Promise<V2WriteOutcome> {
  if (!states.has(bookId) && !books.has(bookId)) await v2Book(bookId)
  const body = v2ProgressBody(bookId, data)
  if (!body) return {}
  try {
    remember(await v2Api.putReadingState(bookId, body))
    return {}
  } catch (e) {
    const err = v2Api.v2ErrorOf(e)
    const current = err?.current as V2ReadingState | null | undefined
    switch (err?.code) {
      case 'stale_revision':
        if (!current) {
          states.delete(bookId)
          return {}
        }
        remember(current)
        return { adopted: await toProgress(current) }
      case 'reset':
        if (current) remember(current)
        remember(await v2Api.putReadingState(bookId, { ...body, expectedRevision: current?.revision ?? null }))
        return {}
      case 'file_replaced':
        forgetV2Book(bookId)
        return { reload: true }
      case 'unknown_file':
        forgetV2Book(bookId)
        return {}
      case 'chapter_not_found':
        return {}
      default:
        throw e
    }
  }
}

/** After a keepalive write landed: its answer is the new revision. */
export const rememberV2State = (s: V2ReadingState) => remember(s)

export const v2StateUrl = (bookId: string) => `${API_BASE}/me/v2/books/${bookId}/reading-state`

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
 * send the parts, complete. The same bytes already in the library open that book (`existing`).
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
  const opened = (id: string, b?: V2Book) =>
    ({ userBookId: id, jobId: '', status: 'existing', existing: true, hasOriginalPdf: b ? isPdf(b) : false })
  const sha256 = await sha256Hex(file)
  const existing = await v2Api.findBySha256(sha256)
  if (existing) return opened(existing.id, existing)

  const bookId = crypto.randomUUID()
  const fileId = crypto.randomUUID()
  const title = clip(file.name.replace(/\.(epub|pdf)$/i, '').trim() || file.name, 500)
  try {
    await v2Api.importBook(bookId, { title, file: { id: fileId, sha256, byteSize: file.size, originalName: clip(file.name, 500), format } })
  } catch (e) {
    const err = v2Api.v2ErrorOf(e)
    if (err?.code === 'duplicate_file') return opened((err.current as V2Book).id, err.current as V2Book)
    throw e
  }

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
  return { userBookId: bookId, jobId: '', status: 'Processing', hasOriginalPdf: format === 'pdf' }
}
