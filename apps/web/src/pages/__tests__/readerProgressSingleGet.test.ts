import { describe, it, expect } from 'vitest'
import { readerPageSource } from './readerPageSource'

/**
 * R4-5: a PDF open in Original layout fetched `/me/books/{id}/progress` twice — once in
 * ReaderPage for the resume page, once in useUserBookProgress for the restore. The page now
 * reads the hook's answer (`userProgress.serverRow`), whose GET is also the bounded one.
 *
 * Review #4: and it reads it through `serverResumePage` at every render, so a reflow → Original
 * switch takes the server page only when it is provably newer than the page just read here.
 */
describe('ReaderPage', () => {
  // The page and the hooks its code moved to (the PDF resume lives in useReaderPdfOriginal).
  const source = readerPageSource()

  it('does not fetch reading progress at open', () => {
    expect(source).not.toMatch(/getUserBookProgress|getProgress\(/)
  })

  it('resumes a PDF from the progress hook, through the newer-than-local rule', () => {
    expect(source).toMatch(/serverResumePage\(id, userProgress\.serverRow\)/)
    expect(source).not.toMatch(/parsePdfPageLocator\(userProgress/)
  })
})
