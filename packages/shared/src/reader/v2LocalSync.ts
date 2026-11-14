/**
 * The V2 reader's local data as sync payloads, and back (R6, #1038; PDD v2-sync-protocol.md
 * "Reading state", "Annotations", "The revision rule"). Pure: the mobile local library and sync
 * client use it, and a web host will. The page's shapes are `store.mjs`'s: a position
 * `{cfi, quote, index, fraction, at}` (a named page, CBZ or pre-paginated EPUB, has `page` instead of `quote`, the `page-name` locator; a PDF one is
 * `{page, index, fraction, at}` with `page` the 1-based page number, #1128 S5; one from a transitional
 * locator is `{fraction, at}` alone, #1187) and a highlight
 * `{id, cfi, index, quote, selectedText, prefix, suffix, color, at}`.
 */
import type { V2Annotation, V2AnnotationWrite, V2Locator, V2ReadingState, V2ReadingStateWrite } from '../api/v2'
import { isFractionOnly } from './fractionPosition'
import { isPdfPage } from './pdfPagePosition'
import { decideNewerPosition, serverProvablyNewer, type NewerPositionAction } from './newerPosition'
import { MAX_SELECTED_TEXT } from './v2Locators'

export interface PagePosition {
  /** Absent on a fraction-only position (a transitional server locator): restored by `fraction`, never pushed. */
  cfi?: string
  quote?: string
  /** A named page's key (beside `cfi`: a CBZ image's entry name, a pre-paginated EPUB's spine href), or a PDF's 1-based page number (alone: `pdf-page`). */
  page?: string | number
  index?: number
  fraction?: number
  at?: number
}

export interface PageHighlight {
  id: string
  cfi: string
  index?: number
  quote: string
  /** Absent on a highlight stored before #1078: its `quote` then holds the full selection. */
  selectedText?: string
  prefix?: string
  suffix?: string
  color?: string
  at?: number
}

/** Any 8-4-4-4-12 hex id: a client v4, or the server's after an adopt or a merge (never remapped). */
export const isUuid = (id: unknown): id is string =>
  typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

/** The first (or, `fromEnd`, the last) `max` code points: the server counts them, never UTF-16 units. */
export function codePoints(text: string, max: number, fromEnd = false): string {
  const cps = Array.from(text)
  if (cps.length <= max) return text
  return (fromEnd ? cps.slice(cps.length - max) : cps.slice(0, max)).join('')
}

