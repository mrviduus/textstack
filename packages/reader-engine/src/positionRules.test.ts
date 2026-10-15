// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as engineApi from './index'
import {
  PDF_GATE_INITIAL, decideNewerPosition, localProgressWins, pdfGateReduce, serverProvablyNewer,
  type PdfGateEvent, type PdfGateState,
} from './index'
import { CHAPTER, deferred, destroyAll, makeReader } from './engine.testkit'

/**
 * ADR-019's eight position rules (docs/01-architecture/adr/ADR-019-reader-position-rules.md), one
 * pinning test each, through the engine's API: the engine itself, plus the pure rules it re-exports
 * from packages/shared (D2: the code stays in shared; moving it is out of Phase 6, answer 6a). The host keeps save timing and I/O.
 */

afterEach(() => {
  destroyAll()
  vi.useRealTimers()
})

const MIDDLE = 'Malin log 3'
const FURTHER = 'Valentia log 2'
const iso = (ms: number) => new Date(ms).toISOString()

/** Runs PDF gate events in order; returns which reported pages were saveable. */
function savedPages(events: PdfGateEvent[]): number[] {
  let state: PdfGateState = PDF_GATE_INITIAL
  const saved: number[] = []
  for (const e of events) {
    const r = pdfGateReduce(state, e)
    state = r.state
    if (r.persist && e.type === 'pageReported') saved.push(e.page)
  }
  return saved
}

