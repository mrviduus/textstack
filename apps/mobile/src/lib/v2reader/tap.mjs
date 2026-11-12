// What a tap in a book section hands the host: the tapped word's sentence and an external link. DOM
// only, no foliate, so tap.test.ts runs it in jsdom.
import { offsetOf, textNodes } from '../../../../../packages/reader-engine/src/text'
import { blockOf, sentenceAround } from '../../../../../packages/reader-engine/src/engine'

/** The tapped word's sentence inside its block (the engine's `blockOf`), by the engine's sentence rule (TR-1). */
export function sentenceOf(node, start, end) {
  return sentenceOfRange(node, start, node, end)
}

/**
 * The sentence around a range (a selection, #1268) inside the start's block. A range ending past that block
 * is taken to the block's end. Boundaries may be element points (the engine's `offsetOf`).
 */
export function sentenceOfRange(startNode, start, endNode, end) {
  const block = blockOf(startNode, startNode.ownerDocument.body ?? startNode.ownerDocument.documentElement)
  const nodes = textNodes(block)
  // A <br> between two text nodes is a line break on screen: a space. A PDF's text layer (pdf.js) separates
  // its lines with nothing else, so without it the last word of a line glues to the next line's first.
  const brs = [...block.querySelectorAll('br')]
  const follows = (a, b) => !!(a.compareDocumentPosition(b) & a.DOCUMENT_POSITION_FOLLOWING)
  const parts = nodes.map((t, k) => (k && brs.some((br) => follows(nodes[k - 1], br) && follows(br, t)) ? ' ' : '') + t.data)
  // Source line breaks are spaces on screen, not sentence ends; one for one, so offsets hold (#1072).
  const text = parts.join('').replace(/\s/g, ' ')
  /** A DOM point's offset in `text` (the block's text plus those spaces); the block's end when outside it. */
  const at = (node, offset) => {
    let raw = offsetOf(block, node, offset)
    if (raw === null) return text.length
    let pos = 0
    for (let k = 0; k < nodes.length; k++) {
      pos += parts[k].length - nodes[k].length
      if (raw <= nodes[k].length) return pos + raw
      raw -= nodes[k].length
      pos += nodes[k].length
    }
    return text.length
  }
  const a = at(startNode, start)
  return sentenceAround(text, 0, text.length, a, Math.max(a, at(endNode, end))).replace(/ +/g, ' ')
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
