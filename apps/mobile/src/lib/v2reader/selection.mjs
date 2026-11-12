// The `selection` page → host message (#1268): built by the page, read by both hosts with the same caps.
// Pure, no DOM: the page renders untrusted book content, so a host takes only what `readSelection` returns.
// No imports: the format check loads this file in node (strip-types), where the engine's extensionless imports do not resolve.

/** reader-engine's SELECTION_MAX_CHARS, the server's translate and TTS cap (selection.test.ts pins them equal). */
export const SELECTION_MAX_CHARS = 500

/** SyncLimits.MaxSelectedText (UTF-16 units), as `highlightSelection`: a longer selection is cut here, `tooLong` set. */
export const MAX_SELECTION_TEXT = 4000
/** `sentenceAround` returns at most 206 characters; anything far past that did not come from it. */
export const MAX_SELECTION_SENTENCE = 1000
/** A CFI past this is sent as null (no highlight can be drawn from the message; real ones are ~50–200). */
export const MAX_SELECTION_CFI = 1024

/**
 * The message for a selection, or null when it has no text (whitespace, an image). `frame` and `range` are
 * DOMRect-likes: the section iframe in the page viewport, the range inside the iframe. `text` is the range's
 * text, edge whitespace dropped; `tooLong` past the server's translate/TTS cap (reader-engine's rule).
 */
export function selectionMessage({ index, text, cfi, sentence, frame, range }) {
  let t = text.trim()
  if (!t) return null
  const tooLong = t.length > SELECTION_MAX_CHARS
  if (t.length > MAX_SELECTION_TEXT) {
    t = t.slice(0, MAX_SELECTION_TEXT)
    // Never half a surrogate pair at the cut.
    if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1)
  }
  return {
    type: 'selection', index, text: t, tooLong,
    cfi: typeof cfi === 'string' && cfi.length <= MAX_SELECTION_CFI ? cfi : null,
    sentence: sentence.slice(0, MAX_SELECTION_SENTENCE),
    // Host-viewport coordinates of the whole selection (iframe rect + range rect), as `word`'s rect.
    rect: { x: Math.round(frame.left + range.left), y: Math.round(frame.top + range.top), w: Math.round(range.width), h: Math.round(range.height) },
  }
}

const str = (v, max) => typeof v === 'string' && v.length <= max
const num = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * A host's read of a `selection` message: a fresh object of the known fields, or null (dropped) when any
 * field is missing, of the wrong type, not finite or over its cap. Never throws.
 */
export function readSelection(m) {
  if (!m || typeof m !== 'object' || m.type !== 'selection') return null
  const { index, text, cfi, sentence, tooLong, rect } = m
  if (!Number.isInteger(index) || index < 0) return null
  if (!str(text, MAX_SELECTION_TEXT) || !text) return null
  if (!str(sentence, MAX_SELECTION_SENTENCE)) return null
  if (cfi !== null && !(str(cfi, MAX_SELECTION_CFI) && cfi.startsWith('epubcfi('))) return null
  if (typeof tooLong !== 'boolean') return null
  if (!rect) return null   // a primitive has no finite x, y, w, h below
  const { x, y, w, h } = rect
  if (!num(x) || !num(y) || !num(w) || !num(h) || w < 0 || h < 0) return null
  return { index, text, cfi, sentence, tooLong, rect: { x, y, w, h } }
}
