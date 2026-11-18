import { describe, expect, it } from 'vitest'
import { MAX_TOC_DEPTH, MAX_TOC_ENTRIES, readToc, tocAround, withTitle } from './toc.mjs'

const opened = (toc: unknown) => ({ type: 'opened', toc })
const entry = (index: number, label = `e${index}`, depth = 0) => ({ index, label, href: `${label}.xhtml`, depth })

describe('v2 reader table of contents (host side)', () => {
  it('readToc_NestedEntries_KeptInOrderWithTheirPlaceAndDepth', () => {
    expect(readToc(opened([
      { label: 'Part One', href: 'p1.xhtml', depth: 0 },
      { label: 'The Pond', href: 'c1.xhtml#a', depth: 1 },
      { label: 'Notes', href: 'n.xhtml', depth: 2 },
    ]))).toEqual([
      { index: 0, label: 'Part One', href: 'p1.xhtml', depth: 0 },
      { index: 1, label: 'The Pond', href: 'c1.xhtml#a', depth: 1 },
      { index: 2, label: 'Notes', href: 'n.xhtml', depth: 2 },
    ])
  })

  it.each([
    ['no message', undefined],
    ['no toc', {}],
    ['a toc string', opened('c1.xhtml')],
    ['a toc object', opened({ 0: { label: 'a', href: 'b' }, length: 1 })],
    ['an empty toc', opened([])],
  ])('readToc_%s_Empty', (_name, m) => {
    expect(readToc(m)).toEqual([])
  })

  it.each([
    ['null', null],
    ['a string', 'c1.xhtml'],
    ['an array', ['a', 'b']],
    ['no label', { href: 'x.xhtml' }],
    ['a label that is no string', { label: 7, href: 'x.xhtml' }],
    ['a blank label', { label: ' \n\t', href: 'x.xhtml' }],
    ['no href', { label: 'x' }],
    ['an empty href', { label: 'x', href: '' }],
    ['an href that is no string', { label: 'x', href: 3 }],
    ['an href over the cap', { label: 'x', href: 'x'.repeat(2049) }],
  ])('readToc_AnEntryThatIs%s_DroppedAndTheOthersKeepTheirPlace', (_name, bad) => {
    const toc = readToc(opened([{ label: 'a', href: 'a.xhtml', depth: 0 }, bad, { label: 'c', href: 'c.xhtml', depth: 0 }]))
    expect(toc.map((e) => [e.index, e.label])).toEqual([[0, 'a'], [2, 'c']])
  })

  it('readToc_LabelAndHref_TrimmedCutAndTakenAtTheCap', () => {
    const [e] = readToc(opened([{ label: `  ${'x'.repeat(500)}  `, href: 'h'.repeat(2048), depth: 0 }]))
    expect(e.label).toBe('x'.repeat(200))
    expect(e.href).toHaveLength(2048)
  })

  it.each([
    [0, 0], [3, 3], [MAX_TOC_DEPTH, MAX_TOC_DEPTH], [MAX_TOC_DEPTH + 1, MAX_TOC_DEPTH], [1e9, MAX_TOC_DEPTH],
    [-1, 0], [1.5, 0], ['2', 0], [null, 0], [undefined, 0], [NaN, 0], [Infinity, 0],
  ])('readToc_Depth%s_Is%s', (depth, expected) => {
    expect(readToc(opened([{ label: 'a', href: 'a.xhtml', depth }]))[0].depth).toBe(expected)
  })

  it('readToc_MoreEntriesThanTheCap_TheFirstOnesByPlace', () => {
    const many = Array.from({ length: MAX_TOC_ENTRIES + 10 }, (_, i) => (i === 0 ? null : { label: `e${i}`, href: `${i}.xhtml`, depth: 0 }))
    const toc = readToc(opened(many))
    // The cap is on the place in the page's list, not on the entries kept: the dropped first one is not made up for.
    expect(toc).toHaveLength(MAX_TOC_ENTRIES - 1)
    expect(toc[toc.length - 1].index).toBe(MAX_TOC_ENTRIES - 1)
  })

  it('readToc_UnknownFields_NotKept', () => {
    expect(readToc(opened([{ label: 'a', href: 'a.xhtml', depth: 0, subitems: [1], html: '<b>' }]))).toEqual([{ index: 0, label: 'a', href: 'a.xhtml', depth: 0 }])
  })
})

