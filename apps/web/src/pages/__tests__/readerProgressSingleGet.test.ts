import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * R4-5: a PDF open in Original layout fetched `/me/books/{id}/progress` twice — once in
 * ReaderPage for the resume page, once in useUserBookProgress for the restore. The page now
 * reads the hook's answer (`userProgress.serverLocator`), whose GET is also the bounded one.
 */
describe('ReaderPage', () => {
  const source = readFileSync(resolve(__dirname, '../ReaderPage.tsx'), 'utf8')

  it('does not fetch reading progress itself', () => {
    expect(source).not.toMatch(/getUserBookProgress|getProgress\(/)
  })

  it('resumes a PDF from the progress hook', () => {
    expect(source).toMatch(/parsePdfPageLocator\(userProgress\.serverLocator\)/)
  })
})