/** foliate's spine index from a CFI's first step, `/6/N` with N = 2·(index + 1); null for any other shape. */
export function spineIndexOf(cfi: string): number | null {
  const m = /^epubcfi\(\/6\/(\d+)/.exec(cfi)
  const n = m ? Number(m[1]) : NaN
  return n >= 2 && n % 2 === 0 ? n / 2 - 1 : null
}

/**
 * A highlight's full selection when it may reach the server: non-blank and at most 4000 UTF-16
 * units (`SyncLimits.MaxSelectedText`). Null: kept on the device, never synced (the page refuses new
 * ones; an older stored one is tolerated, not sent).
 */
export function syncableText(h: PageHighlight): string | null {
  const text = h.selectedText ?? h.quote
  return typeof text === 'string' && text.trim() && text.length <= MAX_SELECTED_TEXT ? text : null
}

/** `SyncLimits.MaxPageName`: a `page-name` locator's page key, in UTF-16 units. */
export const MAX_PAGE_NAME = 512

/**
 * A page key the server takes (`SyncValidation.IsPageName`): non-blank, at most 512 UTF-16 units, no control
 * character (Unicode Cc) and no lone surrogate (`u`: a whole pair is one code point, outside the range).
 */
export const isPageName = (k: unknown): k is string =>
  typeof k === 'string' && k.trim().length > 0 && k.length <= MAX_PAGE_NAME && !/[\p{Cc}\uD800-\uDFFF]/u.test(k)

/** A section index the server takes: an Int32 ≥ 0. */
const isIndex = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 2 ** 31 - 1

/**
 * The page position as a reading-state write (PDD: `epub-cfi` with its `quote`, `pdf-page` `{"page":N}`, or
 * `page-name` `{"page":"<key>","index":N}`; `bookFraction`, `clientRecordedAt` clamped to now). The
 * scheme fits the file (`SyncValidation.FitsFile`): `pdf-page` only when `format` is `pdf`, and `epub-cfi`
 * never then; `page-name` only on a `cbz` (#1188) or an `epub` (#1196), from the page's named-page position
 * (`page` = the CBZ entry name or the pre-paginated EPUB's spine href, `index` = its section; the CFI beside
 * them is not sent). A reflowable EPUB's position has a quote and no `page`: always `epub-cfi`. Null for any other position without a
 * quote (the server refuses an `epub-cfi` position without one), and for a fraction-only position: the
 * server's transitional locator is never rewritten as a CFI.
 */
/** The formats a `page-name` position fits (`SyncValidation.FitsFile`): a CBZ, an EPUB (a pre-paginated one, #1196). */
const PAGE_NAMED = new Set<string | null>(['cbz', 'epub'])

export function positionWrite(p: PagePosition, fileId: string, expectedRevision: number | null, now = Date.now(), format: string | null = null): V2ReadingStateWrite | null {
  const pdf = format === 'pdf'
  let currentLocator: V2Locator
  if (pdf && isPdfPage(p)) currentLocator = { version: 1, scheme: 'pdf-page', value: { page: p.page } }
  else if (PAGE_NAMED.has(format) && p.quote === undefined && isPageName(p.page) && isIndex(p.index)) {
    currentLocator = { version: 1, scheme: 'page-name', value: { page: p.page, index: p.index } }
  } else if (!pdf && p.quote && p.cfi?.startsWith('epubcfi(')) currentLocator = { version: 1, scheme: 'epub-cfi', value: p.cfi, quote: codePoints(p.quote, 64) }
  else return null
  return {
    expectedRevision,
    fileId,
    currentLocator,
    bookFraction: Math.min(1, Math.max(0, p.fraction ?? 0)),
    clientRecordedAt: new Date(Math.min(p.at ?? now, now)).toISOString(),
  }
}

/**
 * Why a named-page position (a `page` key, no quote) gets no `positionWrite`, or null (it gets one, or it is not a
 * named page). For a host's log: it names the key's length and the file's format, never the key itself.
 */
export function pageNameRefusal(p: PagePosition, format: string | null): string | null {
  if (typeof p.page !== 'string' || p.quote !== undefined) return null
  if (!PAGE_NAMED.has(format)) return `a named page does not fit a ${format ?? 'unknown-format'} file`
  if (!isPageName(p.page)) return `its page key (${p.page.length} UTF-16 units) is blank, over ${MAX_PAGE_NAME}, or has a control character or lone surrogate`
  if (!isIndex(p.index)) return 'its section index is not an Int32 ≥ 0'
  return null
}

const FRACTION_SCHEMES = new Set<string>(['textstack-position-v1', 'textstack-anchor-v1', 'epub-cfi'])

/**
 * A server reading state as the page's position, for a file of `format` (null: not known here). A
 * `pdf-page` one is its page (`index` = page − 1, foliate's section), and a PDF has no other: no CFI, no
 * fraction fallback (#1128 S5). A `page-name` one (a `cbz` or an `epub`, #1188, #1196) is the page's named-page
 * position: the key restore checks, its section, and that section's CFI (the shape the page store keeps). An `epub-cfi` one with its quote is restored by CFI; a transitional
 * `textstack-*` one (or an `epub-cfi` without a quote) by its `bookFraction` alone (PDD "Transitional
 * locators", #1187): approximate, never converted to a CFI. Null for a scheme that does not fit the
 * file, an unknown one, and a state without a fraction in [0, 1].
 */
export function statePosition(s: V2ReadingState, format: string | null = null): PagePosition | null {
  const l = s.currentLocator
  const at = Date.parse(s.clientRecordedAt)
  if (l.scheme === 'pdf-page') {
    const p = { page: (l.value as { page?: unknown } | null)?.page }
    return (format === null || format === 'pdf') && isPdfPage(p) ? { page: p.page, index: p.page - 1, fraction: s.bookFraction, at } : null
  }
  if (l.scheme === 'page-name') {
    const v = l.value as { page?: unknown; index?: unknown } | null
    return (format === null || PAGE_NAMED.has(format)) && isPageName(v?.page) && isIndex(v?.index)
      ? { cfi: `epubcfi(/6/${2 * (v.index + 1)})`, page: v.page, index: v.index, fraction: s.bookFraction, at }
      : null
  }
  if (format === 'pdf') return null
  if (l.scheme === 'epub-cfi' && typeof l.value === 'string' && l.quote) {
    return { cfi: l.value, quote: l.quote, index: spineIndexOf(l.value) ?? undefined, fraction: s.bookFraction, at }
  }
  // An allowlist: the transitional schemes and an unverifiable epub-cfi. Any other (a scheme this build
  // does not know) is no position here, so `keep`.
  const p = { fraction: s.bookFraction, at }
  return FRACTION_SCHEMES.has(l.scheme) && isFractionOnly(p) ? p : null
}

/** The page highlight as an annotation write; null when its text may not be synced (`syncableText`). */
export function highlightWrite(h: PageHighlight, bookId: string, fileId: string, expectedRevision: number | null): V2AnnotationWrite | null {
  const selectedText = syncableText(h)
  if (!selectedText) return null
  const locator: V2Locator = { version: 1, scheme: 'epub-cfi', value: h.cfi, quote: codePoints(h.quote, 64) }
  // The page's 30 characters of context: the server bounds each at 32 code points, kept nearest the selection.
  if (h.prefix) locator.prefix = codePoints(h.prefix, 32, true)
  if (h.suffix) locator.suffix = codePoints(h.suffix, 32)
  return { expectedRevision, bookId, fileId, selectedText, locator, color: h.color ?? 'yellow' }
}

/**
 * A pulled annotation as the page's highlight; null for one the page cannot draw (no `epub-cfi`
 * locator: a `textstack-anchor-v1` quotation from the transitional reader, a catalog quotation).
 */
export function annotationHighlight(a: V2Annotation): PageHighlight | null {
  const l = a.locator
  if (!l || l.scheme !== 'epub-cfi' || typeof l.value !== 'string') return null
  return {
    id: a.id, cfi: l.value, index: spineIndexOf(l.value) ?? undefined,
    quote: l.quote || codePoints(a.selectedText, 64), selectedText: a.selectedText,
    prefix: l.prefix ?? '', suffix: l.suffix ?? '', color: a.color, at: Date.parse(a.createdAt),
  }
}

/** JSON values compared structurally: key order ignored (jsonb keeps none), undefined members absent. */
export function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, norm(x)]))
        : v
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b)

