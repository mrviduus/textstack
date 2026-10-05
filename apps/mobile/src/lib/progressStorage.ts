import AsyncStorage from '@react-native-async-storage/async-storage'

// Catalog (edition) progress keys. Kept as-is for backwards compatibility
// with installed users — changing the prefix would lose their progress.
const KEY_PREFIX = 'reading.progress.'
// Separate keyspace for user-uploaded books — the server stores only
// chapter-level percent for these, so we cache book-percent locally so
// ContinueReadingCard can render the same "% of book" UX as catalog books.
// NOTE: this prefix begins with KEY_PREFIX as a string. Every read that
// filters by KEY_PREFIX MUST explicitly exclude USERBOOK_KEY_PREFIX, or
// it will pick up user-book entries with the wrong shape. We isolate that
// invariant in `isCatalogKey()` below — do not inline the startsWith
// check at call sites.
const USERBOOK_KEY_PREFIX = 'reading.progress.userbook.'

/** True when the key is a catalog (edition) progress row, NOT a user-book
 *  row. Centralised so future prefix additions don't have to be added at
 *  every call site (the lesson from B-?? in the mobile bug sweep). */
function isCatalogKey(k: string): boolean {
  return k.startsWith(KEY_PREFIX) && !k.startsWith(USERBOOK_KEY_PREFIX)
}

export interface LocalProgress {
  chapterId: string
  chapterSlug: string
  locator?: string
  /** The logical position, serialised (see @textstack/shared textPosition).
   *  Optional for back-compat with entries written before this field, and
   *  cleared rather than carried forward — a stale anchor beside a fresh pixel
   *  offset is a record that contradicts itself, which is the failure the whole
   *  position model exists to end. */
  positionJson?: string
  percent: number
  /** Book-wide reading progress (0..1) computed across all chapters.
   *  Stored alongside chapter `percent` so ContinueReadingCard can show
   *  "how far into the book" instead of "how far into current chapter".
   *  Optional for back-compat with entries written before this field. */
  bookPercent?: number
  /** Epoch ms, this device's clock. Compared with the server row's
   *  `clientUpdatedAt`, never its `updatedAt` (see `localProgressWins`). */
  updatedAt: number
  /** The server acknowledged this exact write. Set by `markLocalProgressSynced`;
   *  a new save drops it (whole-record write). */
  synced?: boolean
}

/** Persist progress for a single edition. Never throws — callers can fire-and-forget.
 *
 *  `bookPercent` is CARRIED FORWARD when the caller omits it. Callers pass
 *  `undefined` to mean "I don't know the book-wide percent right now" — which
 *  happens on every save before the chapter list resolves, and on every save
 *  while offline, where it never resolves at all. This is a whole-record
 *  `setItem` and `JSON.stringify` drops `undefined`, so the previous value was
 *  silently deleted instead of preserved. The resume card then fell back to the
 *  chapter percent and announced "85% complete" for a book 12% read. */
export async function saveLocalProgress(editionId: string, data: LocalProgress): Promise<void> {
  try {
    let toWrite = data
    if (data.bookPercent === undefined) {
      const prev = await getLocalProgress(editionId)
      if (prev && typeof prev.bookPercent === 'number') {
        toWrite = { ...data, bookPercent: prev.bookPercent }
      }
    }
    await AsyncStorage.setItem(`${KEY_PREFIX}${editionId}`, JSON.stringify(toWrite))
  } catch {
    // Out of space / corrupted store — progress still goes to server on the next flush.
  }
}

