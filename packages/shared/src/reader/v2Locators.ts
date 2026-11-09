/**
 * The transitional reader's places on V2 (M2.7, ADR-031 "Locator schemes"): the legacy progress
 * record (`chapterSlug`, `page:N`, a serialized `TextPosition`) and highlight anchor (`TextAnchor`,
 * `PdfAnchor`) as V2 locators, and back. **Never a CFI from or to a `textstack-*` locator**: an
 * `epub-cfi` (the V2 reader's) has no legacy place, and resumes from `bookFraction`.
 */
import type { V2Locator } from '../api/v2'
import { parsePdfPageLocator } from './pdfProgress'
import { parseTextPosition } from './textPosition'
import { clip, type TextAnchor } from './textAnchor'
import { isPdfAnchor, type PdfAnchor } from './pdfHighlightAnchor'

/** `SyncLimits.MaxSelectedText`: a highlight's selection and its anchor's quote share it. */
export const MAX_SELECTED_TEXT = 4000

/** A legacy progress write's place. */
export interface LegacyPlace {
  chapterSlug: string | null
  locator?: string | null
  positionJson?: string | null
}

/**
 * The place as a V2 position: a PDF page is `pdf-page {"page":N}`; a reflow place is the reader's
 * own `TextPosition` as `textstack-position-v1`. Null: nothing to write (no chapter and no page).
 * ponytail: a place with nothing to quote (the very end of a chapter) goes scroll-only at its start.
 */
export function placeToV2Locator(place: LegacyPlace): V2Locator | null {
  const page = parsePdfPageLocator(place.locator)
  if (page != null) return { version: 1, scheme: 'pdf-page', value: { page } }
  if (!place.chapterSlug) return null
  const position = parseTextPosition(place.positionJson)
  const value = position?.chapterSlug === place.chapterSlug ? position : { v: 1, chapterSlug: place.chapterSlug, chapterFraction: 0 }
  return { version: 1, scheme: 'textstack-position-v1', value }
}

/**
 * A stored V2 position as the legacy place, or null for a scheme the transitional reader cannot
 * resolve (`epub-cfi`): the caller resumes from the fraction (`chapterAtFraction`).
 */
export function v2LocatorToPlace(locator: V2Locator): { chapterSlug: string | null; locator: string | null; positionJson: string | null } | null {
  if (locator.scheme === 'pdf-page') return { chapterSlug: null, locator: `page:${(locator.value as { page: number }).page}`, positionJson: null }
  if (locator.scheme !== 'textstack-position-v1') return null
  const value = locator.value as { chapterSlug: string; anchor?: unknown }
  // A position with an anchor is the TextPosition the reader serialized; scroll-only has none.
  return { chapterSlug: value.chapterSlug, locator: null, positionJson: value.anchor ? JSON.stringify(value) : null }
}

/**
 * A highlight's anchor as its V2 locator: a reflow `TextAnchor` is `textstack-anchor-v1` naming the
 * chapter key it was made in (its `chapterId` on V2); a PDF one is `pdf-page`, the `PdfAnchor` as
 * stored. `exact` is cut as `selectedText` is. Throws on an anchor without a `startOffset` (one
 * parsed from an old `{prefix, exact, suffix}` JSON): the server refuses it (#1139), so never send it.
 */
export function anchorToV2Locator(anchor: (TextAnchor & { chapterId: string }) | PdfAnchor): V2Locator {
  if (isPdfAnchor(anchor)) return { version: 1, scheme: 'pdf-page', value: anchor }
  if (!Number.isInteger(anchor.startOffset) || anchor.startOffset < 0) {
    throw new Error('A textstack-anchor-v1 needs an integer startOffset >= 0')
  }
  const exact = clip(anchor.exact, MAX_SELECTED_TEXT)
  return {
    version: 1,
    scheme: 'textstack-anchor-v1',
    value: {
      chapterKey: anchor.chapterId, prefix: anchor.prefix, exact, suffix: anchor.suffix,
      startOffset: anchor.startOffset, endOffset: anchor.startOffset + exact.length,
    },
  }
}

/** A V2 annotation locator as the anchor the transitional reader draws; null when it cannot (an `epub-cfi`, or none). */
export function v2LocatorToAnchor(locator: V2Locator | null): (TextAnchor & { chapterId: string }) | PdfAnchor | null {
  if (locator?.scheme === 'textstack-anchor-v1') {
    const { chapterKey, prefix, exact, suffix, startOffset, endOffset } = locator.value as {
      chapterKey: string; prefix: string; exact: string; suffix: string; startOffset: number; endOffset: number
    }
    return { chapterId: chapterKey, prefix, exact, suffix, startOffset, endOffset }
  }
  if (locator?.scheme === 'pdf-page') return { ...(locator.value as PdfAnchor), v: 1, kind: 'pdf' }
  return null
}
