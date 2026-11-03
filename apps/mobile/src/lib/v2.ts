/**
 * The mobile app on V2 (`Features:V2Api`, #1025 M2.7): the probe, and the V2 side of the user-book
 * API — library, upload, the transitional chapter reader, reading state — mapped onto the shared
 * legacy shapes, so `userBooksApi` (./userBooksApi) switches per call and no screen changes. The
 * twin of apps/web/src/api/v2.ts; wire calls are `v2Api`, the place and anchor mappings are
 * `@textstack/shared` reader/v2Locators.
 */
import { uuid } from 'expo-modules-core'
import {
  v2Api, ApiError, V2_OFF, clip, chapterAtFraction, placeToV2Locator, v2LocatorToPlace, createSha256, parsePdfPageLocator,
  type V2Book, type V2FileChapters, type V2Chapter, type V2ReadingState, type V2ReadingStateWrite, type V2Switch,
  type LegacyPlace, type UserBookDto, type UserBookChapterDto, type UserBookDetailResponse,
} from '@textstack/shared'
import { dropReplacedUserBookFile } from './offlineDb'
import { deleteOriginal } from './originalFileCache'
import { getUserBookV2State, setUserBookV2State, saveUserBookLocalProgress } from './progressStorage'

// ---- The switch ---------------------------------------------------------------------------------

let probe: Promise<V2Switch> | null = null
let known: V2Switch = V2_OFF

/**
 * `GET /me/v2/status`, once per app start with a session: 200 on, 404 (unmapped) / 503 / offline
 * off for this start (sync stays legacy). A 401 (no session yet) is asked again by the next call.
 * Started by the session (AuthContext) and by the first call that needs the answer, whichever
 * comes first — a screen's effect can run before the provider's.
 */
export function startV2Probe(): Promise<V2Switch> {
  probe ??= v2Api.probeV2().then(
    (s) => (known = s),
    () => { probe = null; return V2_OFF },
  )
  return probe
}

/** The probe's answer once it has settled (off before): for the synchronous paths. */
export const v2Enabled = () => known.enabled

/** Every call site checks one thing: `if (await onV2()) …`. */
export const onV2 = async () => (await startV2Probe()).enabled

/** Sign-out or another account: what this app cached from V2 belongs to the previous session. */
export function forgetV2Session() {
  books.clear()
  chapters.clear()
}

/** Tests only: forget the probe. */
export function resetV2ForTests() {
  probe = null
  known = V2_OFF
  forgetV2Session()
}

// ---- Library ------------------------------------------------------------------------------------

// The last library pull, by book id: the reader, the upload and the reading state find a book's
// current file here. ponytail: a full pull per library load, no local store; R6 is the local library.
const books = new Map<string, V2Book>()
// A file's chapters, once its extraction succeeded (they never change after).
const chapters = new Map<string, V2FileChapters>()

/** A book whose file changed since this device cached it: drop the old file's chapters and original. */
async function dropReplaced(b: V2Book): Promise<void> {
  const fileId = b.currentFile?.id
  if (!fileId) return
  try {
    if (await dropReplacedUserBookFile(b.id, fileId)) await deleteOriginal(b.id, 'pdf')
  } catch (e) {
    console.warn('[v2] could not drop a replaced file:', e)
  }
}

let pulling: Promise<V2Book[]> | null = null

/** The library feed, whole; concurrent callers (the list, the sweep, the reader) share one pull. */
export function pullV2Books(): Promise<V2Book[]> {
  pulling ??= (async () => {
    const { items } = await v2Api.pullAll<V2Book>('library')
    books.clear()
    for (const b of items) books.set(b.id, b)
    await Promise.all(items.map(dropReplaced))
    return items
  })().finally(() => { pulling = null })
  return pulling
}

/** A live book of the user's, from the last pull or a fresh one; 404 when there is none. */
export async function v2Book(id: string): Promise<V2Book> {
  const b = books.get(id) ?? (await pullV2Books(), books.get(id))
  if (!b || b.removedAt) throw new ApiError(404, 'Book not found')
  return b
}

