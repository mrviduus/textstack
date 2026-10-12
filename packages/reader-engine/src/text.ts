// The chapter as text: the DOM half of anchoring (ADR-025). Offsets count the chapter's text nodes in
// document order — what web `createTextAnchor` and the phone's `getSelectionAnchor` count — so stored
// anchors land on the same characters. Reads the DOM only; never changes a text node.
//
// Skips the apps' gloss nodes like both apps do: until slice 4 the legacy vocab path still writes
// them into the chapter the engine reads.
import type { Locator } from './api'
import { ANCHOR_CONTEXT_LENGTH } from '../../shared/src/reader/textAnchor'
import { buildTextPosition } from '../../shared/src/reader/textPosition'
import { READER_GLOSS_SELECTOR } from '../../shared/src/text/gloss'

const NOT_TEXT = `script, style, noscript, ${READER_GLOSS_SELECTOR}`

export function textNodes(root: Node): Text[] {
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(NOT_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  const out: Text[] = []
  while (walker.nextNode()) out.push(walker.currentNode as Text)
  return out
}

export function chapterText(root: Node): string {
  return textNodes(root).map((t) => t.data).join('')
}

/** Character offset of a DOM point (a caret, a range boundary) in the chapter's text; null outside it. */
function offsetOf(root: Node, node: Node, offset: number): number | null {
  const max = node.nodeType === Node.TEXT_NODE ? (node as Text).length : node.childNodes.length
  if (!root.contains(node) || offset < 0 || offset > max) return null
  const point = (root.ownerDocument ?? (root as Document)).createRange()
  point.setStart(node, offset)
  let total = 0
  for (const t of textNodes(root)) {
    if (t === node) return total + offset
    if (point.comparePoint(t, t.length) > 0) break   // this node ends after the point
    total += t.length
  }
  return total
}

/** A Range over [start, start + length) of the chapter's text; null when that is not all in it. */
export function rangeAt(root: Node, start: number, length: number): Range | null {
  if (start < 0 || length < 0) return null
  const range = (root.ownerDocument ?? (root as Document)).createRange()
  let consumed = 0
  let started = false
  for (const t of textNodes(root)) {
    if (!started && consumed + t.length > start) { range.setStart(t, start - consumed); started = true }
    if (started && consumed + t.length >= start + length) { range.setEnd(t, start + length - consumed); return range }
    consumed += t.length
  }
  return null
}

/** A selection as a TextQuoteSelector, with the same 30 characters of context as every stored anchor. */
export function rangeToLocator(root: Node, range: Range, href: string): Locator | null {
  const start = offsetOf(root, range.startContainer, range.startOffset)
  const end = offsetOf(root, range.endContainer, range.endOffset)
  if (start === null || end === null || end <= start) return null
  const text = chapterText(root)
  const n = ANCHOR_CONTEXT_LENGTH
  return {
    href,
    type: 'text/html',
    locations: { charOffset: start },
    text: { before: text.slice(Math.max(0, start - n), start), highlight: text.slice(start, end), after: text.slice(end, end + n) },
  }
}

/**
 * The reading position at a caret (the reading-line probe finds the caret; that is geometry). Quoted
 * by the shared `buildTextPosition`, so it is the TextPosition the apps store.
 */
export function positionAt(root: Node, node: Node, offset: number, href: string, progression: number): Locator | null {
  const at = offsetOf(root, node, offset)
  return at === null ? null : locatorAt(chapterText(root), at, href, progression)
}

/** The reading position at a chapter offset, quoted by the shared `buildTextPosition`. */
export function locatorAt(text: string, at: number, href: string, progression: number): Locator | null {
  const p = buildTextPosition({ chapterSlug: href, chapterText: text, charOffset: at, chapterFraction: progression })
  if (!p) return null
  return {
    href,
    type: 'text/html',
    locations: { charOffset: p.charOffset, progression: p.chapterFraction },
    text: { before: p.anchor.prefix, highlight: p.anchor.exact, after: p.anchor.suffix },
  }
}
