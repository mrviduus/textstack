// The `selection` page → host message (#1268): built by the page, read by both hosts with the same caps.
// Pure, no DOM: the page renders untrusted book content, so a host takes only what `readSelection` returns.
// The format check loads it bundled (esbuild): plain node does not resolve packages/shared's extensionless imports.
import { clip } from '../../../../../packages/shared/src/reader/textAnchor'
import { MAX_SELECTED_TEXT } from '../../../../../packages/shared/src/reader/v2Locators'

/** reader-engine's SELECTION_MAX_CHARS, the server's translate and TTS cap (selection.test.ts pins them equal). */
export const SELECTION_MAX_CHARS = 500
/** `sentenceAround` returns at most 206 characters; anything far past that did not come from it. */
export const MAX_SELECTION_SENTENCE = 1000
/** A CFI past this is sent as null (no highlight can be drawn from the message; real ones are ~50–200). */
export const MAX_SELECTION_CFI = 1024
/** A section index past this is no book's (the largest real spines are a few thousand). */
export const MAX_SELECTION_INDEX = 100_000
/** |x|, |y|, w and h in CSS px: far past any screen, still room for a selection scrolled off it. */
export const MAX_SELECTION_PX = 100_000

/**
 * The message for a selection, or null when it has no text (whitespace, an image). `text` is the selection
 * as rendered (`Selection.toString()`), edge whitespace dropped and cut at the server's MaxSelectedText
 * (`clip`, never half a surrogate pair). A cut one carries no CFI: its text no longer covers the range, and
 * `highlightSelection` refuses it anyway. `rect`: the trimmed range's box in the page viewport.
 */
export function selectionMessage({ index, text, cfi, sentence, rect }) {
  const t = text.trim()
  if (!t) return null
  const cut = clip(t, MAX_SELECTED_TEXT)
  return {
    type: 'selection', index, text: cut,
    cfi: cut === t && typeof cfi === 'string' && cfi.length <= MAX_SELECTION_CFI ? cfi : null,
    sentence: sentence.slice(0, MAX_SELECTION_SENTENCE),
    rect,
  }
}

const str = (v, max) => typeof v === 'string' && v.length <= max
/** A number in [min, MAX_SELECTION_PX]: NaN and ±Infinity fail the bounds. */
const px = (v, min) => typeof v === 'number' && v >= min && v <= MAX_SELECTION_PX

/**
 * A host's read of a `selection` message: a fresh object of the known fields plus `tooLong` (derived here,
 * never taken from the page), or null (dropped) when any field is missing, of the wrong type, not finite,
 * out of bounds or over its cap. Never throws.
 */
export function readSelection(m) {
  if (!m || typeof m !== 'object' || m.type !== 'selection') return null
  const { index, text, cfi, sentence, rect } = m
  if (!Number.isInteger(index) || index < 0 || index > MAX_SELECTION_INDEX) return null
  if (!str(text, MAX_SELECTED_TEXT) || !/\S/.test(text)) return null
  if (!str(sentence, MAX_SELECTION_SENTENCE)) return null
  if (cfi !== null && !(str(cfi, MAX_SELECTION_CFI) && cfi.startsWith('epubcfi('))) return null
  const r = readRect(rect)
  return r && { index, text, cfi, sentence, tooLong: text.length > SELECTION_MAX_CHARS, rect: r }
}

/** A box in page-viewport px, `{ x, y, w, h }` fresh, or null: |x|, |y| over MAX_SELECTION_PX, w or h negative or over it, not a number. */
export function readRect(rect) {
  if (!rect) return null   // a primitive has no x, y, w, h below
  const { x, y, w, h } = rect
  if (!px(x, -MAX_SELECTION_PX) || !px(y, -MAX_SELECTION_PX) || !px(w, 0) || !px(h, 0)) return null
  return { x, y, w, h }
}