/** The current file's table of contents and extraction status (empty when it has no bytes). */
export async function v2Chapters(b: V2Book): Promise<V2FileChapters> {
  const file = b.currentFile
  if (!file) return { items: [], ingestion: null }
  const cached = chapters.get(file.id)
  if (cached) return cached
  const toc = await v2Api.getChapters(b.id, file.id)
  if (toc.ingestion === 'succeeded') chapters.set(file.id, toc)
  return toc
}

/** Forget what was known of a book: its file changed (`file_replaced` / `unknown_file`). */
async function forgetV2Book(id: string) {
  const file = books.get(id)?.currentFile
  if (file) chapters.delete(file.id)
  books.delete(id)
  await setUserBookV2State(id, null)
}

function status(toc: V2FileChapters): string {
  if (toc.ingestion === 'queued' || toc.ingestion === 'processing') return 'Processing'
  return toc.ingestion === 'succeeded' ? 'Ready' : 'Failed'
}

const isPdf = (b: V2Book) => b.currentFile?.format === 'pdf' && b.currentFile.hasContent

const totalWords = (toc: V2FileChapters) =>
  toc.items.some((c) => c.wordCount != null) ? toc.items.reduce((s, c) => s + (c.wordCount ?? 0), 0) : null

/**
 * The uploads list: live books only, each with its status and the reader's place.
 * ponytail: no cover on V2 (the cover route needs a Bearer an <Image> does not send; no cover upload
 * either); one chapters call per book per load, for status and counts.
 */
export async function getV2UserBooks(): Promise<UserBookDto[]> {
  const [list, reading] = await Promise.all([pullV2Books(), v2Api.pullAll<V2ReadingState>('reading')])
  const stateOf = new Map(reading.items.map((s) => [s.bookId, s]))
  return Promise.all(list.filter((b) => !b.removedAt).map(async (b): Promise<UserBookDto> => {
    // One failing call (content removed, a 503) costs that book its status, never the shelf.
    const toc = await v2Chapters(b).catch((): V2FileChapters => ({ items: [], ingestion: null }))
    const state = stateOf.get(b.id)
    return {
      id: b.id,
      title: b.title,
      author: b.author,
      language: b.language ?? 'en',
      coverPath: null,
      genre: b.genre,
      totalWordCount: totalWords(toc),
      status: status(toc),
      chapterCount: toc.items.length,
      createdAt: b.createdAt,
      completedAt: state?.completedAt ?? null,
      errorMessage: null,
      progressPercent: state ? state.bookFraction : null,
      progressUpdatedAt: state?.updatedAt ?? null,
      progressChapterSlug: state ? resumeChapter(state, toc) : null,
      progressLocator: state?.currentLocator.scheme === 'pdf-page' ? `page:${(state.currentLocator.value as { page: number }).page}` : null,
      progressClientUpdatedAt: state?.clientRecordedAt ?? null,
      hasOriginalPdf: isPdf(b),
    }
  }))
}

/** The book page and the reader's book: the chapter list is the current file's. */
export async function getV2UserBook(id: string): Promise<UserBookDetailResponse> {
  const b = await v2Book(id)
  await dropReplaced(b)
  const toc = await v2Chapters(b)
  return {
    id: b.id,
    title: b.title,
    slug: '',
    language: b.language ?? 'en',
    author: b.author,
    description: b.description,
    coverPath: null,
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
    originalFileBytes: isPdf(b) ? b.currentFile!.byteSize : null,
    pageCount: b.currentFile?.pageCount ?? null,
    fileId: b.currentFile?.id ?? null,
  }
}

const nav = (h: V2Chapter['previous']) => h && { slug: h.chapterKey, title: h.title }

export async function getV2UserBookChapter(bookId: string, chapterKey: string): Promise<UserBookChapterDto> {
  const b = await v2Book(bookId)
  if (!b.currentFile) throw new ApiError(404, 'Chapter not found')
  const ch = await v2Api.getChapter(bookId, b.currentFile.id, chapterKey)
  return {
    id: ch.chapterKey, slug: ch.chapterKey, title: ch.title, html: ch.html, wordCount: ch.wordCount,
    prev: nav(ch.previous), next: nav(ch.next), fileId: b.currentFile.id,
  }
}

export async function removeV2Book(id: string): Promise<void> {
  await v2Api.removeBook(id)
  await forgetV2Book(id)
}

