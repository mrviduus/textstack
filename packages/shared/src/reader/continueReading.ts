/**
 * Pure "what should ContinueReadingCard show?" picker.
 *
 * Why a pure function: the previous inline implementation in
 * `ContinueReadingCard.tsx` was the most complex logic in the file —
 * it merged four data sources (server library + server progress + user
 * books + local AsyncStorage) using last-write-wins on `updatedAt`
 * timestamps from heterogeneous time formats (epoch ms vs ISO string).
 * That code had at least one bug in its history (segments swap, see
 * the apology comment in the component). Pure function + unit tests
 * make these merge semantics ratchetable.
 *
 * Lives in `@textstack/shared` so both mobile and (future) web home
 * screens use identical merge semantics — users reading on web then
 * checking mobile see the same "Continue Reading" book.
 *
 * Inputs are plain data shapes — no RN, no fetch, no I/O. The mobile
 * ContinueReadingCard adapts API responses and AsyncStorage maps to
 * these shapes before calling.
 */

import type { UserLibraryItem, ReadingProgressDto, UserBookDto } from '../types/api'
import { resumeChapterSlug } from './resume'

/** Local-cache shape for catalog (edition) progress. */
export interface LocalProgressLite {
  chapterSlug: string
  percent: number
  /** Book-wide percent if the reader wrote it. Optional — older entries
   *  predate this field. */
  bookPercent?: number
  /** Epoch ms. */
  updatedAt: number
}

/** Local-cache shape for user-book book-percent. */
export interface UserBookProgressLite {
  bookPercent: number
  /** Epoch ms. */
  updatedAt: number
}

export type ContinueReadingPick =
  | { type: 'edition'; slug: string; title: string; coverPath: string | null; percent: number; chapterSlug: string | null; updatedAtMs: number }
  | { type: 'userbook'; id: string; title: string; coverPath: string | null; percent: number; chapterSlug: string | null; updatedAtMs: number }

export interface ContinueReadingInputs {
  library: UserLibraryItem[]
  serverProgress: ReadingProgressDto[]
  userBooks: UserBookDto[]
  /** editionId → LocalProgressLite */
  localCatalogMap: Map<string, LocalProgressLite>
  /** userBookId → UserBookProgressLite */
  localUserBookMap: Map<string, UserBookProgressLite>
}

/** Grace window where local book-percent is preferred over server's
 *  chapter-percent on the same chapter. Server PUT lands at debounce
 *  intervals after local cache write; without grace, the server's
 *  later timestamp would always win and we'd lose the cached bookPercent.
 *  60s comfortably covers the 2s debounce + network round-trip + clock
 *  skew between device and server. */
const LOCAL_BOOKPERCENT_GRACE_MS = 60_000

/**
 * Pick the single "Continue Reading" book to show on home — the most
 * recently active not-yet-finished book across catalog + user-book sources.
 *
 * Returns `null` when nothing is in progress. Caller renders empty state.
 *
 * Semantics:
 *   - Each item is scored by `updatedAtMs`. Highest wins.
 *   - 100%-complete books are excluded (`>= 1`).
 *   - For catalog books: LWW between server and local, then optionally
 *     swap in local bookPercent if available for the chosen chapter.
 *   - For user-books: server progressPercent is the timestamp anchor;
 *     local bookPercent is preferred for display when within the grace
 *     window (LOCAL_BOOKPERCENT_GRACE_MS).
 */
export function pickContinueReadingBook(input: ContinueReadingInputs): ContinueReadingPick | null {
  return rankContinueReading(input)[0] ?? null
}

/**
 * Every in-progress book, most recently active first.
 *
 * Same merge semantics as `pickContinueReadingBook` — which is now just
 * `rank(...)[0]` — so the resume hero and the rail behind it can never
 * disagree about which book is "current".
 *
 * This exists because `LibraryShelfItem` (the `/me/library/shelves`
 * payload) carries no `chapterSlug`, so a shelf tap structurally cannot
 * resume at the right chapter — it can only open a detail page. The data
 * needed for a real resume link already lives in `ReadingProgressDto`
 * and `UserBookDto`; this function just stops throwing away everything
 * but the winner.
 *
 * Ties keep input order (library before user books) — `Array#sort` is
 * stable, which matches the previous strictly-greater-than comparison.
 */
export function rankContinueReading(input: ContinueReadingInputs): ContinueReadingPick[] {
  const { library, serverProgress, userBooks, localCatalogMap, localUserBookMap } = input

  // Index server progress by editionId for O(1) lookup.
  const progressMap = new Map<string, ReadingProgressDto>()
  for (const p of serverProgress) progressMap.set(p.editionId, p)

  const picks: ContinueReadingPick[] = []

  for (const item of library) {
    const pick = pickCatalog(item, progressMap.get(item.editionId), localCatalogMap.get(item.editionId))
    if (pick) picks.push(pick)
  }

  for (const ub of userBooks) {
    const pick = pickUserBook(ub, localUserBookMap.get(ub.id))
    if (pick) picks.push(pick)
  }

  return picks.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
}

