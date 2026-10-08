import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source guard (style of `rareWordNoticeWired.test.ts`): these are RN components the test
 * lane cannot render. TR-1: every reader translate call for a tapped word sends its sentence.
 */
const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8')
const element = (src: string, name: string) => {
  const m = src.match(new RegExp(`<${name}\\b[\\s\\S]*?\\/>`))
  if (!m) throw new Error(`<${name}> not found`)
  return m[0]
}

describe('TR-1: mobile reader translate calls carry the tapped sentence', () => {
  const shell = read('src/components/reader/ReaderShell.tsx')

  it('TR-1: SelectionActionBar translates with the selection sentence', () => {
    expect(element(shell, 'SelectionActionBar')).toContain('sentence={selection.sentence}')
    const bar = read('src/components/SelectionActionBar.tsx')
    expect(bar).toContain('peekTranslation(selectedText, fromLang, translationTarget!, ctx)')
    expect(bar).toContain('cachedTranslate(selectedText, fromLang, translationTarget!, ctx)')
  })

  it('TR-1: TranslationSheet translates with the selection sentence', () => {
    expect(element(shell, 'TranslationSheet')).toContain('sentence={selection?.sentence}')
    expect(read('src/components/TranslationSheet.tsx'))
      .toContain('cachedTranslate(text, fromLang, translationTarget, { sentence, bookId })')
  })
})