export async function getLocalProgress(editionId: string): Promise<LocalProgress | null> {
  try {
    const raw = await AsyncStorage.getItem(`${KEY_PREFIX}${editionId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.updatedAt !== 'number') return null
    return parsed as LocalProgress
  } catch {
    return null
  }
}

/**
 * Flag the stored record as acknowledged by the server — unless a newer save has
 * replaced it since (its `updatedAt` no longer matches). Merged rather than
 * rewritten, so a save landing between the read and the write keeps its fields.
 * Never throws: an entry left unsynced still wins locally, so nothing is lost.
 */
async function markSynced(key: string, updatedAt: number): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(key)
    if (!raw) return
    const entry = JSON.parse(raw)
    if (entry?.updatedAt !== updatedAt) return
    await AsyncStorage.mergeItem(key, JSON.stringify({ synced: true }))
  } catch {
    // Storage unavailable / corrupt — stays unsynced.
  }
}

export function markLocalProgressSynced(editionId: string, updatedAt: number): Promise<void> {
  return markSynced(`${KEY_PREFIX}${editionId}`, updatedAt)
}

export function markUserBookLocalProgressSynced(bookId: string, updatedAt: number): Promise<void> {
  return markSynced(`${USERBOOK_KEY_PREFIX}${bookId}`, updatedAt)
}

/**
 * Wipe every locally-cached reading-progress row. Called on sign-out so
 * user A's last page never leaks to user B when they sign in on the same
 * device. Never throws — progress is non-critical transient state (server
 * is the source of truth once the next user reads anything).
 */
export async function clearAllLocalProgress(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys()
    // Explicit union — clears catalog AND user-book rows. Listing both
    // prefixes by name (rather than relying on the substring coincidence)
    // makes the intent obvious and survives a future prefix rename.
    const progressKeys = keys.filter(k => isCatalogKey(k) || k.startsWith(USERBOOK_KEY_PREFIX))
    if (progressKeys.length === 0) return
    await AsyncStorage.multiRemove(progressKeys)
  } catch {
    // Storage unavailable — ignore; next successful write will resume.
  }
}

/** Per-user-book cache. Two jobs:
 *
 *  1. `bookPercent` for ContinueReadingCard, which is all this held originally —
 *     the server stores chapter-level percent for uploads, so "% of book" has to
 *     be computed by the reader and remembered here.
 *  2. Everything needed to REOPEN the book where it was left, for a book being
 *     read offline. The server is the resume authority whenever it can be
 *     reached; these fields are what the reader falls back to when `GET
 *     /me/books/{id}/progress` cannot be made at all. Without them an offline
 *     reader reopened every downloaded book at chapter one.
 */
export interface UserBookLocalProgress {
  /** 0..1 across the whole book. Optional because the reader does not know it
   *  until the chapter list resolves — which, offline, can be after the first
   *  save. Omitted means "keep what is already stored", never "reset to zero". */
  bookPercent?: number | null
  /** Epoch ms, this device's clock — see `LocalProgress.updatedAt`. */
  updatedAt: number
  /** The server acknowledged this exact write — see `LocalProgress.synced`. */
  synced?: boolean
  /** Chapter last read. Null/absent for a PDF read in Original layout. */
  chapterSlug?: string | null
  /** How far through THAT chapter (0..1) — the chapter-space twin of bookPercent. */
  chapterPercent?: number
  /** Pixel scroll offset inside the chapter. */
  scrollOffset?: number
  /** Serialised TextPosition (see @textstack/shared textPosition) — the only
   *  resume coordinate that survives a reflow, so it is tried first. */
  positionJson?: string
  /** 1-based page, when the book was last read as an Original-layout PDF. */
  page?: number
}

/** Persist an upload's local progress.
 *
 *  `bookPercent` is carried forward when omitted, for the same reason it is in
 *  `saveLocalProgress`: callers pass `undefined` to mean "not known right now",
 *  which is every save made before the chapter list resolves — and offline,
 *  every save. Every OTHER field is assigned, never carried forward: a stale
 *  chapter slug left beside a fresh page number is a record that contradicts
 *  itself, which is the failure the position model exists to end. */
export async function saveUserBookLocalProgress(bookId: string, data: UserBookLocalProgress): Promise<void> {
  try {
    let toWrite = data
    if (data.bookPercent == null) {
      const prev = await getUserBookLocalProgress(bookId)
      if (prev && typeof prev.bookPercent === 'number') {
        toWrite = { ...data, bookPercent: prev.bookPercent }
      }
    }
    await AsyncStorage.setItem(`${USERBOOK_KEY_PREFIX}${bookId}`, JSON.stringify(toWrite))
  } catch {
    // Out of space — non-fatal; reader still saves to server.
  }
}

export async function getUserBookLocalProgress(bookId: string): Promise<UserBookLocalProgress | null> {
  try {
    const raw = await AsyncStorage.getItem(`${USERBOOK_KEY_PREFIX}${bookId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.updatedAt !== 'number') return null
    return parsed as UserBookLocalProgress
  } catch {
    return null
  }
}

/** A stored row that is known to carry a book-percent. The map below filters
 *  out the ones that do not, so its callers — the resume card and the discover
 *  card, both of which exist to render that number — never have to re-check. */
export type UserBookProgressWithPercent = UserBookLocalProgress & { bookPercent: number }

export async function getAllUserBookLocalProgress(): Promise<Map<string, UserBookProgressWithPercent>> {
  const map = new Map<string, UserBookProgressWithPercent>()
  try {
    const keys = await AsyncStorage.getAllKeys()
    const ubKeys = keys.filter(k => k.startsWith(USERBOOK_KEY_PREFIX))
    if (ubKeys.length === 0) return map
    const pairs = await AsyncStorage.multiGet(ubKeys)
    for (const [k, v] of pairs) {
      if (!v) continue
      try {
        const parsed = JSON.parse(v)
        if (!parsed || typeof parsed.bookPercent !== 'number' || typeof parsed.updatedAt !== 'number') continue
        map.set(k.slice(USERBOOK_KEY_PREFIX.length), parsed as UserBookProgressWithPercent)
      } catch {
        // Skip corrupted entry — next save overwrites it.
      }
    }
  } catch {
    // Storage unavailable.
  }
  return map
}

/** Load all cached progress records keyed by editionId. Used by home/continue-reading. */
export async function getAllLocalProgress(): Promise<Map<string, LocalProgress>> {
  const map = new Map<string, LocalProgress>()
  try {
    const keys = await AsyncStorage.getAllKeys()
    // Excludes user-book rows — their shape lacks chapterId/chapterSlug/percent
    // and would silently corrupt LWW merges in ContinueReadingCard if a UUID
    // ever collided with an editionId.
    const progressKeys = keys.filter(isCatalogKey)
    if (progressKeys.length === 0) return map
    const pairs = await AsyncStorage.multiGet(progressKeys)
    for (const [k, v] of pairs) {
      if (!v) continue
      try {
        const parsed = JSON.parse(v)
        // Structural validation — guards against future shape changes and
        // any user-book row that slips past the prefix filter.
        if (!parsed
          || typeof parsed.updatedAt !== 'number'
          || typeof parsed.chapterId !== 'string'
          || typeof parsed.chapterSlug !== 'string'
          || typeof parsed.percent !== 'number') continue
        map.set(k.slice(KEY_PREFIX.length), parsed as LocalProgress)
      } catch {
        // Skip corrupted entry.
      }
    }
  } catch {
    // Storage unavailable — return empty.
  }
  return map
}
