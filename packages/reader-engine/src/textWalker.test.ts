// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { textWalker, findTextMatches } from './textWalker'

describe('textWalker', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
    document.body.appendChild(root)
  })

  it('walks text nodes in a simple element', () => {
    root.innerHTML = '<p>Hello <strong>world</strong> end.</p>'
    const seen: string[] = []
    const gen = textWalker<string>(root, function* (strings) {
      for (const s of strings) yield s
    })
    for (const s of gen) seen.push(s)
    expect(seen).toEqual(['Hello ', 'world', ' end.'])
  })

  it('skips script and style contents', () => {
    root.innerHTML = '<p>a</p><script>BAD</script><style>X</style><p>b</p>'
    const seen: string[] = []
    const gen = textWalker<string>(root, function* (strings) {
      for (const s of strings) yield s
    })
    for (const s of gen) seen.push(s)
    expect(seen).toEqual(['a', 'b'])
  })

  it('accepts a Range and limits to its span', () => {
    root.innerHTML = '<p>one</p><p>two</p><p>three</p>'
    const ps = root.querySelectorAll('p')
    const range = document.createRange()
    range.setStart(ps[0].firstChild!, 0)
    range.setEnd(ps[1].firstChild!, 3)
    const seen: string[] = []
    const gen = textWalker<string>(range, function* (strings) {
      for (const s of strings) yield s
    })
    for (const s of gen) seen.push(s)
    expect(seen).toContain('one')
    expect(seen).toContain('two')
    expect(seen).not.toContain('three')
  })

  it('makeRange constructs a multi-node range', () => {
    root.innerHTML = '<p>Hello <strong>bold</strong> world</p>'
    const ranges: Range[] = []
    const gen = textWalker<Range>(root, function* (strings, makeRange) {
      // span from node[0] start → node[2] end
      yield makeRange(0, 0, strings.length - 1, strings[strings.length - 1].length)
    })
    for (const r of gen) ranges.push(r)
    expect(ranges).toHaveLength(1)
    expect(ranges[0].toString()).toBe('Hello bold world')
  })

  it('custom filterFn can reject specific elements', () => {
    root.innerHTML = '<p>keep</p><aside>drop</aside><p>keep2</p>'
    const filter = (node: Node): number => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as Element).tagName.toLowerCase()
        if (tag === 'aside') return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_SKIP
      }
      return NodeFilter.FILTER_ACCEPT
    }
    const seen: string[] = []
    const gen = textWalker<string>(root, function* (strings) {
      for (const s of strings) yield s
    }, filter)
    for (const s of gen) seen.push(s)
    expect(seen).toEqual(['keep', 'keep2'])
  })
})

describe('findTextMatches', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
    document.body.appendChild(root)
  })

  it('emits a range per occurrence, case-insensitive', () => {
    root.innerHTML = '<p>The cat sat. The CAT ran.</p>'
    const hits = Array.from(findTextMatches(root, 'cat'))
    expect(hits).toHaveLength(2)
    expect(hits[0].toString().toLowerCase()).toBe('cat')
  })

  it('returns nothing for empty needle', () => {
    root.textContent = 'anything'
    expect(Array.from(findTextMatches(root, ''))).toEqual([])
  })

  it('returns nothing when no match', () => {
    root.textContent = 'nothing here'
    expect(Array.from(findTextMatches(root, 'absent'))).toEqual([])
  })
})