/** The original PDF, Range-capable; '' until the book is known (the reader loads it first). */
export function v2FileUrl(id: string): string {
  const file = books.get(id)?.currentFile
  return file ? v2Api.contentUrl(id, file.id) : ''
}

// ---- Reading state ------------------------------------------------------------------------------

/** The legacy progress row the reader restores from (`getUserBookProgress`'s shape). */
export interface V2Progress {
  chapterSlug: string | null
  locator: string | null
  percent: number | null
  updatedAt: string | null
  positionJson?: string | null
  clientUpdatedAt?: string | null
}

const NO_PROGRESS: V2Progress = { chapterSlug: null, locator: null, percent: null, updatedAt: null, positionJson: null, clientUpdatedAt: null }

const remember = (s: V2ReadingState) => setUserBookV2State(s.bookId, { revision: s.revision, fileId: s.fileId })

/** The chapter a stored state resumes in: its own, none for a PDF page, by fraction for an `epub-cfi` (never converted). */
const resumeChapter = (s: V2ReadingState, toc: V2FileChapters) =>
  v2LocatorToPlace(s.currentLocator)?.chapterSlug ?? (s.currentLocator.scheme === 'pdf-page' ? null : chapterAtFraction(toc.items, s.bookFraction))

/** A V2 state as the legacy progress row. An `epub-cfi` (the V2 reader's) resumes by fraction. */
async function toProgress(s: V2ReadingState): Promise<V2Progress> {
  const place = v2LocatorToPlace(s.currentLocator)
  const toc = place ? { items: [], ingestion: null } : await v2Chapters(await v2Book(s.bookId))
  return {
    chapterSlug: resumeChapter(s, toc),
    locator: place?.locator ?? null,
    percent: s.bookFraction,
    updatedAt: s.updatedAt,
    positionJson: place?.positionJson ?? null,
    clientUpdatedAt: s.clientRecordedAt,
  }
}

export async function readV2Progress(bookId: string): Promise<V2Progress> {
  const s = await v2Api.getReadingState(bookId)
  if (!s) return NO_PROGRESS
  await remember(s)
  return toProgress(s)
}

/** A lost write takes the server's place: it becomes this device's record, so the next open resumes there. */
async function adopt(s: V2ReadingState): Promise<V2Progress> {
  await remember(s)
  const p = await toProgress(s)
  const page = parsePdfPageLocator(p.locator)
  const at = Math.min(Date.parse(s.clientRecordedAt) || Date.now(), Date.now())
  await saveUserBookLocalProgress(s.bookId, {
    bookPercent: s.bookFraction,
    updatedAt: at,
    synced: true,
    chapterSlug: p.chapterSlug,
    positionJson: p.positionJson ?? undefined,
    ...(page != null && { page }),
  })
  return p
}

/** Mark read on V2: the state as it stands (or the book's start), with `completedAt` — web's rule. */
export async function completeV2Book(bookId: string): Promise<void> {
  const b = await v2Book(bookId)
  const state = await v2Api.getReadingState(bookId)
  const first = (await v2Chapters(b)).items[0]?.chapterKey
  const sameFile = state && state.fileId === b.currentFile?.id
  const currentLocator = sameFile ? state.currentLocator : placeToV2Locator({ chapterSlug: first ?? null })
  if (!b.currentFile || !currentLocator) throw new ApiError(409, 'Nothing to mark read yet')
  const now = new Date().toISOString()
  await remember(await v2Api.putReadingState(bookId, {
    expectedRevision: sameFile ? state.revision : null,
    fileId: b.currentFile.id,
    currentLocator,
    bookFraction: sameFile ? state.bookFraction : 0,
    completedAt: now,
    clientRecordedAt: now,
  }))
}

/** Mark unread on V2: a reset clears completion and the frontier; the place stays. */
export async function uncompleteV2Book(bookId: string): Promise<void> {
  const state = await v2Api.getReadingState(bookId)
  if (state) await remember(await v2Api.resetReadingState(bookId, state.revision))
}

export interface ProgressWrite extends LegacyPlace {
  percent?: number
  updatedAt?: string
}

