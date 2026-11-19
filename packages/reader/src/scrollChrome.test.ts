import { describe, it, expect } from 'vitest'
import { createScrollIntent, readReaderScroll } from './scrollChrome.mjs'
import { createHostMoves, hidesBarsOnRelocate } from './chrome.mjs'

describe('reading controls on scroll', () => {
  it('ignores delayed navigation scrolls and reads the next real gesture from the new landing', () => {
    const intent = createScrollIntent()
    const host = createHostMoves()
    intent.move({ section: 0, offset: 400 })
    host.start()
    intent.reset()
    const suppressed = (now: number) => !hidesBarsOnRelocate({ moved: true, msSinceHostMove: host.onRelocate(now) })
    expect(intent.move({ section: 0, offset: 2500 }, suppressed(100))).toBeNull()
    expect(intent.move({ section: 0, offset: 2534 }, suppressed(200))).toBeNull()
    expect(intent.move({ section: 0, offset: 2434 }, suppressed(1200))).toBe('show')
    // No scroll event from a navigation: forget the previous location instead of hiding on the first reverse gesture.
    host.start()
    intent.reset()
    host.onRelocate(2000)
    expect(intent.move({ section: 0, offset: 4000 }, suppressed(3200))).toBeNull()
    expect(intent.move({ section: 0, offset: 3900 }, suppressed(3300))).toBe('show')
  })
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
