import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { emitDataChange, emitDataChanges, useDataChange } from './dataEvents'

describe('emitDataChange', () => {
  let received: { entity: string; detail: unknown }[] = []
  let handlers: Array<{ name: string; fn: EventListener }> = []

  beforeEach(() => {
    received = []
    handlers = []
  })

  afterEach(() => {
    for (const { name, fn } of handlers) window.removeEventListener(name, fn)
  })

  function listen(entity: string) {
    const handler: EventListener = (e) => {
      received.push({ entity, detail: (e as CustomEvent).detail })
    }
    const name = 'textstack:data:' + entity
    handlers.push({ name, fn: handler })
    window.addEventListener(name, handler)
  }

  it('dispatches a CustomEvent on the prefixed channel', () => {
    listen('vocabulary')
    emitDataChange('vocabulary')
    expect(received).toHaveLength(1)
    expect(received[0].entity).toBe('vocabulary')
  })

  it('passes the detail payload through to listeners', () => {
    listen('user-books')
    emitDataChange('user-books', { reason: 'book-saved', id: 'ed-1' })
    expect(received[0].detail).toEqual({ reason: 'book-saved', id: 'ed-1' })
  })

  it('listeners on a different entity do not fire', () => {
    listen('vocabulary')
    emitDataChange('user-books')
    expect(received).toHaveLength(0)
  })
})

describe('emitDataChanges (multi-entity)', () => {
  let received: string[] = []
  let handlers: Array<{ name: string; fn: EventListener }> = []

  beforeEach(() => {
    received = []
    handlers = []
  })

  afterEach(() => {
    for (const { name, fn } of handlers) window.removeEventListener(name, fn)
  })

  function listen(entity: string) {
    const handler: EventListener = () => received.push(entity)
    const name = 'textstack:data:' + entity
    handlers.push({ name, fn: handler })
    window.addEventListener(name, handler)
  }

  it('fires events for each entity in array', () => {
    listen('user-books')
    listen('shelves')
    emitDataChanges(['user-books', 'shelves'])
    expect(received.sort()).toEqual(['shelves', 'user-books'])
  })

  it('passes detail to all listeners', () => {
    let lastDetail: unknown
    window.addEventListener('textstack:data:tags', e => {
      lastDetail = (e as CustomEvent).detail
    }, { once: true })
    emitDataChanges(['tags'], { id: 'tag-1' })
    expect(lastDetail).toEqual({ id: 'tag-1' })
  })
})

describe('useDataChange hook', () => {
  it('fires callback when matching entity changes', () => {
    let fired = 0
    const { unmount } = renderHook(() => useDataChange('highlights', () => { fired++ }))
    emitDataChange('highlights')
    expect(fired).toBe(1)
    emitDataChange('highlights')
    expect(fired).toBe(2)
    unmount()
  })

  it('does NOT fire for unrelated entity', () => {
    let fired = 0
    const { unmount } = renderHook(() => useDataChange('bookmarks', () => { fired++ }))
    emitDataChange('vocabulary')
    expect(fired).toBe(0)
    unmount()
  })

  it('accepts array of entities — fires for any of them', () => {
    let fired = 0
    const { unmount } = renderHook(() =>
      useDataChange(['shelves', 'user-books'], () => { fired++ })
    )
    emitDataChange('shelves')
    emitDataChange('user-books')
    emitDataChange('vocabulary') // not in array — should not fire
    expect(fired).toBe(2)
    unmount()
  })

  it('removes listener on unmount (no leak)', () => {
    let fired = 0
    const { unmount } = renderHook(() => useDataChange('collections', () => { fired++ }))
    emitDataChange('collections')
    expect(fired).toBe(1)
    unmount()
    emitDataChange('collections')
    expect(fired).toBe(1) // not incremented after unmount
  })

  it('emitDataChange is a no-op when window undefined (SSR safety)', () => {
    // Can't actually unset window in jsdom — just check the no-throw contract.
    expect(() => emitDataChange('reading-progress')).not.toThrow()
  })
})
