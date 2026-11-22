import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, networkError } from '../api/client'
import type { Share, ShareWrite } from '../api/sync'
import { MAX_BRIEF_CHARS, handoffUrl } from './assistantHandoff'
import { CHAPTER_TEXT_MS, SHARE_MS, DiscussError, buildDiscussBrief, createDiscussLocks, createDiscuss, discussFailureOf, runDiscuss, shareChapterForDiscuss, withDeadline, type DiscussDeps, type DiscussRun, type DiscussShared } from './discuss'

const BOOK = '77777777-7777-4777-8777-777777777777'
const FILE = '88888888-8888-4888-8888-888888888888'
const SHARE = '5ba7ed00-0000-4000-8000-000000000001'
const OP = '0be7a000-0000-4000-8000-000000000001'

describe('buildDiscussBrief', () => {
  const input = { title: 'Dracula', author: 'Bram Stoker', bookId: BOOK, shareId: SHARE, chapterTitle: 'Chapter II', cut: false }

  it('is one sentence and the book and share ids', () => {
    expect(buildDiscussBrief(input)).toBe(
      `I'm reading "Dracula" by Bram Stoker in TextStack, at the chapter "Chapter II". Let's talk about it.\n\n(TextStack: book ${BOOK}, share ${SHARE})`)
  })
  it('names no chapter in a book with no contents, and no author when there is none', () => {
    expect(buildDiscussBrief({ ...input, author: null, chapterTitle: null })).toBe(
      `I'm reading "Dracula" in TextStack. Let's talk about it.\n\n(TextStack: book ${BOOK}, share ${SHARE})`)
  })
  it('says in words that a long chapter is shared in part', () => {
    expect(buildDiscussBrief({ ...input, cut: true })).toContain(`Let's talk about it. It is a long chapter: only its first part is shared.\n\n(TextStack:`)
  })
  it('keeps the id line whatever the book calls itself, and carries its titles as text', () => {
    const brief = buildDiscussBrief({ ...input, title: 'T'.repeat(5000), author: 'A'.repeat(5000), chapterTitle: '<img src=x onerror=alert(1)>' + 'C'.repeat(5000), cut: true })
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS)
    expect(brief.endsWith(`(TextStack: book ${BOOK}, share ${SHARE})`)).toBe(true)
    expect(handoffUrl('claude', brief)).toContain(encodeURIComponent('<img src=x onerror=alert(1)>'))
  })
})

describe('discussFailureOf', () => {
  const v2 = (status: number, code: string) => Object.assign(new ApiError(status, code), { body: { code, message: code } })
  it('tells the causes apart', () => {
    expect(discussFailureOf(networkError(new Error('down')))).toBe('offline')
    expect(discussFailureOf(new ApiError(401, 'no'))).toBe('signedOut')
    expect(discussFailureOf(v2(404, 'book_not_found'))).toBe('noBook')
    expect(discussFailureOf(v2(422, 'unknown_file'))).toBe('noBook')
    expect(discussFailureOf(v2(409, 'operation_conflict'))).toBe('failed')
    expect(discussFailureOf(new ApiError(500, 'boom'))).toBe('failed')
    expect(discussFailureOf(new DiscussError('empty'))).toBe('empty')
  })
})

