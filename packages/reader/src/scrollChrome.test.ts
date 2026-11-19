import { describe, it, expect } from 'vitest'
import { createScrollIntent, readReaderScroll } from './scrollChrome.mjs'

describe('reading controls on scroll', () => {
  it('shows on deliberate backwards movement, hides forwards, ignores jitter and chapter resets', () => {
    const intent = createScrollIntent()
    expect(intent.move({ section: 0, offset: 100 })).toBeNull()
    expect(intent.move({ section: 0, offset: 90 })).toBeNull()
    expect(intent.move({ section: 0, offset: 74 })).toBe('show')
    expect(intent.move({ section: 0, offset: 78 })).toBeNull()
    expect(intent.move({ section: 0, offset: 77 })).toBeNull()
    expect(intent.move({ section: 0, offset: 105 })).toBe('hide')
    expect(intent.move({ section: 1, offset: 0 })).toBeNull()
    intent.reset()
    expect(intent.move({ section: 1, offset: 100 })).toBeNull()
  })
  it('rejects malformed or unbounded positions', () => {
    for (const raw of [null, {}, { type: 'reader-scroll', section: -1, offset: 0 }, { type: 'reader-scroll', section: 0, offset: Infinity }]) expect(readReaderScroll(raw)).toBeNull()
    expect(readReaderScroll({ type: 'reader-scroll', section: 1, offset: 20 })).toEqual({ section: 1, offset: 20 })
  })
})
