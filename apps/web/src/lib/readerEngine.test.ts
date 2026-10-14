import { describe, it, expect } from 'vitest'
import { mountedEngineFor, setMountedEngine, unmountEngine } from './readerEngine'
import type { ReaderEngine } from '@textstack/reader-engine'

describe('unmountEngine', () => {
  it('unmountEngine_AnotherEngineHoldsTheSlot_LeavesIt', () => {
    // Web remounts the chapter: the next chapter's engine can register before the last one goes.
    const first = {} as ReaderEngine
    const second = {} as ReaderEngine
    setMountedEngine({ engine: first, href: 'a' })
    setMountedEngine({ engine: second, href: 'b' })
    unmountEngine(first)
    expect(mountedEngineFor('b')?.engine).toBe(second)
    unmountEngine(second)
    expect(mountedEngineFor('b')).toBeNull()
  })
})
