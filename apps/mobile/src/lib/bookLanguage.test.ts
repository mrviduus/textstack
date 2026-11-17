import { describe, it, expect } from 'vitest'
import { readerTextLanguage } from './bookLanguage'

describe('readerTextLanguage (M5)', () => {
  it("an upload's own language wins over the app language", () => {
    expect(readerTextLanguage('de', 'en')).toBe('de')
    expect(readerTextLanguage('pt-BR', 'en')).toBe('pt-BR')
  })

  it('missing or junk falls back to the app language', () => {
    expect(readerTextLanguage(null, 'en')).toBe('en')
    expect(readerTextLanguage('', 'en')).toBe('en')
    expect(readerTextLanguage('  ', 'en')).toBe('en')
    expect(readerTextLanguage('und', 'en')).toBe('en')
    expect(readerTextLanguage('English', 'en')).toBe('en')
  })
})
