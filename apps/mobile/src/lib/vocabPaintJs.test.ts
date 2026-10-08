import { describe, it, expect, vi } from 'vitest'
import { vocabPaintJs } from './vocabPaintJs'

describe('vocabPaintJs', () => {
  const map = { quiver: { stage: 1, id: 'w1', translation: 'сагайдак' } }

  it('is a no-op in a document without markVocabWords (the PDF viewer, or the old one mid-swap)', () => {
    expect(() => new Function(vocabPaintJs(map))()).not.toThrow()
  })

  it('paints with the map when the reflow document has it', () => {
    const markVocabWords = vi.fn()
    new Function('markVocabWords', vocabPaintJs(map))(markVocabWords)
    expect(markVocabWords).toHaveBeenCalledWith(map)
  })
})
