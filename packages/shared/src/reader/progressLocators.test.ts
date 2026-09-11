import { describe, it, expect } from 'vitest'
import { PROGRESS_LOCATOR_END, PROGRESS_LOCATOR_START } from './progressLocators'
import { locatorSpace } from './locatorSpace'

describe('progress sentinels', () => {
  it('are valid JSON both clients and the server can round-trip', () => {
    expect(JSON.parse(PROGRESS_LOCATOR_END)).toEqual({ type: 'end' })
    expect(JSON.parse(PROGRESS_LOCATOR_START)).toEqual({ type: 'start' })
  })

  it('belong to no coordinate space', () => {
    // Deliberate, and load-bearing on the server: LocatorSpace.Derive returns null for these, so a
    // sentinel is never mistaken for a page or a scroll offset. It also means a sentinel cannot
    // replace a stored page/scroll position on the guarded (upload) path — which is why uploads
    // mark progress with a scroll locator instead, and only catalog books use these.
    expect(locatorSpace(PROGRESS_LOCATOR_END)).toBeNull()
    expect(locatorSpace(PROGRESS_LOCATOR_START)).toBeNull()
  })
})