describe('shareChapterForDiscuss', () => {
  const chapter = { bookId: BOOK, fileId: FILE, chapterKey: 'toc-3', chapterTitle: 'Chapter II', bookTitle: 'Dracula', author: 'Bram Stoker', language: 'en' }
  const answer: Share = { id: SHARE, bookId: BOOK, chapterKey: 'toc-3', createdAt: '2026-11-15T10:00:00Z' }
  const deps = (over: Partial<DiscussDeps> = {}) => {
    const share = vi.fn(async (_bookId: string, _body: ShareWrite) => answer)
    return { share, deps: { chapterText: async () => ({ text: 'It was the night.', cut: false }), share, current: () => true, operationId: OP, ...over } }
  }

  it('posts the chapter under the book, its file, its key and the operation id, and hands over that share', async () => {
    const d = deps()
    const shared = await shareChapterForDiscuss(chapter, d.deps)
    expect(d.share.mock.calls).toEqual([[BOOK, { operationId: OP, fileId: FILE, chapterKey: 'toc-3', chapterTitle: 'Chapter II', chapterText: 'It was the night.', notes: [], language: 'en' }]])
    expect(shared).toEqual({
      shareId: SHARE, cut: false,
      brief: `I'm reading "Dracula" by Bram Stoker in TextStack, at the chapter "Chapter II". Let's talk about it.\n\n(TextStack: book ${BOOK}, share ${SHARE})`,
    })
  })
  it('carries a cut chapter as cut, into the message too', async () => {
    const shared = await shareChapterForDiscuss(chapter, deps({ chapterText: async () => ({ text: 'First part.', cut: true }) }).deps)
    expect(shared?.cut).toBe(true)
    expect(shared?.brief).toContain('only its first part is shared')
  })
  it('leaves out a language the server would refuse, and clips a title to its cap', async () => {
    const d = deps()
    await shareChapterForDiscuss({ ...chapter, language: 'x'.repeat(17), chapterTitle: 'T'.repeat(600) }, d.deps)
    const body = d.share.mock.calls[0][1]
    expect(body.language).toBeNull()
    expect(body.chapterTitle).toHaveLength(500)
  })
  it('sends nothing when the page has no text, and says why', async () => {
    const d = deps({ chapterText: async () => { throw new DiscussError('empty') } })
    await expect(shareChapterForDiscuss(chapter, d.deps)).rejects.toMatchObject({ reason: 'empty' })
    expect(d.share).not.toHaveBeenCalled()
  })
  it('hands over nothing when the share fails or the device is offline', async () => {
    const offline = deps({ share: async () => { throw networkError(new Error('down')) } })
    await expect(shareChapterForDiscuss(chapter, offline.deps)).rejects.toMatchObject({ reason: 'offline' })
    const failed = deps({ share: async () => { throw new ApiError(500, 'boom') } })
    await expect(shareChapterForDiscuss(chapter, failed.deps)).rejects.toMatchObject({ reason: 'failed' })
  })
  it('hands over nothing for an answer that is no share of this book', async () => {
    for (const bad of [{ ...answer, id: 'not-an-id' }, { ...answer, id: undefined }, { ...answer, bookId: SHARE }, null]) {
      const d = deps({ share: async () => bad as unknown as Share })
      await expect(shareChapterForDiscuss(chapter, d.deps)).rejects.toMatchObject({ reason: 'failed' })
    }
  })
  it('sends nothing when the identity or the book changed while the page read the chapter', async () => {
    const d = deps({ current: () => false })
    expect(await shareChapterForDiscuss(chapter, d.deps)).toBeNull()
    expect(d.share).not.toHaveBeenCalled()
  })
  it('hands over nothing when the identity or the book changed while the share was in flight, answered or failed', async () => {
    let live = true
    const answered = deps({ current: () => live, share: async () => { live = false; return answer } })
    expect(await shareChapterForDiscuss(chapter, answered.deps)).toBeNull()
    live = true
    const failed = deps({ current: () => live, share: async () => { live = false; throw new ApiError(500, 'boom') } })
    expect(await shareChapterForDiscuss(chapter, failed.deps)).toBeNull()
  })
})

