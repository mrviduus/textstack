// The old web reader's caret probe (moved from apps/web/src/lib/textAnchor.ts in Phase 6): the yardstick
// E25 measures the engine's reading line against. Not the engine; the playground is its only user.

// Decorative inline content the old reader added (vocab translations inside a <mark>): skipped when
// walking for text, as the anchor offsets measured it.
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
  let node: Node | null = walker.nextNode()
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
 * What the reader is looking at, as text. `readingLineY` is a viewport coordinate — a quarter down,
 * matching the probe the mobile reader measures against.
 */
export function readReadingLine(
  article: HTMLElement,
  readingLineY: number,
): { chapterText: string; charOffset: number } | null {
  const rect = article.getBoundingClientRect()
  // Clamped into the article's visible band: a chapter shorter than the reading line ends above it.
  const y = Math.max(rect.top + 4, Math.min(readingLineY, rect.bottom - 4))
  // A few x positions: the reading line can land in a margin, between paragraphs, or on an image.
  const xs = [rect.left + 24, rect.left + rect.width / 2, rect.right - 24]
  for (const x of xs) {
    const caret = caretAt(x, y)
    // A caret on an element (an empty table cell) is not a place in the text: the counter below
    // would read the whole chapter (#802).
    if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !article.contains(caret.node)) continue
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
