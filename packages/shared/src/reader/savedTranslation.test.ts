import { describe, it, expect } from 'vitest'
import { savedTranslationOffer } from './savedTranslation'

describe('savedTranslationOffer', () => {
  it('TR-3: the bubble differs from the saved translation → offers the saved one', () => {
    expect(savedTranslationOffer('enterrado', 'embolsou', 'pt', 'pt')).toBe('enterrado')
  })

  it('TR-3: same translation (trimmed, any case), nothing saved, or nothing shown → no offer', () => {
    expect(savedTranslationOffer('embolsou', ' embolsou ', 'pt', 'pt')).toBeNull()
    expect(savedTranslationOffer('Embolsou', 'embolsou', 'pt', 'pt')).toBeNull()
    expect(savedTranslationOffer('ПОКЛАВ', 'поклав', 'uk', 'uk')).toBeNull()
    expect(savedTranslationOffer(undefined, 'embolsou', 'pt', 'pt')).toBeNull()
    expect(savedTranslationOffer('', 'embolsou', 'pt', 'pt')).toBeNull()
    expect(savedTranslationOffer('enterrado', null, 'pt', 'pt')).toBeNull()
  })

  it('TR-3: the shown translation is not in the current native language → no offer', () => {
    expect(savedTranslationOffer('enterrado', 'eingesteckt', 'de', 'pt')).toBeNull()
    expect(savedTranslationOffer('enterrado', 'embolsou', null, 'pt')).toBeNull()
    expect(savedTranslationOffer('enterrado', 'embolsou', 'PT', 'pt')).toBe('enterrado')
  })
})
