import { describe, it, expect, vi, afterEach } from 'vitest'
import { upsertProgress } from '../auth'

afterEach(() => vi.unstubAllGlobals())

describe('upsertProgress', () => {
  // It used auth.ts's own fetch, which never refreshed: an expired access cookie dropped the save.
  it('on 401 refreshes the cookie once, then retries the save', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"user":{"id":"u1"}}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"editionId":"e1"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(upsertProgress('e1', { chapterId: 'c1', locator: 'x', percent: 0.5 }))
      .resolves.toMatchObject({ editionId: 'e1' })

    const calls = fetchMock.mock.calls.map(([url, init]) => `${init.method ?? 'GET'} ${String(url).replace(/^.*?(\/(me|auth)\/)/, '$1')}`)
    expect(calls).toEqual(['PUT /me/progress/e1', 'POST /auth/refresh', 'PUT /me/progress/e1'])
    for (const [, init] of fetchMock.mock.calls) expect(init.credentials).toBe('include')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ percent: 0.5, percentUnit: 'book' })
  })
})