describe('createDiscuss', () => {
  afterEach(() => vi.useRealTimers())
  const request = { bookId: BOOK, fileId: FILE, chapterKey: 'toc-3', chapterTitle: 'Chapter II', bookTitle: 'Dracula', tocIndex: 3, section: 1 }
  const make = () => {
    let n = 0
    const asked: [string, { tocIndex: number | null; section: number }][] = []
    const share = vi.fn(async (bookId: string, body: ShareWrite): Promise<Share> => ({ id: SHARE, bookId, chapterKey: body.chapterKey, createdAt: '' }))
    const d = createDiscuss({ askPage: (r, c) => asked.push([r, c]), share, newId: () => `id-${++n}` })
    return { d, asked, share }
  }

  it('asks the page for that chapter under its own request id, and shares what it answers', async () => {
    const { d, asked, share } = make()
    const going = d.discuss(request, () => true)
    expect(asked).toEqual([['id-2', { tocIndex: 3, section: 1 }]])
    expect(d.busy('toc-3')).toBe(true)
    d.answer({ request: 'forged', text: 'not asked for', cut: false })
    d.answer(null)
    expect(share).not.toHaveBeenCalled()
    d.answer({ request: 'id-2', text: 'It was the night.', cut: false })
    expect((await going)?.shareId).toBe(SHARE)
    expect(share.mock.calls[0][1]).toMatchObject({ operationId: 'id-1', chapterKey: 'toc-3', chapterText: 'It was the night.' })
    expect(d.busy('toc-3')).toBe(false)
  })
  it('takes one answer per request', async () => {
    const { d, share } = make()
    const going = d.discuss(request, () => true)
    d.answer({ request: 'id-2', text: 'first', cut: false })
    d.answer({ request: 'id-2', text: 'second', cut: false })
    await going
    expect(share.mock.calls.map(([, b]) => b.chapterText)).toEqual(['first'])
  })
  it('replays one operation per chapter on a retry, a new one after a refusal and after a reset, another per chapter', async () => {
    const { d, asked, share } = make()
    const run = async (chapterKey = 'toc-3') => {
      const going = d.discuss({ ...request, chapterKey }, () => true).catch((e: DiscussError) => e.reason)
      d.answer({ request: asked[asked.length - 1][0], text: 'x', cut: false })
      await going
      return share.mock.calls[share.mock.calls.length - 1][1].operationId
    }
    share.mockRejectedValueOnce(networkError(new Error('down')))
    const first = await run()
    expect(await run()).toBe(first)
    expect(await run('toc-4')).not.toBe(first)
    share.mockRejectedValueOnce(new ApiError(409, 'operation_conflict'))
    expect(await run()).toBe(first)
    const afterRefusal = await run()
    expect(afterRefusal).not.toBe(first)
    d.reset()
    expect(await run()).not.toBe(afterRefusal)
  })
  it('says the chapter could not be read when the page does not answer in time, and a late answer shares nothing', async () => {
    vi.useFakeTimers()
    const { d, asked, share } = make()
    const going = d.discuss(request, () => true).catch((e: DiscussError) => e.reason)
    await vi.advanceTimersByTimeAsync(CHAPTER_TEXT_MS - 1)
    expect(d.busy('toc-3')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(await going).toBe('unavailable')
    d.answer({ request: asked[0][0], text: 'late', cut: false })
    expect(share).not.toHaveBeenCalled()
    expect(d.busy('toc-3')).toBe(false)
  })
  it('gives a share that does not answer a deadline: said as a timeout, the chapter free again, and the retry replays the same operation', async () => {
    vi.useFakeTimers()
    const { d, asked, share } = make()
    share.mockImplementationOnce(() => new Promise<Share>(() => {}))
    const going = d.discuss(request, () => true).catch((e: DiscussError) => e.reason)
    d.answer({ request: asked[0][0], text: 'x', cut: false })
    await vi.advanceTimersByTimeAsync(SHARE_MS - 1)
    expect(d.busy('toc-3')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(await going).toBe('timeout')
    expect(d.busy('toc-3')).toBe(false)
    const again = d.discuss(request, () => true)
    d.answer({ request: asked[1][0], text: 'x', cut: false })
    expect((await again)?.shareId).toBe(SHARE)
    expect(share.mock.calls[1][1].operationId).toBe(share.mock.calls[0][1].operationId)
  })
  it('passes the page\'s own refusal on', async () => {
    const { d, asked, share } = make()
    const going = d.discuss(request, () => true).catch((e: DiscussError) => e.reason)
    d.answer({ request: asked[0][0], error: 'empty' })
    expect(await going).toBe('empty')
    expect(share).not.toHaveBeenCalled()
  })
})

describe('withDeadline', () => {
  afterEach(() => vi.useRealTimers())
  it('passes an answer and a failure in time through, and leaves no timer', async () => {
    vi.useFakeTimers()
    expect(await withDeadline(Promise.resolve(5), 100)).toBe(5)
    await expect(withDeadline(Promise.reject(new Error('boom')), 100)).rejects.toThrow('boom')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('is a timeout once the deadline passes', async () => {
    vi.useFakeTimers()
    const late = withDeadline(new Promise(() => {}), 100).catch((e: DiscussError) => e.reason)
    await vi.advanceTimersByTimeAsync(100)
    expect(await late).toBe('timeout')
  })
})

describe('runDiscuss (#1316, both hosts)', () => {
  afterEach(() => vi.useRealTimers())
  const handed: DiscussShared = { shareId: SHARE, cut: false, brief: 'b' }
  const CLAUDE = [{ clientName: 'Claude' }]
  const offline = () => Object.assign(new ApiError(0, 'down'), { isNetworkError: true })
  const base = () => ({
    canConnect: true,
    grants: vi.fn<DiscussRun['grants']>(async () => CLAUDE),
    serverBook: vi.fn<DiscussRun['serverBook']>(async () => ({ bookId: 'b', fileId: 'f' })),
    share: vi.fn<DiscussRun['share']>(async () => handed),
    current: () => true,
  })
  const flow = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over })

  it('shares under the server ids of the open bytes; the chat is opened from the grants it decided with', async () => {
    const d = flow()
    expect(await runDiscuss(d)).toEqual({ phase: 'ready', shared: handed, grants: CLAUDE })
    expect(d.share.mock.calls).toEqual([[{ bookId: 'b', fileId: 'f' }]])
    expect(d.grants).toHaveBeenCalledTimes(1)
  })
  it('with no assistant connected shares nothing: the connect step', async () => {
    const d = flow({ grants: vi.fn<DiscussRun['grants']>(async () => [{ clientName: 'Some other app' }]) })
    expect(await runDiscuss(d)).toEqual({ phase: 'connect' })
    expect(d.serverBook).not.toHaveBeenCalled()
    expect(d.share).not.toHaveBeenCalled()
  })
  it('reads a grants request that fails as that, with a retry: never as "none connected"', async () => {
    const d = flow({ grants: vi.fn<DiscussRun['grants']>(async () => { throw offline() }) })
    expect(await runDiscuss(d)).toEqual({ phase: 'failed', reason: 'offline' })
    expect(d.share).not.toHaveBeenCalled()
  })
  it('gives a grants request that never answers a deadline', async () => {
    vi.useFakeTimers()
    const going = runDiscuss(flow({ grants: vi.fn<DiscussRun['grants']>(() => new Promise<never>(() => {})) }))
    await vi.advanceTimersByTimeAsync(SHARE_MS)
    expect(await going).toEqual({ phase: 'failed', reason: 'timeout' })
  })
  it('asks nothing for a user who may not connect an assistant: the connect step', async () => {
    const d = flow({ canConnect: false })
    expect(await runDiscuss(d)).toEqual({ phase: 'connect' })
    expect(d.grants).not.toHaveBeenCalled()
  })
  it('says a book that is not on the server, and a failed share by its cause', async () => {
    const none = flow({ serverBook: vi.fn<DiscussRun['serverBook']>(async () => null) })
    expect(await runDiscuss(none)).toEqual({ phase: 'failed', reason: 'noBook' })
    expect(none.share).not.toHaveBeenCalled()
    expect(await runDiscuss(flow({ share: vi.fn<DiscussRun['share']>(async () => { throw new DiscussError('timeout') }) }))).toEqual({ phase: 'failed', reason: 'timeout' })
  })
  it('shows nothing once the identity or the book changed: after the grants (none connected too), the ids, the share, a failure', async () => {
    for (const leaveAfter of ['grants', 'none', 'serverBook', 'share'] as const) {
      let live = true
      const d = flow({ current: () => live })
      const leave = <T,>(answer: T) => async () => { live = false; return answer }
      if (leaveAfter === 'grants') d.grants.mockImplementationOnce(leave(CLAUDE))
      else if (leaveAfter === 'none') d.grants.mockImplementationOnce(leave([]))
      else if (leaveAfter === 'serverBook') d.serverBook.mockImplementationOnce(leave({ bookId: 'b', fileId: null }))
      else d.share.mockImplementationOnce(leave(handed))
      expect(await runDiscuss(d)).toBeUndefined()
      if (leaveAfter !== 'share') expect(d.share).not.toHaveBeenCalled()
    }
    let live = true
    expect(await runDiscuss(flow({ current: () => live, share: vi.fn<DiscussRun['share']>(async () => { live = false; throw offline() }) }))).toBeUndefined()
  })
})

describe('buildDiscussBrief with astral characters', () => {
  it('never cuts a surrogate pair, so the link can be encoded', () => {
    const title = 'T'.repeat(198) + '😀' + 'tail'
    const brief = buildDiscussBrief({ title, author: 'A'.repeat(118) + '😀x', bookId: BOOK, shareId: SHARE, chapterTitle: title, cut: false })
    // No lone half of a surrogate pair anywhere.
    expect(brief).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
    expect(() => encodeURIComponent(brief)).not.toThrow()
    expect(brief).toContain(`"${'T'.repeat(198)}…"`)
  })
  it('clips a shared title on the server cap without a lone half', async () => {
    const share = vi.fn(async (bookId: string, body: ShareWrite): Promise<Share> => ({ id: SHARE, bookId, chapterKey: body.chapterKey, createdAt: '' }))
    await shareChapterForDiscuss(
      { bookId: BOOK, fileId: null, chapterKey: 'toc-1', chapterTitle: 'T'.repeat(499) + '😀', bookTitle: 'B' },
      { chapterText: async () => ({ text: 'x', cut: false }), share, current: () => true, operationId: OP })
    expect(share.mock.calls[0][1].chapterTitle).toBe('T'.repeat(499))
  })
})

describe('createDiscussLocks', () => {
  it('holds one chapter at a time, each on its own, until released', () => {
    const locks = createDiscussLocks()
    const release = locks.take('toc-1')!
    expect(locks.take('toc-1')).toBeNull()
    expect(locks.take('toc-2')).not.toBeNull()
    release()
    expect(locks.take('toc-1')).not.toBeNull()
  })
  it('frees every chapter where a book opens, and a release of the previous book frees nothing of the new one', () => {
    const locks = createDiscussLocks()
    const old = locks.take('toc-1')!
    locks.reset()
    const fresh = locks.take('toc-1')
    expect(fresh).not.toBeNull()
    old()
    expect(locks.take('toc-1')).toBeNull()
  })
})