/** PDD "Own write, lost response": the stored state is what this write sent (file, locator, time). */
export const ownStateWrite = (current: V2ReadingState, sent: V2ReadingStateWrite) =>
  current.fileId === sent.fileId && sameJson(current.currentLocator, sent.currentLocator) && sameInstant(current.clientRecordedAt, sent.clientRecordedAt)

/** The same for an annotation: every field sent. */
export const ownAnnotationWrite = (current: V2Annotation, sent: V2AnnotationWrite) =>
  !current.deletedAt && current.bookId === sent.bookId && (current.fileId ?? null) === (sent.fileId ?? null)
  && current.selectedText === sent.selectedText && (current.noteText ?? null) === (sent.noteText ?? null)
  && sameJson(current.locator ?? null, sent.locator ?? null) && current.color === sent.color

/** The open reader of a book, as the host sees it; null when the book is not open. */
export interface OpenReader {
  /** The page answered `restored` for this book. */
  restoreApplied: boolean
  /** The reader has relocated since the restore settled (CFI compared, no tolerance). */
  moved: boolean
  /** The spine index on screen. */
  index: number | null
}

/**
 * Another device's reading state, from a pull or a lost write's `current` (PDD `stale_revision`):
 * ADR-019 rule 5 re-keyed by CFI + spine index. `keep`: the local position stays (the server's is
 * not provably newer, is on another file version, or is a scheme this page cannot restore) and the
 * next write goes on the server's revision. Otherwise the newer-check's action: `adopt` (nothing
 * restored yet, or the book is not open), `move` (restored, not moved since, same spine item),
 * `prompt` (moved, or another spine item: never yank a reader who moved).
 */
export function decideServerState(o: {
  local: PagePosition | null
  localFileId: string | null
  server: V2ReadingState
  reader: OpenReader | null
  /** The server state's file format, when known: a PDF takes a page position only (`statePosition`). */
  format?: string | null
  now?: number
}): 'keep' | NewerPositionAction {
  const theirs = statePosition(o.server, o.format ?? null)
  if (!theirs || o.server.fileId !== o.localFileId) return 'keep'
  const local = o.local?.at != null ? { updatedAt: o.local.at } : null
  if (!serverProvablyNewer(local, { clientUpdatedAt: o.server.clientRecordedAt }, o.now)) return 'keep'
  // Nothing restored yet: adopt, whatever spine item is on screen (none is reported before `restored`).
  if (!o.reader || !o.reader.restoreApplied) return 'adopt'
  // A named page (`page-name`) is compared by name when the local place has one too: two devices may order a
  // CBZ's entries differently, so their indexes may disagree. The local name is the reader's only while the reader
  // is still on the local place's section (both indexes this device's own): a chosen jump (a TOC entry) moves it
  // without `moved`, and this pass may still read the place before it. Otherwise by spine index.
  const named = typeof theirs.page === 'string' && typeof o.local?.page === 'string'
  return decideNewerPosition({
    // A fraction-only position, local or the server's, has no spine index: a restored reader is asked.
    sameChapter: named
      ? o.local!.page === theirs.page && o.reader.index != null && o.reader.index === o.local!.index
      : o.reader.index != null && o.reader.index === theirs.index,
    restoreApplied: o.reader.restoreApplied,
    readerMoved: o.reader.moved,
  })
}
