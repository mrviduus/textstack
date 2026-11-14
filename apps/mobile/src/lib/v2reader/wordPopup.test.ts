import { describe, expect, it } from 'vitest'
import { MAX_SELECTION_CFI, MAX_SELECTION_INDEX, MAX_SELECTION_PX, MAX_SELECTION_SENTENCE, readSelection } from './selection.mjs'
import { MAX_WORD, popupStep, readLang, readWord } from './wordPopup.mjs'

// #1269: the word popup's state, one rule for both hosts.

const WIDTH = 1000
const RECT = { x: 480, y: 100, w: 40, h: 20 }
const wordMsg = (o: object = {}) => ({ type: 'word', index: 2, word: 'pond', sentence: 'By the pond.', cfi: 'epubcfi(/6/4!/4/2,/1:7,/1:11)', rect: RECT, ...o })
const word = (x = 480, w = 40) => readWord(wordMsg({ rect: { ...RECT, x, w } }))!
const selection = readSelection({ type: 'selection', index: 2, text: 'by the pond', sentence: 'By the pond.', cfi: null, rect: RECT })!
const paged = { width: WIDTH, flow: 'paginated' as const, dir: 'ltr' as const }
const scrolled = { ...paged, flow: 'scrolled' as const }

describe('v2 reader word popup', () => {
  it('readWord_AWord_TheKnownFieldsOnly', () => {
    expect(readWord(wordMsg({ extra: '<b>' }))).toEqual({ index: 2, word: 'pond', sentence: 'By the pond.', cfi: 'epubcfi(/6/4!/4/2,/1:7,/1:11)', rect: RECT })
    expect(readWord(wordMsg({ cfi: null }))?.cfi).toBeNull()
  })

  it.each([
    ['another type', wordMsg({ type: 'tap' })],
    ['null', null],
    ['a string', 'word'],
    ['index negative', wordMsg({ index: -1 })],
    ['index past its bound', wordMsg({ index: MAX_SELECTION_INDEX + 1 })],
    ['index a float', wordMsg({ index: 1.5 })],
    ['word missing', wordMsg({ word: undefined })],
    ['word whitespace', wordMsg({ word: ' \n' })],
    ['word past its cap', wordMsg({ word: 'a'.repeat(MAX_WORD + 1) })],
    ['sentence missing', wordMsg({ sentence: undefined })],
    ['sentence past its cap', wordMsg({ sentence: 'a'.repeat(MAX_SELECTION_SENTENCE + 1) })],
    ['cfi missing', wordMsg({ cfi: undefined })],
    ['cfi of another scheme', wordMsg({ cfi: 'javascript:1' })],
    ['cfi past its cap', wordMsg({ cfi: 'epubcfi(' + 'x'.repeat(MAX_SELECTION_CFI) })],
    ['no rect', wordMsg({ rect: undefined })],
    ['rect a string', wordMsg({ rect: 'x' })],
    ['x NaN', wordMsg({ rect: { ...RECT, x: NaN } })],
    ['w missing', wordMsg({ rect: { x: 1, y: 1, h: 1 } })],
    ['w negative', wordMsg({ rect: { ...RECT, w: -1 } })],
    ['x past its bound', wordMsg({ rect: { ...RECT, x: MAX_SELECTION_PX + 1 } })],
  ])('readWord_%s_Dropped', (_, m) => {
    expect(() => readWord(m)).not.toThrow()
    expect(readWord(m)).toBeNull()
  })

  it('readWord_AtTheCaps_Taken', () => {
    expect(readWord(wordMsg({ word: 'a'.repeat(MAX_WORD), sentence: 'a'.repeat(MAX_SELECTION_SENTENCE), index: MAX_SELECTION_INDEX }))).not.toBeNull()
  })

  it.each([
    ['en', 'en'], ['en-GB', 'en'], ['EN_us', 'en'], ['he', 'he'],
    // Three letters: null, so the host's fallback applies (an English book tagged `eng` is not translated en→en).
    ['eng', null], ['fre', null], ['ukr', null], ['eng-US', null],
    ['und', null], ['', null], ['e', null], ['english', null], ['en GB', null], ['en-<b>', null], [42, null], [undefined, null],
  ])('readLang_%s_%s', (lang, want) => {
    expect(readLang({ type: 'opened', lang })).toBe(want)
  })

  it('wordInTheCentre_OpensItsPopup_NoTurn', () => {
    expect(popupStep(null, { type: 'word', word: word() }, paged)).toEqual({ popup: { kind: 'word', ...word() }, turn: null })
  })

  it('wordOnAnEdge_Paginated_TurnsThePage_NoPopup', () => {
    // The centre of the word decides, as a tap there: right edge on, left edge back (rtl: the other way round).
    expect(popupStep(null, { type: 'word', word: word(WIDTH - 60) }, paged)).toEqual({ popup: null, turn: 'next' })
    expect(popupStep(null, { type: 'word', word: word(10) }, paged)).toEqual({ popup: null, turn: 'prev' })
    expect(popupStep(null, { type: 'word', word: word(10) }, { ...paged, dir: 'rtl' })).toEqual({ popup: null, turn: 'next' })
    // A word with a popup open, on an edge: the popup closes and the page turns.
    expect(popupStep({ kind: 'word', ...word() }, { type: 'word', word: word(WIDTH - 60) }, paged)).toEqual({ popup: null, turn: 'next' })
  })

  it('wordOnAnEdge_Scrolled_OpensItsPopup', () => {
    expect(popupStep(null, { type: 'word', word: word(WIDTH - 60) }, scrolled).popup?.kind).toBe('word')
  })

  it('aWordStraddlingTheEdge_ItsCentreDecides', () => {
    // From 230 to 270: its centre (250) is in the centre zone (edge < 250).
    expect(popupStep(null, { type: 'word', word: word(230, 40) }, paged).turn).toBeNull()
    expect(popupStep(null, { type: 'word', word: word(200, 40) }, paged).turn).toBe('prev')
  })

  it('anotherWord_ReplacesThePopup', () => {
    const other = { ...word(), word: 'lake' }
    expect(popupStep({ kind: 'word', ...word() }, { type: 'word', word: other }, paged).popup).toEqual({ kind: 'word', ...other })
  })

  it('tap_NothingOpen_ActsAsATap', () => {
    expect(popupStep(null, { type: 'tap', x: WIDTH / 2 }, paged)).toEqual({ popup: null, turn: 'toggle' })
    expect(popupStep(null, { type: 'tap', x: WIDTH - 5 }, paged)).toEqual({ popup: null, turn: 'next' })
  })

  it('tap_APopupOpen_ClosesIt_TheCentreDoesNothingMore_AnEdgeStillTurns', () => {
    const open = { kind: 'word' as const, ...word() }
    expect(popupStep(open, { type: 'tap', x: WIDTH / 2 }, paged)).toEqual({ popup: null, turn: null })
    expect(popupStep(open, { type: 'tap', x: WIDTH - 5 }, paged)).toEqual({ popup: null, turn: 'next' })
    expect(popupStep({ kind: 'selection', ...selection }, { type: 'tap', x: WIDTH / 2 }, scrolled)).toEqual({ popup: null, turn: null })
  })

  it('selection_SupersedesAWord', () => {
    expect(popupStep({ kind: 'word', ...word() }, { type: 'selection', selection }, paged)).toEqual({ popup: { kind: 'selection', ...selection }, turn: null })
  })

  it('selectionCleared_ClosesTheToolbar_NeverAWordPopup', () => {
    expect(popupStep({ kind: 'selection', ...selection }, { type: 'selection-cleared' }, paged).popup).toBeNull()
    const open = { kind: 'word' as const, ...word() }
    expect(popupStep(open, { type: 'selection-cleared' }, paged).popup).toBe(open)
  })

  it('moved_ClosesAWordPopup_NeverTheToolbar', () => {
    expect(popupStep({ kind: 'word', ...word() }, { type: 'moved' }, paged)).toEqual({ popup: null, turn: null })
    const open = { kind: 'selection' as const, ...selection }
    expect(popupStep(open, { type: 'moved' }, paged)).toEqual({ popup: open, turn: null })
  })
})
