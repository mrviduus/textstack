import { isPdfAnchor, findAnchorOffset, ANCHOR_CONTEXT_LENGTH } from '@textstack/shared'
import type { TextAnchor, HighlightAnchor } from './offlineDb'

// The matching itself — the context ladder, the disambiguation and the fuzzy
// fallback — lives in @textstack/shared so mobile resolves anchors the same way.
// This file keeps the parts that need a document: reading text out of the DOM,
// and turning an offset back into a Range.
const CONTEXT_LENGTH = ANCHOR_CONTEXT_LENGTH

// Decorative inline content added by the reader (legacy VocabWordLayer
// appends <span.vocab-inline-translation> inside vocab <mark>). Range text
// extraction includes it, which pollutes anchor prefix/exact/suffix and
// breaks later lookup. Skip these when walking for text.
const EXCLUDE_SELECTOR = '.vocab-inline-translation, [data-vocab-overlay="true"]'

function isExcluded(node: Node): boolean {
  let el: Node | null = node
  while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode
  if (!el) return false
  return !!(el as Element).closest?.(EXCLUDE_SELECTOR)
}

// Walk text nodes between two boundary (node, offset) pairs — in document
// order — and emit their text, skipping nodes beneath EXCLUDE_SELECTOR.
// If `endNode`/`endOffset` is null, runs until the scope ends.
function extractText(
  scope: Node,
  startNode: Node,
  startOffset: number,
  endNode: Node | null,
  endOffset: number | null,
): string {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  let out = ''
  let started = startNode === scope && startOffset === 0
  // Find the start text node.
  let node: Node | null = walker.nextNode()
  // If startNode is itself a text node, walker must reach it first.
  while (node) {
    const tn = node as Text
    const inStart = node === startNode
    const inEnd = node === endNode
    if (!started) {
      if (inStart) {
        started = true
        const upper = inEnd && endOffset !== null ? endOffset : tn.length
        if (!isExcluded(tn)) out += tn.data.slice(startOffset, upper)
        if (inEnd) return out
      }
    } else {
      if (inEnd && endOffset !== null) {
        if (!isExcluded(tn)) out += tn.data.slice(0, endOffset)
        return out
      }
      if (!isExcluded(tn)) out += tn.data
    }
    node = walker.nextNode()
  }
  return out
}

// Walk up from `node` to find the nearest ancestor with [data-chapter-id].
// Returns null if there is no chapter wrapper — callers fall back to the
// passed-in container (legacy single-chapter readers, tests).
function findChapterScope(node: Node | null, boundary: HTMLElement): HTMLElement | null {
  let current: Node | null = node
  while (current && current !== boundary) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const el = current as HTMLElement
      if (el.dataset && el.dataset.chapterId) return el
    }
    current = current.parentNode
  }
  return null
}

function chapterScopes(container: HTMLElement): HTMLElement[] {
  const list = container.querySelectorAll<HTMLElement>('[data-chapter-id]')
  return list.length > 0 ? Array.from(list) : [container]
}

/**
 * Create a TextAnchor from a Range in the DOM.
 * Offsets are relative to the nearest [data-chapter-id] ancestor of the
 * selection — so chapter eviction/remount elsewhere in the scroll container
 * does not invalidate them.
 */
export function createTextAnchor(
  range: Range,
  chapterId: string,
  container: HTMLElement
): TextAnchor {
  const scope = findChapterScope(range.startContainer, container) ?? container

  const beforeText = extractText(scope, scope, 0, range.startContainer, range.startOffset)
  const exact = extractText(scope, range.startContainer, range.startOffset, range.endContainer, range.endOffset)
  const afterText = extractText(scope, range.endContainer, range.endOffset, null, null)

  const prefix = beforeText.slice(-CONTEXT_LENGTH)
  const suffix = afterText.slice(0, CONTEXT_LENGTH)

  const startOffset = beforeText.length
  const endOffset = startOffset + exact.length

  return {
    prefix,
    exact,
    suffix,
    startOffset,
    endOffset,
    chapterId,
  }
}

/**
 * Find text in container using the anchor.
 * When the container holds multiple chapter wrappers, search each scope
 * independently — offsets were stored chapter-relative, so a cross-chapter
 * search would match at the wrong absolute offset.
 */
export function findTextByAnchor(
  anchor: HighlightAnchor,
  container: HTMLElement
): Range | null {
  // PDF (quad-rect) anchors can't be re-located by text over a pdf.js text
  // layer — they're painted from stored rects, never re-anchored via `exact`.
  // Guard so reflow consumers skip them instead of fuzzy-matching the display
  // text into the wrong place.
  if (isPdfAnchor(anchor)) return null
  for (const scope of chapterScopes(container)) {
    const range = findTextInScope(anchor, scope)
    if (range) return range
  }
  return null
}

