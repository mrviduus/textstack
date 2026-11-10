/**
 * The V2 reader's local data as sync payloads, and back (R6, #1038; PDD v2-sync-protocol.md
 * "Reading state", "Annotations", "The revision rule"). Pure: the mobile local library and sync
 * client use it, and a web host will. The page's shapes are `store.mjs`'s: a position
 * `{cfi, quote, index, fraction, at}` (a CBZ one has `page` instead of `quote`) and a highlight
 * `{id, cfi, index, quote, selectedText, prefix, suffix, color, at}`.
 */
import type { V2Annotation, V2AnnotationWrite, V2Locator, V2ReadingState, V2ReadingStateWrite } from '../api/v2'
import { decideNewerPosition, serverProvablyNewer, type NewerPositionAction } from './newerPosition'
import { MAX_SELECTED_TEXT } from './v2Locators'

export interface PagePosition {
  cfi: string
  quote?: string
  page?: string
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

/**
 * The page position as a reading-state write (PDD: `epub-cfi` with its `quote`, `bookFraction`,
 * `clientRecordedAt` clamped to now). Null for a position without a quote: a CBZ page has no text,
 * and the server refuses an `epub-cfi` position without one (PDD "CBZ positions: open question").
 */
export function positionWrite(p: PagePosition, fileId: string, expectedRevision: number | null, now = Date.now()): V2ReadingStateWrite | null {
  if (!p.quote || !p.cfi.startsWith('epubcfi(')) return null
  return {
    expectedRevision,
    fileId,
    currentLocator: { version: 1, scheme: 'epub-cfi', value: p.cfi, quote: codePoints(p.quote, 64) },
    bookFraction: Math.min(1, Math.max(0, p.fraction ?? 0)),
    clientRecordedAt: new Date(Math.min(p.at ?? now, now)).toISOString(),
  }
}

/** A server reading state as the page's position; null for one the V2 page cannot restore (another scheme). */
export function statePosition(s: V2ReadingState): PagePosition | null {
  const l = s.currentLocator
  if (l.scheme !== 'epub-cfi' || typeof l.value !== 'string' || !l.quote) return null
  return { cfi: l.value, quote: l.quote, index: spineIndexOf(l.value) ?? undefined, fraction: s.bookFraction, at: Date.parse(s.clientRecordedAt) }
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
  now?: number
}): 'keep' | NewerPositionAction {
  const theirs = statePosition(o.server)
  if (!theirs || o.server.fileId !== o.localFileId) return 'keep'
  const local = o.local?.at != null ? { updatedAt: o.local.at } : null
  if (!serverProvablyNewer(local, { clientUpdatedAt: o.server.clientRecordedAt }, o.now)) return 'keep'
  if (!o.reader) return 'adopt'
  return decideNewerPosition({
    sameChapter: o.reader.index != null && o.reader.index === theirs.index,
    restoreApplied: o.reader.restoreApplied,
    readerMoved: o.reader.moved,
  })
}