/**
 * One reading-state write under the revision rule (PDD "The revision rule"). Lost (409):
 * `stale_revision` adopts the server's row; `reset` writes this place again on the new revision;
 * `file_replaced` forgets the book and asks the reader to reload; `unknown_file` refetches the
 * book and writes once more; `chapter_not_found` drops the write (the file's chapters changed — the
 * place resumes from `bookFraction`). Anything else throws: the local record stays unsynced.
 * ponytail: a `chapter_not_found` while the file is still extracting is dropped too, not queued (R6).
 */
/**
 * After a write, as web's: `accepted` the server holds it (mark it synced); `adopted` the server's
 * place is now this device's record; `reload` the book's file was replaced; `dropped` neither —
 * the local record stays unsynced.
 */
export type V2WriteOutcome = 'accepted' | 'dropped' | 'reload' | { adopted: V2Progress }

export async function saveV2Progress(bookId: string, data: ProgressWrite, retried = false): Promise<V2WriteOutcome> {
  const known = (await getUserBookV2State(bookId)) ?? { revision: null, fileId: (await v2Book(bookId)).currentFile?.id }
  const currentLocator = placeToV2Locator(data)
  if (!known.fileId || !currentLocator) return 'dropped'
  const now = Date.now()
  const body: V2ReadingStateWrite = {
    expectedRevision: known.revision,
    fileId: known.fileId,
    currentLocator,
    bookFraction: Math.min(1, Math.max(0, data.percent ?? 0)),
    // The device's stamp of the write, never later than now (MAX_CLIENT_SKEW_MS is the server's bound).
    clientRecordedAt: new Date(Math.min(Date.parse(data.updatedAt ?? '') || now, now)).toISOString(),
  }
  try {
    await remember(await v2Api.putReadingState(bookId, body))
    return 'accepted'
  } catch (e) {
    const err = v2Api.v2ErrorOf(e)
    const current = err?.current as V2ReadingState | null | undefined
    switch (err?.code) {
      case 'stale_revision':
        if (!current) {
          await setUserBookV2State(bookId, null)
          return 'dropped'
        }
        return { adopted: await adopt(current) }
      case 'reset':
        await remember(await v2Api.putReadingState(bookId, { ...body, expectedRevision: current?.revision ?? null }))
        return 'accepted'
      case 'file_replaced':
        await forgetV2Book(bookId)
        return 'reload'
      case 'unknown_file':
        // The file we named is not the book's: fetch the book again and write once more.
        await forgetV2Book(bookId)
        return retried ? 'dropped' : saveV2Progress(bookId, data, true)
      case 'chapter_not_found': {
        // The file's chapter keys changed: its TOC is fetched again.
        const file = books.get(bookId)?.currentFile
        if (file) chapters.delete(file.id)
        return 'dropped'
      }
      default:
        throw e
    }
  }
}

// ---- Upload -------------------------------------------------------------------------------------

