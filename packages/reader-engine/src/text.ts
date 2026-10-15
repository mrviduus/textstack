// The chapter as text: the DOM half of anchoring (ADR-025). Offsets count the chapter's text nodes in
// document order — what web `createTextAnchor` and the phone's `getSelectionAnchor` count — so stored
// anchors land on the same characters. Reads the DOM only; never changes a text node.
//
// Skips the reader's gloss nodes (READER_GLOSS_SELECTOR): the engine's own overlay carries that marker.
import type { Locator } from './api'
import { ANCHOR_CONTEXT_LENGTH } from '../../shared/src/reader/textAnchor'
import { buildTextPosition } from '../../shared/src/reader/textPosition'
import { READER_GLOSS_SELECTOR } from '../../shared/src/text/gloss'
import { normalizeVocabKey, tokenizeVocabWords } from '../../shared/src/text/vocabKey'

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
export function offsetOf(root: Node, node: Node, offset: number): number | null {
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
  return rangesIn(root)(start, length)
}

/**
 * `rangeAt` for many ranges: walks the chapter once, then each range is two binary searches. Pass
 * `into` to reuse one Range: every live Range is updated on each DOM change, so thousands cost seconds.
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
export function rangeToLocator(root: Node, range: Range, href: string): Locator | null {
  const start = offsetOf(root, range.startContainer, range.startOffset)
  const end = offsetOf(root, range.endContainer, range.endOffset)
  if (start === null || end === null || end <= start) return null
  return quoteAt(chapterText(root), start, end, href)
}

/** [start, end) of the chapter's text as a TextQuoteSelector locator. */
export function quoteAt(text: string, start: number, end: number, href?: string): Locator {
  const n = ANCHOR_CONTEXT_LENGTH
  return {
    href,
    type: 'text/html',
    locations: { charOffset: start },
    text: { before: text.slice(Math.max(0, start - n), start), highlight: text.slice(start, end), after: text.slice(end, end + n) },
  }
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u

/**
 * Where saved words stand in the chapter (chapter offsets), by the apps' vocabulary key: whole words,
 * any case, one text node at a time like the web matcher — a block or a `<sup>` ends a word, since the
 * chapter text joins nodes with nothing between them. Phrases first, longest first, so "make sense" is
 * never also "make" + "sense".
 * ponytail: offsets assume NFC and lowercasing keep lengths (not so for Turkish İ), like the web
 * matcher; map offsets through the normalisation if such a book shows up.
 */
export function matchWords<T extends { word: string }>(root: Node, items: T[], nodes?: Text[]): { item: T; start: number; end: number }[] {
  const byKey = new Map(items.map((i) => [normalizeVocabKey(i.word), i]))
  const phrases = [...byKey.keys()].filter((k) => k.includes(' ')).sort((a, b) => b.length - a.length)
  const out: { item: T; start: number; end: number }[] = []
  let base = 0
  for (const { data: text } of byKey.size ? (nodes ?? textNodes(root)) : []) {
    const taken = new Uint8Array(text.length)
    const lower = text.normalize('NFC').toLowerCase()
    for (const key of phrases) {
      for (let at = lower.indexOf(key); at !== -1; at = lower.indexOf(key, at + 1)) {
        const end = at + key.length
        if (WORD_CHAR.test(text.charAt(at - 1)) || WORD_CHAR.test(text.charAt(end)) || taken.subarray(at, end).includes(1)) continue
        taken.fill(1, at, end)
        out.push({ item: byKey.get(key)!, start: base + at, end: base + end })
      }
    }
    for (const t of tokenizeVocabWords(text)) {
      const item = byKey.get(normalizeVocabKey(t.word))
      if (item && !taken[t.start]) out.push({ item, start: base + t.start, end: base + t.end })
    }
    base += text.length
  }
  return out.sort((a, b) => a.start - b.start)
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

// The one matcher behind in-book search (`find`): case-insensitive, NBSP == space, composed ==
// decomposed (NFC), non-overlapping (E17, E49). Folding can change a length (Turkish İ lowercases to two
// characters, e + U+0301 composes to one), so the text is folded one letter-with-its-marks at a time and
// each hit is mapped back to `[start, end]` in `text` itself (E50).
const fold = (s: string) => s.normalize('NFC').toLowerCase().replace(/\u00a0/g, ' ')
const LETTER = /\P{M}\p{M}*|\p{M}+/gu
export function findTextOffsets(text: string, needle: string): [number, number][] {
  const n = fold(needle)
  if (!n) return []
  let hay = ''
  const from: number[] = []   // per folded character: where its letter starts in `text`
  const to: number[] = []     // ... and ends
  LETTER.lastIndex = 0
  for (let m = LETTER.exec(text); m; m = LETTER.exec(text)) {   // not matchAll: Android 7–9 WebViews lack it
    const f = fold(m[0])
    hay += f
    for (let k = 0; k < f.length; k++) { from.push(m.index); to.push(m.index + m[0].length) }
  }
  const out: [number, number][] = []
  for (let i = hay.indexOf(n); i !== -1; i = hay.indexOf(n, i + n.length)) out.push([from[i], to[i + n.length - 1]])
  return out
}
