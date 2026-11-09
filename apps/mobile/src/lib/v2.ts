/**
 * The mobile app on V2 (`Features:V2Api`, #1025 M2.7): the probe, and the V2 side of the user-book
 * API — library, upload, the transitional chapter reader, reading state — mapped onto the shared
 * legacy shapes, so `userBooksApi` (./userBooksApi) switches per call and no screen changes. The
 * twin of apps/web/src/api/v2.ts; wire calls are `v2Api`, the place and anchor mappings are
 * `@textstack/shared` reader/v2Locators.
 */
import { uuid } from 'expo-modules-core'
import NetInfo from '@react-native-community/netinfo'
import {
  v2Api, ApiError, isOfflineError, V2_OFF, clip, chapterAtFraction, placeToV2Locator, v2LocatorToPlace, createSha256, parsePdfPageLocator,
  type V2Book, type V2FileChapters, type V2Annotation, type V2Chapter, type V2ReadingState, type V2ReadingStateWrite, type V2Switch,
  type V2WriteOutcome, type UserBookProgressDto, type LegacyPlace, type UserBookDto, type UserBookChapterDto, type UserBookDetailResponse,
} from '@textstack/shared'
import { dropReplacedUserBookFiles } from './offlineDb'
import { createSingleFlight } from './singleFlight'
import { deleteOriginal } from './originalFileCache'
import { getUserBookV2State, setUserBookV2State, saveUserBookLocalProgress } from './progressStorage'

// ---- The switch ---------------------------------------------------------------------------------

let probe: Promise<V2Switch> | null = null
let known: V2Switch = V2_OFF
/** The last probe never reached the server: off until the network is back, then asked again. */
let unreached = false

/**
 * `GET /me/v2/status`, once per app start with a session: 200 on, 404 (unmapped) off for this start
 * (sync stays legacy). A 401 (no session yet) is asked again by the next call; a network failure —
 * the usual mobile cold start — or a 503 is off until `reprobeV2AfterReconnect`. Started by the
 * session (AuthContext) and by the first call that needs the answer, whichever comes first.
 */
export function startV2Probe(): Promise<V2Switch> {
  if (probe) return probe
  const seen = onlineEvents
  probe = v2Api.getStatus().then(
    (s) => (known = { enabled: true, maxPartBytes: s.maxPartBytes }),
    (e) => {
      if (e instanceof ApiError && e.status === 401) probe = null
      // Never reached, or V2 paused (503 `v2_unavailable`): asked again after a reconnect. 404 = unmapped, off.
      else if ((unreached = isOfflineError(e) || (e instanceof ApiError && e.status === 503))) {
        watchReconnect()
        // The network came back while this one was in flight: that reconnect is spent, so ask again now.
        if (onlineEvents !== seen) forgetUnreached()
      }
      return V2_OFF
    },
  )
  return probe
}

/** An unreached probe is stale: the next call asks again. */
function forgetUnreached() {
  if (!unreached) return
  unreached = false
  probe = null
}

/** The NetInfo subscription, once one probe went unreached (kept for the app's life). */
let unwatch: (() => void) | null = null
/** Online events seen: a probe in flight across one is not left stale when it then fails. */
let onlineEvents = 0

/**
 * The network coming back marks an unreached probe stale here, inside the NetInfo event (#1141).
 * Screens learn of a reconnect from a React effect, which runs after this and — children first —
 * before AuthContext's `reprobeV2AfterReconnect`: without this their calls still read the offline
 * answer and went legacy. Offline nothing changes: no event, no network wait on the reading path.
 */
function watchReconnect() {
  if (unwatch) return
  unwatch = NetInfo.addEventListener((s) => {
    if (!(s.isInternetReachable ?? s.isConnected)) return
    onlineEvents++
    forgetUnreached()
  })
}

/** The network is back (AuthContext's reconnect count): a probe that never reached the server asks again. */
export function reprobeV2AfterReconnect(): Promise<V2Switch> {
  forgetUnreached()
  return startV2Probe()
}

/** The probe's answer once it has settled (off before): for the synchronous paths. */
export const v2Enabled = () => known.enabled

/** Every call site checks one thing: `if (await onV2()) …`. */
export const onV2 = async () => (await startV2Probe()).enabled

/** A call that is `legacy` with V2 off and `v2` with it on, decided per call (after the probe answers); it takes legacy's arguments. */
export const switched = <A extends unknown[], V, L>(v2: (...args: NoInfer<A>) => Promise<V> | V, legacy: (...args: A) => Promise<L> | L) =>
  async (...args: A): Promise<V | L> => ((await onV2()) ? v2(...args) : legacy(...args))

