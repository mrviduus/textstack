import { describe, it, expect } from 'vitest'
import { reflowWritesEnabled, deviceLayout } from './readerWriteMode'

describe('reflowWritesEnabled', () => {
  it('is false while the PDF viewer owns the position', () => {
    // The defect in one line. With this true, the reader's unmount flush wrote
    // scroll:<url-slug>:0 over page:16 and the book fell from 14% to 4%.
    expect(reflowWritesEnabled({ hasOriginalPdf: true, forceReflow: false })).toBe(false)
  })

  it('is true for an ordinary reflow book', () => {
    expect(reflowWritesEnabled({ hasOriginalPdf: false, forceReflow: false })).toBe(true)
  })

  it('is true when a PDF is being read as text', () => {
    // The "read as text" fallback exists for PDFs that will not render. That
    // reader is in scroll space and must be able to save — which is also why
    // the server rule cannot simply rank page above scroll.
    expect(reflowWritesEnabled({ hasOriginalPdf: true, forceReflow: true })).toBe(true)
  })

  it('is true before the book has loaded', () => {
    // hasOriginalPdf is false until the fetch lands. Deciding at mount would
    // decide on this value, which is why the guard is applied at call time.
    expect(reflowWritesEnabled({ hasOriginalPdf: false, forceReflow: false })).toBe(true)
  })
})

describe('deviceLayout (H1) — is it a PDF, answered by the device', () => {
  it('the original file on the phone → Original layout, no network needed', () => {
    expect(deviceLayout({ hasLocalOriginal: true, knownPdf: true })).toBe('original')
    expect(deviceLayout({ hasLocalOriginal: true, knownPdf: null })).toBe('original')
  })

  it('known not to be a PDF → reflow, no network needed', () => {
    expect(deviceLayout({ hasLocalOriginal: false, knownPdf: false })).toBe('reflow')
  })

  it('a PDF whose file is not here, or a book the device knows nothing about → unknown', () => {
    // Stream vs. extracted text is the network's call; the reflow WebView must not render first,
    // or its scroll writes `scroll:` over `page:N`.
    expect(deviceLayout({ hasLocalOriginal: false, knownPdf: true })).toBeNull()
    expect(deviceLayout({ hasLocalOriginal: false, knownPdf: null })).toBeNull()
  })
})