/** A V2 upload the reader must hear about. */
export class V2UploadError extends Error {
  constructor(readonly code: 'content_mismatch' | 'quota_exceeded', readonly quota?: { used: number; limit: number }) {
    super(code === 'content_mismatch'
      ? 'The file changed while it was uploading. Pick it again.'
      : `Not enough storage: ${mb(quota?.used ?? 0)} of ${mb(quota?.limit ?? 0)} used.`)
  }
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`

/** The picked file's bytes, read a range at a time (expo-file-system `FileHandle` on the device). */
export interface ByteSource {
  size: number
  read(offset: number, length: number): Uint8Array
  close(): void
}

export interface UploadIo {
  open(uri: string): ByteSource
  /** One part's bytes to its route. */
  sendPart(bookId: string, fileId: string, index: number, bytes: Uint8Array): Promise<unknown>
  /** Hands the JS thread back between chunks: hashing 80 MB in one go freezes the screen. */
  yieldNow(): Promise<void>
}

const HASH_CHUNK = 1024 * 1024

/** Lowercase hex SHA-256 of the file, streamed a chunk at a time (never the whole file in memory). */
export async function sha256Of(source: ByteSource, yieldNow: () => Promise<void>): Promise<string> {
  const hash = createSha256()
  for (let at = 0; at < source.size; at += HASH_CHUNK) {
    hash.update(source.read(at, Math.min(HASH_CHUNK, source.size - at)))
    await yieldNow()
  }
  return hash.hex()
}

/**
 * An upload on V2 (PDD "File sync upload protocol"): hash, look the bytes up, import the metadata,
 * send the parts, complete — web's sequence. The same bytes already in the library open that book
 * (`existing`). `content_mismatch` re-hashes (same hash: send once more; changed: tell the reader);
 * `incomplete_upload` re-sends every part once; `quota_exceeded` carries `used/limit`.
 * ponytail: no cover, the title is the file name; progress moves per part.
 */
export async function uploadV2Book(
  file: { uri: string; name: string },
  maxPartBytes: number,
  io: UploadIo,
  onProgress?: (percent: number) => void,
): Promise<{ bookId: string; existing: boolean }> {
  const source = io.open(file.uri)
  try {
    const format = file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'epub'
    const sha256 = await sha256Of(source, io.yieldNow)
    // The same bytes already in the library open that book — or, when another device imported it
    // without its bytes, this upload sends them to that book's file.
    let target = await v2Api.findBySha256(sha256)
    if (!target) {
      const id = uuid.v4()
      const title = clip(file.name.replace(/\.(epub|pdf)$/i, '').trim() || file.name, 500)
      try {
        target = await v2Api.importBook(id, { title, file: { id: uuid.v4(), sha256, byteSize: source.size, originalName: clip(file.name, 500), format } })
      } catch (e) {
        const err = v2Api.v2ErrorOf(e)
        if (err?.code !== 'duplicate_file') throw e
        target = err.current as V2Book
      }
    }
    if (!target.currentFile || target.currentFile.hasContent) return { bookId: target.id, existing: true }
    const bookId = target.id
    const fileId = target.currentFile.id

    const partBytes = Math.max(1, maxPartBytes)
    const partCount = Math.max(1, Math.ceil(source.size / partBytes))
    const sendAll = async () => {
      for (let i = 0; i < partCount; i++) {
        const start = i * partBytes
        await io.sendPart(bookId, fileId, i, source.read(start, Math.min(partBytes, source.size - start)))
        onProgress?.(((i + 1) / partCount) * 100)
      }
    }
    const quota = (e: unknown) => {
      const err = v2Api.v2ErrorOf(e)
      return err?.code === 'quota_exceeded' ? new V2UploadError('quota_exceeded', err.current as { used: number; limit: number }) : e
    }
    // One second round: every part again after `incomplete_upload`, or after `content_mismatch`
    // when the file still hashes the same (the bytes broke in flight).
    for (let retried = false; ; retried = true) {
      try {
        await sendAll()
      } catch (e) {
        throw quota(e)
      }
      try {
        await v2Api.completeContent(bookId, fileId, partCount)
        return { bookId, existing: false }
      } catch (e) {
        const err = v2Api.v2ErrorOf(e)
        if (err?.code === 'quota_exceeded') throw quota(e)
        const again = !retried && (err?.code === 'incomplete_upload'
          || (err?.code === 'content_mismatch' && (await sha256Of(source, io.yieldNow)) === sha256))
        if (again) continue
        throw err?.code === 'content_mismatch' ? new V2UploadError('content_mismatch') : e
      }
    }
  } finally {
    source.close()
  }
}

/**
 * The device's bytes: the picker's copy read through expo-file-system's `FileHandle` (`offset` +
 * `readBytes`), each part a `Uint8Array` body through `fetch` (PDD "File sync upload protocol").
 * `isCancelled` stops before the next part.
 */
export function deviceUploadIo(isCancelled: () => boolean): UploadIo {
  return {
    open(uri) {
      const { File } = require('expo-file-system') as typeof import('expo-file-system')
      const file = new File(uri)
      const handle = file.open()
      return {
        size: file.size,
        read(offset, length) {
          handle.offset = offset
          return handle.readBytes(length)
        },
        close: () => handle.close(),
      }
    },
    async sendPart(bookId, fileId, index, bytes) {
      if (isCancelled()) throw Object.assign(new Error('Upload cancelled'), { aborted: true })
      return v2Api.putPart(bookId, fileId, index, bytes)
    },
    yieldNow: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }
}
