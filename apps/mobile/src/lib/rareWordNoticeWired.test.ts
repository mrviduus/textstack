import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source guard (style of `chapterLoadOrder.test.ts`). A rare-word save returns
 * `lookup`/`lookup_pending`; the hook stores `lookupState` and returns. If no
 * screen renders it, Save on a rare word does nothing visible — which shipped
 * once (5b527a37 dropped WordCard and the notice with it). The WebView isn't
 * e2e-drivable, so pin the wiring in the source.
 */
const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8')

describe('rare-word notice is wired', () => {
  it('SelectionActionBar renders RareWordNotice', () => {
    expect(read('src/components/SelectionActionBar.tsx')).toMatch(/<RareWordNotice[\s\S]*onAddAnyway=/)
  })

  it('ReaderShell passes lookupState + addAnyway to the bar', () => {
    const shell = read('src/components/reader/ReaderShell.tsx')
    expect(shell).toContain('lookup={lookupState}')
    expect(shell).toContain('vocabActions.addAnyway(lookupState)')
  })

  it('addAnyway promotes the lookup', () => {
    expect(read('src/hooks/useReaderVocabActions.ts')).toContain('vocabularyApi.promoteLookup(')
  })
})

describe('Save is hidden behind the rare-word notice', () => {
  it('Save button condition excludes lookup', () => {
    expect(read('src/components/SelectionActionBar.tsx')).toContain('!wordSaved && !lookup && onSaveWord')
  })
})