describe('ADR-019 position rules', () => {
  it('rule 1: "doc loaded" is keyed by the chapter the host opened; nothing after the open resets it', async () => {
    const reader = makeReader()
    await reader.open(undefined, 'open-c1')
    await reader.goTo(MIDDLE)
    reader.setStyle({ fontSize: 24 })
    reader.grow('Arden log 1', 300)
    await reader.settle()
    expect(reader.payloads('ready')).toEqual([{ opId: 'open-c1', href: 'c1' }])
    await reader.engine.open({ href: 'c2', layout: 'reflow', html: CHAPTER }, undefined, 'open-c2')
    expect(reader.payloads('ready')).toEqual([{ opId: 'open-c1', href: 'c1' }, { opId: 'open-c2', href: 'c2' }])
  })

  it('rule 2: the restore lands once, on its target, after the chapter is ready — never at the top first', async () => {
    const reader = makeReader()
    expect(await reader.open(MIDDLE, 'restore')).toBe('exact')
    await reader.settle()
    expect(reader.events()).toEqual(['ready', 'relocated'])
    expect(reader.ack('restore').locator.text?.highlight).toMatch(/^Malin log 3:/)
  })

  it('rule 3: land on the ack — a stale restore lands nothing; a PDF saves no page before its jump lands', async () => {
    const fonts = deferred()
    const reader = makeReader({ fonts: () => fonts.promise })
    const stale = reader.open(MIDDLE, 'stale')
    const fresh = reader.open(FURTHER, 'fresh')
    fonts.resolve()
    expect(await stale).toBe('superseded')
    expect(await fresh).toBe('exact')
    expect(reader.ack('stale').locator.text?.highlight).not.toMatch(/^Malin/)
    expect(reader.line().startsWith(FURTHER)).toBe(true)

    expect(savedPages([
      { type: 'documentLoaded' },
      { type: 'pageReported', page: 1, at: 0 },                    // the viewer opens at the top
      { type: 'jumpIssued', page: 40, jumpId: 2, at: 10 },
      { type: 'pageReported', page: 7, ackJumpId: 1, at: 20 },     // a stale ack, passing through
      { type: 'pageReported', page: 40, ackJumpId: 2, at: 30 },    // landed
      { type: 'pageReported', page: 3, at: 40 },                   // the reader goes back: saved
    ])).toEqual([40, 3])
  })

  it('rule 4: every place names the chapter it was captured in, so a pending save goes to its own doc', async () => {
    const reader = makeReader()
    await reader.open(MIDDLE)
    await reader.settle()
    reader.scrollBy(300)
    await reader.settle()
    await reader.engine.open({ href: 'c2', layout: 'reflow', html: CHAPTER }, reader.place(FURTHER, 'c2'))
    expect(reader.relocations().map((r) => [r.reason, r.locator.href])).toEqual([['open', 'c1'], ['scroll', 'c1'], ['open', 'c2']])
  })

  it("rule 5: server data is a newer-check on client stamps; it moves the reader only if no 'scroll' arrived", async () => {
    const now = Date.parse('2026-10-12T12:00:00Z')
    // Which record the chapter opens from: client stamps only, never the server's clock (an hour ahead here).
    expect(localProgressWins({ updatedAt: now, synced: true }, { clientUpdatedAt: iso(now - 1000), updatedAt: iso(now + 3_600_000) })).toBe(true)
    // A local stamp from a fast clock counts as now + 5 min at most: a later write from another device is newer.
    expect(serverProvablyNewer({ updatedAt: now + 3_600_000 }, { clientUpdatedAt: iso(now + 600_000) }, now)).toBe(true)
    expect(serverProvablyNewer({ updatedAt: now }, { clientUpdatedAt: null }, now)).toBe(false)

    // "The reader moved" = a 'scroll' arrived after the restore. No pixel tolerance.
    expect('readerMovedSince' in engineApi).toBe(false)
    const reader = makeReader()
    await reader.open(MIDDLE)
    await reader.settle()
    let moved = false
    reader.engine.on('relocated', (r) => { if (r.reason === 'scroll') moved = true })
    const decide = () => decideNewerPosition({ sameChapter: true, restoreApplied: true, readerMoved: moved })
    reader.setStyle({ fontSize: 24 })
    reader.grow('Arden log 1', 300)
    await reader.settle()
    expect(decide(), 'a style change or a late image is not the reader moving').toBe('move')
    reader.scrollBy(50)
    await reader.settle()
    expect(decide(), 'never yank a reader who moved').toBe('prompt')
  })

  it('rule 6: every wait has a deadline — a webfont that never loads holds the open 4 s at most', async () => {
    vi.useFakeTimers()
    const reader = makeReader({ fonts: () => new Promise<void>(() => {}) })
    let result: string | undefined
    void reader.open(MIDDLE, 'restore').then((r) => { result = r })
    await vi.advanceTimersByTimeAsync(3900)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(result).toBe('exact')
    expect(reader.events()).toEqual(['ready', 'relocated'])

    // A font that fails is a font wait that ended: the open still lands.
    const failing = makeReader({ fonts: () => Promise.reject(new Error('font failed')) })
    const landing = failing.open(MIDDLE)
    await vi.advanceTimersByTimeAsync(10)
    expect(await landing).toBe('exact')
  })

  it("rule 7: a programmatic move is not reading — only the reader's own scroll is 'scroll'", async () => {
    const reader = makeReader()
    await reader.open(MIDDLE)
    await reader.goTo(FURTHER)
    reader.setStyle({ fontSize: 24 })
    await reader.settle()
    reader.grow('Arden log 1', 300)
    await reader.settle()
    reader.scrollBy(200)
    await reader.settle()
    expect(reader.reasons()).toEqual(['open', 'goTo', 'style', 'reflow', 'scroll'])
  })

  it('rule 8: a reflow during a restore keeps the pending target, not the half-restored view', async () => {
    const fonts = deferred()
    const reader = makeReader({ fonts: () => fonts.promise })
    const restoring = reader.open(FURTHER, 'restore')
    reader.grow('Arden log 1', 500)
    await reader.settle()
    expect(reader.line(), 'mid-restore, the place is the target').toMatch(/^Valentia log 2:/)
    fonts.resolve()
    expect(await restoring).toBe('exact')
    await reader.settle()
    expect(reader.line().startsWith(FURTHER)).toBe(true)
    expect(reader.reasons()).toEqual(['open'])
  })
})
