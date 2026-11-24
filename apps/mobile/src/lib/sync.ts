/**
 * The mobile app's user-book API on V2 (#1025 M2.7; the only store since M6): the status probe, and
 * library, upload, reading state mapped onto the shared shapes
 * (`userBooksApi`, ./userBooksApi). The twin of apps/web/src/api/v2.ts; wire calls are `syncApi`, the
 * place and anchor mappings are `@textstack/shared` reader/locators, the book client and the upload
 * sequence are shared too (`createBooks`, `uploadFile`, #1121): this file keeps the probe, the
 * DTOs and the device IO.
 */
import { uuid } from 'expo-modules-core'
import AsyncStorage from '@react-native-async-storage/async-storage'
import NetInfo from '@react-native-community/netinfo'
import {
  syncApi, ApiError, isOfflineError, SYNC_OFF, placeToLocator, createSha256, parsePdfPageLocator,
  shelfFileSummary, isShelfBook, resumeChapterOf, createBooks, uploadFile, FileUploadError,
  type Book, type FileChapters, type Annotation, type Word, type ReadingState, type ReadingStateWrite, type SyncSwitch,
  type UserBookProgressDto, type ProgressWrite, type UserBookDto, type UserBookDetailResponse, type ClientFormat, type FileDetails,
} from '@textstack/shared'

export { FileUploadError }
export type { ProgressWrite }
import { createSingleFlight } from './singleFlight'
import { getUserBookSyncState, setUserBookSyncState, saveUserBookLocalProgress } from './progressStorage'

// ---- The probe ----------------------------------------------------------------------------------

let probe: Promise<SyncSwitch> | null = null
/**
 * The server's last status answer for this account (M5 #1031): whether the V2 sync may run now (`syncOn`, the
 * library sync) and the part size an upload takes. Every client call is V2 since M6; this only says whether the
 * server answered for this session. An offline cold start or a 503 pause keeps the last stored answer; only the
 * server's 200/404 changes it; sign-out and an account change forget it (`forgetSyncAnswer`).
 */
let known: SyncSwitch = SYNC_OFF
/** Bumped by `forgetSyncAnswer`: a probe started before it answers for the previous account, and is dropped. */
let generation = 0
const setKnown = (s: SyncSwitch) => { known = s }
/** `known` is newer than the device's copy (the server answered, or the answer was forgotten): a late read keeps out. */
let settled = false
const LAST_ANSWER_KEY = 'v2.lastStatus'
const hydrate = () => AsyncStorage.getItem(LAST_ANSWER_KEY).then((v) => {
  const s = v ? (JSON.parse(v) as SyncSwitch) : null
  if (!settled && s && typeof s.enabled === 'boolean') setKnown({ enabled: s.enabled, maxPartBytes: Number(s.maxPartBytes) || 0 })
}, () => {})
// The stored answer into `known` (a local read, never the network).
void hydrate()
const answer = (s: SyncSwitch, gen: number) => {
  if (gen !== generation) return known // the previous account's probe
  settled = true
  setKnown(s)
  AsyncStorage.setItem(LAST_ANSWER_KEY, JSON.stringify(s)).catch(() => {})
  return s
}
/** Sign-out, an auth failure, another account signing in: the answer was the previous account's. Asked again next. */
export function forgetSyncAnswer() {
  generation++
  settled = true
  setKnown(SYNC_OFF)
  probe = null
  unreached = false
  AsyncStorage.removeItem(LAST_ANSWER_KEY).catch(() => {})
}
/** Tests only: a new app start reads the stored answer again. */
export const reloadLastSyncAnswerForTests = () => hydrate()
/** The last probe never reached the server: the last answer stands until the network is back, then asked again. */
let unreached = false

/**
 * `GET /me/v2/status`, once per app start with a session: 200 on, 404 off (a server without the route); both stored. A 401 (no
 * session yet) is asked again by the next call; a network failure — the usual mobile cold start — or a 503 keeps
 * the last answer until `reprobeSyncAfterReconnect`. Started by the session (AuthContext) and by the first call that
 * needs the answer, whichever comes first.
 */
