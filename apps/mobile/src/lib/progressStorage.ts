import AsyncStorage from '@react-native-async-storage/async-storage'
import { forgetChapterPositions } from './positionHandoff'

// Catalog (edition) progress keys. Kept as-is for backwards compatibility
// with installed users — changing the prefix would lose their progress.
const KEY_PREFIX = 'reading.progress.'
// The old per-upload progress record. Nothing writes it since the V2 reader keeps its places in the
// local library (#1532); kept so the sign-out wipe still removes an older build's rows.
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

/**
 * Wipe every locally-cached reading-progress row. Called on sign-out so
 * user A's last page never leaks to user B when they sign in on the same
 * device. Never throws — progress is non-critical transient state (server
 * is the source of truth once the next user reads anything).
 */
export async function clearAllLocalProgress(): Promise<void> {
  forgetChapterPositions()
  try {
    const keys = await AsyncStorage.getAllKeys()
    // Explicit union — clears catalog AND user-book rows. Listing both
    // prefixes by name (rather than relying on the substring coincidence)
    // makes the intent obvious and survives a future prefix rename.
    const progressKeys = keys.filter(k => isCatalogKey(k) || k.startsWith(USERBOOK_KEY_PREFIX) || k.startsWith(USERBOOK_PDF_PREFIX) || k.startsWith(USERBOOK_V2_PREFIX))
    if (progressKeys.length === 0) return
    await AsyncStorage.multiRemove(progressKeys)
  } catch {
    // Storage unavailable — ignore; next successful write will resume.
  }
}

const USERBOOK_PDF_PREFIX = 'reading.userbook-is-pdf.'
const USERBOOK_V2_PREFIX = 'reading.userbook-v2-state.'

/** V2 (#1025): the reading-state revision last read or written for a book, and the file it is on —
 *  beside the local progress, so a write after a restart names the revision it read. */
export interface UserBookSyncState {
  revision: number | null
  fileId: string
  /** The book fraction it holds: a write that knows none yet sends this, never 0 (absent on older records). */
  bookFraction?: number
}

export async function getUserBookSyncState(bookId: string): Promise<UserBookSyncState | null> {
  try {
    const raw = await AsyncStorage.getItem(`${USERBOOK_V2_PREFIX}${bookId}`)
    return raw ? (JSON.parse(raw) as UserBookSyncState) : null
  } catch {
    return null
  }
}

/** Null forgets it (the book's file changed). */
export async function setUserBookSyncState(bookId: string, state: UserBookSyncState | null): Promise<void> {
  try {
    if (state) await AsyncStorage.setItem(`${USERBOOK_V2_PREFIX}${bookId}`, JSON.stringify(state))
    else await AsyncStorage.removeItem(`${USERBOOK_V2_PREFIX}${bookId}`)
  } catch {
    // Non-fatal: a write without its revision loses once and adopts the server's.
  }
}

/** Whether an upload is a PDF, remembered from the last time the server said so — so the next
 *  open knows its viewer without a network (deviceLayout, H1). Null: never known here. */
export async function getUserBookIsPdf(bookId: string): Promise<boolean | null> {
  try {
    const raw = await AsyncStorage.getItem(`${USERBOOK_PDF_PREFIX}${bookId}`)
    return raw === '1' ? true : raw === '0' ? false : null
  } catch {
    return null
  }
}

export async function setUserBookIsPdf(bookId: string, isPdf: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(`${USERBOOK_PDF_PREFIX}${bookId}`, isPdf ? '1' : '0')
  } catch {
    // Non-fatal: the next open asks the server again.
  }
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

/**
 * V2 guest → account merge: an upload's local records move from the guest's book id to the
 * account's. The stored revision is dropped (it named the guest's row): the next write reads anew.
 */
export async function rekeyUserBookProgress(books: Record<string, string>): Promise<void> {
  try {
    for (const [from, to] of Object.entries(books)) {
      const value = await AsyncStorage.getItem(USERBOOK_PDF_PREFIX + from)
      if (value != null) {
        await AsyncStorage.setItem(USERBOOK_PDF_PREFIX + to, value)
        await AsyncStorage.removeItem(USERBOOK_PDF_PREFIX + from)
      }
      await AsyncStorage.removeItem(USERBOOK_V2_PREFIX + from)
    }
  } catch {
    // Storage unavailable: the old ids stay, and their writes are refused and dropped.
  }
}
