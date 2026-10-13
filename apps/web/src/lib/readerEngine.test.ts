import { describe, it, expect, beforeEach } from 'vitest'
import { readerEngineEnabled, mountedEngineFor, setMountedEngine, unmountEngine } from './readerEngine'
import type { ReaderEngine } from '@textstack/reader-engine'

describe('readerEngineEnabled (Phase 4 flag, owner decision 1)', () => {
  beforeEach(() => localStorage.clear())

  it('readerEngineEnabled_EnvTrue_OnForEveryone', () => {
    expect(readerEngineEnabled('true', '', localStorage)).toBe(true)
  })

  it('readerEngineEnabled_NoEnvNoOverride_Off', () => {
    expect(readerEngineEnabled(undefined, '', localStorage)).toBe(false)
  })

  it('readerEngineEnabled_EngineParam_StaysOnForLaterLoads', () => {
    expect(readerEngineEnabled(undefined, '?engine=1', localStorage)).toBe(true)
    expect(readerEngineEnabled(undefined, '', localStorage)).toBe(true)
  })

  it('readerEngineEnabled_EngineParamZero_ClearsOverride', () => {
    readerEngineEnabled(undefined, '?engine=1', localStorage)
    expect(readerEngineEnabled(undefined, '?engine=0', localStorage)).toBe(false)
    expect(readerEngineEnabled(undefined, '', localStorage)).toBe(false)
  })

  it('readerEngineEnabled_NoStorage_OffWithoutEnv', () => {
    expect(readerEngineEnabled(undefined, '?engine=1', null)).toBe(false)
  })
})

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
