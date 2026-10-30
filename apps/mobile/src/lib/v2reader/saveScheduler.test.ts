import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSaveScheduler } from './saveScheduler.mjs'

type Store = { type: string; key: string; json: string }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('v2 reader save scheduler', () => {
  it('debouncedSave_BookReplacedBeforeItFires_NeverAddressedToTheNewBook', () => {
    // The page's sequence: open A, restore, read on (a 400 ms position save pending), open B at once.
    const sent: Store[] = []
    const saves = createSaveScheduler((m: Store) => sent.push(m))
    const a = { sha256: 'a'.repeat(64), entry: { v: 1, position: { cfi: 'epubcfi(/6/8!/4/2/1:5)' } } }
    const b = { sha256: 'b'.repeat(64), entry: null }   // B's entry before its own `restored`

    saves.save(a.sha256, JSON.stringify(a.entry), 400)
    saves.cancel()                                      // open(B) cancels what A left pending
    vi.advanceTimersByTime(1000)

    expect(sent.filter((m) => m.key === b.sha256)).toEqual([])
    expect(sent.map((m) => m.json)).not.toContain(JSON.stringify(b.entry))   // never "null"
    expect(sent).toEqual([])                                                 // and nothing before B's `restored`
  })

  it('save_KeyAndPayloadReadWhenCalled_NotWhenTheTimerFires', () => {
    const sent: Store[] = []
    const saves = createSaveScheduler((m: Store) => sent.push(m))
    const entry = { position: 'first' }
    saves.save('a'.repeat(64), JSON.stringify(entry), 400)
    entry.position = 'later'   // the page moved on; the pending save keeps what it was given
    vi.advanceTimersByTime(400)
    expect(sent).toEqual([{ type: 'store', key: 'a'.repeat(64), json: '{"position":"first"}' }])
  })

  it('save_CalledAgainWhilePending_SendsOnlyTheLastOne', () => {
    const sent: Store[] = []
    const saves = createSaveScheduler((m: Store) => sent.push(m))
    for (const fraction of [0.1, 0.2, 0.3]) saves.save('k'.repeat(64), `{"fraction":${fraction}}`, 400)
    vi.advanceTimersByTime(400)
    expect(sent).toEqual([{ type: 'store', key: 'k'.repeat(64), json: '{"fraction":0.3}' }])
  })
})
