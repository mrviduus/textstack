// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { MAX_CHAPTER_TEXT_BYTES, chapterBefore, chapterKey, chapterOf, discussEntryOf, fitText, placeOf, readChapterEnd, readChapterText, textBetween } from './chapters.mjs'

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
  it('ends a chapter at the next entry that leads somewhere else, at any depth', () => {
    expect(chapterOf(places, 0)).toEqual({ start: places[0], end: places[2] })
    expect(chapterOf(places, 1)).toEqual({ start: places[1], end: places[2] })
  })
  it('skips an entry that leads nowhere, and lets an entry run over the files before the next one', () => {
    expect(chapterOf(places, 2)).toEqual({ start: places[2], end: places[4] })
  })
  it('never ends a chapter at a later entry that points back before it: the last chapter ends with the book', () => {
    expect(chapterOf(places, 4)).toEqual({ start: places[4], end: null })
  })
  it('is null for no entry, an entry that leads nowhere and anything that is no index', () => {
    for (const i of [null, -1, 3, 6, 1.5, '1' as unknown as number]) expect(chapterOf(places, i)).toBeNull()
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

describe('discussEntryOf', () => {
  const toc = [{ index: 0, label: 'Alpha' }, { index: 2, label: 'Gamma' }]
  it('is the entry whose end is on screen, by its index in the page\'s list', () => {
    expect(discussEntryOf({ tocIndex: 2, section: 5 }, toc)).toEqual({ title: 'Gamma' })
  })
  it('is an untitled chapter for a section of a book with no contents', () => {
    expect(discussEntryOf({ tocIndex: null, section: 5 }, [])).toEqual({ title: null })
  })
  it('is none with no chapter end, for an entry the host does not hold, and for a section of a book that has contents', () => {
    expect(discussEntryOf(null, toc)).toBeNull()
    expect(discussEntryOf({ tocIndex: 1, section: 0 }, toc)).toBeNull()
    expect(discussEntryOf({ tocIndex: null, section: 0 }, toc)).toBeNull()
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
  it('takes a contents entry or a section of a book with no contents', () => {
    expect(readChapterEnd({ type: 'relocate', chapterEnd: { tocIndex: 4, section: 2, extra: 1 } })).toEqual({ tocIndex: 4, section: 2 })
    expect(readChapterEnd({ type: 'relocate', chapterEnd: { tocIndex: null, section: 0 } })).toEqual({ tocIndex: null, section: 0 })
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
