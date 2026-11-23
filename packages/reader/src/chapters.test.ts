// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { MAX_CHAPTER_TEXT_BYTES, chapterKey, fileSummary, fitText, hasContents, offersDiscuss, placeOf, readChapterEnd, readChapterText, segmentsIn, startsIn, textBetween, tocEntries } from './chapters.mjs'

const at = (sec: number, href: string) => ({ sec, at: href, top: !href.includes('#'), anchor: null })
const places = [at(0, 's1'), at(0, 's1#c2'), null, at(2, 's3')]

describe('placeOf', () => {
  it('takes the section and the href, says whether the href names the file only, and keeps the anchor function', () => {
    const anchor = () => null
    expect(placeOf({ index: 2, anchor }, 's3.xhtml#x', 3)).toEqual({ sec: 2, at: 's3.xhtml#x', top: false, anchor })
    expect(placeOf({ index: 2, anchor }, 's3.xhtml', 3)).toEqual({ sec: 2, at: 's3.xhtml', top: true, anchor })
  })
  it('is null for an entry that names no section of the book', () => {
    for (const r of [null, undefined, {}, { index: -1 }, { index: 3 }, { index: 1.5 }, { index: '1' }]) expect(placeOf(r, 'x', 3)).toBeNull()
    expect(placeOf({ index: 0 }, undefined, 3)).toBeNull()
  })
})

describe('hasContents', () => {
  it('is whether any entry leads somewhere', () => {
    expect(hasContents(places)).toBe(true)
    expect(hasContents([null, null])).toBe(false)
    expect(hasContents([])).toBe(false)
  })
})

