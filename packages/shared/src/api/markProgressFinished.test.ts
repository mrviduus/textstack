import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initApi } from './client'
import { markProgressFinished, updateProgress } from './readingProgress'

/**
 * What "mark as finished" puts on the wire.
 *
 * <p>The server treats `updatedAt` as a last-write-wins guard: a timestamp that is not newer than
 * the stored one makes the whole write a **no-op, answered 200 with the row untouched**
 * (`UserDataEndpoints.UpsertProgress`). That is right for a queued background sync and wrong for a
 * button: the reader taps "mark as finished", the shelf flips optimistically, and on a device whose
 * clock runs a minute behind the server — ordinary, and invisible — nothing is saved and nothing
 * says so.</p>
 *
 * <p>Found by an adversarial QA pass on 2026-09-12, in code shipped the day before. Web's
 * `markAsRead` never sent one; the mobile helper introduced to make the two clients agree quietly
 * introduced this asymmetry instead.</p>
 */
describe('markProgressFinished', () => {
  const realFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 204, text: async () => '' }) as unknown as Response)
    globalThis.fetch = fetchMock as unknown as typeof fetch
    initApi({
      baseUrl: 'https://api.test',
      getAccessToken: async () => 'token',
      onUnauthorized: async () => null,
    })
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  const bodyOf = () => JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)

  it('sends no updatedAt — a device clock must not be able to veto a deliberate tap', async () => {
    await markProgressFinished('e1', { chapterId: 'c1', finished: true })

    expect(bodyOf()).not.toHaveProperty('updatedAt')
  })

  it('finishes with the end sentinel and a whole-book percent', async () => {
    await markProgressFinished('e1', { chapterId: 'c1', finished: true })

    expect(bodyOf()).toMatchObject({
      chapterId: 'c1',
      locator: '{"type":"end"}',
      percent: 1,
      percentUnit: 'book',
    })
  })

  it('un-finishes with the start sentinel and zero', async () => {
    await markProgressFinished('e1', { chapterId: 'c1', finished: false })

    expect(bodyOf()).toMatchObject({ locator: '{"type":"start"}', percent: 0 })
  })

  it('leaves the ordinary progress write alone — it IS a queued sync and keeps its timestamp', async () => {
    // The guard exists for this caller: reader progress is flushed from a queue, offline and out of
    // order, where an older write must not overwrite a newer one.
    await updateProgress('e1', { chapterId: 'c1', chapterSlug: 'ch-1', progress: 0.4 })

    expect(bodyOf()).toHaveProperty('updatedAt')
  })
})