describe('v2 reader current entry', () => {
  const toc = [entry(0), entry(1), entry(2)]

  it('tocAround_InTheMiddle_CurrentWithBothNeighbours', () => {
    expect(tocAround(toc, 1)).toEqual({ prev: toc[0], current: toc[1], next: toc[2] })
  })

  it('tocAround_FirstEntry_NoPrev', () => {
    expect(tocAround(toc, 0)).toEqual({ prev: null, current: toc[0], next: toc[1] })
  })

  it('tocAround_LastEntry_NoNext', () => {
    expect(tocAround(toc, 2)).toEqual({ prev: toc[1], current: toc[2], next: null })
  })

  it('tocAround_RepeatedLabels_ResolvedByPlaceNotLabel', () => {
    const notes = [entry(0, 'Notes'), entry(1, 'Notes'), entry(2, 'Notes')]
    expect(tocAround(notes, 1).current).toBe(notes[1])
  })

  it.each([[null], [undefined], [-1], [1.5], ['1'], [NaN]])('tocAround_TocIndex%s_NoCurrentAndTheFirstEntryNext', (tocIndex) => {
    expect(tocAround(toc, tocIndex as never)).toEqual({ prev: null, current: null, next: toc[0] })
  })

  it('tocAround_TheCurrentEntryWasDropped_NoCurrentAndTheNearestKeptNeighbours', () => {
    const kept = [entry(0), entry(2), entry(5)]
    expect(tocAround(kept, 3)).toEqual({ prev: kept[1], current: null, next: kept[2] })
    // The entry after a dropped one is marked by its own place, not by its position in the kept list.
    expect(tocAround(kept, 2)).toEqual({ prev: kept[0], current: kept[1], next: kept[2] })
    expect(tocAround(kept, 1)).toEqual({ prev: kept[0], current: null, next: kept[1] })
  })

  it('tocAround_TocIndexPastTheList_NoCurrentAndTheLastEntryPrev', () => {
    expect(tocAround(toc, 99)).toEqual({ prev: toc[2], current: null, next: null })
  })

  it('tocAround_NeighboursWithTheCurrentHref_SkippedForTheNearestOtherPlace', () => {
    // "Part I" and "Chapter 1" open the same file: the page names the last of them, and the other is no way back.
    const at = (index: number, label: string, href: string) => ({ index, label, href, depth: 0 })
    const same = [at(0, 'Preface', 'pre.xhtml'), at(1, 'Part I', 'ch1.xhtml'), at(2, 'Chapter 1', 'ch1.xhtml'), at(3, 'Epigraph', 'ch1.xhtml'), at(4, 'Chapter 2', 'ch2.xhtml')]
    expect(tocAround(same, 2)).toEqual({ prev: same[0], current: same[2], next: same[4] })
    expect(tocAround(same, 1)).toEqual({ prev: same[0], current: same[1], next: same[4] })
    expect(tocAround(same, 3)).toEqual({ prev: same[0], current: same[3], next: same[4] })
    // Only the current entry's own href is skipped: fragments are other places, and so are equal neighbours of another entry.
    expect(tocAround(same, 4)).toEqual({ prev: same[3], current: same[4], next: null })
    const anchors = [at(0, 'One', 'c.xhtml#a'), at(1, 'Two', 'c.xhtml#b'), at(2, 'Three', 'c.xhtml#c')]
    expect(tocAround(anchors, 1)).toEqual({ prev: anchors[0], current: anchors[1], next: anchors[2] })
  })

  it('tocAround_EveryEntryOnTheCurrentHref_NoNeighbours', () => {
    const one = [entry(0, 'a'), { ...entry(1), href: 'a.xhtml' }]
    expect(tocAround(one, 1)).toEqual({ prev: null, current: one[1], next: null })
  })

  it('tocAround_NoCurrentEntry_NothingSkipped', () => {
    const kept = [{ ...entry(0), href: 'x.xhtml' }, { ...entry(2), href: 'x.xhtml' }]
    expect(tocAround(kept, 1)).toEqual({ prev: kept[0], current: null, next: kept[1] })
    expect(tocAround(kept, null)).toEqual({ prev: null, current: null, next: kept[0] })
  })

  it('tocAround_EmptyToc_Nothing', () => {
    expect(tocAround([], 0)).toEqual({ prev: null, current: null, next: null })
  })
})

describe('v2 reader title labels', () => {
  it('withTitle_APlainTitle_Filled', () => {
    expect(withTitle('Next section: {title}', 'The Pond')).toBe('Next section: The Pond')
  })

  it.each([['Earn $$ fast'], ['$& and $1'], ["$` $'"], ['{title}']])('withTitle_%s_KeptAsText', (title) => {
    expect(withTitle('Next section: {title}', title)).toBe(`Next section: ${title}`)
  })
})
