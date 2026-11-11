/**
 * The mobile app on V2 (`Features:V2Api`, #1025 M2.7): the probe, and the V2 side of the user-book
 * API — library, upload, the transitional chapter reader, reading state — mapped onto the shared
 * legacy shapes, so `userBooksApi` (./userBooksApi) switches per call and no screen changes. The
 * twin of apps/web/src/api/v2.ts; wire calls are `v2Api`, the place and anchor mappings are
 * `@textstack/shared` reader/v2Locators, the book client and the upload sequence are shared too
 * (`createV2Books`, `uploadV2File`, #1121): this file keeps the probe, the DTOs and the device IO.
 */
import { uuid } from 'expo-modules-core'
import NetInfo from '@react-native-community/netinfo'
import {
  v2Api, ApiError, isOfflineError, V2_OFF, placeToV2Locator, createSha256, parsePdfPageLocator,
  ingestionStatus, shelfFileSummary, resumeChapterOf, createV2Books, uploadV2File, V2UploadError,
  type V2Book, type V2FileChapters, type V2Annotation, type V2Word, type V2Chapter, type V2ReadingState, type V2ReadingStateWrite, type V2Switch,
  type UserBookProgressDto, type ProgressWrite, type UserBookDto, type UserBookChapterDto, type UserBookDetailResponse, type V2ClientFormat,
} from '@textstack/shared'

