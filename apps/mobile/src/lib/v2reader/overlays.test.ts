import { describe, expect, it } from 'vitest'
import { mergeOverlay } from './overlays.mjs'

const cfi = 'epubcfi(/6/8!/4/2,/1:5,/1:10)'
const hl = { value: cfi, index: 3, hl: { id: 'h1' } }

describe('v2 reader overlays', () => {
  it('glossOverAHighlightedRange_KeepsTheHighlight', () => {
    // Both decorations share foliate's overlay key (the CFI), so they must share one overlay:
    // tapping a highlighted word used to erase its highlight from the screen.
    const both = mergeOverlay(hl, { value: cfi, index: 3, gloss: 'twenty' })
    expect(both).toEqual({ value: cfi, index: 3, hl: { id: 'h1' }, gloss: 'twenty' })
  })

  it('highlightOverAGlossedWord_KeepsTheGloss', () => {
    const gloss = { value: cfi, index: 3, gloss: 'twenty' }
    expect(mergeOverlay(gloss, hl)).toEqual({ value: cfi, index: 3, hl: { id: 'h1' }, gloss: 'twenty' })
  })

  it('newGlossForTheSameRange_ReplacesOnlyTheText', () => {
    const first = mergeOverlay(hl, { value: cfi, index: 3, gloss: 'twenty' })
    expect(mergeOverlay(first, { value: cfi, index: 3, gloss: 'score' })).toMatchObject({ hl: { id: 'h1' }, gloss: 'score' })
  })

  it('nothingThereYet_IsJustThePatch', () => {
    expect(mergeOverlay(undefined, hl)).toEqual(hl)
  })
})
