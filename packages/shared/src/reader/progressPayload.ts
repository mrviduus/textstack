/**
 * The unit every percentage in this codebase is measured in, declared on the wire.
 *
 * The server stores a book-wide fraction, and for a long time nothing said so —
 * mobile wrote chapter fractions, web wrote book fractions, and both landed in the
 * same column. The clients agree now, but old builds keep running and their writes
 * cannot be told apart by looking at the number. So the number travels with its
 * unit, and the server declines to store one that arrives without it.
 */
export const PERCENT_UNIT_BOOK = 'book'

import { LOCATOR_SPACE_SCROLL, type LocatorSpaceKind } from './locatorSpace'

/**
 * Pure builders for the reading-progress wire payloads.
 *
 * Why pure functions and not inline in the hooks: hooks combine refs +
 * subscriptions + I/O, which is painful to unit-test. The decision of
 * "what should this PUT body look like, given the current scroll state"
 * is straightforward arithmetic + null-guard logic — extract it and you
 * get a function that's a 5-line test instead of a fragile RN hook test.
 *
 * Each builder returns `null` when there's nothing meaningful to save
 * (no bookId / no chapter slug). Callers should skip the I/O in that
 * case rather than POSTing a half-empty payload.
 *
 * Used by:
 *   - `useUserBookProgress` (mobile)
 *   - Future: web-reader user-book save flow (when it exists)
 */

import { computeBookProgress, type ChapterWithCount } from './bookProgress'

export interface UserBookProgressPayload {
  /** Book-wide reading progress (0..1). Canonical semantics of the stored
   *  UserBook.ProgressPercent column — matches what the web reader writes and
   *  what the library card + Continue-reading shelf read back verbatim.
   *
   *  Omitted when it cannot be computed (chapter list unresolved — offline, or
   *  the first saves of a cold open). The server then keeps the stored value.
   *  It is never filled with the chapter fraction: that reaches 1.0 at the
   *  bottom of every chapter, which is the confusion this column was
   *  canonicalised to end. */
  percent?: number
  /** Declares what `percent` is a fraction of. Sent whenever `percent` is, and
   *  never without it — the server stores the number only when it is present. */
  percentUnit?: string
  /** The coordinate space `locator` is written in. Always 'scroll' here — this
   *  builder only ever produces a chapter offset. Sent so the server can tell a
   *  deliberate move into scroll space (the read-as-text fallback for a corrupt
   *  PDF) from a stale writer clobbering a PDF reader's page. */
  locatorKind: LocatorSpaceKind
  chapterSlug: string
  locator: string
  /** Where the reader is in the TEXT, serialised. Omitted when the viewer could
   *  not anchor — the server then clears the stored one rather than leaving it
   *  beside a fresher pixel offset. */
  positionJson?: string
}

export interface UserBookProgressInputs {
  /** Active chapter slug. May come from the WebView's progress message
   *  (preferred — reflects infinite-scroll position) or the URL param. */
  currentChapterSlug: string | null | undefined
  /** Fallback when the WebView hasn't reported its slug yet. */
  fallbackChapterSlug: string | null | undefined
  /** Live chapter scroll progress (0..1). */
  chapterProgress: number
  /** Live pixel offset for the resume locator. Builder defends against
   *  NaN/Infinity/negative/null at runtime — TypeScript doesn't see the
   *  WebView's untyped postMessage JSON boundary. */
  scrollOffset: number | null | undefined
  /** Ordered chapter list (slug + wordCount) used to turn the within-chapter
   *  scroll into a book-wide percent via computeBookProgress. When omitted (or
   *  the current chapter can't be located) the builder falls back to the raw
   *  chapter progress so it never stores nothing. */
  chapters?: ChapterWithCount[]
  /** Canonical book-wide word total (Σ chapter WordCount on the server). Passed
   *  through to computeBookProgress so the denominator matches the server's. */
  totalWordCount?: number
  /** Serialised `TextPosition` for the reading line, when the viewer could build one. */
  positionJson?: string
}

// Reasonable upper bound for a scroll offset (pixels). Real long-form
// content tops out a few hundred thousand px on the longest chapters
// (~3M characters at 16px line-height). 10M is generous headroom; past
// that we suspect a WebView bug and clamp to avoid emitting a 20+ char
// integer in the locator (and the surprise it would cause downstream).
const MAX_SCROLL_OFFSET = 10_000_000

