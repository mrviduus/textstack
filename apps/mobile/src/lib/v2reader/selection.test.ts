import { describe, expect, it } from 'vitest'
import { SELECTION_MAX_CHARS as ENGINE_MAX_CHARS } from '../../../../../packages/reader-engine/src/engine'
import { MAX_SELECTION_CFI, MAX_SELECTION_SENTENCE, MAX_SELECTION_TEXT, SELECTION_MAX_CHARS, readSelection, selectionMessage } from './selection.mjs'

const box = (left: number, top: number, width = 0, height = 0) => ({ left, top, width, height })
const build = (o: Partial<Parameters<typeof selectionMessage>[0]> = {}) =>
  selectionMessage({ index: 2, text: ' two words\n', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)', sentence: 'One two words here.', frame: box(-300.4, 10), range: box(320.2, 40.6, 80.5, 19.4), ...o })

describe('v2 reader selection message', () => {
  it('selectionMessage_Selection_TrimmedTextAndHostViewportRect', () => {
    expect(build()).toEqual({
      type: 'selection', index: 2, text: 'two words', tooLong: false, cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)',
      sentence: 'One two words here.', rect: { x: 20, y: 51, w: 81, h: 19 },
    })
  })

  it('selectionMessage_WhitespaceOnly_Null', () => {
    expect(build({ text: ' \n\t ' })).toBeNull()
  })

  it('selectionMessage_OverTranslateCap_TooLong', () => {
    expect(SELECTION_MAX_CHARS).toBe(ENGINE_MAX_CHARS)
    expect(build({ text: 'a'.repeat(501) })?.tooLong).toBe(true)
    expect(build({ text: 'a'.repeat(500) })?.tooLong).toBe(false)
  })

  it('selectionMessage_OverTextCap_CutAtCapNeverHalfASurrogatePair', () => {
    expect(build({ text: 'a'.repeat(MAX_SELECTION_TEXT + 10) })?.text).toHaveLength(MAX_SELECTION_TEXT)
    const cut = build({ text: 'a'.repeat(MAX_SELECTION_TEXT - 1) + '\u{1F600}b' })!.text
    expect(cut).toBe('a'.repeat(MAX_SELECTION_TEXT - 1))
    expect(readSelection(build({ text: 'x'.repeat(100_000) }))).not.toBeNull()
  })

  it('selectionMessage_LongCfi_Null', () => {
    expect(build({ cfi: 'epubcfi(' + 'x'.repeat(MAX_SELECTION_CFI) + ')' })?.cfi).toBeNull()
  })

  it('selectionMessage_LongSentence_Cut', () => {
    expect(build({ sentence: 's'.repeat(MAX_SELECTION_SENTENCE + 1) })?.sentence).toHaveLength(MAX_SELECTION_SENTENCE)
  })

  it('readSelection_BuiltMessage_RoundTripsThroughJson', () => {
    const m = build()!
    const { type: _, ...fields } = m
    expect(readSelection(JSON.parse(JSON.stringify(m)))).toEqual(fields)
    expect(readSelection({ ...m, cfi: null })?.cfi).toBeNull()
  })
})

describe('v2 reader selection validator (hostile payloads)', () => {
  const good = () => JSON.parse(JSON.stringify(build()!))

  it.each([
    ['not an object', () => 'selection'],
    ['null', () => null],
    ['another type', () => ({ ...good(), type: 'word' })],
    ['index missing', () => ({ ...good(), index: undefined })],
    ['index a string', () => ({ ...good(), index: '2' })],
    ['index negative', () => ({ ...good(), index: -1 })],
    ['index fractional', () => ({ ...good(), index: 1.5 })],
    ['text a number', () => ({ ...good(), text: 42 })],
    ['text empty', () => ({ ...good(), text: '' })],
    ['text over cap', () => ({ ...good(), text: 'x'.repeat(MAX_SELECTION_TEXT + 1) })],
    ['text huge', () => ({ ...good(), text: 'x'.repeat(5_000_000) })],
    ['sentence missing', () => ({ ...good(), sentence: undefined })],
    ['sentence over cap', () => ({ ...good(), sentence: 'x'.repeat(MAX_SELECTION_SENTENCE + 1) })],
    ['cfi missing', () => ({ ...good(), cfi: undefined })],
    ['cfi a number', () => ({ ...good(), cfi: 7 })],
    ['cfi over cap', () => ({ ...good(), cfi: 'epubcfi(' + 'x'.repeat(MAX_SELECTION_CFI) })],
    ['cfi another scheme', () => ({ ...good(), cfi: 'javascript:alert(1)' })],
    ['tooLong a string', () => ({ ...good(), tooLong: 'false' })],
    ['rect missing', () => ({ ...good(), rect: undefined })],
    ['rect null', () => ({ ...good(), rect: null })],
    ['rect a string', () => ({ ...good(), rect: '1,2,3,4' })],
    ['rect x NaN', () => ({ ...good(), rect: { ...good().rect, x: NaN } })],
    ['rect y Infinity', () => ({ ...good(), rect: { ...good().rect, y: Infinity } })],
    ['rect w -Infinity', () => ({ ...good(), rect: { ...good().rect, w: -Infinity } })],
    ['rect h a string', () => ({ ...good(), rect: { ...good().rect, h: '19' } })],
    ['rect w negative', () => ({ ...good(), rect: { ...good().rect, w: -1 } })],
    ['rect h negative', () => ({ ...good(), rect: { ...good().rect, h: -1 } })],
    ['fields only under __proto__', () => JSON.parse(`{"type":"selection","__proto__":${JSON.stringify(good())}}`)],
  ])('readSelection_%s_Dropped', (_, payload) => {
    expect(() => readSelection(payload())).not.toThrow()
    expect(readSelection(payload())).toBeNull()
  })

  it('readSelection_ExtraAndPrototypeKeys_OnlyKnownFieldsKept', () => {
    const m = JSON.parse(`{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"extra":1}`)
    const hostile = { ...good(), ...m, rect: JSON.parse(`{"x":1,"y":2,"w":3,"h":4,"__proto__":{"polluted":true},"z":9}`) }
    const s = readSelection(hostile)!
    expect(Object.keys(s).sort()).toEqual(['cfi', 'index', 'rect', 'sentence', 'text', 'tooLong'])
    expect(Object.keys(s.rect).sort()).toEqual(['h', 'w', 'x', 'y'])
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(s.rect)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
