import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { V2SaveStatus, V2SyncTarget } from '../../lib/v2ReaderSync'
import { V2ReaderHost, type V2HostBook } from './V2ReaderHost'

// #1226: the production route's host wiring to its server sync (lib/v2ReaderSync.ts, faked here): restore waits
// for the server, a superseded open's answer is dropped, `store` goes to the server and never to localStorage.

interface FakeSync {
  target: V2SyncTarget
  onStatus(s: V2SaveStatus): void
  answer(json: string | null): void
  sha256: string
  restore: ReturnType<typeof vi.fn>
  store: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  flushKeepalive: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}
const sessions: FakeSync[] = []
vi.mock('../../lib/v2ReaderSync', () => ({
  createV2ReaderSync: (target: V2SyncTarget, o: { onStatus(s: V2SaveStatus): void }) => {
    let answer!: (json: string | null) => void
    const restored = new Promise<string | null>((ok) => { answer = ok })
    const s: FakeSync = {
      target, onStatus: o.onStatus, answer, sha256: target.sha256,
      restore: vi.fn(() => restored), store: vi.fn(), flush: vi.fn(async () => {}), flushKeepalive: vi.fn(), close: vi.fn(),
    }
    sessions.push(s)
    return s
  },
}))

const frameWindow = () => (screen.getByTitle('V2 reader') as HTMLIFrameElement).contentWindow!
let posted: { call: string; args: unknown[] }[]

beforeEach(() => {
  localStorage.clear()
  posted = []
  sessions.length = 0
})

function mount() {
  const el = (b: V2HostBook | null) => <V2ReaderHost book={b} />
  const view = render(el(null))
  vi.spyOn(frameWindow(), 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  return { ...view, open: (b: V2HostBook) => view.rerender(el(b)) }
}
function fromPage(m: object) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frameWindow() })) })
}
const SHA = (c: string) => c.repeat(64)
const target = (bookId: string, sha256: string): V2SyncTarget => ({ bookId, fileId: `f-${bookId}`, format: 'epub', sha256, size: 8, name: `${bookId}.epub` })
const synced = (bookId: string, sha256: string): V2HostBook => ({ bytes: new ArrayBuffer(8), name: `${bookId}.epub`, sync: target(bookId, sha256) })
const opened = (name: string, sha256: string) => ({ type: 'opened', title: 'T', book: { sha256, size: 8, name } })
const restores = () => posted.filter((m) => m.call === 'restore').map((m) => m.args[0])
const flushAll = () => act(async () => { await Promise.resolve() })

describe('V2ReaderHost, server sync', () => {
  it('opened_RestoreWaitsForTheServer_ThenItsEntry', async () => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    expect(sessions.map((s) => s.target.bookId)).toEqual(['b1'])
    expect(restores()).toEqual([])
    sessions[0].answer('{"v":1}')
    await flushAll()
    expect(restores()).toEqual(['{"v":1}'])
  })

  it('aLaterTake_TheEarlierRestoreAnswerDropped_AndItsSessionClosed', async () => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    open(synced('b2', SHA('b')))
    fromPage(opened('2/b2.epub', SHA('b')))
    expect(sessions[0].close).toHaveBeenCalled()
    sessions[0].answer('{"stale":1}')
    sessions[1].answer('{"fresh":1}')
    await flushAll()
    expect(restores()).toEqual(['{"fresh":1}'])
  })

  it('store_ToTheSession_ForItsBookOnly_NeverLocalStorage', () => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    fromPage({ type: 'store', key: SHA('a'), json: '{"x":1}' })
    fromPage({ type: 'store', key: SHA('c'), json: '{"y":1}' })
    expect(sessions[0].store.mock.calls).toEqual([['{"x":1}']])
    expect(localStorage.length).toBe(0)
  })

  it('openedBytesAreNotTheServerFile_RestoreNull_NotSaved_NothingStored', () => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('d')))
    expect(sessions).toEqual([])
    expect(restores()).toEqual([null])
    expect(screen.getByTestId('v2-not-saved')).toBeInTheDocument()
    fromPage({ type: 'store', key: SHA('d'), json: '{"x":1}' })
    expect(localStorage.length).toBe(0)
  })

  it('unsavedStatus_Shown_SavedClearsIt', () => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    expect(screen.queryByTestId('v2-not-saved')).toBeNull()
    act(() => sessions[0].onStatus('unsaved'))
    expect(screen.getByTestId('v2-not-saved')).toHaveTextContent('Not saved')
    act(() => sessions[0].onStatus('saved'))
    expect(screen.queryByTestId('v2-not-saved')).toBeNull()
  })

  it('tabHidden_Flush_PageHide_KeepaliveFlush_Unmount_Closes', () => {
    const { open, unmount } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockRestore()
    window.dispatchEvent(new Event('pagehide'))
    expect(sessions[0].flush).toHaveBeenCalledTimes(1)
    expect(sessions[0].flushKeepalive).toHaveBeenCalledTimes(1)
    unmount()
    expect(sessions[0].close).toHaveBeenCalled()
  })
})
