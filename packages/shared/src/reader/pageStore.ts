/**
 * The V2 reader page's stored entry (ADR-029): one per book FILE (its SHA-256 + size). The page owns the shape;
 * a host keeps it (Android: SQLite rows; web: the server, #1226). An entry for other bytes, or a shape this code
 * does not know, is not applied. A leaf on purpose: the page bundle (`store.mjs` re-exports this) takes nothing
 * else from `@textstack/shared` through it.
 *
 * { v, book: { sha256, size, name }, position: null | { cfi, quote, index, fraction, at } | { cfi, page, index, fraction, at }
 *   | { page: N, index, fraction, at } (PDF, #1128 S5) | { fraction, at },
 *   highlights: [{ id, cfi, index, quote, selectedText, prefix, suffix, color, at }] }
 * `quote` is the first ≤64 code points at the CFI (the epub-cfi locator's `quote`, ADR-031); a
 * highlight's full selection is `selectedText`. A highlight stored before #1078 has only `quote`,
 * which then holds the full selection.
 */
import type { PageHighlight, PagePosition } from './localSync'
import { isFractionOnly } from './fractionPosition'
import { isPdfPage } from './pdfPagePosition'

export const STORE_VERSION = 1

/**
 * #1314: the `color` that makes an entry highlight, and the V2 annotation it is synced as, a bookmark (ADR-031
 * "Amended 2026-11-15"): the first words at a place, never drawn. Not a highlight colour.
 */
export const BOOKMARK_COLOR = 'bookmark'
/** An entry highlight or a V2 annotation that is a bookmark: every list of highlights leaves it out. */
export const isBookmark = (h: { color?: string | null } | null | undefined): boolean => h?.color === BOOKMARK_COLOR

export interface PageEntryBook { sha256: string; size: number; name?: string }

/**
 * #1195: a transitional `textstack-anchor-v1` annotation (the legacy reader's) as the page lists it: a quotation, its
 * text and colour, never drawn, never written back (the server's row stays as it is). It rides the entry a host builds
 * for `restore` (Android) or the web host's `addHighlights` list; the page keeps it out of its stores.
 */
export interface PageQuotation { id: string; quotation: true; selectedText: string; color?: string; at?: number }
export const isQuotation = (q: unknown): q is PageQuotation => {
  const x = q as Partial<PageQuotation> | null | undefined
  return x?.quotation === true && typeof x.id === 'string' && x.id.length > 0 && typeof x.selectedText === 'string' && x.selectedText.trim().length > 0
}

export interface PageEntry {
  v: number
  book: PageEntryBook
  position: PagePosition | null
  highlights: PageHighlight[]
  /** #1195: listed, never drawn nor stored back. */
  quotations?: PageQuotation[]
}

export function emptyEntry(book: PageEntryBook): PageEntry {
  return { v: STORE_VERSION, book, position: null, highlights: [] }
}

type Loose = { cfi?: unknown; quote?: unknown; page?: unknown; selectedText?: unknown; id?: unknown } | null | undefined

/** A position or highlight this code can act on: a CFI and the text that was there. */
const isQuoted = (x: Loose) => typeof x?.cfi === 'string' && x.cfi.startsWith('epubcfi(') && typeof x.quote === 'string' && x.quote.length > 0
/**
 * An image-only book's position (CBZ, #1128): there is no text at any CFI, so no quote. `page` is the
 * image's entry name in the archive, checked on restore instead; `cfi` is foliate's section CFI. Synced as a
 * `page-name` locator (#1188, `positionWrite` / `statePosition`).
 */
const isPaged = (x: Loose) => typeof x?.cfi === 'string' && x.cfi.startsWith('epubcfi(') && x.quote === undefined && typeof x.page === 'string' && x.page.length > 0
/** A transitional server position by book fraction alone (#1187), a PDF page (#1128 S5), a CBZ page, or CFI + quote. */
export const isPosition = (x: unknown): x is PagePosition => isQuoted(x as Loose) || isPaged(x as Loose) || isPdfPage(x) || isFractionOnly(x)
/** A highlight's `selectedText` is optional (older entries), but when present it is what restore compares. */
const isHighlight = (h: Loose): boolean => isQuoted(h) && (h!.selectedText === undefined || (typeof h!.selectedText === 'string' && h!.selectedText.trim().length > 0))

/** The stored entry for this file, or null (missing, corrupt, another version, other bytes). */
export function entryFor(json: string | null | undefined, book: { sha256: string; size: number | null }): PageEntry | null {
  let e
  try { e = JSON.parse(json as string) } catch { return null }
  if (e?.v !== STORE_VERSION || e.book?.sha256 !== book.sha256 || e.book?.size !== book.size) return null
  if (!Array.isArray(e.highlights)) return null
  // Only items this code can use. A stored highlight or position without its quote would throw on
  // restore, and a page that throws there never finishes restoring and never saves again.
  return {
    ...e, position: isPosition(e.position) ? e.position : null, highlights: e.highlights.filter(isHighlight) as PageHighlight[],
    quotations: Array.isArray(e.quotations) ? e.quotations.filter(isQuotation) : undefined,
  }
}

export const withPosition = (e: PageEntry, p: unknown): PageEntry => (isPosition(p) ? { ...e, position: p } : e)
/** Same id replaces (a re-anchored highlight), otherwise appends. */
export const withHighlight = (e: PageEntry, h: unknown): PageEntry =>
  (isHighlight(h as Loose) && (h as PageHighlight).id ? { ...e, highlights: [...e.highlights.filter((x) => x.id !== (h as PageHighlight).id), h as PageHighlight] } : e)
