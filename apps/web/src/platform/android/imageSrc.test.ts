import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api', () => ({ APP_HEADERS: {}, freshAccessToken: vi.fn(async () => 'tok') }))

import { clearImages, imageSrc } from './imageSrc'

const png = () => new Response('png', { headers: { 'content-type': 'image/png' } })

describe('a cover on Android', () => {
  const createObjectURL = URL.createObjectURL
  const revokeObjectURL = URL.revokeObjectURL
  beforeEach(() => {
    let n = 0
    URL.createObjectURL = vi.fn(() => `blob:cover-${++n}`)
    URL.revokeObjectURL = vi.fn()
  })
  afterEach(() => {
    clearImages()
    vi.unstubAllGlobals()
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
  })

  it('is fetched once with the bearer and shown from a blob URL', async () => {
    const fetchMock = vi.fn(async () => png())
    vi.stubGlobal('fetch', fetchMock)
    expect(await imageSrc('https://api/cover/1')).toBe('blob:cover-1')
    expect(await imageSrc('https://api/cover/1')).toBe('blob:cover-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://api/cover/1', { headers: { Authorization: 'Bearer tok' } })
  })

  it('is asked for again after a failed fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(png()))
    expect(await imageSrc('https://api/cover/2')).toBeUndefined()
    await Promise.resolve()
    expect(await imageSrc('https://api/cover/2')).toBe('blob:cover-1')
  })

  it('has no src when the server refuses it, or answers with a page', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('<html>', { headers: { 'content-type': 'text/html' } })))
    expect(await imageSrc('https://api/cover/3')).toBeUndefined()
    expect(await imageSrc('https://api/cover/4')).toBeUndefined()
  })

  it('loads a big library a few covers at a time', async () => {
    let open = 0
    let most = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      most = Math.max(most, ++open)
      await new Promise((r) => setTimeout(r, 1))
      open--
      return png()
    }))
    const all = await Promise.all(Array.from({ length: 30 }, (_, i) => imageSrc(`https://api/big/${i}`)))
    expect(all.every(Boolean)).toBe(true)
    expect(most).toBeLessThanOrEqual(6)
  })

  it('leaves memory when the account changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => png()))
    const first = await imageSrc('https://api/cover/5')
    clearImages()
    await Promise.resolve()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first)
    expect(await imageSrc('https://api/cover/5')).not.toBe(first)
  })
})
