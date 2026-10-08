import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source guard (style of `rareWordNoticeWired.test.ts`). QA-007: a tapped word was
 * translated without its sentence ("pocketed" → "enterrado", buried). Every reader
 * translate call must send the same `{ sentence, bookId }` — the server picks the
 * sense from the sentence and the genre from the bookId, and the client cache keys
 * on both, so a call that drops either also misses the toolbar's cached answer.
 * These are RN components the test lane cannot render; pin the wiring in the source.
 */
const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8')

/** The JSX element `<Name ... />` as text. */
const element = (src: string, name: string) => {
  const m = src.match(new RegExp(`<${name}\\b[\\s\\S]*?\\/>`))
  if (!m) throw new Error(`<${name}> not found`)
  return m[0]
}

describe('reader translate calls carry sentence + bookId', () => {
  const shell = read('src/components/reader/ReaderShell.tsx')

  it('ReaderShell_TranslationSheet_GetsSentenceAndBookId', () => {
    const sheet = element(shell, 'TranslationSheet')
    expect(sheet).toContain('sentence={selection?.sentence}')
    expect(sheet).toContain('bookId={translateBookId}')
  })

  it('ReaderShell_SelectionActionBar_GetsBookId', () => {
    expect(element(shell, 'SelectionActionBar')).toContain('bookId={translateBookId}')
  })

  // Same id web sends (`userBookId || editionId`): the server resolves either.
  it('ReaderShell_TranslateBookId_IsTheSourceId', () => {
    expect(shell).toMatch(/const translateBookId = source\.id \|\| undefined/)
  })

  it('TranslationSheet_CachedTranslate_PassesContext', () => {
    expect(read('src/components/TranslationSheet.tsx'))
      .toContain('cachedTranslate(text, fromLang, translationTarget, { sentence, bookId })')
  })

  it('SelectionActionBar_Context_IncludesBookId', () => {
    expect(read('src/components/SelectionActionBar.tsx')).toContain('const ctx = { sentence, bookId }')
  })

  it('useReaderVocabActions_SaveGloss_PassesBookId', () => {
    expect(read('src/hooks/useReaderVocabActions.ts'))
      .toMatch(/cachedTranslate\(sourceText, textLanguage, targetLang, \{ sentence: saved\.sentence, bookId \}\)/)
  })
})
