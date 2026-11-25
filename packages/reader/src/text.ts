// A book section as text: the DOM helpers the V2 page shares with its hosts' tests (moved from the retired reader
// engine, ADR-025, at M6). Offsets count the section's text nodes in document order, as every stored anchor counts
// them. Reads the DOM only; never changes a text node. Skips script, style, noscript and the apps' gloss nodes.
import { ANCHOR_CONTEXT_LENGTH, notInSurrogatePair } from '../../shared/src/reader/textAnchor'
import { READER_GLOSS_SELECTOR } from '../../shared/src/text/gloss'
import { normalizeVocabKey, tokenizeVocabWords } from '../../shared/src/text/vocabKey'

/** iOS fires `selectionchange` all through a drag: a selection is sent once it stops changing. */
export const SELECTION_SETTLE_MS = 220

/** A selection quoted as a W3C TextQuoteSelector, with its character offset in the section's text. */
export interface Quote {
  href?: string
  type: 'text/html'
  locations: { charOffset: number }
  text: { before: string; highlight: string; after: string }
}

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

/** The element `textNodes` walks for `range`: its common ancestor (a text node's parent). */
export function rangeRoot(range: Range): Node {
  const c = range.commonAncestorContainer
  return c.nodeType === Node.TEXT_NODE ? (c.parentNode ?? c) : c
}

/**
 * The text nodes in `range` (`textNodes` of `rangeRoot`), each with the part of it inside the range; empty parts dropped.
 * ponytail: walks the range's whole common ancestor (a section's body for a screen); a walker started at the range's
 * start, if a very long section makes a relocate slow.
 */
export function textPartsIn(range: Range): { node: Text; from: number; to: number }[] {
  return textNodes(rangeRoot(range))
    .filter((t) => range.intersectsNode(t))
    .map((node) => ({ node, from: node === range.startContainer ? range.startOffset : 0, to: node === range.endContainer ? range.endOffset : node.length }))
    .filter((p) => p.to > p.from)
}

/** A `<br>` of `brs` stands between nodes `a` and `b`: a line break on screen. */
export function brBetween(brs: Element[], a: Node, b: Node): boolean {
  const follows = (x: Node, y: Node) => !!(x.compareDocumentPosition(y) & 4 /* DOCUMENT_POSITION_FOLLOWING */)
  return brs.some((br) => follows(a, br) && follows(br, b))
}

export function chapterText(root: Node): string {
  return textNodes(root).map((t) => t.data).join('')
}

/** Character offset of a DOM point (a caret, a range boundary) in the section's text; null outside it. */
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

/**
 * A Range over [start, start + length) of the section's text, null when that is not all in it: walks the section
 * once, then each range is two binary searches. Pass `into` to reuse one Range: every live Range is updated on each
 * DOM change, so thousands cost seconds.
 */
export function rangesIn(root: Node, nodes = textNodes(root)): (start: number, length: number, into?: Range) => Range | null {
  const ends: number[] = []
  let total = 0
  for (const t of nodes) ends.push((total += t.length))
  /** The first node whose end passes the test (ends only grow). */
  const first = (ok: (end: number) => boolean) => {
    let lo = 0
    let hi = ends.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ok(ends[mid])) hi = mid; else lo = mid + 1 }
    return lo
  }
  return (start, length, into) => {
    if (start < 0 || length < 0) return null
    const i = first((end) => end > start)
    const j = Math.max(i, first((end) => end >= start + length))
    if (j >= nodes.length) return null
    const range = into ?? (root.ownerDocument ?? (root as Document)).createRange()
    range.setStart(nodes[i], start - (ends[i] - nodes[i].length))
    range.setEnd(nodes[j], start + length - (ends[j] - nodes[j].length))
    return range
  }
}

/** A selection as a TextQuoteSelector, with the same 30 characters of context as every stored anchor. */
export function rangeToLocator(root: Node, range: Range, href: string): Quote | null {
  const start = offsetOf(root, range.startContainer, range.startOffset)
  const end = offsetOf(root, range.endContainer, range.endOffset)
  if (start === null || end === null || end <= start) return null
  return quoteAt(chapterText(root), start, end, href)
}