const xdoc = (body: string) => new DOMParser().parseFromString(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`, 'application/xhtml+xml')
/** An entry of section `sec`: `id` an anchor (found or not), null the file itself (no fragment), as foliate's resolveHref answers. */
const by = (sec: number, id: string | null) => ({ sec, at: id ? `s${sec}#${id}` : `s${sec}`, top: !id, anchor: (doc: Document) => (id ? doc.getElementById(id) : 0) })

describe('startsIn', () => {
  it('starts an entry with no fragment at the file\'s top, before the entries anchored lower down (Chapter 2, then 2.1)', () => {
    const d = xdoc('<p>Chapter 2 intro.</p><h2 id="x">2.1 X</h2><p>X text.</p>')
    expect(startsIn([by(0, 'a'), by(1, null), by(1, 'x')], 1, d)).toEqual([{ owner: 1, members: [1], el: null }, { owner: 2, members: [2], el: d.getElementById('x') }])
  })
  it('starts a file-level entry at the top even when the list names it after an anchored one of the file', () => {
    const d = xdoc('<p>Intro.</p><h2 id="x">2.1 X</h2>')
    expect(startsIn([by(1, 'x'), by(1, null)], 1, d).map((g) => [g.owner, g.el])).toEqual([[1, null], [0, d.getElementById('x')]])
  })
  it('puts an element that contains another entry\'s element before it (a section around its subsections)', () => {
    const d = xdoc('<section id="s3"><h1>Three</h1><p>Three intro.</p><h2 id="y">3.1</h2><p>Y text.</p></section>')
    expect(startsIn([by(0, 'y'), by(0, 's3')], 0, d).map((g) => g.owner)).toEqual([1, 0])
  })
  it('orders by the document, whatever the order of the list', () => {
    const d = xdoc('<h1 id="one">One</h1><h1 id="three">Three</h1><h1 id="two">Two</h1>')
    expect(startsIn([by(0, 'one'), by(0, 'two'), by(0, 'three')], 0, d).map((g) => g.owner)).toEqual([0, 2, 1])
  })
  it('leaves out an anchor the file lacks after an earlier entry of the file, and starts one at the top when it is the file\'s first', () => {
    const d = xdoc('<h1 id="one">One</h1><h1 id="two">Two</h1>')
    expect(startsIn([by(0, 'one'), by(0, 'nope'), by(0, 'two')], 0, d).map((g) => g.owner)).toEqual([0, 2])
    expect(startsIn([by(0, 'nope'), by(0, 'one')], 0, d)).toEqual([{ owner: 0, members: [0], el: null }, { owner: 1, members: [1], el: d.getElementById('one') }])
  })
  it('makes entries at the same start one group, named by the last of them in the list', () => {
    const d = xdoc('<h1 id="one">One</h1>')
    expect(startsIn([by(0, null), by(0, null), by(0, 'one'), by(0, 'one')], 0, d)).toEqual([{ owner: 1, members: [0, 1], el: null }, { owner: 3, members: [2, 3], el: d.getElementById('one') }])
  })
  it('takes only the entries of its own section, and none that lead nowhere', () => {
    expect(startsIn([null, by(1, null), by(2, null)], 1, xdoc('<p>x</p>')).map((g) => g.owner)).toEqual([1])
  })
})

describe('fileSummary', () => {
  it('says the starts in document order and whether nothing is read before the first', () => {
    expect(fileSummary([by(0, 'x')], 0, xdoc('<h1 id="x">X</h1><p>x</p>'))).toEqual({ owners: [0], top: true })
    expect(fileSummary([by(0, 'x')], 0, xdoc('<p>Still the chapter before.</p><h1 id="x">X</h1>'))).toEqual({ owners: [0], top: false })
    expect(fileSummary([by(0, null)], 0, xdoc('<p>x</p>'))).toEqual({ owners: [0], top: true })
    expect(fileSummary([by(1, null)], 0, xdoc('<p>x</p>'))).toEqual({ owners: [], top: false })
  })
})

describe('segmentsIn', () => {
  const d = xdoc('<p>tail</p><h1 id="a">A</h1><h1 id="b">B</h1>')
  const [a, b] = [d.getElementById('a'), d.getElementById('b')]
  it('gives the text before the first start to the chapter running in, then each start to the next, the last to the file\'s end', () => {
    expect(segmentsIn([{ owner: 3, members: [3], el: a }, { owner: 4, members: [4], el: b }], 1)).toEqual([
      { owner: 1, from: null, to: a, last: false }, { owner: 3, from: a, to: b, last: false }, { owner: 4, from: b, to: null, last: true }])
  })
  it('has no running-in part when a start is at the top, and the whole file is the running-in chapter\'s with no start', () => {
    expect(segmentsIn([{ owner: 3, members: [3], el: null }], 1)).toEqual([{ owner: 3, from: null, to: null, last: true }])
    expect(segmentsIn([], 1)).toEqual([{ owner: 1, from: null, to: null, last: true }])
  })
})

describe('chapterKey', () => {
  it('names a contents entry by its index, and a book with no contents by its section', () => {
    expect(chapterKey({ tocIndex: 3, section: 7 })).toBe('toc-3')
    expect(chapterKey({ tocIndex: null, section: 7 })).toBe('section-7')
  })
})

describe('offersDiscuss', () => {
  const end = (title: string | null) => ({ tocIndex: title === null ? null : 3, section: 1, title })
  it('offers a chapter by its title, and one with no title', () => {
    expect(offersDiscuss(end('The Pond'))).toBe(true)
    expect(offersDiscuss(end(null))).toBe(true)
  })
  it('does not offer front and back matter (the legacy readers\' title rule), nor no chapter end', () => {
    for (const title of ['Cover', 'Title Page', 'Copyright', 'Table of Contents', '2. Acknowledgments', 'Notes']) expect(offersDiscuss(end(title))).toBe(false)
    expect(offersDiscuss(null)).toBe(false)
  })
})

const doc = (body: string) => new DOMParser().parseFromString(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title><style>p{color:red}</style></head><body>${body}</body></html>`, 'application/xhtml+xml')

describe('textBetween', () => {
  const d = doc(`<h1 id="a">Alpha</h1><p>One   <b>bold</b>
    word, soft­hyphen.</p><script>steal()</script><style>.x{}</style><div>Loose <p>Inner</p> tail<br/>after break</div>
    <h1><a id="b"/>Beta</h1><p>Two &lt;img src=x onerror=alert(1)&gt;</p>`)
  it('gives the whole document as paragraphs of plain text, with no script or style content', () => {
    expect(textBetween(d, null, null)).toEqual(['Alpha', 'One bold word, softhyphen.', 'Loose', 'Inner', 'tail', 'after break', 'Beta', 'Two <img src=x onerror=alert(1)>'])
  })
  it('stops just before the end element, even an empty anchor inside the next heading', () => {
    expect(textBetween(d, null, d.getElementById('b'))).toEqual(['Alpha', 'One bold word, softhyphen.', 'Loose', 'Inner', 'tail', 'after break'])
  })
  it('starts at the start element, itself included', () => {
    expect(textBetween(d, d.getElementById('b'), null)).toEqual(['Beta', 'Two <img src=x onerror=alert(1)>'])
    expect(textBetween(d, d.getElementById('a'), d.getElementById('b'))[0]).toBe('Alpha')
  })
  it('leaves out what the markup says is not for reading: page-break markers, hidden and aria-hidden, inline display none', () => {
    const marked = doc('<p>a <span epub:type="pagebreak" xmlns:epub="http://www.idpf.org/2007/ops">12</span><span role="doc-pagebreak">13</span><span hidden="">h</span><span aria-hidden="true">i</span><span style="DISPLAY : none">j</span><span style="color: red">b</span></p>')
    expect(textBetween(marked, null, null)).toEqual(['a b'])
  })
  it('is empty between a place and itself', () => {
    expect(textBetween(d, d.getElementById('b'), d.getElementById('b'))).toEqual([])
  })
})

describe('fitText', () => {
  it('joins paragraphs with a blank line and says nothing was cut', () => {
    expect(fitText(['a', 'b'])).toEqual({ text: 'a\n\nb', cut: false })
    expect(fitText([])).toEqual({ text: '', cut: false })
  })
  it('stops at the last whole paragraph that fits the cap in UTF-8 bytes, and says so', () => {
    // 'яя' is 4 bytes: 'ab' (2) + blank line (2) + 4 = 8 fits a cap of 8, not of 7.
    expect(fitText(['ab', 'яя', 'c'], 8)).toEqual({ text: 'ab\n\nяя', cut: true })
    expect(fitText(['ab', 'яя'], 8)).toEqual({ text: 'ab\n\nяя', cut: false })
    expect(fitText(['ab', 'яя'], 7)).toEqual({ text: 'ab', cut: true })
  })
  it('cuts a first paragraph over the cap alone inside the cap, never through a surrogate pair', () => {
    // One unit before the pairs: the cut at cap / 3 units falls inside a pair.
    const { text, cut } = fitText(['a' + '😀'.repeat(100000)])
    expect(cut).toBe(true)
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_CHAPTER_TEXT_BYTES)
    expect(text.length).toBeGreaterThan(60000)
    expect(text.isWellFormed()).toBe(true)
  })
})

describe('readChapterEnd', () => {
  it('takes a contents entry with its title, or a section of a book with no contents', () => {
    expect(readChapterEnd({ type: 'relocate', chapterEnd: { tocIndex: 4, section: 2, title: ' The Pond ', extra: 1 } })).toEqual({ tocIndex: 4, section: 2, title: 'The Pond' })
    expect(readChapterEnd({ type: 'relocate', chapterEnd: { tocIndex: null, section: 0, title: null } })).toEqual({ tocIndex: null, section: 0, title: null })
  })
  it('reads a blank or missing title, or one that is no text, as none, and cuts a long one', () => {
    for (const title of ['', '  ', undefined, 5, { toString: () => 'x' }]) expect(readChapterEnd({ type: 'relocate', chapterEnd: { tocIndex: 1, section: 0, title } })?.title).toBeNull()
    expect(readChapterEnd({ type: 'relocate', chapterEnd: { tocIndex: 1, section: 0, title: 'T'.repeat(500) } })?.title).toHaveLength(200)
    // An astral character across the cut goes whole or not at all: the server refuses half a pair.
    expect(readChapterEnd({ type: 'relocate', chapterEnd: { tocIndex: 1, section: 0, title: 'T'.repeat(199) + '😀x' } })?.title).toBe('T'.repeat(199))
  })
  it('is null for none and for anything malformed', () => {
    for (const chapterEnd of [null, undefined, true, 'toc-1', { tocIndex: 1 }, { tocIndex: -1, section: 0 }, { tocIndex: '1', section: 0 }, { tocIndex: 1, section: 1.5 }, { tocIndex: 1, section: 100001 }])
      expect(readChapterEnd({ type: 'relocate', chapterEnd })).toBeNull()
    expect(readChapterEnd({ type: 'opened', chapterEnd: { tocIndex: 1, section: 0 } })).toBeNull()
    expect(readChapterEnd(null)).toBeNull()
  })
})

describe('readChapterText', () => {
  it('takes the text and whether it was cut', () => {
    expect(readChapterText({ type: 'chapter-text', request: 'r1', text: 'Alpha', cut: true, x: 1 })).toEqual({ request: 'r1', text: 'Alpha', cut: true })
    expect(readChapterText({ type: 'chapter-text', request: 'r1', text: 'Alpha', cut: 'yes' })).toEqual({ request: 'r1', text: 'Alpha', cut: false })
  })
  it('reads no text as an error: empty, or unavailable for anything else', () => {
    expect(readChapterText({ type: 'chapter-text', request: 'r1', error: 'empty' })).toEqual({ request: 'r1', error: 'empty' })
    expect(readChapterText({ type: 'chapter-text', request: 'r1', error: '<b>boom</b>' })).toEqual({ request: 'r1', error: 'unavailable' })
    expect(readChapterText({ type: 'chapter-text', request: 'r1', text: ' \n ' })).toEqual({ request: 'r1', error: 'empty' })
  })
  it('drops a text over the server cap, another message and an answer to no request', () => {
    expect(readChapterText({ type: 'chapter-text', request: 'r1', text: 'я'.repeat(MAX_CHAPTER_TEXT_BYTES / 2 + 1) })).toBeNull()
    expect(readChapterText({ type: 'chapter-text', request: 'r1', text: 'я'.repeat(MAX_CHAPTER_TEXT_BYTES / 2) })?.request).toBe('r1')
    expect(readChapterText({ type: 'relocate', request: 'r1', text: 'a' })).toBeNull()
    for (const request of [undefined, '', 5, 'x'.repeat(65)]) expect(readChapterText({ type: 'chapter-text', request, text: 'a' })).toBeNull()
  })
})

// ADR-033 P3: the contents the server keeps for a file, by the one chapter rule.
describe('tocEntries', () => {
  // Three linear sections of 100, 300 and 600 bytes (starts 0, 0.1, 0.4) and a non-linear note.
  const sections = [{ size: 100 }, { size: 300 }, { size: 600 }, { size: 50, linear: 'no' }]
  const resolve = (href: string) => ({ index: Number(href.split('#')[0].slice(1)) })

  it('aNestedContents_KeysEachEntryByItsIndex_WithItsDepthAndWhereItsSectionStarts', async () => {
    const toc = [
      { label: 'Part One', href: 's1', depth: 0 },
      { label: ' Chapter 1 ', href: 's1#c1', depth: 1 },
      { label: 'Dead link', href: 'nowhere', depth: 1 },
      { label: 'Chapter 2', href: 's2', depth: 1 },
    ]
    expect(await tocEntries(toc, sections, (h) => (h === 'nowhere' ? null : resolve(h)))).toEqual([
      { key: 'toc-0', title: 'Part One', depth: 0, fraction: 0.1 },
      { key: 'toc-1', title: 'Chapter 1', depth: 1, fraction: 0.1 },
      { key: 'toc-3', title: 'Chapter 2', depth: 1, fraction: 0.4 },
    ])
  })

  it('aBookWithNoContents_HasItsLinearSectionsAsChapters_AFixedLayoutNone', async () => {
    const dead = [{ label: 'Broken', href: 'x', depth: 0 }]
    expect(await tocEntries(dead, sections, () => null)).toEqual([
      { key: 'section-0', title: 'Section 1', depth: 0, fraction: 0 },
      { key: 'section-1', title: 'Section 2', depth: 0, fraction: 0.1 },
      { key: 'section-2', title: 'Section 3', depth: 0, fraction: 0.4 },
    ])
    expect(await tocEntries([], sections, resolve, true)).toEqual([])
  })
})
