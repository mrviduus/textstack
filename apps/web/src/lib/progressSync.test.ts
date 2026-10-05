import { describe, it, expect, beforeEach, vi } from 'vitest'

const { upsertProgressMock } = vi.hoisted(() => ({ upsertProgressMock: vi.fn() }))
vi.mock('../api/auth', () => ({ upsertProgress: upsertProgressMock }))

import { flushLocalProgress, preferLocalProgress, markProgressSynced } from './progressSync'
import { ApiError } from '../api/client'

const ED1 = '11111111-1111-1111-1111-111111111111'
const ED2 = '22222222-2222-2222-2222-222222222222'
const ED_BAD = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const CHAP1 = '33333333-3333-3333-3333-333333333333'
const CHAP2 = '44444444-4444-4444-4444-444444444444'

describe('flushLocalProgress', () => {
  beforeEach(() => {
    localStorage.clear()
    upsertProgressMock.mockReset()
  })

  it('returns 0 when no reading.progress.* keys present', async () => {
    localStorage.setItem('unrelated.key', 'x')
    expect(await flushLocalProgress()).toBe(0)
    expect(upsertProgressMock).not.toHaveBeenCalled()
  })

  it('flushes all entries, removes localStorage keys, returns count', async () => {
    upsertProgressMock.mockResolvedValue({})
    localStorage.setItem(`reading.progress.${ED1}`, JSON.stringify({
      chapterId: CHAP1, locator: 'page:3', percent: 0.1, updatedAt: 1000,
    }))
    localStorage.setItem(`reading.progress.${ED2}`, JSON.stringify({
      chapterId: CHAP2, locator: 'percent:0.5', percent: 0.5, updatedAt: 2000,
    }))

    const n = await flushLocalProgress()

    expect(n).toBe(2)
    expect(upsertProgressMock).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem(`reading.progress.${ED1}`)).toBeNull()
    expect(localStorage.getItem(`reading.progress.${ED2}`)).toBeNull()
  })

  it('keeps localStorage key on network/5xx failure (retry next time)', async () => {
    upsertProgressMock.mockRejectedValue(new Error('500'))
    localStorage.setItem(`reading.progress.${ED1}`, JSON.stringify({
      chapterId: CHAP1, locator: 'page:3', percent: 0.1, updatedAt: 1000,
    }))

    const n = await flushLocalProgress()

    expect(n).toBe(0)
    expect(localStorage.getItem(`reading.progress.${ED1}`)).not.toBeNull()
  })

  it('drops localStorage key on 4xx (entry permanently broken)', async () => {
    upsertProgressMock.mockRejectedValue(new ApiError(404, 'Edition not found'))
    localStorage.setItem(`reading.progress.${ED_BAD}`, JSON.stringify({
      chapterId: CHAP1, locator: 'page:3', percent: 0.1, updatedAt: 1000,
    }))

    const n = await flushLocalProgress()

    expect(n).toBe(0)
    expect(localStorage.getItem(`reading.progress.${ED_BAD}`)).toBeNull()
  })

  it('drops localStorage key on 400 (bad request body)', async () => {
    upsertProgressMock.mockRejectedValue(new ApiError(400, 'Bad request'))
    localStorage.setItem(`reading.progress.${ED1}`, JSON.stringify({
      chapterId: CHAP1, locator: 'page:3', percent: 0.1, updatedAt: 1000,
    }))

    const n = await flushLocalProgress()

    expect(n).toBe(0)
    expect(localStorage.getItem(`reading.progress.${ED1}`)).toBeNull()
  })

  it('drops keys with non-Guid editionId without calling API', async () => {
    localStorage.setItem('reading.progress.not-a-guid', JSON.stringify({
      chapterId: CHAP1, locator: 'page:3', percent: 0.1, updatedAt: 1000,
    }))

    const n = await flushLocalProgress()

    expect(n).toBe(0)
    expect(upsertProgressMock).not.toHaveBeenCalled()
    expect(localStorage.getItem('reading.progress.not-a-guid')).toBeNull()
  })

  it('drops keys with non-Guid chapterId without calling API', async () => {
    localStorage.setItem(`reading.progress.${ED1}`, JSON.stringify({
      chapterId: 'not-a-guid', locator: 'page:3', percent: 0.1, updatedAt: 1000,
    }))

    const n = await flushLocalProgress()

    expect(n).toBe(0)
    expect(upsertProgressMock).not.toHaveBeenCalled()
    expect(localStorage.getItem(`reading.progress.${ED1}`)).toBeNull()
  })

  it('drops corrupt JSON and skips without calling API', async () => {
    localStorage.setItem(`reading.progress.${ED1}`, 'not-json{{{')

    const n = await flushLocalProgress()

    expect(n).toBe(0)
    expect(upsertProgressMock).not.toHaveBeenCalled()
    expect(localStorage.getItem(`reading.progress.${ED1}`)).toBeNull()
  })

  it('skips incomplete entries (missing chapterId or locator)', async () => {
    localStorage.setItem(`reading.progress.${ED1}`, JSON.stringify({ percent: 0.3 }))

    const n = await flushLocalProgress()

    expect(n).toBe(0)
    expect(upsertProgressMock).not.toHaveBeenCalled()
    // incomplete is kept — not "corrupt", may become complete later
    expect(localStorage.getItem(`reading.progress.${ED1}`)).not.toBeNull()
  })

  it('sends updatedAt as ISO string to server', async () => {
    upsertProgressMock.mockResolvedValue({})
    localStorage.setItem(`reading.progress.${ED1}`, JSON.stringify({
      chapterId: CHAP1, locator: 'page:3', percent: 0.1, updatedAt: 1700000000000,
    }))

    await flushLocalProgress()

    expect(upsertProgressMock).toHaveBeenCalledWith(ED1, expect.objectContaining({
      updatedAt: new Date(1700000000000).toISOString(),
    }))
  })

  it('processes entries sequentially (one at a time)', async () => {
    let inFlight = 0
    let maxInFlight = 0
    upsertProgressMock.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return {}
    })
    localStorage.setItem(`reading.progress.${ED1}`, JSON.stringify({
      chapterId: CHAP1, locator: 'page:3', percent: 0.1, updatedAt: 1000,
    }))
    localStorage.setItem(`reading.progress.${ED2}`, JSON.stringify({
      chapterId: CHAP2, locator: 'page:4', percent: 0.2, updatedAt: 1000,
    }))

    await flushLocalProgress()

    expect(maxInFlight).toBe(1)
  })
})

