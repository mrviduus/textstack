import { describe, it, expect } from 'vitest'
import { showsFinishBook } from './finishBook.mjs'
import { readRelocate } from './chrome.mjs'

describe('showsFinishBook (#1266)', () => {
  it('showsFinishBook_EndOnScreenInATextBookOrPdf_Shows', () => {
    for (const format of ['epub', 'mobi', 'fb2', 'pdf']) expect(showsFinishBook({ atEnd: true, format })).toBe(true)
  })

  it('showsFinishBook_NotAtTheEnd_Hidden', () => {
    expect(showsFinishBook({ atEnd: false, format: 'epub' })).toBe(false)
  })

  it('showsFinishBook_Cbz_HiddenUntilItsStateCanBeWritten', () => {
    expect(showsFinishBook({ atEnd: true, format: 'cbz' })).toBe(false)
  })

  it('showsFinishBook_FormatNotKnown_Hidden', () => {
    for (const format of [null, undefined, '']) expect(showsFinishBook({ atEnd: true, format })).toBe(false)
  })

  it('showsFinishBook_AtEndNotExactlyTrue_Hidden', () => {
    expect(showsFinishBook({ atEnd: 1 as unknown as boolean, format: 'epub' })).toBe(false)
  })

  it('showsFinishBook_FromARelocate_FollowsThePagesAtEndOnly', () => {
    const at = (m: object) => showsFinishBook({ atEnd: readRelocate({ type: 'relocate', ...m })!.atEnd, format: 'epub' })
    expect(at({ fraction: 0.4, atEnd: true })).toBe(true)
    // The fraction is the top of the screen in scrolled flow and a spread's first page: never the test.
    expect(at({ fraction: 1, index: 9, sections: 10 })).toBe(false)
    expect(at({ fraction: 1, atEnd: 'true' })).toBe(false)
  })
})
