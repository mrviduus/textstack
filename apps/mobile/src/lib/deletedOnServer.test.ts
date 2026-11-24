import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { failedLoadView } from './deletedOnServer'

describe('failedLoadView', () => {
  const v = (o: Partial<Parameters<typeof failedLoadView>[0]>) =>
    failedLoadView({ notFound: false, hasCopy: false, offline: false, ...o })

  it('404_IsNotFound_EvenWithACopy', () => expect(v({ notFound: true, hasCopy: true })).toBe('notfound'))
  it('offlineWithCopy_IsCached', () => expect(v({ hasCopy: true, offline: true })).toBe('cached'))
  it('offlineNoCopy_IsOffline', () => expect(v({ offline: true })).toBe('offline'))
  it('otherError_IsFailed', () => expect(v({})).toBe('failed'))
})

/** Source guard: the screen cannot be mounted here. */
describe('book screen wiring', () => {
  const page = readFileSync(resolve(__dirname, '../../app/my-books/[id].tsx'), 'utf8')

  it('the failed-load view alone drives the screen: one switch, no second branch on the copy', () => {
    expect(page).toContain('switch (view) {')
    expect(page).toContain("case 'cached':")
    expect(page).toMatch(/case 'offline':\s*case 'failed':\s*setLoadError\(view\)/)
    expect(page).not.toContain('else if (rehydrated)')
  })

  it('readButton_BookWithProgressButNoChapter_SaysContinue', () => {
    // #1532: a V2 place (a PDF at 50%) names no chapter, so how far in decides too.
    expect(page).toContain('const started = !!continueSlug || (bookPct ?? 0) > 0')
    expect(page).toContain("{started ? 'Continue Reading' : 'Start Reading'}")
  })
})