describe('preferLocalProgress (no cross-clock compare)', () => {
  it('an unacknowledged local write wins over the server, whatever the timestamps', () => {
    expect(preferLocalProgress({}, true)).toBe(true)
  })
  it('once acknowledged, the server wins (it may hold another device’s newer position)', () => {
    expect(preferLocalProgress({ synced: true }, true)).toBe(false)
  })
  it('no server row → local; no local → server', () => {
    expect(preferLocalProgress({ synced: true }, false)).toBe(true)
    expect(preferLocalProgress(null, true)).toBe(false)
  })
})

describe('markProgressSynced', () => {
  beforeEach(() => localStorage.clear())
  const KEY = `reading.progress.${ED1}`

  it('flags the entry the server acknowledged', () => {
    localStorage.setItem(KEY, JSON.stringify({ chapterSlug: 'c1', updatedAt: 5 }))
    markProgressSynced(KEY, 5)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ chapterSlug: 'c1', updatedAt: 5, synced: true })
  })

  it('leaves a newer local write (written while the request was in flight) unsynced', () => {
    localStorage.setItem(KEY, JSON.stringify({ chapterSlug: 'c2', updatedAt: 9 }))
    markProgressSynced(KEY, 5)
    expect(JSON.parse(localStorage.getItem(KEY)!).synced).toBeUndefined()
  })
})
