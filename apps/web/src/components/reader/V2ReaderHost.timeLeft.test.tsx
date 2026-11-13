import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { V2ReaderHost, type V2HostBook } from './V2ReaderHost'
import { getReadingPace } from '../../api/readingTracking'

// #1262: the book's percent and the time left in the V2 reader's bottom bar, driven through a fake frame as
// V2ReaderHost.chrome.test.tsx. The pace hook is the real one: a session, and the pace call mocked.

vi.mock('../../context/AuthContext', async (original) => ({
  ...(await original<typeof import('../../context/AuthContext')>()),
  useAuth: () => ({ isAuthenticated: true }),
}))
vi.mock('../../api/readingTracking', () => ({ getReadingPace: vi.fn() }))

const pace = vi.mocked(getReadingPace)
const frame = () => screen.getByTitle('V2 reader') as HTMLIFrameElement
const timeLeft = () => screen.queryByTestId('v2-time-left')

beforeEach(() => {
  localStorage.clear()
  pace.mockReset()
})

function fromPage(m: object) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame().contentWindow })) })
}

/** A book open on screen. */
async function opened() {
  const book: V2HostBook = { bytes: new ArrayBuffer(8), name: 'a.epub' }
  const view = render(<MemoryRouter><V2ReaderHost book={book} idleHeading="idle" /></MemoryRouter>)
  vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(() => {})
  fromPage({ type: 'ready' })
  fromPage({ type: 'opened', title: 'Walden', book: { sha256: 'aa', size: 8, name: '1/a.epub' } })
  await act(async () => {})
  return view
}

/** Halfway through a 60,000-word book, its section ending at 60 %: 6,000 words left there, 30,000 in the book. */
const relocate = (over: object = {}) => ({ type: 'relocate', fraction: 0.5, index: 1, sections: 3, toc: null, moved: true, sectionEnd: 0.6, words: 60_000, ...over })
/** A relocate, and the pace call it starts (the first one) settled. */
async function relocated(over: object = {}) {
  fromPage(relocate(over))
  await act(async () => {})
}

describe('V2ReaderHost time left', () => {
  it('timeLeft_PaceAndWords_ChapterAndBook', async () => {
    pace.mockResolvedValue({ wpm: 200, sessionCount: 9, isUserSpecific: true })
    await opened()
    await relocated()
    expect(timeLeft()).toHaveTextContent(/^30 min left in chapter · 2 hr 30 min left in book$/)
    expect(screen.getByTestId('v2-status')).toHaveTextContent(/^50%$/)
  })

  it('timeLeft_TheServersFallbackPace_IsAPace', async () => {
    pace.mockResolvedValue({ wpm: 200, sessionCount: 0, isUserSpecific: false })
    await opened()
    await relocated()
    expect(timeLeft()).toHaveTextContent('2 hr 30 min left in book')
  })

  it('timeLeft_PaceNotAnsweredYet_Hidden_ThenShown', async () => {
    let answer!: (p: { wpm: number; sessionCount: number; isUserSpecific: boolean }) => void
    pace.mockReturnValue(new Promise((r) => { answer = r }))
    await opened()
    await relocated()
    expect(timeLeft()).toBeNull()
    expect(screen.getByTestId('v2-status')).toHaveTextContent('50%')
    await act(async () => { answer({ wpm: 300, sessionCount: 9, isUserSpecific: true }) })
    expect(timeLeft()).toHaveTextContent(/^20 min left in chapter · 1 hr 40 min left in book$/)
  })

  it('timeLeft_PaceCallFailed_Hidden_TheBookStillReads', async () => {
    pace.mockRejectedValue(new Error('offline'))
    await opened()
    await relocated()
    expect(timeLeft()).toBeNull()
    expect(screen.getByTestId('v2-status')).toHaveTextContent(/^50%$/)
  })

  it('timeLeft_NoWords_Hidden', async () => {
    pace.mockResolvedValue({ wpm: 200, sessionCount: 9, isUserSpecific: true })
    await opened()
    await relocated({ words: null })
    expect(timeLeft()).toBeNull()
  })

  it('timeLeft_NoSectionEnd_BookOnly', async () => {
    pace.mockResolvedValue({ wpm: 200, sessionCount: 9, isUserSpecific: true })
    await opened()
    await relocated({ sectionEnd: 'x' })
    expect(timeLeft()).toHaveTextContent(/^2 hr 30 min left in book$/)
  })

  it('timeLeft_FollowsTheLatestRelocate', async () => {
    pace.mockResolvedValue({ wpm: 200, sessionCount: 9, isUserSpecific: true })
    await opened()
    await relocated()
    await relocated({ fraction: 0.9, sectionEnd: 1 })
    expect(timeLeft()).toHaveTextContent(/^30 min left in chapter · 30 min left in book$/)
  })

  it('timeLeft_GoneWithThePosition_WhenAnotherBookOpens', async () => {
    pace.mockResolvedValue({ wpm: 200, sessionCount: 9, isUserSpecific: true })
    const view = await opened()
    await relocated()
    expect(timeLeft()).not.toBeNull()
    view.rerender(<MemoryRouter><V2ReaderHost book={{ bytes: new ArrayBuffer(8), name: 'b.epub' }} idleHeading="idle" /></MemoryRouter>)
    expect(timeLeft()).toBeNull()
  })

  it('percent_NoFraction_ADash', async () => {
    pace.mockResolvedValue({ wpm: 200, sessionCount: 9, isUserSpecific: true })
    await opened()
    await relocated({ fraction: null })
    expect(screen.getByTestId('v2-status')).toHaveTextContent(/^—$/)
    expect(timeLeft()).toBeNull()
  })
})
