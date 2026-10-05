import { describe, it, expect } from 'vitest'
import { countCollectionsHolding, decideLibraryRemoval } from './libraryRemoval'

describe('countCollectionsHolding', () => {
  it('counts the lists that contain the book', () => {
    expect(countCollectionsHolding('b', [['a', 'b'], ['c'], ['b']])).toBe(2)
  })

  it('no collections → 0', () => {
    expect(countCollectionsHolding('b', [])).toBe(0)
  })
})

describe('decideLibraryRemoval', () => {
  it('in no collection → no confirm (unchanged one-tap removal)', () => {
    expect(decideLibraryRemoval(0)).toEqual({ confirm: false })
  })

  it('in one collection → confirm, singular copy', () => {
    expect(decideLibraryRemoval(1)).toEqual({
      confirm: true, bodyKey: 'library.actions.removeFromLibraryConfirmBodyOne', count: 1,
    })
  })

  it('in several → confirm, plural copy with the count', () => {
    expect(decideLibraryRemoval(3)).toEqual({
      confirm: true, bodyKey: 'library.actions.removeFromLibraryConfirmBodyMany', count: 3,
    })
  })

  it('a nonsense count does not prompt', () => {
    expect(decideLibraryRemoval(Number.NaN)).toEqual({ confirm: false })
    expect(decideLibraryRemoval(-1)).toEqual({ confirm: false })
  })
})
