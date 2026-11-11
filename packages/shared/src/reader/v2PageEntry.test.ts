import { describe, expect, it } from 'vitest'
import { entryChanges, normalisedHighlight, pageEntry, PAGE_ENTRY_VERSION, type HeldHighlight } from './v2PageEntry'
import type { PageHighlight } from './v2LocalSync'

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const NEW = '99999999-9999-4999-8999-999999999999'
const hl = (id: string, cfi = 'epubcfi(/6/4!/4/2,/1:0,/1:5)', text = 'Hello there'): PageHighlight =>
  ({ id, cfi, index: 1, quote: text.slice(0, 64), selectedText: text, prefix: '', suffix: '', color: 'yellow', at: 1 })
const held = (h: PageHighlight, deleted = false): HeldHighlight => ({ id: h.id, highlight: h, deleted })
const pos = { cfi: 'epubcfi(/6/4!/4/2/1:0)', quote: 'Hello', index: 1, fraction: 0.1, at: 5 }
const newId = () => NEW

describe('v2 page entry', () => {
  it('pageEntry_Version_IsTheStoreVersion', () => {
    expect(pageEntry({ sha256: 'a', size: 1, name: 'b.epub' }, null, [])).toEqual({ v: PAGE_ENTRY_VERSION, book: { sha256: 'a', size: 1, name: 'b.epub' }, position: null, highlights: [] })
    expect(PAGE_ENTRY_VERSION).toBe(1)
  })

  it('normalisedHighlight_Pre1078_QuoteBecomesSelectedTextAndIsCut', () => {
    const long = 'x'.repeat(70)
    const h = normalisedHighlight({ id: U1, cfi: 'epubcfi(/6/2!/4)', quote: long })
    expect(h.selectedText).toBe(long)
    expect(h.quote).toBe('x'.repeat(64))
    const now = hl(U1)
    expect(normalisedHighlight(now)).toBe(now)
  })

  it('entryChanges_PositionSame_NotChanged_KeyOrderIgnored', () => {
    const swapped = { at: 5, fraction: 0.1, index: 1, quote: 'Hello', cfi: pos.cfi }
    expect(entryChanges({ position: pos, highlights: [] }, { position: swapped, highlights: [] }, newId).position).toBeNull()
    expect(entryChanges({ position: null, highlights: [] }, { position: pos, highlights: [] }, newId).position).toEqual(pos)
    expect(entryChanges({ position: pos, highlights: [] }, { position: null, highlights: [] }, newId).position).toBeNull()
  })

  it('entryChanges_NewAndEditedAndUnchanged_OnlyTheChangedOnes', () => {
    const a = hl(U1), b = hl(U2, 'epubcfi(/6/6!/4/2,/1:0,/1:3)', 'Bye')
    const out = entryChanges({ position: null, highlights: [held(a), held(b)] }, { position: null, highlights: [a, { ...b, color: 'green' }, hl(NEW.replace('9', '8'), 'epubcfi(/6/8!/4)', 'New')] }, newId)
    expect(out.highlights.map((c) => [c.highlight.id, c.isNew])).toEqual([[U2, false], [NEW.replace('9', '8'), true]])
  })

  it('entryChanges_Tombstoned_StaysDeleted', () => {
    const a = hl(U1)
    expect(entryChanges({ position: null, highlights: [held(a, true)] }, { position: null, highlights: [{ ...a, color: 'red' }] }, newId).highlights).toEqual([])
  })

  it('entryChanges_NonUuidId_TwinOfALiveOneSkipped_ElseANewV4Id', () => {
    const a = hl(U1)
    const twin = { ...a, id: 'h123' }
    expect(entryChanges({ position: null, highlights: [held(a)] }, { position: null, highlights: [twin] }, newId).highlights).toEqual([])
    const other = hl('h456', 'epubcfi(/6/10!/4)', 'Other')
    expect(entryChanges({ position: null, highlights: [held(a)] }, { position: null, highlights: [other] }, newId).highlights)
      .toEqual([{ highlight: { ...other, id: NEW }, isNew: true }])
  })

  it('entryChanges_UnknownUuidTwinOfALiveOne_Skipped_DeletedTwinDoesNotCount', () => {
    const a = hl(U1)
    const rekeyed = { ...a, id: U2 }
    expect(entryChanges({ position: null, highlights: [held(a)] }, { position: null, highlights: [rekeyed] }, newId).highlights).toEqual([])
    expect(entryChanges({ position: null, highlights: [held(a, true)] }, { position: null, highlights: [rekeyed] }, newId).highlights)
      .toEqual([{ highlight: rekeyed, isNew: true }])
  })

  it('entryChanges_SameNewHighlightTwiceInOneEntry_OneChange', () => {
    const a = hl('h1')
    expect(entryChanges({ position: null, highlights: [] }, { position: null, highlights: [a, { ...a, id: 'h2' }] }, newId).highlights).toHaveLength(1)
  })
})
