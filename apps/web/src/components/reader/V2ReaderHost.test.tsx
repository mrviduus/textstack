import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { READY_DEADLINE_MS, V2ReaderHost, type V2HostBook } from './V2ReaderHost'

// #1225: the one web host of the V2 reader page, driven through a fake frame: what it posts into the frame
// (spied on the iframe's window) and which page messages it takes.

const frameWindow = () => (screen.getByTitle('V2 reader') as HTMLIFrameElement).contentWindow!
let posted: { call: string; args: unknown[] }[]

beforeEach(() => {
  localStorage.clear()
  posted = []
})
afterEach(() => vi.useRealTimers())

function mount(book: V2HostBook | null = null) {
  const onOpened = vi.fn()
  const view = render(<V2ReaderHost book={book} onOpened={onOpened} idleHeading="idle" />)
  vi.spyOn(frameWindow(), 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  return { ...view, onOpened, rerender: (b: V2HostBook | null) => view.rerender(<V2ReaderHost book={b} onOpened={onOpened} idleHeading="idle" />) }
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

  it('opened_RestoresFromTheLocalStore_AndShowsTheTitle', () => {
    localStorage.setItem('v2reader:store:aa', '{"v":1}')
    const { onOpened } = mount(book())
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

  it('store_WritesTheLocalStore', () => {
    mount()
    fromPage({ type: 'store', key: 'bb', json: '{"x":1}' })
    expect(localStorage.getItem('v2reader:store:bb')).toBe('{"x":1}')
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
    expect(screen.getByRole('alert')).toHaveTextContent('The reader page did not load')
    fromPage({ type: 'ready' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('frame_IsTheSameOriginShell_NeverSrcdoc', () => {
    mount()
    const f = screen.getByTitle('V2 reader')
    expect(f).toHaveAttribute('src', '/reader-v2/frame.html')
    expect(f).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin')
    expect(f).not.toHaveAttribute('srcdoc')
  })
})
