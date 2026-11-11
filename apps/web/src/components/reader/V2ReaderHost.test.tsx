import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { READY_DEADLINE_MS, V2ReaderHost, type V2HostBook } from './V2ReaderHost'
import { openedDeadlineMs } from '../../../../mobile/src/lib/v2reader/deadlines.mjs'

// #1225: the one web host of the V2 reader page, driven through a fake frame: what it posts into the frame
// (spied on the iframe's window) and which page messages it takes.

const frameWindow = () => (screen.getByTitle('V2 reader') as HTMLIFrameElement).contentWindow!
let posted: { call: string; args: unknown[] }[]

beforeEach(() => {
  localStorage.clear()
  posted = []
})
afterEach(() => vi.useRealTimers())

/** Records what the host posts into the frame now on screen (a Retry mounts a new one). */
const spyFrame = () => vi.spyOn(frameWindow(), 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)

function mount(book: V2HostBook | null = null, extra: { dev?: boolean; readyDeadlineMs?: number; onReload?: () => void } = {}) {
  const onOpened = vi.fn()
  const el = (b: V2HostBook | null) => <V2ReaderHost book={b} onOpened={onOpened} idleHeading="idle" {...extra} />
  const view = render(el(book))
  spyFrame()
  return { ...view, onOpened, rerender: (b: V2HostBook | null) => view.rerender(el(b)) }
}

/** A page message, as the frame posts it (JSON), from `source` at `origin`. */
function fromPage(m: object, { source = frameWindow() as Window | null, origin = location.origin } = {}) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin, source })) })
}

const book = (name = 'a.epub'): V2HostBook => ({ bytes: new ArrayBuffer(8), name })
const opened = (name: string) => ({ type: 'opened', title: 'Walden', author: 'Thoreau', book: { sha256: 'aa', size: 8, name } })

