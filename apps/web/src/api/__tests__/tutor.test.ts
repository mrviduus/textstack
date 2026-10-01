import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '../client' // cookie-mode initApi
import { startTutorSession, sendTutorFeedback } from '@textstack/shared'

function mockOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  })
}

const SAMPLE = {
  sessionId: 's1',
  plan: [{ wordId: 'w1', word: 'foo', stage: 1, exerciseType: 'recognition', difficulty: 'easy', why: 'because' }],
  rationale: 'plan',
  readingNudge: 'read more',
  runId: 'r1',
}

describe('tutor api', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('startTutorSession POSTs maxItems and returns parsed response', async () => {
    const fetchMock = mockOk(SAMPLE)
    vi.stubGlobal('fetch', fetchMock)

    const res = await startTutorSession(7)

    expect(res.sessionId).toBe('s1')
    expect(res.plan).toHaveLength(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/me/tutor/session')
    expect(opts.method).toBe('POST')
    expect(opts.credentials).toBe('include')
    expect(JSON.parse(opts.body)).toEqual({ maxItems: 7 })
  })

  it('startTutorSession sends empty body when maxItems omitted', async () => {
    const fetchMock = mockOk(SAMPLE)
    vi.stubGlobal('fetch', fetchMock)

    await startTutorSession()

    const [, opts] = fetchMock.mock.calls[0]
    expect(JSON.parse(opts.body)).toEqual({})
  })

  it('sendTutorFeedback POSTs results to the session feedback URL', async () => {
    const fetchMock = mockOk({ ...SAMPLE, plan: [] })
    vi.stubGlobal('fetch', fetchMock)

    const results = [{ wordId: 'w1', correct: true, responseTimeMs: 1234 }]
    const res = await sendTutorFeedback('s1', results)

    expect(res.plan).toHaveLength(0)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/me/tutor/session/s1/feedback')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ results })
  })

  it('rejects on a non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: 'no tutor' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(startTutorSession()).rejects.toThrow('no tutor')
  })
})
