import type { PendingSession } from '@textstack/shared'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { v2ReaderSyncApi, type V2SyncTarget } from '../../lib/v2ReaderSync'
import { V2ReaderHost, type V2HostBook } from './V2ReaderHost'

// #1313 in the host: a synced book's reading session goes to the session queue (useReadingSession's, which sends
// it to PUT /me/v2/reading/sessions/{id}); the session rules themselves are sessionTracker.test.ts's.

const queued: PendingSession[] = []
vi.mock('../../hooks/useReadingSession', () => ({
  queueReadingSession: (s: PendingSession) => queued.push(s),
  flushPendingSessions: async () => {},
}))

const target = (n: number): V2SyncTarget => ({ bookId: `b${n}`, fileId: `f${n}`, format: 'epub', sha256: String(n).repeat(64), size: 8, name: `b${n}.epub` })
let now = Date.parse('2026-11-14T10:00:00Z')
const later = (s: number) => { now += s * 1000 }

beforeEach(() => {
  queued.length = 0
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.spyOn(v2ReaderSyncApi, 'getReadingState').mockResolvedValue(null)
  vi.spyOn(v2ReaderSyncApi, 'annotations').mockResolvedValue([])
})
afterEach(() => vi.restoreAllMocks())

async function reader(o: { dev?: boolean } = {}) {
  const host = (book: V2HostBook | null) => <MemoryRouter><V2ReaderHost book={book} dev={o.dev} /></MemoryRouter>
  const view = render(host(null))
  const frame = (screen.getByTitle('V2 reader') as HTMLIFrameElement).contentWindow!
  vi.spyOn(frame, 'postMessage').mockImplementation((() => {}) as never)
  const fromPage = (m: object) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame }))
    await new Promise((r) => setTimeout(r, 0))
  })
  let opens = 0
  /** A book handed to the host and opened by the page (its bytes `sha256`), landing at 10 %. */
  const open = async (t: V2SyncTarget, sha256 = t.sha256) => {
    view.rerender(host({ bytes: new ArrayBuffer(8), name: t.name, sync: o.dev ? undefined : t }))
    await fromPage({ type: 'opened', title: 'T', format: 'epub', book: { sha256, size: 8, name: `${++opens}/${t.name}` } })
    await relocate(0.1, false)
  }
  const relocate = (fraction: number, moved = true) => fromPage({ type: 'relocate', cfi: 'epubcfi(/6/2!/4/2)', index: 1, sections: 3, fraction, moved, words: 100_000 })
  await fromPage({ type: 'ready' })
  return { open, relocate, unmount: view.unmount }
}

describe('V2ReaderHost reading sessions (#1313)', () => {
  it('session_ReadThenLeave_QueuedForTheServerBookWithItsOwnId', async () => {
    const r = await reader()
    await r.open(target(1))
    later(60)
    await r.relocate(0.101) // 100 words
    later(30)
    r.unmount()
    expect(queued).toEqual([{
      userBookId: 'b1', clientSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/), startedAt: '2026-11-14T10:01:00.000Z', endedAt: '2026-11-14T10:01:30.000Z',
      durationSeconds: 30, wordsRead: 100, startPercent: 0.1, endPercent: 0.101,
    }])
  })

  it('session_AnotherBookOpened_TheFirstBooksSessionEndsThere', async () => {
    const r = await reader()
    await r.open(target(1))
    await r.relocate(0.2)
    later(20)
    await r.open(target(2))
    later(5)
    await r.relocate(0.3)
    later(15)
    r.unmount()
    expect(queued.map((s) => [s.userBookId, s.durationSeconds])).toEqual([['b1', 20], ['b2', 15]])
  })

  it('session_TabHidden_Ended', async () => {
    const r = await reader()
    await r.open(target(1))
    await r.relocate(0.2)
    later(40)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(queued.map((s) => [s.userBookId, s.durationSeconds])).toEqual([['b1', 40]])
    r.unmount()
    expect(queued).toHaveLength(1)
  })

  it('session_DevRouteOrBytesNotTheServerFile_NoneRecorded', async () => {
    const dev = await reader({ dev: true })
    await dev.open(target(1))
    await dev.relocate(0.2)
    later(60)
    dev.unmount()
    const other = await reader()
    await other.open(target(2), 'f'.repeat(64))
    await other.relocate(0.2)
    later(60)
    other.unmount()
    expect(queued).toEqual([])
  })
})
