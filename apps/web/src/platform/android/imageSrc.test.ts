import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api', () => ({ APP_HEADERS: {}, freshAccessToken: vi.fn(async () => 'tok') }))

import { imageSrc } from './imageSrc'

describe('a cover on Android', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:cover')
  })

  it('is fetched once with the bearer and shown from a blob URL', async () => {
    const fetchMock = vi.fn(async () => new Response('png'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await imageSrc('https://api/cover/1')).toBe('blob:cover')
    expect(await imageSrc('https://api/cover/1')).toBe('blob:cover')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://api/cover/1', { headers: { Authorization: 'Bearer tok' } })
  })

  it('is asked for again after a failed fetch', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(new Response('png'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await imageSrc('https://api/cover/2')).toBeUndefined()
    await Promise.resolve()
    expect(await imageSrc('https://api/cover/2')).toBe('blob:cover')
  })

  it('has no src when the server refuses it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    expect(await imageSrc('https://api/cover/3')).toBeUndefined()
  })
})
