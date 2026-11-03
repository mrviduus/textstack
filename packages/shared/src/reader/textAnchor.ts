/**
 * Locating a passage in a document that has changed since it was saved.
 *
 * A highlight, a bookmark or a reading position cannot be stored as a pixel
 * offset or a character index: the text reflows when the reader changes font
 * size, line height, theme, or rotates the device, and re-parsing a book can
 * shift indices outright. What survives all of that is the passage itself plus
 * a little of the text around it — the model Hypothesis and Readium both use.
 *
 * This module is the DOM-free half: given the plain text of a scope and an
 * anchor, it answers "where does this passage start?". Building the anchor from
 * a selection and turning an offset back into a Range need a document, so they
 * stay on each platform — but the matching, which is where the subtlety lives,
 * is shared.
 *
 * It was written three times before this: `apps/web/src/lib/textAnchor.ts`, the
 * resolver inlined into the mobile WebView, and mobile's creator, which captured
 * 50 characters of context while web compared 30 — so an anchor made on the
 * phone scored worse when the same book was opened on the web.
 */

/** Characters of context captured either side of the passage. Changing this
 *  makes existing anchors match less well, so both creators must agree on it. */
export const ANCHOR_CONTEXT_LENGTH = 30

/**
 * `i`, or the nearest index before (`-1`) or after (`1`) it when `i` falls between the halves of a
 * surrogate pair. Every cut of a quote or its context goes through this: half a pair has no UTF-8
 * form, and the server refuses an anchor holding one.
 */
export function notInSurrogatePair(text: string, i: number, direction: -1 | 1): number {
  const splits = i > 0 && i < text.length
    && /[\uD800-\uDBFF]/.test(text[i - 1]) && /[\uDC00-\uDFFF]/.test(text[i])
  return splits ? i + direction : i
}

/** Below this Dice score a sliding-window match is rejected. Tightened from
 *  0.6 once OCR'd books drifted matches onto a similar-looking word elsewhere. */
const FUZZY_MIN_SCORE = 0.75

/** How closely a candidate's surrounding text must match before a bare
 *  `exact` hit is accepted without comparing every other occurrence. */
const CONTEXT_ACCEPT_SCORE = 0.5

/** Offset-based verification tolerance — the stored offsets are a hint, not
 *  a promise, so the text they point at only has to be close. */
const OFFSET_VERIFY_SCORE = 0.8

/** A passage plus its surroundings. `startOffset`/`endOffset` are a hint from
 *  when the anchor was made; they are verified, never trusted. */
export interface TextAnchor {
  prefix: string
  exact: string
  suffix: string
  startOffset: number
  endOffset: number
  chapterId?: string
}

/**
 * Dice coefficient over character bigrams, case-insensitive. Cheap, and
 * forgiving of the edits that actually happen to book text — a changed
 * character moves the score a little rather than failing the comparison.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }

  const aBigrams = bigrams(a.toLowerCase())
  const bBigrams = bigrams(b.toLowerCase())
  if (aBigrams.size === 0 || bBigrams.size === 0) return 0

  let intersection = 0
  for (const bg of aBigrams) if (bBigrams.has(bg)) intersection++

  return (2 * intersection) / (aBigrams.size + bBigrams.size)
}

/**
 * Start offset of `anchor.exact` within `fullText`, or null.
 *
 * Four attempts, most confident first:
 *   1. prefix + exact + suffix, then either side alone — an exact context hit
 *      is unambiguous, so it wins outright.
 *   2. `exact` alone. When the passage occurs more than once, every occurrence
 *      is scored on how well its surroundings match and the best one wins.
 *   3. The stored offsets, accepted only if the text there still resembles the
 *      passage.
 *   4. A sliding window, for text that was edited rather than moved.
 */
export function findAnchorOffset(fullText: string, anchor: TextAnchor): number | null {
  if (!anchor || typeof anchor.exact !== 'string' || anchor.exact.length === 0) return null
  if (typeof fullText !== 'string' || fullText.length === 0) return null

  const prefix = anchor.prefix ?? ''
  const suffix = anchor.suffix ?? ''

  const withContext = findWithContext(fullText, anchor.exact, prefix, suffix)
  if (withContext !== null) return withContext

  const { startOffset, endOffset } = anchor
  if (
    Number.isFinite(startOffset) && Number.isFinite(endOffset) &&
    startOffset >= 0 && endOffset <= fullText.length && endOffset > startOffset
  ) {
    const atOffset = fullText.slice(startOffset, endOffset)
    if (atOffset === anchor.exact || similarity(atOffset, anchor.exact) > OFFSET_VERIFY_SCORE) {
      return startOffset
    }
  }

  return findFuzzyMatch(fullText, anchor.exact)
}

function findWithContext(fullText: string, exact: string, prefix: string, suffix: string): number | null {
  let index = fullText.indexOf(prefix + exact + suffix)
  if (index !== -1) return index + prefix.length

  index = fullText.indexOf(prefix + exact)
  if (index !== -1) return index + prefix.length

  index = fullText.indexOf(exact + suffix)
  if (index !== -1) return index

  index = fullText.indexOf(exact)
  if (index === -1) return null

  const scoreAt = (at: number): number =>
    similarity(fullText.slice(Math.max(0, at - ANCHOR_CONTEXT_LENGTH), at), prefix) +
    similarity(fullText.slice(at + exact.length, at + exact.length + ANCHOR_CONTEXT_LENGTH), suffix)

  const first = scoreAt(index)
  // Surroundings already match well enough — no need to weigh the alternatives.
  if (first >= CONTEXT_ACCEPT_SCORE * 2 ||
      similarity(fullText.slice(Math.max(0, index - ANCHOR_CONTEXT_LENGTH), index), prefix) > CONTEXT_ACCEPT_SCORE ||
      similarity(fullText.slice(index + exact.length, index + exact.length + ANCHOR_CONTEXT_LENGTH), suffix) > CONTEXT_ACCEPT_SCORE) {
    return index
  }

  let bestIndex = index
  let bestScore = first
  let searchFrom = index + 1
  while ((index = fullText.indexOf(exact, searchFrom)) !== -1) {
    const score = scoreAt(index)
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
    searchFrom = index + 1
  }
  return bestIndex
}

/** Sliding window, for a passage whose text was edited. Skipped for long
 *  passages — the scan is quadratic and a long passage rarely drifts. */
function findFuzzyMatch(fullText: string, exact: string): number | null {
  if (exact.length >= 100) return null

  let bestIndex = -1
  let bestScore = FUZZY_MIN_SCORE

  for (let i = 0; i <= fullText.length - exact.length; i++) {
    const score = similarity(fullText.slice(i, i + exact.length), exact)
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  }

  return bestIndex === -1 ? null : bestIndex
}

/** `text` cut to `max` UTF-16 units, never between the halves of a surrogate pair (the server refuses a lone one). */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, notInSurrogatePair(text, max, -1))
}
