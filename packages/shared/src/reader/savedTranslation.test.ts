import { describe, it, expect } from 'vitest'
import { savedTranslationOffer } from './savedTranslation'

describe('savedTranslationOffer', () => {
  it('TR-3: the bubble differs from the saved translation → offers the saved one', () => {
    expect(savedTranslationOffer('enterrado', 'embolsou')).toBe('enterrado')
  })

  it('TR-3: same translation (trimmed), nothing saved, or nothing shown → no offer', () => {
    expect(savedTranslationOffer('embolsou', ' embolsou ')).toBeNull()
    expect(savedTranslationOffer(undefined, 'embolsou')).toBeNull()
    expect(savedTranslationOffer('', 'embolsou')).toBeNull()
    expect(savedTranslationOffer('enterrado', null)).toBeNull()
  })
})