/**
 * Everything this app caches from V2, per signed-in account: `reset()` on sign-out and on an
 * account change, so the next account never reads the previous one's books. ponytail: memory only,
 * a full pull per library load; R6 is the local library.
 */
export const v2Store = {
  /** The last library pull, by book id: a book's current file. */
  books: new Map<string, V2Book>(),
  /** A file's chapters, once its extraction succeeded (they never change after). */
  chapters: new Map<string, V2FileChapters>(),
  /** Per book: the reading state as last pulled, read or written. */
  states: new Map<string, V2ReadingState>(),
  /** Upload highlights as last pulled or written, by id, and the books pulled since they were opened. */
  annotations: new Map<string, V2Annotation>(),
  pulled: new Set<string>(),
  /** Per word: the card revision last read (the shared V2 vocabulary). */
  revisions: new Map<string, number>(),
  reset() {
    for (const cache of [this.books, this.chapters, this.states, this.annotations, this.pulled, this.revisions]) cache.clear()
    v2Api.forgetPulls()
    pullFlight = createSingleFlight()
    epoch++
  },
}

/** Tests only: forget the probe and the cache. */
export function resetV2ForTests() {
  probe = null
  known = V2_OFF
  unreached = false
  unwatch?.()
  unwatch = null
  v2Store.reset()
}

// ---- Library ------------------------------------------------------------------------------------

const { books, chapters } = v2Store

/** Books whose file changed since this device cached them: drop the old files' chapters and originals. */
async function dropReplaced(list: V2Book[]): Promise<void> {
  const current = list.flatMap((b) => (b.currentFile ? [{ bookId: b.id, fileId: b.currentFile.id }] : []))
  try {
    for (const id of await dropReplacedUserBookFiles(current)) await deleteOriginal(id, 'pdf')
  } catch (e) {
    console.warn('[v2] could not drop a replaced file:', e)
  }
}

/** Recreated by `v2Store.reset()`: the next account never joins the previous one's pull. */
let pullFlight = createSingleFlight<V2Book[]>()
/** Bumped by `v2Store.reset()`. */
let epoch = 0

/**
 * `work`'s answer, or null when the store was reset while it ran (signed out, another account): the
 * caller then writes, maps, fetches and shows nothing of the previous account's under the next one.
 */
async function whileCurrent<T>(work: Promise<T>): Promise<T | null> {
  const started = epoch
  const value = await work
  return started === epoch ? value : null
}

/**
 * The library feed, whole. Concurrent callers share one pull AND its cleanup (#1140): one
 * `dropReplaced` per pull, never two transactions racing on the connection.
 */
