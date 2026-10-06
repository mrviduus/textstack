import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

describe('M5 wiring — the book language reaches TTS, translate, explain and saves', () => {
  const shell = readFileSync(resolve(__dirname, '../components/reader/ReaderShell.tsx'), 'utf8')
  const userBook = readFileSync(resolve(__dirname, '../components/reader/useUserBookReaderSource.ts'), 'utf8')

  it('the upload source hands its language over, online and offline', () => {
    expect(userBook).toContain('setBookLanguage(b.language')
    expect(userBook).toContain('setBookLanguage(meta.language')
    expect(userBook).toMatch(/bookLanguage,/)
  })

  it('the shell speaks, translates, explains and saves in it — never the app language', () => {
    expect(shell).toContain('const textLanguage = readerTextLanguage(props.bookLanguage, language)')
    expect(shell).not.toMatch(/lang: language \}/)
    expect(shell).not.toMatch(/fromLang=\{language\}/)
    expect(shell).toMatch(/bookLanguage: textLanguage/)
    expect(shell).toMatch(/textLanguage,\n/)
  })
})
