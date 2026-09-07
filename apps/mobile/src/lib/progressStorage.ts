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
  /** Epoch ms. Source of truth for LWW merge between local and server. */
  updatedAt: number
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

/** Lightweight per-user-book cache for ContinueReadingCard. We don't need
 *  the full LocalProgress shape (server handles chapterSlug / locator
 *  resume) — just the book-percent the reader computed last time. */
export interface UserBookLocalProgress {
  bookPercent: number
  updatedAt: number
}

export async function saveUserBookLocalProgress(bookId: string, data: UserBookLocalProgress): Promise<void> {
  try {
    await AsyncStorage.setItem(`${USERBOOK_KEY_PREFIX}${bookId}`, JSON.stringify(data))
  } catch {
    // Out of space — non-fatal; reader still saves to server.
  }
}

export async function getAllUserBookLocalProgress(): Promise<Map<string, UserBookLocalProgress>> {
  const map = new Map<string, UserBookLocalProgress>()
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
        map.set(k.slice(USERBOOK_KEY_PREFIX.length), parsed as UserBookLocalProgress)
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