function findTextInScope(anchor: TextAnchor, scope: HTMLElement): Range | null {
  // Filtered — matches the filtering applied in createTextAnchor so offsets
  // align even when excluded decorative spans (vocab translations) sit
  // inside the text.
  const fullText = extractText(scope, scope, 0, null, null)
  const offset = findAnchorOffset(fullText, anchor)
  if (offset === null) return null
  return createRangeAtOffset(scope, offset, anchor.exact.length)
}

/**
 * Create a Range at a specific text offset in container
 */
function createRangeAtOffset(
  container: HTMLElement,
  startOffset: number,
  length: number
): Range | null {
  const range = document.createRange()
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)

  let currentOffset = 0
  let startNode: Text | null = null
  let startNodeOffset = 0
  let endNode: Text | null = null
  let endNodeOffset = 0

  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    // Skip decorative descendants so offsets match extractText.
    if (isExcluded(node)) continue
    const nodeLength = node.length

    if (startNode === null && currentOffset + nodeLength > startOffset) {
      startNode = node
      startNodeOffset = startOffset - currentOffset
    }

    if (startNode !== null && currentOffset + nodeLength >= startOffset + length) {
      endNode = node
      endNodeOffset = startOffset + length - currentOffset
      break
    }

    currentOffset += nodeLength
  }

  if (startNode && endNode) {
    try {
      range.setStart(startNode, startNodeOffset)
      range.setEnd(endNode, endNodeOffset)
      return range
    } catch {
      return null
    }
  }

  return null
}

/**
 * Simple string similarity (Dice coefficient)
 */

/**
 * Get the bounding rectangles for a highlight anchor
 */
export function getHighlightRects(
  anchor: HighlightAnchor,
  container: HTMLElement
): DOMRect[] {
  const range = findTextByAnchor(anchor, container)
  if (!range) return []

  return Array.from(range.getClientRects())
}

// --- The reading position (ADR-015) ------------------------------------------
//
// Not a highlight: nothing is selected, and the passage is whatever happens to
// sit under the reading line. But it is anchored the same way, with the same
// resolver and the same exclusions, because an anchor built here has to resolve
// on the phone and vice versa.

/** (node, offset) at a viewport point, across the two spellings of the API. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  try {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    }
    if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(x, y)
      if (pos?.offsetNode) return { node: pos.offsetNode, offset: pos.offset }
    }
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y)
      if (r) return { node: r.startContainer, offset: r.startOffset }
    }
  } catch { /* a detached or cross-origin node — treat as no caret */ }
  return null
}

/**
 * What the reader is looking at, as text.
 *
 * `readingLineY` is a viewport coordinate — a quarter down, matching the probe
 * the mobile reader measures against, so a position captured on one client
 * describes the same place on the other.
 *
 * Returns the raw material; `buildTextPosition` in `@textstack/shared` turns it
 * into the stored shape, so both clients quote the same number of characters.
 */
export function readReadingLine(
  article: HTMLElement,
  readingLineY: number,
): { chapterText: string; charOffset: number } | null {
  const rect = article.getBoundingClientRect()
  // Clamped into the article's visible band. A chapter shorter than the reading
  // line — a poem, a preface, a clip, the stub last chapter of a book — ends
  // ABOVE it, so an unclamped probe finds no text and the reader silently gets
  // no logical position at all, falling back to the pixel offset forever.
  const y = Math.max(rect.top + 4, Math.min(readingLineY, rect.bottom - 4))
  // A few x positions: the reading line can land in a margin, between
  // paragraphs, or on an image, and a caret there resolves to nothing.
  const xs = [rect.left + 24, rect.left + rect.width / 2, rect.right - 24]
  for (const x of xs) {
    const caret = caretAt(x, y)
    if (!caret || !article.contains(caret.node)) continue
    const before = extractText(article, article, 0, caret.node, caret.offset)
    const after = extractText(article, caret.node, caret.offset, null, null)
    if (before.length + after.length === 0) continue
    return { chapterText: before + after, charOffset: before.length }
  }
  return null
}

/** The article's text, as the anchor offsets measure it — same exclusions. */
export function articleText(article: HTMLElement): string {
  return extractText(article, article, 0, null, null)
}

/** A Range at a character offset within the article, for scrolling to. */
export function rangeAtCharOffset(article: HTMLElement, target: number): Range | null {
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT)
  let consumed = 0
  let node: Node | null
  while ((node = walker.nextNode())) {
    const tn = node as Text
    if (isExcluded(tn)) continue
    if (consumed + tn.length > target) {
      const range = document.createRange()
      const offset = target - consumed
      range.setStart(tn, offset)
      range.setEnd(tn, Math.min(tn.length, offset + 1))
      return range
    }
    consumed += tn.length
  }
  return null
}