/**
 * Build the wire payload for `PUT /me/books/{id}/progress`.
 *
 * Returns null when no usable chapter slug is available (e.g. the WebView
 * has mounted but neither it nor the URL has produced a slug yet — rare
 * but possible during the first few ms of a chapter mount).
 */
export function buildUserBookProgressPayload(input: UserBookProgressInputs): UserBookProgressPayload | null {
  const slug = input.currentChapterSlug || input.fallbackChapterSlug
  if (!slug) return null
  // `percent` is book-wide (canonical ProgressPercent semantics), computed from
  // the chapter word counts.
  //
  // When the chapter list is missing or the slug isn't in it, we cannot compute
  // it — and the raw chapter fraction is NOT an acceptable substitute: it reaches
  // 1.0 at the bottom of every chapter, which is exactly the confusion this
  // column was canonicalised to end. It happens on every save made offline
  // (the list never resolves) and before the list lands on a cold open, so the
  // fallback was quietly writing chapter fractions into the canonical column.
  // Returning null instead leaves the last known good value in place.
  const bookPct = input.chapters
    ? computeBookProgress(input.chapters, slug, input.chapterProgress, input.totalWordCount)
    : null
  // Locator stays within-chapter (scroll restore) — unchanged. It is saved even
  // when the percent cannot be, so the reader never loses their place.
  const safeOffset = clampScrollOffset(input.scrollOffset)
  const payload: UserBookProgressPayload = {
    chapterSlug: slug,
    locator: `scroll:${slug}:${safeOffset}`,
    locatorKind: LOCATOR_SPACE_SCROLL,
  }
  if (bookPct != null) {
    payload.percent = clampUnit(bookPct)
    payload.percentUnit = PERCENT_UNIT_BOOK
  }
  if (input.positionJson) payload.positionJson = input.positionJson
  return payload
}

/** Clamp scroll offset to [0, MAX_SCROLL_OFFSET]; coerces NaN/Infinity/
 *  null/undefined/non-number to 0. Defense at the JSON boundary. */
function clampScrollOffset(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  if (n <= 0) return 0
  if (n > MAX_SCROLL_OFFSET) return MAX_SCROLL_OFFSET
  return Math.round(n)
}

// --- Locator parser ---------------------------------------------------

export interface ParsedScrollLocator {
  slug: string
  offset: number
}

/**
 * Inverse of the `scroll:<slug>:<offset>` format produced by
 * `buildUserBookProgressPayload` (and by the catalog reader's inline
 * locator emission).
 *
 * Why this is non-trivial: chapter slugs are user-controllable on user-
 * uploaded books (extractor derives them from chapter titles). If a slug
 * ever contains `:` — even pathologically rare — the naive `split(':')`
 * approach two callers had inline would split into too many pieces and
 * lose part of the slug + corrupt the offset. We parse from the RIGHT:
 * the last `:` separates offset from the slug, regardless of how many
 * colons the slug itself contains.
 *
 * Returns `null` for any malformed input (wrong prefix, missing offset,
 * negative offset, garbage). Callers should treat null as "start at top
 * of chapter" — never crash, never restore to a bogus position.
 *
 * Lives in `@textstack/shared` so both readers + any future ones share
 * one parser with one set of tests (was: two inline split-on-colon
 * implementations that would have to be kept in sync forever).
 */
export function parseScrollLocator(locator: string | null | undefined): ParsedScrollLocator | null {
  if (typeof locator !== 'string') return null
  const PREFIX = 'scroll:'
  if (!locator.startsWith(PREFIX)) return null
  // lastIndexOf finds the offset separator regardless of colons in slug.
  const lastColon = locator.lastIndexOf(':')
  if (lastColon < PREFIX.length) return null // no offset segment after prefix
  const offsetStr = locator.slice(lastColon + 1)
  // Must be a non-empty integer string. parseInt is lenient ("123abc" →
  // 123); reject anything that isn't strictly digits to avoid silent
  // truncation of malformed data.
  if (offsetStr.length === 0 || !/^\d+$/.test(offsetStr)) return null
  const offset = parseInt(offsetStr, 10)
  if (!Number.isFinite(offset) || offset < 0) return null
  const slug = locator.slice(PREFIX.length, lastColon)
  if (slug.length === 0) return null
  return { slug, offset }
}

/** Clamp to [0, 1]; coerces NaN/Infinity to 0. */
function clampUnit(n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
