// What a tap in a book section hands the host: the tapped word's sentence and an external link. DOM
// only, no foliate, so tap.test.ts runs it in jsdom.
import { chapterText, offsetOf } from '../../../../../packages/reader-engine/src/text'
import { sentenceAround } from '../../../../../packages/reader-engine/src/engine'

/** The tapped word's sentence inside its block, by the reader engine's rule (TR-1, the other readers' too). */
export function sentenceOf(node, start, end) {
  const block = node.parentElement?.closest('p, li, blockquote, td, h1, h2, h3, h4, h5, h6') ?? node.parentElement
  const at = offsetOf(block, node, start)
  // A line break in a book's source is a space on screen, not a sentence end: hard-wrapped XHTML
  // would otherwise cut every sentence at its source line. One for one, so offsets still hold.
  const text = chapterText(block).replace(/\s/g, ' ')
  return sentenceAround(text, 0, text.length, at, at + (end - start)).replace(/ +/g, ' ')
}

/**
 * The link's absolute URL when the OS may open it, else null. The host hands `openLink` to the OS
 * opener, so a book must not pick the scheme (javascript:, intent:, file:…). Reads the attribute, not
 * `.href`: on an SVG <a> that is an SVGAnimatedString.
 */
export function openableHref(a) {
  const raw = a.getAttribute('href') ?? a.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
  if (raw === null) return null
  try {
    const url = new URL(raw, a.baseURI)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}
