// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { MAX_CHAPTER_TEXT_BYTES, boundsIn, chapterBefore, chapterKey, chapterOf, fitText, hasContents, offersDiscuss, placeOf, readChapterEnd, readChapterText, textBetween } from './chapters.mjs'

const at = (sec: number, href: string) => ({ sec, at: href, anchor: null })
// Part I (s1) > Chapter 1 (s1, the same place) and Chapter 2 (s1#c2); an entry that leads nowhere; Chapter 3 (s3: s2 is its
// predecessor's second file); an appendix listed last that points back into s1.
const places = [at(0, 's1'), at(0, 's1'), at(0, 's1#c2'), null, at(2, 's3'), at(0, 's1#app')]

describe('placeOf', () => {
  it('takes the section and the href, and keeps the anchor function', () => {
    const anchor = () => null
    expect(placeOf({ index: 2, anchor }, 's3.xhtml#x', 3)).toEqual({ sec: 2, at: 's3.xhtml#x', anchor })
  })
  it('is null for an entry that names no section of the book', () => {
    for (const r of [null, undefined, {}, { index: -1 }, { index: 3 }, { index: 1.5 }, { index: '1' }]) expect(placeOf(r, 'x', 3)).toBeNull()
    expect(placeOf({ index: 0 }, undefined, 3)).toBeNull()
  })
})

describe('chapterOf', () => {
  it('names the other entries of its section at another href, listed before or after, and the next entry in a later section', () => {
    expect(chapterOf(places, 0)).toEqual({ start: places[0], inSection: [places[2], places[5]], next: places[4], startShared: false })
    expect(chapterOf(places, 2)).toEqual({ start: places[2], inSection: [places[0], places[1], places[5]], next: places[4], startShared: true })
  })
  it('has no next entry for the last chapter, whatever points back before it', () => {
    expect(chapterOf(places, 4)).toEqual({ start: places[4], inSection: [], next: null, startShared: false })
  })
  it('says the start is shared only when an EARLIER entry leads into the same section at another href', () => {
    expect(chapterOf(places, 1)?.startShared).toBe(false)
    expect(chapterOf(places, 5)?.startShared).toBe(true)
  })
  it('is null for no entry, an entry that leads nowhere and anything that is no index', () => {
    for (const i of [null, -1, 3, 6, 1.5, '1' as unknown as number]) expect(chapterOf(places, i)).toBeNull()
  })
})

describe('hasContents', () => {
  it('is whether any entry leads somewhere', () => {
    expect(hasContents(places)).toBe(true)
    expect(hasContents([null, null])).toBe(false)
    expect(hasContents([])).toBe(false)
  })
})

describe('boundsIn', () => {
  const d = new DOMParser().parseFromString('<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="one">One</h1><p>1</p><h1 id="three"><a id="in"/>Three</h1><p>3</p><h1 id="two">Two</h1><p>2</p></body></html>', 'application/xhtml+xml')
  const el = (id: string) => d.getElementById(id)
  const by = (sec: number, id: string | null) => ({ sec, at: `s${sec}#${id}`, anchor: (doc: Document) => (id ? doc.getElementById(id) : 0) })
  // The contents list One, Missing, Two, Three (Three is before Two in the file), then Next in the file after.
  const [one, missing, two, three, inside, next] = [by(0, 'one'), by(0, 'nope'), by(0, 'two'), by(0, 'three'), by(0, 'in'), by(1, 'n')]
  const chapter = (start: typeof one, startShared = false) => ({ start, inSection: [one, missing, two, three, inside].filter((p) => p !== start), next, startShared })

  it('ends a chapter at the nearest entry after its start in the document, whatever the order of the list', () => {
    expect(boundsIn(chapter(one), 0, d)).toEqual({ from: el('one'), to: el('three'), more: false })
    expect(boundsIn(chapter(three, true), 0, d)).toEqual({ from: el('three'), to: el('two'), more: false })
  })
  it('lets nothing placed before its start, inside it, or at an anchor the file lacks end it: it goes on after the file', () => {
    expect(boundsIn(chapter(two, true), 0, d)).toEqual({ from: el('two'), to: null, more: true })
  })
  it('refuses a start the file does not have when an earlier entry leads into the same file', () => {
    expect(boundsIn(chapter(missing, true), 0, d)).toEqual({ refuse: true })
  })
  it('takes the file from its start for a start it does not have, as the file\'s first entry', () => {
    expect(boundsIn(chapter(missing, false), 0, d)).toEqual({ from: null, to: el('one'), more: false })
  })
  it('goes through a file between, and into the next entry\'s file up to its anchor', () => {
    const far = { ...chapter(one), next: by(2, 'two') }
    expect(boundsIn(far, 1, d)).toEqual({ from: null, to: null, more: true })
    expect(boundsIn(far, 2, d)).toEqual({ from: null, to: el('two'), more: false })
  })
  it('has nothing in the next entry\'s file when that entry starts it (no anchor, or one not found)', () => {
    expect(boundsIn({ ...chapter(one), next: by(1, null) }, 1, d)).toEqual({ none: true })
    expect(boundsIn({ ...chapter(one), next: by(1, 'nope') }, 1, d)).toEqual({ none: true })
  })
})

describe('chapterBefore', () => {
  it('is the nearest earlier entry at another place', () => {
    expect(chapterBefore(places, 2)).toBe(1)
    expect(chapterBefore(places, 4)).toBe(2)
  })
  it('is null for the first place of the book, whatever entries share it', () => {
    expect(chapterBefore(places, 0)).toBeNull()
    expect(chapterBefore(places, 1)).toBeNull()
    expect(chapterBefore(places, 3)).toBeNull()
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
