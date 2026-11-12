// What a tap in a book section hands the host: the tapped word's sentence and an external link. DOM
// only, no foliate, so tap.test.ts runs it in jsdom.
import { textNodes } from '../../../../../packages/reader-engine/src/text'
import { blockOf, sentenceAround } from '../../../../../packages/reader-engine/src/engine'

/** The tapped word's sentence inside its block (the engine's `blockOf`), by the engine's sentence rule (TR-1). */
export function sentenceOf(node, start, end) {
  return sentenceOfRange(node, start, node, end)
}

/**
 * The block a DOM point is in. `blockOf` starts from the node's parent: an element point starts at the
 * element itself, and a point on <html> or the document is the whole body. Never throws.
 */
function blockAt(node) {
  const doc = node.ownerDocument ?? node
  const root = doc.body ?? doc.documentElement
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
  if (!root || !el || el === root || !root.contains(el)) return root
  return blockOf(node.nodeType === Node.ELEMENT_NODE ? (el.firstChild ?? el) : node, root)
}

/**
 * The sentence around a range (a selection, #1268) inside the start's block. A range ending past that block
 * is taken to the block's end. Boundaries may be element points. '' where there is no text.
 */
export function sentenceOfRange(startNode, start, endNode, end) {
  const block = blockAt(startNode)
  if (!block) return ''
  const nodes = textNodes(block)
  // A <br> between two text nodes is a line break on screen: a space. A PDF's text layer (pdf.js) separates
  // its lines with nothing else, so without it the last word of a line glues to the next line's first.
  const brs = [...block.querySelectorAll('br')]
  const follows = (a, b) => !!(a.compareDocumentPosition(b) & a.DOCUMENT_POSITION_FOLLOWING)
  const parts = nodes.map((t, k) => (k && brs.some((br) => follows(nodes[k - 1], br) && follows(br, t)) ? ' ' : '') + t.data)
  // Where each node's data starts in the joined text.
  const starts = []
  parts.reduce((n, p, k) => (starts.push(n + p.length - nodes[k].length), n + p.length), 0)
  // Source line breaks are spaces on screen, not sentence ends; one for one, so offsets hold (#1072).
  const text = parts.join('').replace(/\s/g, ' ')
  /** A DOM point's offset in `text`: a text node's own; any other point's at the first text after it (the end past the block). */
  const at = (node, offset) => {
    const i = nodes.indexOf(node)
    if (i >= 0) return starts[i] + offset
    const point = block.ownerDocument.createRange()
    point.setStart(node, offset)
    const k = nodes.findIndex((t) => point.comparePoint(t, 0) >= 0)
    return k < 0 ? text.length : starts[k]
  }
  const a = at(startNode, start)
  return sentenceAround(text, 0, text.length, a, Math.max(a, at(endNode, end))).replace(/ +/g, ' ')
}

/**
 * `range` without its edge whitespace, as reader-engine trims a selection: a drag from the blank after a
 * heading starts in the next block's text, not at the heading's end. Null when it holds no text.
 */
export function trimRange(range) {
  const c = range.commonAncestorContainer
  const nodes = textNodes(c.nodeType === Node.TEXT_NODE ? c.parentNode : c).filter((t) => range.intersectsNode(t))
  let first = null
  let last = null
  for (const t of nodes) {
    const from = t === range.startContainer ? range.startOffset : 0
    const part = t.data.slice(from, t === range.endContainer ? range.endOffset : t.length)
    const a = part.search(/\S/)
    if (a < 0) continue
    first ??= [t, from + a]
    last = [t, from + part.search(/\s*$/)]
  }
  if (!first) return null
  const r = range.cloneRange()
  r.setStart(...first)
  r.setEnd(...last)
  return r
}

/**
 * A box inside a section frame (its document's coordinates) in the page viewport. The fixed-layout renderer
 * scales a pre-paginated page's frame with a CSS `transform: scale()`: the frame's laid-out width against
 * its drawn one is that scale. Used for `word` and `selection`.
 */
export function rectInPage(frame, r) {
  const f = frame.getBoundingClientRect()
  const scale = frame.offsetWidth ? f.width / frame.offsetWidth : 1
  const x = f.left + (frame.clientLeft + r.left) * scale
  const y = f.top + (frame.clientTop + r.top) * scale
  return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width * scale), h: Math.round(r.height * scale) }
}

/**
 * The link's absolute URL when the OS may open it, else null. The host hands `openLink` to the OS
 * opener, so a book must not pick the scheme (javascript:, intent:, file:…). Reads the attribute, not
 * `.href`: on an SVG <a> that is an SVGAnimatedString.
 */
export function openableHref(a) {
  const raw = a.getAttribute('href')
  if (raw === null) return null
  try {
    const url = new URL(raw, a.baseURI)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}
