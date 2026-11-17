import { describe, it, expect } from 'vitest'
import { shouldApplyUpdate, isReading } from './updateApply'

const ready = { isUpdatePending: true, isDev: false, pathname: '/library' }

describe('shouldApplyUpdate', () => {
  it('applies as soon as an update is ready', () => {
    expect(shouldApplyUpdate(ready)).toBe(true)
  })

  it('waits while the user is reading', () => {
    // The one interruption this product cannot justify. The next check offers
    // the same update again, so waiting costs nothing.
    expect(shouldApplyUpdate({ ...ready, pathname: '/my-books/read/b1/chapter-1' })).toBe(false)
    expect(shouldApplyUpdate({ ...ready, pathname: '/my-books/read/12/ch-3' })).toBe(false)
  })

  it('does nothing without an update, and nothing in development', () => {
    expect(shouldApplyUpdate({ ...ready, isUpdatePending: false })).toBe(false)
    // Reloading a Metro-served build drops the dev session and gains nothing.
    expect(shouldApplyUpdate({ ...ready, isDev: true })).toBe(false)
  })
})

describe('isReading', () => {
  it('matches a reader route and its children, not its neighbours', () => {
    expect(isReading('/my-books/read')).toBe(true)
    expect(isReading('/my-books/read/9')).toBe(true)
    // Not reading: the book's detail screen, and a route that merely starts
    // with the same letters.
    expect(isReading('/my-books/9')).toBe(false)
    expect(isReading('/my-books/reader-club')).toBe(false)
    expect(isReading('/library')).toBe(false)
  })
})
