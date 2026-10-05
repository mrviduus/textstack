import { describe, it, expect } from 'vitest'
import { READINESS_INITIAL, readinessReduce, readyToRestore, type Readiness, type ReadinessEvent } from './restoreReadiness'

const run = (events: ReadinessEvent[], s: Readiness = READINESS_INITIAL) => events.reduce(readinessReduce, s)

describe('restoreReadiness', () => {
  it('C1: WebView loads BEFORE the book id resolves → restore still fires once the id lands', () => {
    // bookKey null: the load effect runs for the document, has nothing to read
    let s = run([{ type: 'opened', doc: 'reflow:ch-2' }])
    s = run([{ type: 'webViewLoaded' }], s)
    expect(readyToRestore(s)).toBe(false)
    // bookKey null → id: the effect re-runs for the SAME document. No new onLoadEnd will follow.
    s = run([{ type: 'opened', doc: 'reflow:ch-2' }, { type: 'positionLoaded' }], s)
    expect(readyToRestore(s)).toBe(true)
  })

  it('usual order: position first, then the load', () => {
    const s = run([{ type: 'opened', doc: 'reflow:ch-1' }, { type: 'positionLoaded' }, { type: 'webViewLoaded' }])
    expect(readyToRestore(s)).toBe(true)
  })

  it('a different document has to load again before it is restored', () => {
    const s = run([
      { type: 'opened', doc: 'pdf:ch-1' }, { type: 'webViewLoaded' },
      { type: 'opened', doc: 'reflow:ch-1' }, { type: 'positionLoaded' },
    ])
    expect(readyToRestore(s)).toBe(false)
    expect(readyToRestore(readinessReduce(s, { type: 'webViewLoaded' }))).toBe(true)
  })

  it('fires once', () => {
    const s = run([{ type: 'opened', doc: 'reflow:ch-1' }, { type: 'positionLoaded' }, { type: 'webViewLoaded' }, { type: 'restoreFired' }])
    expect(s.restored).toBe(true)
    expect(readyToRestore(s)).toBe(false)
  })
})
