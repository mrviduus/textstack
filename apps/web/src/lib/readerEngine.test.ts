import { describe, it, expect, beforeEach } from 'vitest'
import { readerEngineEnabled, openedEngineFor, setMountedEngine, unmountEngine } from './readerEngine'
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

describe('openedEngineFor', () => {
  const fake = () => ({}) as ReaderEngine

  it('openedEngineFor_EngineReplacedDuringOpen_ReturnsTheNewOne', async () => {
    // React StrictMode (dev) mounts ReaderSection twice: the first engine is gone before its open lands.
    const first = fake()
    const second = fake()
    let land!: () => void
    setMountedEngine({ engine: first, href: 'ch', opened: new Promise<void>((r) => { land = r }) })
    const result = openedEngineFor('ch')
    unmountEngine(first)
    setMountedEngine({ engine: second, href: 'ch', opened: Promise.resolve() })
    land()
    expect((await result)?.engine).toBe(second)
    unmountEngine(second)
  })

  it('openedEngineFor_NothingMounted_Null', async () => {
    expect(await openedEngineFor('ch')).toBeNull()
  })
})
