/**
 * The transitional reader's places on V2 (#1025 M2.7), for both clients: the legacy reader's own
 * `TextPosition` / `TextAnchor` / `PdfAnchor` as the `textstack-*` and `pdf-page` locators the
 * server accepts (PDD "Transitional locators"), and back. Never converted to a CFI (ADR-031).
 */
import type { V2FileChapters, V2Locator, V2ReadingState } from '../api/v2'
import { notInSurrogatePair, type TextAnchor } from './textAnchor'
import { parseTextPosition } from './textPosition'
import { parsePdfPageLocator } from './pdfProgress'
import { isPdfAnchor, type PdfAnchor } from './pdfHighlightAnchor'

/** `SyncLimits.MaxSelectedText`: a highlight's selection and its anchor's quote share it. */
export const V2_MAX_SELECTED_TEXT = 4000

/** Cut to `max` UTF-16 units, never between the halves of a surrogate pair (the server refuses a lone one). */
export const clip = (text: string, max: number) => (text.length <= max ? text : text.slice(0, notInSurrogatePair(text, max, -1)))

/**
 * The chapter at a book fraction, by cumulative word counts: where a reader resumes when the stored
 * position is not one it can resolve (an `epub-cfi` from the V2 reader). ponytail: proportional on
 * word counts, chapters without a count weigh the average.
 */
export function chapterAtFraction(items: { chapterKey: string; wordCount: number | null }[], fraction: number): string | null {
  if (items.length === 0) return null
  const known = items.filter((c) => c.wordCount != null)
  const average = known.length ? known.reduce((s, c) => s + c.wordCount!, 0) / known.length : 1
  const weights = items.map((c) => c.wordCount ?? average)
  const target = Math.min(1, Math.max(0, fraction)) * weights.reduce((s, w) => s + w, 0)
  let sum = 0
  for (let i = 0; i < items.length; i++) {
    sum += weights[i]
    if (target < sum) return items[i].chapterKey
  }
  return items[items.length - 1].chapterKey
}

/** The chapter a stored V2 state resumes in: its own for a position the reader wrote, none for a PDF page. */
export function v2ResumeChapter(state: Pick<V2ReadingState, 'currentLocator' | 'bookFraction'>, toc: V2FileChapters): string | null {
  const { scheme, value } = state.currentLocator
  if (scheme === 'textstack-position-v1') return (value as { chapterSlug: string }).chapterSlug
  if (scheme === 'pdf-page') return null
  // An epub-cfi (the V2 reader's) is never turned into a chapter place (ADR-031): resume from the fraction.
  return chapterAtFraction(toc.items, state.bookFraction)
}

/**
 * A legacy progress write as a V2 locator. A PDF page is `pdf-page {"page":N}`; a reflow place is
 * the reader's own TextPosition as `textstack-position-v1`. Null: nothing to write (no chapter, no page).
 */
export function v2PositionLocator(data: { chapterSlug: string | null; locator?: string | null; positionJson?: string | null }): V2Locator | null {
  const page = parsePdfPageLocator(data.locator)
  if (page != null) return { version: 1, scheme: 'pdf-page', value: { page } }
  if (!data.chapterSlug) return null
  const position = parseTextPosition(data.positionJson)
  // ponytail: a place with nothing to quote (the very end of a chapter) is sent scroll-only at the chapter's start.
  const value = position?.chapterSlug === data.chapterSlug ? position : { v: 1, chapterSlug: data.chapterSlug, chapterFraction: 0 }
  return { version: 1, scheme: 'textstack-position-v1', value }
}

/**
 * A highlight's anchor as a V2 locator: a reflow `TextAnchor` is `textstack-anchor-v1` with the chapter
 * key it was made in; a PDF one is `pdf-page`, the `PdfAnchor` as stored. `exact` is cut as
 * `selectedText` is (one cap, never inside a surrogate pair).
 */
export function v2AnchorLocator(anchor: TextAnchor | PdfAnchor, chapterKey: string): V2Locator {
  if (isPdfAnchor(anchor)) return { version: 1, scheme: 'pdf-page', value: anchor }
  const exact = clip(anchor.exact, V2_MAX_SELECTED_TEXT)
  return {
    version: 1,
    scheme: 'textstack-anchor-v1',
    value: {
      chapterKey, prefix: anchor.prefix, exact, suffix: anchor.suffix,
      startOffset: anchor.startOffset, endOffset: anchor.startOffset + exact.length,
    },
  }
}

/** The anchor a V2 annotation's locator names; null when this reader cannot draw it (an `epub-cfi`, or none). */
export function anchorOfV2Locator(locator: V2Locator | null | undefined): (TextAnchor & { chapterId: string }) | PdfAnchor | null {
  if (locator?.scheme === 'textstack-anchor-v1') {
    const { chapterKey, prefix, exact, suffix, startOffset, endOffset } = locator.value as {
      chapterKey: string; prefix: string; exact: string; suffix: string; startOffset: number; endOffset: number
    }
    return { chapterId: chapterKey, prefix, exact, suffix, startOffset, endOffset }
  }
  if (locator?.scheme === 'pdf-page') return { ...(locator.value as PdfAnchor), v: 1, kind: 'pdf' }
  return null
}
