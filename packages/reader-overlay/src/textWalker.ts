// TreeWalker-backed text iteration with per-match Range construction.
// Port of https://github.com/johnfactotum/foliate-js/blob/master/text-walker.js
// (MIT, © John Factotum). Adapted to TS.
//
// Use: pass a Range (to walk the portion it covers) or an Element/Document
// (to walk everything). `func(strings, makeRange)` is a generator that yields
// matches — strings is the array of text-node contents in document order,
// makeRange(startIdx, startOffset, endIdx, endOffset) constructs a Range
// across potentially multiple nodes.
//
// Replaces the per-feature ad-hoc TreeWalker loops in vocabHighlightEngine,
// in-book search, TTS sentence chunking.

type TextFinder<T> = (strings: string[], makeRange: MakeRange) => IterableIterator<T>

export type MakeRange = (
  startIndex: number,
  startOffset: number,
  endIndex: number,
  endOffset: number,
) => Range

const NODE_FILTER_MASK =
  NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION

const defaultAcceptNode = (node: Node): number => {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const name = (node as Element).tagName.toLowerCase()
    if (name === 'script' || name === 'style' || name === 'noscript') {
      return NodeFilter.FILTER_REJECT
    }
    return NodeFilter.FILTER_SKIP
  }
  return NodeFilter.FILTER_ACCEPT
}

const walkRange = (range: Range, walker: TreeWalker): Node[] => {
  const nodes: Node[] = []
  for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
    const compare = range.comparePoint(node, 0)
    if (compare === 0) nodes.push(node)
    else if (compare > 0) break
  }
  return nodes
}

const walkRoot = (_: Node, walker: TreeWalker): Node[] => {
  const nodes: Node[] = []
  for (let node: Node | null = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node)
  }
  return nodes
}

function resolveRoot(input: Range | Element | Document): Node {
  if (input instanceof Range) return input.commonAncestorContainer
  if ((input as Document).body) return (input as Document).body
  return input
}

export function* textWalker<T>(
  input: Range | Element | Document,
  func: TextFinder<T>,
  filterFn: (node: Node) => number = defaultAcceptNode,
): Generator<T> {
  const root = resolveRoot(input)
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, NODE_FILTER_MASK, {
    acceptNode: filterFn,
  })
  const nodes =
    input instanceof Range ? walkRange(input, walker) : walkRoot(root, walker)
  const strs = nodes.map((node) => node.nodeValue ?? '')
  const makeRange: MakeRange = (startIndex, startOffset, endIndex, endOffset) => {
    const range = doc.createRange()
    range.setStart(nodes[startIndex], startOffset)
    range.setEnd(nodes[endIndex], endOffset)
    return range
  }
  for (const match of func(strs, makeRange)) yield match
}

// The one matcher behind in-book search: the drawer's list (over the chapter
// text) and the painted overlay (over the DOM) both count with it, so their
// indexes agree. Case-insensitive, NBSP == space, non-overlapping. Offsets are
// into `text`. ponytail: assumes lowercasing keeps lengths (true outside a few
// letters such as Turkish İ).
const fold = (s: string) => s.toLowerCase().replace(/\u00a0/g, ' ')
export function findTextOffsets(text: string, needle: string): number[] {
  const out: number[] = []
  if (!needle) return out
  const hay = fold(text)
  const n = fold(needle)
  for (let i = hay.indexOf(n); i !== -1; i = hay.indexOf(n, i + n.length)) out.push(i)
  return out
}

// Helper: find all occurrences of `needle` (findTextOffsets rules) — emits
// Ranges, which may span nodes ("Mr. <em>Darcy</em>").
export function* findTextMatches(
  input: Range | Element | Document,
  needle: string,
): Generator<Range> {
  if (!needle) return
  yield* textWalker<Range>(input, function* (strings, makeRange) {
    const starts: number[] = []
    let total = 0
    for (const s of strings) { starts.push(total); total += s.length }
    let i = 0
    for (const start of findTextOffsets(strings.join(''), needle)) {
      const end = start + needle.length
      while (starts[i] + strings[i].length <= start) i++
      let j = i
      while (starts[j] + strings[j].length < end) j++
      yield makeRange(i, start - starts[i], j, end - starts[j])
    }
  })
}
