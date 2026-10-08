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
    expect(markVocabWords).toHaveBeenCalledWith({ quiver: { stage: 1, translation: 'сагайдак' } })
  })

  // Review of #780: the map now carries each word's sentence; the WebView paints from
  // stage + translation only, so nothing else crosses the bridge on every repaint.
  it('vocabPaintJs_EntryWithSentenceAndId_InjectsOnlyStageAndTranslation', () => {
    const markVocabWords = vi.fn()
    const full = { quiver: { stage: 1, id: 'w1', translation: 'сагайдак', sentence: 'An arrow in the quiver.' } }
    new Function('markVocabWords', vocabPaintJs(full))(markVocabWords)
    expect(markVocabWords).toHaveBeenCalledWith({ quiver: { stage: 1, translation: 'сагайдак' } })
  })
})
