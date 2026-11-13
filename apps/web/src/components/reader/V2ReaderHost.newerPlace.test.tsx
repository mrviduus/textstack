import { ApiError, type V2ReadingState, type V2ReadingStateWrite } from '@textstack/shared'
import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { v2ReaderSyncApi, type V2SyncTarget } from '../../lib/v2ReaderSync'
import { V2ReaderHost } from './V2ReaderHost'

// #1232 end to end in the host, on the real session (the server faked): the page's real message order — opened,
// restore, restored, relocate, the first move — then a write lost to another device's newer place: ours is written
// on their revision and theirs is offered.

const SHA = 'a'.repeat(64)
const T: V2SyncTarget = { bookId: 'b1', fileId: 'f1', format: 'epub', sha256: SHA, size: 8, name: 'b1.epub' }
const cfi = (n: number) => `epubcfi(/6/${2 * n + 2}!/4/2/1:0)`
const state = (revision: number, n: number, at: string): V2ReadingState => ({
  bookId: T.bookId, fileId: T.fileId, currentLocator: { version: 1, scheme: 'epub-cfi', value: cfi(n), quote: `quote ${n}` },
  bookFraction: n / 10, frontierLocator: null, frontierFraction: null, completedAt: null, clientRecordedAt: at, updatedAt: at, revision, resetRevision: null,
})

afterEach(() => vi.restoreAllMocks())

it('firstMoveLosesToAnotherDevicesNewerPlace_OursWrittenOnTheirRevision_TheirsOffered', async () => {
  vi.spyOn(v2ReaderSyncApi, 'getReadingState').mockResolvedValue(state(4, 1, '2026-01-01T00:00:00.000Z'))
  vi.spyOn(v2ReaderSyncApi, 'annotations').mockResolvedValue([])
  const put = vi.spyOn(v2ReaderSyncApi, 'putReadingState')
    .mockRejectedValueOnce(Object.assign(new ApiError(409, 'stale_revision'), { body: { code: 'stale_revision', message: '', current: state(9, 5, '2026-02-01T00:00:00.000Z') } }))
    .mockImplementationOnce(async (_b, w) => ({ ...state(10, 2, w.clientRecordedAt), currentLocator: w.currentLocator }))

  const view = render(<V2ReaderHost book={null} />)
  const frame = (screen.getByTitle('V2 reader') as HTMLIFrameElement).contentWindow!
  const posted: { call: string; args: unknown[] }[] = []
  vi.spyOn(frame, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  const fromPage = (m: object) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame }))
    await new Promise((r) => setTimeout(r, 0))
  })

  await fromPage({ type: 'ready' })
  view.rerender(<V2ReaderHost book={{ bytes: new ArrayBuffer(8), name: T.name, sync: T }} />)
  await fromPage({ type: 'opened', title: 'T', book: { sha256: SHA, size: 8, name: `1/${T.name}` } })
  expect(posted.filter((m) => m.call === 'restore')).toHaveLength(1)
  await fromPage({ type: 'relocate', cfi: cfi(1), index: 1, fraction: 0.1 })
  await fromPage({ type: 'restored', key: SHA, position: 'restored' })
  // The reader's first page turn.
  const moved = { cfi: cfi(2), quote: 'quote 2', index: 2, fraction: 0.2, at: Date.now() }
  await fromPage({ type: 'relocate', cfi: cfi(2), index: 2, fraction: 0.2 })
  await fromPage({ type: 'store', key: SHA, json: JSON.stringify({ v: 1, book: { sha256: SHA, size: 8, name: T.name }, position: moved, highlights: [] }) })

  expect(put.mock.calls.map((c) => [(c[1] as V2ReadingStateWrite).currentLocator.value, (c[1] as V2ReadingStateWrite).expectedRevision]))
    .toEqual([[cfi(2), 4], [cfi(2), 9]])
  expect(screen.getByRole('status', { name: 'Newer reading place' })).toHaveTextContent('(50%)')
  expect(screen.queryByTestId('v2-not-saved')).toBeNull()
  expect(posted.some((m) => m.call === 'goTo')).toBe(false)

  // Taken: the page goes there, and its landing (a `moved` relocate) keeps the bars up (#1263).
  const main = document.querySelector('main')!
  expect(main).toHaveAttribute('data-bars', 'shown')
  act(() => { screen.getByRole('button', { name: 'Go to their place' }).click() })
  expect(posted.some((m) => m.call === 'goTo')).toBe(true)
  await fromPage({ type: 'relocate', cfi: cfi(5), index: 5, fraction: 0.5, moved: true })
  expect(main).toHaveAttribute('data-bars', 'shown')
})