describe('V2ReaderHost', () => {
  it('bookBeforeReady_HeldUntilReady_ThenFlowAndOpenBytesTransferred', () => {
    const { rerender } = mount()
    const b = book()
    rerender(b)
    expect(screen.getByTestId('v2-heading')).toHaveTextContent('Opening a.epub')
    expect(posted).toEqual([])
    fromPage({ type: 'ready' })
    expect(posted.map((m) => m.call)).toEqual(['flow', 'openBytes'])
    expect(posted[1].args).toEqual([b.bytes, '1/a.epub'])
    expect(frameWindow().postMessage).toHaveBeenLastCalledWith(posted[1], location.origin, [b.bytes])
  })

  it('sameBookObjectAgain_NotASecondOpen', () => {
    const { rerender } = mount()
    const b = book()
    rerender(b)
    fromPage({ type: 'ready' })
    rerender(b)
    expect(posted.filter((m) => m.call === 'openBytes')).toHaveLength(1)
  })

  it('messageFromAnotherSourceOrOrigin_Ignored', () => {
    mount(book())
    fromPage({ type: 'ready' }, { source: window })
    fromPage({ type: 'ready' }, { origin: 'https://evil.example' })
    expect(posted).toEqual([])
  })

  it('devRoute_Opened_RestoresFromTheLocalStore_AndShowsTheTitle', () => {
    localStorage.setItem('v2reader:store:aa', '{"v":1}')
    const { onOpened } = mount(book(), { dev: true })
    fromPage({ type: 'ready' })
    fromPage(opened('1/a.epub'))
    expect(posted[posted.length - 1]).toEqual({ call: 'restore', args: ['{"v":1}'] })
    expect(screen.getByTestId('v2-heading')).toHaveTextContent('Walden — Thoreau')
    expect(onOpened).toHaveBeenCalledWith(expect.objectContaining({ title: 'Walden' }), 'a.epub')
  })

  it('openedOfASupersededOpen_Dropped', () => {
    const { rerender } = mount(book('a.epub'))
    fromPage({ type: 'ready' })
    rerender(book('b.epub'))
    fromPage(opened('1/a.epub'))
    expect(posted.some((m) => m.call === 'restore')).toBe(false)
    expect(screen.getByTestId('v2-heading')).toHaveTextContent('Opening b.epub')
  })

  it('devRoute_Store_WritesTheLocalStore', () => {
    mount(null, { dev: true })
    fromPage({ type: 'store', key: 'bb', json: '{"x":1}' })
    expect(localStorage.getItem('v2reader:store:bb')).toBe('{"x":1}')
  })

  it('prodRoute_AfterAFailedOpen_StoreNeverReachesLocalStorage', () => {
    mount(book('broken.epub'))
    fromPage({ type: 'ready' })
    fromPage({ type: 'open-failed', name: '1/broken.epub', error: 'not a zip' })
    fromPage({ type: 'store', key: 'bb', json: '{"x":1}' })
    expect(localStorage.length).toBe(0)
  })

  it('prodRoute_BookWithoutASyncTarget_RestoreNull_NotTheLocalStore', () => {
    localStorage.setItem('v2reader:store:aa', '{"v":1}')
    mount(book())
    fromPage({ type: 'ready' })
    fromPage(opened('1/a.epub'))
    expect(posted[posted.length - 1]).toEqual({ call: 'restore', args: [null] })
  })

  it('openFailed_ShowsAnAlert_AndClearsThePosition', () => {
    mount(book('broken.epub'))
    fromPage({ type: 'ready' })
    fromPage({ type: 'open-failed', name: '1/broken.epub', error: 'not a zip' })
    expect(screen.getByRole('alert')).toHaveTextContent('cannot open broken.epub: not a zip')
    expect(screen.getByTestId('v2-status')).toHaveTextContent('')
  })

  it('noReadyByTheDeadline_ShowsAnAlert_ReadyClearsIt', () => {
    vi.useFakeTimers()
    mount()
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { vi.advanceTimersByTime(READY_DEADLINE_MS) })
    expect(screen.getByRole('alert')).toHaveTextContent('The reader failed to load')
    fromPage({ type: 'ready' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('readyOverdue_Retry_AFreshFrame_TheHeldBookOpensOnItsReady', () => {
    vi.useFakeTimers()
    const onReload = vi.fn()
    const b = book()
    mount(b, { onReload })
    const first = screen.getByTitle('V2 reader')
    act(() => { vi.advanceTimersByTime(READY_DEADLINE_MS) })
    act(() => { screen.getByRole('button', { name: 'Retry' }).click() })
    expect(screen.getByTitle('V2 reader')).not.toBe(first)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onReload).not.toHaveBeenCalled() // the bytes never left the host
    spyFrame()
    fromPage({ type: 'ready' })
    expect(posted.map((m) => m.call)).toEqual(['flow', 'openBytes'])
    // The new frame has its own ready deadline.
    act(() => { vi.advanceTimersByTime(READY_DEADLINE_MS) })
    expect(screen.queryByTestId('v2-overdue')).toBeNull()
  })

  it('noOpenedByTheOpensDeadline_ShowsAnAlert_ALateOpenedClearsIt', () => {
    vi.useFakeTimers()
    mount(book())
    fromPage({ type: 'ready' })
    act(() => { vi.advanceTimersByTime(openedDeadlineMs(8) - 1) })
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByRole('alert')).toHaveTextContent(`a.epub is taking too long to open (no answer in ${openedDeadlineMs(8) / 1000} s)`)
    fromPage(opened('1/a.epub'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('v2-heading')).toHaveTextContent('Walden — Thoreau')
  })

  it('openedOverdue_ABookOfOddSize_WholeSecondsRoundedUp', () => {
    vi.useFakeTimers()
    const size = 1_500_000 // 20 s + 1.43 s: 21,431 ms
    mount({ bytes: new ArrayBuffer(size), name: 'big.epub' })
    fromPage({ type: 'ready' })
    act(() => { vi.advanceTimersByTime(openedDeadlineMs(size)) })
    expect(openedDeadlineMs(size)).toBe(21_431)
    expect(screen.getByRole('alert')).toHaveTextContent('big.epub is taking too long to open (no answer in 22 s)')
  })

  it('openedOverdue_Retry_AsksTheRouteForTheBookAgain_IdleHeading', () => {
    vi.useFakeTimers()
    const onReload = vi.fn()
    mount(book(), { onReload })
    fromPage({ type: 'ready' })
    act(() => { vi.advanceTimersByTime(openedDeadlineMs(8)) })
    act(() => { screen.getByRole('button', { name: 'Retry' }).click() })
    expect(onReload).toHaveBeenCalledOnce()
    expect(screen.getByTestId('v2-heading')).toHaveTextContent('idle')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('openFailedInTime_NoOpenDeadlineLater', () => {
    vi.useFakeTimers()
    mount(book('broken.epub'))
    fromPage({ type: 'ready' })
    fromPage({ type: 'open-failed', name: '1/broken.epub', error: 'not a zip' })
    act(() => { vi.advanceTimersByTime(openedDeadlineMs(8)) })
    expect(screen.queryByTestId('v2-overdue')).toBeNull()
  })

  it('openFailedAfterABookWasRead_HeadingIsNotThePreviousTitle', () => {
    const { rerender } = mount(book('a.epub'))
    fromPage({ type: 'ready' })
    fromPage(opened('1/a.epub'))
    expect(screen.getByTestId('v2-heading')).toHaveTextContent('Walden')
    rerender(book('broken.epub'))
    fromPage({ type: 'open-failed', name: '2/broken.epub', error: 'not a zip' })
    expect(screen.getByTestId('v2-heading')).toHaveTextContent(/^$/)
    expect(screen.getByRole('alert')).toHaveTextContent('cannot open broken.epub: not a zip')
  })

  it('frame_IsTheSameOriginShell_NeverSrcdoc', () => {
    mount()
    const f = screen.getByTitle('V2 reader')
    expect(f).toHaveAttribute('src', '/reader-v2/frame.html')
    expect(f).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin')
    expect(f).not.toHaveAttribute('srcdoc')
  })

  it('readyDeadlineMs_ThePropsDeadline_NotTheDefault', () => {
    vi.useFakeTimers()
    mount(null, { readyDeadlineMs: 30_000 })
    act(() => { vi.advanceTimersByTime(READY_DEADLINE_MS) })
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { vi.advanceTimersByTime(30_000 - READY_DEADLINE_MS) })
    expect(screen.getByRole('alert')).toHaveTextContent('in 30 s')
  })

  it('idleHeading_UntilTheFirstOpen', () => {
    const { rerender } = mount()
    expect(screen.getByTestId('v2-heading')).toHaveTextContent('idle')
    rerender(book())
    expect(screen.getByTestId('v2-heading')).toHaveTextContent('Opening a.epub')
  })

  it.each([[false, 0], [true, 1]])('dev %s: the word stub label and the restore line, %i times', (dev, shown) => {
    mount(book(), { dev })
    fromPage({ type: 'ready' })
    fromPage({ type: 'word', word: 'pond', cfi: 'epubcfi(/6/2)', index: 0 })
    expect(posted.filter((m) => m.call === 'showTranslation')).toHaveLength(shown)
    expect(screen.queryAllByTestId('v2-restore')).toHaveLength(shown)
  })
})