function pickCatalog(
  item: UserLibraryItem,
  server: ReadingProgressDto | undefined,
  local: LocalProgressLite | undefined,
): ContinueReadingPick | null {
  const serverMs = parseEpochMs(server?.updatedAt)
  const localMs = local?.updatedAt ?? 0

  // Both sources are now book-wide. `ReadingProgress.Percent` carried no declared
  // unit for most of its life — mobile wrote a chapter fraction, web a book
  // fraction — so this function used to track which convention a value came from
  // and refuse to treat a server 1.0 as finished. That flag is gone with the
  // ambiguity; see the migration that cleared the mixed-unit rows.
  let percent: number | null = null
  let chapterSlug: string | null = null
  let updatedAtMs = 0

  if (localMs > serverMs && local) {
    // Local is newer — user just read offline. `bookPercent` is the cached
    // book-wide value; `percent` is the within-chapter scroll fraction kept for
    // resume, and is not a substitute for it.
    percent = typeof local.bookPercent === 'number' ? local.bookPercent : null
    chapterSlug = local.chapterSlug
    updatedAtMs = localMs
  } else if (server && server.percent != null) {
    percent = server.percent
    // Not `server.chapterSlug`. That field is a projection the API derives by joining the row's
    // `chapterId` to the chapters table, and `chapterId` stops moving the moment infinite scroll
    // carries the reader into the next chapter — so a row can name chapter two while its locator
    // is deep in chapter four, and this card would promise to continue and open the wrong one.
    // The book screen learned this in #496; the rail and the shelf did not, which is how a reader
    // 45% in was sent back to 0.66%. No chapter list is available here, and none is needed: the
    // locator either names a chapter or it does not.
    chapterSlug = resumeChapterSlug(server.chapterSlug, server.locator, null)
    updatedAtMs = serverMs
    // Multi-device: our local cache may hold a fresher book-wide value for the
    // same chapter than the server round-trip has delivered.
    if (local && local.chapterSlug === server.chapterSlug && typeof local.bookPercent === 'number') {
      percent = local.bookPercent
    }
  }

  // `>=` rather than `===` catches NaN too (NaN <= 0 is false; NaN >= 0
  // is false; so we use Number.isFinite + positive). Prior version used
  // `updatedAtMs === 0` which silently let through Date.parse('garbage')
  // → NaN, producing picks with NaN timestamps that broke "best of two"
  // comparisons downstream.
  if (percent == null || !Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return null
  // A finished book leaves the list. This is now safe to apply unconditionally:
  // the value spans the whole book, so 1.0 means finished rather than "reached
  // the bottom of some chapter".
  if (percent >= 1) return null
  return {
    type: 'edition',
    slug: item.slug,
    title: item.title,
    coverPath: item.coverPath,
    percent: Math.max(0, Math.min(1, percent)),
    chapterSlug,
    updatedAtMs,
  }
}

function pickUserBook(ub: UserBookDto, local: UserBookProgressLite | undefined): ContinueReadingPick | null {
  if (ub.status.toLowerCase() !== 'ready') return null
  if (!ub.progressPercent || ub.progressPercent >= 1) return null
  if (!ub.progressUpdatedAt) return null
  const ubMs = parseEpochMs(ub.progressUpdatedAt)
  if (!Number.isFinite(ubMs) || ubMs <= 0) return null

  // Prefer local bookPercent within grace window (covers the 2s debounce
  // + network round-trip + small clock skew between device and server).
  const displayPercent = (local && local.updatedAt >= ubMs - LOCAL_BOOKPERCENT_GRACE_MS)
    ? local.bookPercent
    : ub.progressPercent

  return {
    type: 'userbook',
    id: ub.id,
    title: ub.title || 'Untitled',
    coverPath: ub.coverPath,
    percent: displayPercent,
    // Same rule the catalog branch above applies, and for the same reason: the
    // locator is the position and the slug beside it is a field that can lag.
    // It happens to be client-written here rather than server-derived, so this
    // has not yet cost anything — but one branch of one function obeying a rule
    // the other does not is how #496 turned into #500 turned into #501.
    chapterSlug: resumeChapterSlug(ub.progressChapterSlug, ub.progressLocator, null),
    updatedAtMs: ubMs,
  }
}

/** Safe timestamp parser. Accepts ISO strings OR epoch ms numbers — backend
 *  contracts can drift (.NET vs node serializers handle DateTime differently),
 *  and the local cache stores epoch ms directly. Returns 0 (interpreted as
 *  "no timestamp" upstream) for null/undefined/empty/garbage inputs. Prevents
 *  NaN from leaking into `updatedAtMs` and corrupting "most recent"
 *  comparisons across both data sources. */
function parseEpochMs(s: string | number | null | undefined): number {
  if (typeof s === 'number') {
    // Reject 0/negative/NaN/Infinity — epoch ms must be a positive finite int.
    return Number.isFinite(s) && s > 0 ? s : 0
  }
  if (typeof s !== 'string' || s.length === 0) return 0
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : 0
}