export { V2UploadError }
export type { ProgressWrite }
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
  /** The vocabulary cards last read or written, by id (the shared V2 vocabulary's). */
  cards: new Map<string, V2Word>(),
  reset() {
    for (const cache of [this.books, this.chapters, this.states, this.annotations, this.pulled, this.cards]) cache.clear()
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
/** For the shared V2 vocabulary: it drops a card answered after a reset (#1151). */
export const v2Epoch = () => epoch

/**
 * The shared V2 book client (`@textstack/shared` v2Books) on this app's store; `whileCurrent` is its
 * epoch guard (#1151). A reading state is kept in the store and, its revision, beside the local
 * progress (survives a restart); concurrent library pulls share one pull AND its cleanup (#1140).
 */
const v2 = createV2Books({
  books,
  chapters,
  epoch: v2Epoch,
  keepState: (s) => {
    v2Store.states.set(s.bookId, s)
    // ponytail: started in the checked tick, but the setItem itself can still land after the sign-out
    // wipe (clearAllLocalProgress is fire-and-forget); serialize V2 state writes with the wipe if that shows.
    return setUserBookV2State(s.bookId, { revision: s.revision, fileId: s.fileId, bookFraction: s.bookFraction })
  },
  forgetState: (id) => {
    v2Store.states.delete(id)
    return setUserBookV2State(id, null)
  },
  progressBody,
  pullFlight: (pull) => pullFlight.run(pull),
  afterPull: dropReplaced,
  // A lost write takes the server's place: it becomes this device's record, so the next open resumes there.
  keepAdopted: (s, p) => {
    const page = parsePdfPageLocator(p.locator)
    const at = Math.min(Date.parse(s.clientRecordedAt) || Date.now(), Date.now())
    return saveUserBookLocalProgress(s.bookId, {
      bookPercent: s.bookFraction,
      updatedAt: at,
      synced: true,
      chapterSlug: p.chapterSlug,
      positionJson: p.positionJson ?? undefined,
      ...(page != null && { page }),
    })
  },
})
export const {
  resetSince, whileCurrent, pullV2Books, v2Book, v2Chapters, removeV2Book, v2FileUrl, saveV2Progress, completeV2Book, uncompleteV2Book,
} = v2
const { rememberState: remember, toProgress } = v2

/**
 * A write's body from the stored revision (no network when one is stored: the reading path). A state
 * on a superseded file is not written on: the write is a first write on the current one (as web).
 */
async function progressBody(bookId: string, data: ProgressWrite): Promise<V2ReadingStateWrite | null> {
  const stored = await getUserBookV2State(bookId)
  const current = books.get(bookId)?.currentFile?.id ?? (stored ? undefined : (await v2Book(bookId)).currentFile?.id)
  const onStored = !!stored && (!current || stored.fileId === current)
  const known = onStored ? stored! : { revision: null, fileId: current, bookFraction: undefined }
  const currentLocator = placeToV2Locator(data)
  if (!known.fileId || !currentLocator) return null
  const now = Date.now()
  return {
    expectedRevision: known.revision,
    fileId: known.fileId,
    currentLocator,
    // No percent yet (the chapter list has not loaded): the fraction last read, never 0 over it.
    bookFraction: Math.min(1, Math.max(0, data.percent ?? known.bookFraction ?? 0)),
    // The device's stamp of the write, never later than now (MAX_CLIENT_SKEW_MS is the server's bound).
    clientRecordedAt: new Date(Math.min(Date.parse(data.updatedAt ?? '') || now, now)).toISOString(),
  }
}

const isPdf = (b: V2Book) => b.currentFile?.format === 'pdf' && b.currentFile.hasContent

const totalWords = (toc: V2FileChapters) =>
  toc.items.some((c) => c.wordCount != null) ? toc.items.reduce((s, c) => s + (c.wordCount ?? 0), 0) : null

/**
 * The uploads list: live books only, each with its status and the reader's place — two feed pulls,
 * no per-book call: the feed's file carries the extraction summary (#1118); `/chapters` is the reader's.
 * ponytail: no cover on V2 (the cover route needs a Bearer an <Image> does not send; no cover upload either).
 */
export async function getV2UserBooks(): Promise<UserBookDto[]> {
  const pulled = await whileCurrent(Promise.all([pullV2Books(), v2Api.pullFeed<V2ReadingState>('reading')]), ([, reading]) => {
    for (const s of reading.items) v2Store.states.set(s.bookId, s)
  })
  // A pull a store reset dropped is no answer, not an empty library: the orphan sweep deletes every
  // download missing from a listing (#1191). Retryable 503, the same rule as `v2Book` (#1174).
  if (!pulled) throw new ApiError(503, 'Library pull interrupted, retry')
  const [list] = pulled
  const stateOf = v2Store.states
  return list.filter((b) => !b.removedAt).map((b): UserBookDto => {
    const file = b.currentFile
    const state = stateOf.get(b.id)
    return {
      id: b.id,
      title: b.title,
      author: b.author,
      language: b.language ?? 'en',
      coverPath: null,
      genre: b.genre,
      ...shelfFileSummary(file),
      createdAt: b.createdAt,
      completedAt: state?.completedAt ?? null,
      errorMessage: null,
      progressPercent: state ? state.bookFraction : null,
      progressUpdatedAt: state?.updatedAt ?? null,
      progressChapterSlug: state ? resumeChapterOf(state, file ? chapters.get(file.id)?.items : undefined) : null,
      progressLocator: state?.currentLocator.scheme === 'pdf-page' ? `page:${(state.currentLocator.value as { page: number }).page}` : null,
      progressClientUpdatedAt: state?.clientRecordedAt ?? null,
      hasOriginalPdf: isPdf(b),
    }
  })
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
    status: ingestionStatus(toc.ingestion),
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

// ---- Reading state ------------------------------------------------------------------------------

const NO_PROGRESS: UserBookProgressDto = { chapterSlug: null, locator: null, percent: null, updatedAt: null, positionJson: null, clientUpdatedAt: null }

/** The book's reading state from the server (null: none yet, or signed out meanwhile), remembered. */
const readState = (bookId: string) => remember(v2Api.getReadingState(bookId))

export async function readV2Progress(bookId: string): Promise<UserBookProgressDto> {
  const s = await readState(bookId)
  return s ? toProgress(s) : NO_PROGRESS
}

// ---- Upload -------------------------------------------------------------------------------------

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
 * An upload on V2: the shared sequence (`@textstack/shared` v2Upload) over the device's IO — the
 * streamed hash, a part read from the file at a time. `existing`: nothing was sent (the book had
 * these bytes). ponytail: progress moves per part.
 */
export async function uploadV2Book(
  file: { uri: string; name: string; format?: V2ClientFormat },
  maxPartBytes: number,
  io: UploadIo,
  onProgress?: (percent: number) => void,
  /**
   * A synced local book (R6 file sync): its bytes go to its current file only, never a new import.
   * Its retained copy is named by its sha256, so the hash is not recomputed (the server's sha256
   * check on complete is the backstop).
   */
  target?: { bookId: string; fileId: string; sha256: string },
): Promise<{ bookId: string; existing: boolean }> {
  const source = io.open(file.uri)
  try {
    // RN fetch sends a typed-array body as base64 over the bridge: an 80 MB part would peak near
    // 200 MB of JS memory on Hermes, so a part is at most 8 MB whatever the server takes.
    const { bookId, sent } = await uploadV2File({ name: file.name, size: source.size, format: file.format }, Math.min(Math.max(1, maxPartBytes), MAX_DEVICE_PART_BYTES), {
      known: target && { bookId: target.bookId, fileId: target.fileId },
      newId: () => uuid.v4(),
      hash: () => (target ? Promise.resolve(target.sha256) : sha256Of(source, io.yieldNow)),
      sendPart: async ({ bookId, fileId, index, partCount, start, end }) => {
        await io.sendPart(bookId, fileId, index, source.read(start, end - start))
        onProgress?.(((index + 1) / partCount) * 100)
      },
      // A cancel while the last part was in flight: never complete it (the cancel point throws `aborted`).
      beforeComplete: io.yieldNow,
    })
    return { bookId, existing: !sent }
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