// Fixture suite — real-world DOM shapes from book content that historically
// broke overlay coord mapping. Each fixture asserts that findTextMatches
// returns a range whose toString() equals the needle verbatim. That's the
// minimum contract every annotation layer relies on.
describe('textWalker — real-chapter fixtures', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
    document.body.appendChild(root)
  })

  it('matches across nested inline spans (word split by styling)', () => {
    // "unbelievable" split mid-word by a stray <span> (common from cleanup).
    root.innerHTML = '<p>Something <em>un<span>bel</span>iev</em>able happened.</p>'
    const hits = Array.from(findTextMatches(root, 'iev'))
    expect(hits).toHaveLength(1)
    expect(hits[0].toString()).toBe('iev')
  })

  it('matches plain text when a word has a soft-hyphen splitter', () => {
    // Soft hyphen (U+00AD) between "un" and "believable". Search for the
    // visible form — current impl treats U+00AD as a real character, so the
    // visible-form lookup returns no hit. This test pins that behavior so a
    // future "normalize away soft hyphens" change doesn't silently regress.
    root.innerHTML = '<p>Something un\u00ADbelievable happened.</p>'
    const withShy = Array.from(findTextMatches(root, 'un\u00ADbelievable'))
    expect(withShy).toHaveLength(1)
    const visibleOnly = Array.from(findTextMatches(root, 'unbelievable'))
    expect(visibleOnly).toHaveLength(0)
  })

  it('skips script/style but keeps text in footnote <sup>', () => {
    root.innerHTML = '<p>A footnote<sup><a href="#n1">1</a></sup> here.</p><script>const cat=1</script>'
    const hits = Array.from(findTextMatches(root, 'footnote'))
    expect(hits).toHaveLength(1)
    expect(Array.from(findTextMatches(root, 'const'))).toHaveLength(0)
  })

  it('walks nested block structures (list inside blockquote)', () => {
    root.innerHTML = '<blockquote><ul><li>one <strong>two</strong> three</li></ul></blockquote>'
    const hits = Array.from(findTextMatches(root, 'two'))
    expect(hits).toHaveLength(1)
    expect(hits[0].toString()).toBe('two')
  })

  it('walks text inside table cells', () => {
    root.innerHTML = '<table><tr><td>alpha</td><td>beta</td></tr><tr><td>alpha</td></tr></table>'
    const hits = Array.from(findTextMatches(root, 'alpha'))
    expect(hits).toHaveLength(2)
  })

  it('handles mixed-direction inline spans (LTR host, RTL insert)', () => {
    root.innerHTML = '<p>He said <span dir="rtl">שלום</span> quietly.</p>'
    const hits = Array.from(findTextMatches(root, 'quietly'))
    expect(hits).toHaveLength(1)
    expect(hits[0].toString()).toBe('quietly')
  })

  it('respects custom filter that rejects MathML roots', () => {
    root.innerHTML = '<p>See <math><mi>x</mi></math> here too.</p>'
    const filter = (node: Node): number => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as Element).tagName.toLowerCase()
        if (tag === 'math') return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_SKIP
      }
      return NodeFilter.FILTER_ACCEPT
    }
    const strs: string[] = []
    const gen = textWalker<string>(root, function* (strings) {
      for (const s of strings) yield s
    }, filter)
    for (const s of gen) strs.push(s)
    expect(strs.join('')).toBe('See  here too.')
  })

  it('respects custom filter that rejects ruby annotation (<rt>)', () => {
    // Base text walks, reading annotation is excluded by caller filter.
    root.innerHTML = '<p><ruby>漢<rt>kan</rt></ruby><ruby>字<rt>ji</rt></ruby> means "character".</p>'
    const filter = (node: Node): number => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as Element).tagName.toLowerCase()
        if (tag === 'rt' || tag === 'rp') return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_SKIP
      }
      return NodeFilter.FILTER_ACCEPT
    }
    const strs: string[] = []
    const gen = textWalker<string>(root, function* (strings) {
      for (const s of strings) yield s
    }, filter)
    for (const s of gen) strs.push(s)
    expect(strs.join('')).toContain('漢')
    expect(strs.join('')).toContain('字')
    expect(strs.join('')).not.toContain('kan')
    expect(strs.join('')).not.toContain('ji')
  })

  it('matches across a Range that crosses a paragraph boundary', () => {
    root.innerHTML = '<p>Chapter one begins here.</p><p>And continues here.</p>'
    const ps = root.querySelectorAll('p')
    const range = document.createRange()
    range.setStart(ps[0].firstChild!, 0)
    range.setEnd(ps[1].firstChild!, ps[1].firstChild!.nodeValue!.length)
    const hits = Array.from(findTextMatches(range, 'here'))
    expect(hits).toHaveLength(2)
  })

  it('emits one range per identical match even when adjacent', () => {
    root.innerHTML = '<p>hahahaha</p>'
    // With needle "haha" and step = max(1, len), we get non-overlapping matches
    // at 0 and 4 — 2 hits total.
    const hits = Array.from(findTextMatches(root, 'haha'))
    expect(hits).toHaveLength(2)
    expect(hits.map(h => h.startOffset)).toEqual([0, 4])
  })

  it('ignores empty text nodes that sit between elements', () => {
    const p = document.createElement('p')
    p.appendChild(document.createTextNode(''))
    p.appendChild(document.createTextNode('visible'))
    p.appendChild(document.createTextNode(''))
    root.appendChild(p)
    const hits = Array.from(findTextMatches(root, 'visible'))
    expect(hits).toHaveLength(1)
    expect(hits[0].toString()).toBe('visible')
  })
})