export function startSyncProbe(): Promise<SyncSwitch> {
  if (probe) return probe
  const seen = onlineEvents
  const gen = generation
  probe = syncApi.getStatus().then(
    (s) => answer({ enabled: true, maxPartBytes: s.maxPartBytes }, gen),
    (e) => {
      if (gen !== generation) return known // the previous account's probe: nothing of it stays
      if (e instanceof ApiError && e.status === 404) return answer(SYNC_OFF, gen)
      if (e instanceof ApiError && e.status === 401) probe = null
      // Never reached, or V2 paused (503 `v2_unavailable`): asked again after a reconnect.
      else if ((unreached = isOfflineError(e) || (e instanceof ApiError && e.status === 503))) {
        watchReconnect()
        // The network came back while this one was in flight: that reconnect is spent, so ask again now.
        if (onlineEvents !== seen) forgetUnreached()
      }
      return known
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
 * before AuthContext's `reprobeSyncAfterReconnect`: without this their calls still read the offline
 * answer and skipped the sync. Offline nothing changes: no event, no network wait on the reading path.
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
export function reprobeSyncAfterReconnect(): Promise<SyncSwitch> {
  forgetUnreached()
  return startSyncProbe()
}

/** Whether the server answered the status probe for this session (the sync's gate): `if (await syncOn()) …`. */
export const syncOn = async () => (await startSyncProbe()).enabled

/**
 * Everything this app caches from V2, per signed-in account: `reset()` on sign-out and on an
 * account change, so the next account never reads the previous one's books. ponytail: memory only,
 * a full pull per library load; R6 is the local library.
 */
export const syncStore = {
  /** The last library pull, by book id: a book's current file. */
  books: new Map<string, Book>(),
  /** A file's chapters, once its extraction succeeded (they never change after). */
  chapters: new Map<string, FileChapters>(),
  /** Per book: the reading state as last pulled, read or written. */
  states: new Map<string, ReadingState>(),
  /** Upload highlights as last pulled or written, by id, and the books pulled since they were opened. */
  annotations: new Map<string, Annotation>(),
  pulled: new Set<string>(),
  /** The vocabulary cards last read or written, by id (the shared V2 vocabulary's). */
  cards: new Map<string, Word>(),
  reset() {
    for (const cache of [this.books, this.chapters, this.states, this.annotations, this.pulled, this.cards]) cache.clear()
    syncApi.forgetPulls()
    pullFlight = createSingleFlight()
    epoch++
  },
}

/** Tests only: forget the probe and the cache. */
export function resetSyncForTests() {
  probe = null
  known = SYNC_OFF
  generation++
  settled = false
  unreached = false
  unwatch?.()
  unwatch = null
  syncStore.reset()
}

// ---- Library ------------------------------------------------------------------------------------

const { books, chapters } = syncStore

/** Recreated by `syncStore.reset()`: the next account never joins the previous one's pull. */
let pullFlight = createSingleFlight<Book[]>()
/** Bumped by `syncStore.reset()`. */
let epoch = 0
/** For the shared V2 vocabulary: it drops a card answered after a reset (#1151). */
export const syncEpoch = () => epoch

/**
 * The shared V2 book client (`@textstack/shared` books) on this app's store; `whileCurrent` is its
 * epoch guard (#1151). A reading state is kept in the store and, its revision, beside the local
 * progress (survives a restart); concurrent library pulls share one pull AND its cleanup (#1140).
 */
const client = createBooks({
  books,
  chapters,
  epoch: syncEpoch,
  keepState: (s) => {
    syncStore.states.set(s.bookId, s)
    // ponytail: started in the checked tick, but the setItem itself can still land after the sign-out
    // wipe (clearAllLocalProgress is fire-and-forget); serialize V2 state writes with the wipe if that shows.
    return setUserBookSyncState(s.bookId, { revision: s.revision, fileId: s.fileId, bookFraction: s.bookFraction })
  },
  forgetState: (id) => {
    syncStore.states.delete(id)
    return setUserBookSyncState(id, null)
  },
  progressBody,
  pullFlight: (pull) => pullFlight.run(pull),
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
  resetSince, whileCurrent, pullBooks, liveBook, bookChapters, removeBook,
  originalFileUrl, saveProgress, completeBook, uncompleteBook,
} = client
const { rememberState: remember, toProgress } = client

/**
 * A write's body from the stored revision (no network when one is stored: the reading path). A state
 * on a superseded file is not written on: the write is a first write on the current one (as web).
 */
async function progressBody(bookId: string, data: ProgressWrite): Promise<ReadingStateWrite | null> {
  const stored = await getUserBookSyncState(bookId)
  const current = books.get(bookId)?.currentFile?.id ?? (stored ? undefined : (await liveBook(bookId)).currentFile?.id)
  const onStored = !!stored && (!current || stored.fileId === current)
  const known = onStored ? stored! : { revision: null, fileId: current, bookFraction: undefined }
  const currentLocator = placeToLocator(data)
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

const isPdf = (b: Book) => b.currentFile?.format === 'pdf' && b.currentFile.hasContent

const coverOf = (b: Book) => (b.hasCover ? syncApi.coverUrl(b.id, b.updatedAt) : null)

/**
 * The uploads list: live books only, each with its status and the reader's place — two feed pulls,
 * no per-book call: the feed's file carries its status and chapter count; `/chapters` is the reader's.
 * The cover is the authed V2 route; `useCoverSource` sends the Bearer an <Image> needs.
 */
export async function getUserBooks(): Promise<UserBookDto[]> {
  const pulled = await whileCurrent(Promise.all([pullBooks(), syncApi.pullFeed<ReadingState>('reading')]), ([, reading]) => {
    for (const s of reading.items) syncStore.states.set(s.bookId, s)
  })
  // A pull a store reset dropped is no answer, not an empty library: the orphan sweep deletes every
  // download missing from a listing (#1191). Retryable 503, the same rule as `liveBook` (#1174).
  if (!pulled) throw new ApiError(503, 'Library pull interrupted, retry')
  const [list] = pulled
  const stateOf = syncStore.states
  return list.filter(isShelfBook).map((b): UserBookDto => {
    const file = b.currentFile
    const state = stateOf.get(b.id)
    return {
      id: b.id,
      title: b.title,
      author: b.author,
      language: b.language ?? 'en',
      coverPath: coverOf(b),
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
export async function getUserBook(id: string): Promise<UserBookDetailResponse> {
  const b = await liveBook(id)
  const toc = await bookChapters(b)
  return {
    id: b.id,
    title: b.title,
    slug: '',
    language: b.language ?? 'en',
    author: b.author,
    description: b.description,
    coverPath: coverOf(b),
    genre: b.genre,
    publishedYear: b.publishedYear,
    totalWordCount: null,
    status: shelfFileSummary(b.currentFile).status,
    errorMessage: null,
    // The chapter key is the chapter's id and slug on V2: highlights and vocabulary name it.
    chapters: toc.items.map((c) => ({ id: c.chapterKey, chapterNumber: c.chapterNumber, slug: c.chapterKey, title: c.title, wordCount: null })),
    toc: null,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    // From the reading pull (the library) or the reader's read; fetched only on a miss (#1118 puts it on the book).
    completedAt: (syncStore.states.get(id) ?? await readState(id))?.completedAt ?? null,
    hasOriginalPdf: isPdf(b),
    hasFile: !!b.currentFile?.hasContent,
    originalFileBytes: isPdf(b) ? b.currentFile!.byteSize : null,
    pageCount: b.currentFile?.pageCount ?? null,
    fileId: b.currentFile?.id ?? null,
  }
}

// ---- Reading state ------------------------------------------------------------------------------

const NO_PROGRESS: UserBookProgressDto = { chapterSlug: null, locator: null, percent: null, updatedAt: null, positionJson: null, clientUpdatedAt: null }

/** The book's reading state from the server (null: none yet, or signed out meanwhile), remembered. */
const readState = (bookId: string) => remember(syncApi.getReadingState(bookId))

export async function readProgress(bookId: string): Promise<UserBookProgressDto> {
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
  /** #1426: the file's details and cover for a new import (shared `FileUploadIo.describe`). */
  describe?(): Promise<FileDetails | null>
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
 * An upload on V2: the shared sequence (`@textstack/shared` upload) over the device's IO — the
 * streamed hash, a part read from the file at a time. `existing`: nothing was sent (the book had
 * these bytes). ponytail: progress moves per part.
 */
export async function uploadBook(
  file: { uri: string; name: string; format?: ClientFormat },
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
    const { bookId, sent } = await uploadFile({ name: file.name, size: source.size, format: file.format }, Math.min(Math.max(1, maxPartBytes), MAX_DEVICE_PART_BYTES), {
      known: target && { bookId: target.bookId, fileId: target.fileId },
      newId: () => uuid.v4(),
      hash: () => (target ? Promise.resolve(target.sha256) : sha256Of(source, io.yieldNow)),
      sendPart: async ({ bookId, fileId, index, partCount, start, end }) => {
        await io.sendPart(bookId, fileId, index, source.read(start, end - start))
        onProgress?.(((index + 1) / partCount) * 100)
      },
      // A cancel while the last part was in flight: never complete it (the cancel point throws `aborted`).
      beforeComplete: io.yieldNow,
      describe: io.describe,
    })
    return { bookId, existing: !sent }
  } finally {
    source.close()
  }
}

/**
 * What the upload screen's picker offers, by format (the six the reader reads). Android names .mobi, .azw3 and .fb2
 * by many types or none, so octet-stream (and zip, for a CBZ or an FBZ) is offered too.
 */
export const PICKER_TYPES_BY_FORMAT: Record<ClientFormat, string[]> = {
  epub: ['application/epub+zip'],
  mobi: ['application/x-mobipocket-ebook'],
  azw3: ['application/vnd.amazon.ebook', 'application/vnd.amazon.mobi8-ebook'],
  fb2: ['application/x-fictionbook+xml', 'application/x-zip-compressed-fb2', 'text/xml'],
  cbz: ['application/vnd.comicbook+zip', 'application/x-cbz'],
  pdf: ['application/pdf'],
}
export const UPLOAD_PICKER_TYPES = [...Object.values(PICKER_TYPES_BY_FORMAT).flat(), 'application/zip', 'application/octet-stream']

/** Where a picked file is copied for its upload: the reader's `staging/` on a device. */
export interface UploadStaging {
  /** Copies `uri` in; resolves to the copy's name under `files/v2/` (`staging/<ms>.epub`) and its file URI. */
  copyIn(uri: string): Promise<{ name: string; uri: string }>
  /** Best-effort; a missing file is not an error. */
  remove(name: string): void
}

/**
 * #1426: a picked file uploaded from a copy in the reader's `staging/`, the one place the reader page can read it from,
 * and read by the page (`describe(name)`) on the way. The copy is deleted however the upload ends. The reader's first
 * storage creation empties `staging/` (ReaderScreen `deviceFiles`): the describe then answers null and the upload
 * goes on from its open file.
 */
export async function uploadPicked(
  file: { uri: string; name: string },
  maxPartBytes: number,
  io: UploadIo,
  staging: UploadStaging,
  describe: (name: string) => Promise<FileDetails | null>,
  onProgress?: (percent: number) => void,
): Promise<{ bookId: string; existing: boolean }> {
  const copy = await staging.copyIn(file.uri)
  try {
    return await uploadBook({ uri: copy.uri, name: file.name }, maxPartBytes, { ...io, describe: () => describe(copy.name) }, onProgress)
  } finally {
    try { staging.remove(copy.name) } catch { /* best effort: staging/ is emptied on the reader's next start */ }
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
      return syncApi.putPart(bookId, fileId, index, bytes)
    },
    // Also the hash loop's cancel point (#1143): Cancel stops within one chunk, not after the whole hash.
    yieldNow: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (isCancelled()) throw cancelled()
    },
  }
}

const cancelled = () => Object.assign(new Error('Upload cancelled'), { aborted: true })