/** [start, end) of the section's text as a TextQuoteSelector; the context never splits a surrogate pair. */
export function quoteAt(text: string, start: number, end: number, href?: string): Quote {
  const n = ANCHOR_CONTEXT_LENGTH
  const before = text.slice(notInSurrogatePair(text, Math.max(0, start - n), 1), start)
  const after = text.slice(end, notInSurrogatePair(text, Math.min(text.length, end + n), -1))
  return { href, type: 'text/html', locations: { charOffset: start }, text: { before, highlight: text.slice(start, end), after } }
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u

/**
 * Where saved words stand in the section (section offsets), by the apps' vocabulary key: whole words, any case, one
 * text node at a time — a block or a `<sup>` ends a word, since the section text joins nodes with nothing between
 * them. Phrases first, longest first, so "make sense" is never also "make" + "sense". Matched on the folded text and
 * mapped back (E51).
 */
export function matchWords<T extends { word: string }>(root: Node, items: T[], nodes?: Text[]): { item: T; start: number; end: number }[] {
  const key = (w: string) => fold(normalizeVocabKey(w))
  const byKey = new Map(items.map((i) => [key(i.word), i]))
  const phrases = [...byKey.keys()].filter((k) => k.includes(' ')).sort((a, b) => b.length - a.length)
  const out: { item: T; start: number; end: number }[] = []
  let base = 0
  for (const { data: text } of byKey.size ? (nodes ?? textNodes(root)) : []) {
    const taken = new Uint8Array(text.length)
    const { hay, from, to } = folded(text)
    for (const k of phrases) {
      for (let at = hay.indexOf(k); at !== -1; at = hay.indexOf(k, at + 1)) {
        const start = from[at]
        const end = to[at + k.length - 1]
        if (WORD_CHAR.test(text.charAt(start - 1)) || WORD_CHAR.test(text.charAt(end)) || taken.subarray(start, end).includes(1)) continue
        taken.fill(1, start, end)
        out.push({ item: byKey.get(k)!, start: base + start, end: base + end })
      }
    }
    for (const t of tokenizeVocabWords(hay)) {
      const item = byKey.get(key(t.word))
      const start = from[t.start]
      if (item && !taken[start]) out.push({ item, start: base + start, end: base + to[t.end - 1] })
    }
    base += text.length
  }
  return out.sort((a, b) => a.start - b.start)
}

// The fold behind saved words (`matchWords`): case-insensitive, NBSP == space, composed == decomposed (NFC), dotted
// capital İ == i (E17, E49, E51). Folding can change a length (İ lowercases to i + U+0307, e + U+0301 composes to
// one), so the text is folded one letter-with-its-marks at a time and each hit is mapped back to `text` itself (E50).
const fold = (s: string) => s.normalize('NFC').toLowerCase().replace(/i\u0307/g, 'i').replace(/\u00a0/g, ' ')
const LETTER = /\P{M}\p{M}*|\p{M}+/gu
const ASCII = /^[\x00-\x7f]*$/

/** `text` folded, and per folded character where its letter starts (`from`) and ends (`to`) in `text`. */
function folded(text: string): { hay: string; from: number[]; to: number[] } {
  let hay = ''
  const from: number[] = []
  const to: number[] = []
  if (ASCII.test(text)) {   // folds letter for letter: 10x faster on an English section
    for (let i = 0; i < text.length; i++) { from.push(i); to.push(i + 1) }
    return { hay: text.toLowerCase(), from, to }
  }
  LETTER.lastIndex = 0
  for (let m = LETTER.exec(text); m; m = LETTER.exec(text)) {   // not matchAll: Android 7–9 WebViews lack it
    const f = fold(m[0])
    hay += f
    for (let k = 0; k < f.length; k++) { from.push(m.index); to.push(m.index + m[0].length) }
  }
  return { hay, from, to }
}

/** Inline elements share their block's box; a text node is placed by its nearest non-inline ancestor. */
const INLINE = new Set('A ABBR B BDI BDO BR CITE CODE DATA DEL DFN EM FONT I IMG INS KBD MARK Q S SAMP SMALL SPAN STRONG SUB SUP TIME TT U VAR'.split(' '))

/** The block a text node is placed by: its nearest non-inline ancestor, at most `root`. Upper-cased: XHTML keeps lower-case tags. */
export function blockOf(node: Node, root: Element): Element {
  let block = node.parentElement!
  while (block !== root && INLINE.has(block.tagName.toUpperCase())) block = block.parentElement!
  return block
}

const SENTENCE_END = /[.!?\n]/
/** A longer sentence is cut to this many characters around the selection. */
const SENTENCE_MAX = 200

/** The sentence around [start, end) of `text`, inside [from, to), cut to SENTENCE_MAX around the selection (TR-1). */
export function sentenceAround(text: string, from: number, to: number, start: number, end: number): string {
  let a = start
  while (a > from && !SENTENCE_END.test(text[a - 1])) a--
  let b = end
  while (b < to && !SENTENCE_END.test(text[b - 1])) b++
  const sentence = text.slice(a, b).trim()
  if (sentence.length <= SENTENCE_MAX) return sentence
  const c = Math.max(a, start - 80, end - SENTENCE_MAX)
  const d = Math.min(b, c + SENTENCE_MAX)
  // A cut edge keeps its space, as both apps' extractors did (TR-1 fixture, E48): "... words".
  let cut = text.slice(c, d)
  if (c <= a) cut = cut.trimStart()
  if (d >= b) cut = cut.trimEnd()
  return `${c > a ? '...' : ''}${cut}${d < b ? '...' : ''}`
}