export function pullV2Books(): Promise<V2Book[]> {
  return pullFlight.run(async () => {
    const feed = await whileCurrent(v2Api.pullFeed<V2Book>('library'))
    if (!feed) return []
    const { items } = feed
    books.clear()
    for (const b of items) books.set(b.id, b)
    await dropReplaced(items)
    return items
  })
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
  v2Store.states.delete(id)
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
  const pulled = await whileCurrent(Promise.all([pullV2Books(), v2Api.pullFeed<V2ReadingState>('reading')]))
  if (!pulled) return []
  const [list, reading] = pulled
  for (const s of reading.items) v2Store.states.set(s.bookId, s)
  const stateOf = v2Store.states
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
    // From the reading pull (the library) or the reader's read; fetched only on a miss (#1118 puts it on the book).
    completedAt: (v2Store.states.get(id) ?? await readState(id))?.completedAt ?? null,
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

const NO_PROGRESS: UserBookProgressDto = { chapterSlug: null, locator: null, percent: null, updatedAt: null, positionJson: null, clientUpdatedAt: null }

/** A state read or written: the session's store, and its revision beside the local progress (survives a restart). */
const remember = (s: V2ReadingState) => {
  v2Store.states.set(s.bookId, s)
  return setUserBookV2State(s.bookId, { revision: s.revision, fileId: s.fileId, bookFraction: s.bookFraction })
}

/** The book's reading state from the server (null: none yet), remembered. */
async function readState(bookId: string): Promise<V2ReadingState | null> {
  const s = await v2Api.getReadingState(bookId)
  if (s) await remember(s)
  return s
}

/** The chapter a stored state resumes in: its own, none for a PDF page, by fraction for an `epub-cfi` (never converted). */
const resumeChapter = (s: V2ReadingState, toc: V2FileChapters) =>
  v2LocatorToPlace(s.currentLocator)?.chapterSlug ?? (s.currentLocator.scheme === 'pdf-page' ? null : chapterAtFraction(toc.items, s.bookFraction))

/** A V2 state as the legacy progress row. An `epub-cfi` (the V2 reader's) resumes by fraction. */
async function toProgress(s: V2ReadingState): Promise<UserBookProgressDto> {
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

export async function readV2Progress(bookId: string): Promise<UserBookProgressDto> {
  const s = await readState(bookId)
  return s ? toProgress(s) : NO_PROGRESS
}

/** A lost write takes the server's place: it becomes this device's record, so the next open resumes there. */
async function adopt(s: V2ReadingState): Promise<UserBookProgressDto> {
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
 * One reading-state write under the revision rule (PDD "The revision rule"), answered as a
 * `V2WriteOutcome`. Lost (409): `stale_revision` adopts the server's row (it becomes this device's
 * record); `reset` writes this place again on the new revision; `file_replaced` forgets the book
 * and asks the reader to reload; `unknown_file` refetches the book and writes once more;
 * `chapter_not_found` drops the write (the file's chapters changed — the place resumes from
 * `bookFraction`). Anything else throws: the local record stays unsynced.
 * ponytail: a `chapter_not_found` while the file is still extracting is dropped too, not queued (R6).
 */
export async function saveV2Progress(bookId: string, data: ProgressWrite, retried = false): Promise<V2WriteOutcome> {
  const stored = await getUserBookV2State(bookId)
  const current = books.get(bookId)?.currentFile?.id ?? (stored ? undefined : (await v2Book(bookId)).currentFile?.id)
  // A state on a superseded file is not written on: the write is a first write on the current one (as web).
  const onStored = !!stored && (!current || stored.fileId === current)
  const known = onStored ? stored! : { revision: null, fileId: current, bookFraction: undefined }
  const currentLocator = placeToV2Locator(data)
  if (!known.fileId || !currentLocator) return 'dropped'
  const now = Date.now()
  const body: V2ReadingStateWrite = {
    expectedRevision: known.revision,
    fileId: known.fileId,
    currentLocator,
    // No percent yet (the chapter list has not loaded): the fraction last read, never 0 over it.
    bookFraction: Math.min(1, Math.max(0, data.percent ?? known.bookFraction ?? 0)),
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
  /** Hands the JS thread back between chunks: hashing 80 MB in one go freezes the screen. Throws `aborted` once cancelled. */
  yieldNow(): Promise<void>
}

const HASH_CHUNK = 1024 * 1024
export const MAX_DEVICE_PART_BYTES = 8 * 1024 * 1024

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
  // The book this upload made (not found, not another device's). Cancelled at any cancel point before
  // its content completed, it would sit on the shelf as Failed with no action on V2 (no retry), so it
  // goes; picking the file again starts afresh.
  let imported: string | null = null
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
        imported = target.id
      } catch (e) {
        const err = v2Api.v2ErrorOf(e)
        if (err?.code !== 'duplicate_file') throw e
        // The book that has these bytes: the 409's `current`, or looked up again when it carries none.
        target = (err.current as V2Book | undefined) ?? await v2Api.findBySha256(sha256)
        if (!target) throw e
      }
    }
    if (!target.currentFile || target.currentFile.hasContent) return { bookId: target.id, existing: true }
    const bookId = target.id
    const fileId = target.currentFile.id

    // RN fetch sends a typed-array body as base64 over the bridge: an 80 MB part would peak near
    // 200 MB of JS memory on Hermes, so a part is at most 8 MB whatever the server takes.
    const partBytes = Math.min(Math.max(1, maxPartBytes), MAX_DEVICE_PART_BYTES)
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
        // A cancel while the last part was in flight: never complete it (the cancel point throws `aborted`).
        await io.yieldNow()
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
  } catch (e) {
    if ((e as { aborted?: boolean }).aborted && imported) await v2Api.removeBook(imported).catch(() => {})
    throw e
  } finally {
    source.close()
  }
}

/**
 * The device's bytes: the picker's copy read through expo-file-system's `FileHandle` (`offset` +
 * `readBytes`), each part a `Uint8Array` body through `fetch` (PDD "File sync upload protocol").
 * `isCancelled` stops before the next part, and before the next hash chunk.
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
      if (isCancelled()) throw cancelled()
      return v2Api.putPart(bookId, fileId, index, bytes)
    },
    // Also the hash loop's cancel point (#1143): Cancel stops within one chunk, not after the whole hash.
    yieldNow: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (isCancelled()) throw cancelled()
    },
  }
}

const cancelled = () => Object.assign(new Error('Upload cancelled'), { aborted: true })
