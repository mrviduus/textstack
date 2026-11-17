import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPendingSessions } from '../useReadingSession'

const KEY = 'reading.pendingSessions'

const session = (over: object = {}) => {
  const now = new Date().toISOString()
  return { editionId: null, userBookId: 'b1', clientSessionId: 's1', startedAt: now, endedAt: now, durationSeconds: 0, wordsRead: 0, startPercent: 0, endPercent: 0.1, ...over }
}
const answer = (status: number) => vi.fn().mockResolvedValue({ ok: status < 400, status, text: async () => '{"code":"x","message":"x"}', json: async () => ({}) })

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

// The V2 reader's ended sessions: queued, sent, retried until the server settles them.
describe('flushPendingSessions', () => {
  it('a session the server took leaves the queue', async () => {
    vi.stubGlobal('fetch', answer(200))
    localStorage.setItem(KEY, JSON.stringify([session()]))
    await flushPendingSessions()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('a book gone (404) drops its session, a server error (5xx) keeps it for the next flush', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', answer(404))
    localStorage.setItem(KEY, JSON.stringify([session()]))
    await flushPendingSessions()
    expect(localStorage.getItem(KEY)).toBeNull()

    vi.stubGlobal('fetch', answer(503))
    localStorage.setItem(KEY, JSON.stringify([session()]))
    await flushPendingSessions()
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(1)
  })

  it('a session the retired reader queued (no client session id) is dropped unsent', async () => {
    const fetch = answer(200)
    vi.stubGlobal('fetch', fetch)
    localStorage.setItem(KEY, JSON.stringify([session({ clientSessionId: undefined, userBookId: null, editionId: 'e1' })]))
    await flushPendingSessions()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})
