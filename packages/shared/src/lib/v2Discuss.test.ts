import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, networkError } from '../api/client'
import type { V2Share, V2ShareWrite } from '../api/v2'
import { MAX_BRIEF_CHARS, handoffUrl } from './assistantHandoff'
import { CHAPTER_TEXT_MS, SHARE_MS, V2DiscussError, buildV2DiscussBrief, createV2Discuss, discussFailureOf, shareChapterForDiscuss, withDeadline, type V2DiscussDeps } from './v2Discuss'

const BOOK = '77777777-7777-4777-8777-777777777777'
const FILE = '88888888-8888-4888-8888-888888888888'
const SHARE = '5ba7ed00-0000-4000-8000-000000000001'
const OP = '0be7a000-0000-4000-8000-000000000001'

describe('buildV2DiscussBrief', () => {
  const input = { title: 'Dracula', author: 'Bram Stoker', bookId: BOOK, shareId: SHARE, chapterTitle: 'Chapter II', cut: false }

  it('is one sentence and the book and share ids', () => {
    expect(buildV2DiscussBrief(input)).toBe(
      `I'm reading "Dracula" by Bram Stoker in TextStack, at the chapter "Chapter II". Let's talk about it.\n\n(TextStack: book ${BOOK}, share ${SHARE})`)
  })
  it('names no chapter in a book with no contents, and no author when there is none', () => {
    expect(buildV2DiscussBrief({ ...input, author: null, chapterTitle: null })).toBe(
      `I'm reading "Dracula" in TextStack. Let's talk about it.\n\n(TextStack: book ${BOOK}, share ${SHARE})`)
  })
  it('says in words that a long chapter is shared in part', () => {
    expect(buildV2DiscussBrief({ ...input, cut: true })).toContain(`Let's talk about it. It is a long chapter: only its first part is shared.\n\n(TextStack:`)
  })
  it('keeps the id line whatever the book calls itself, and carries its titles as text', () => {
    const brief = buildV2DiscussBrief({ ...input, title: 'T'.repeat(5000), author: 'A'.repeat(5000), chapterTitle: '<img src=x onerror=alert(1)>' + 'C'.repeat(5000), cut: true })
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
    expect(discussFailureOf(new V2DiscussError('empty'))).toBe('empty')
  })
})

describe('shareChapterForDiscuss', () => {
  const chapter = { bookId: BOOK, fileId: FILE, chapterKey: 'toc-3', chapterTitle: 'Chapter II', bookTitle: 'Dracula', author: 'Bram Stoker', language: 'en' }
  const answer: V2Share = { id: SHARE, bookId: BOOK, chapterKey: 'toc-3', createdAt: '2026-11-15T10:00:00Z' }
  const deps = (over: Partial<V2DiscussDeps> = {}) => {
    const share = vi.fn(async (_bookId: string, _body: V2ShareWrite) => answer)
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
    const d = deps({ chapterText: async () => { throw new V2DiscussError('empty') } })
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
      const d = deps({ share: async () => bad as unknown as V2Share })
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

describe('createV2Discuss', () => {
  afterEach(() => vi.useRealTimers())
  const request = { bookId: BOOK, fileId: FILE, chapterKey: 'toc-3', chapterTitle: 'Chapter II', bookTitle: 'Dracula', tocIndex: 3, section: 1 }
  const make = () => {
    let n = 0
    const asked: [string, { tocIndex: number | null; section: number }][] = []
    const share = vi.fn(async (bookId: string, body: V2ShareWrite): Promise<V2Share> => ({ id: SHARE, bookId, chapterKey: body.chapterKey, createdAt: '' }))
    const d = createV2Discuss({ askPage: (r, c) => asked.push([r, c]), share, newId: () => `id-${++n}` })
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
      const going = d.discuss({ ...request, chapterKey }, () => true).catch((e: V2DiscussError) => e.reason)
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
    const going = d.discuss(request, () => true).catch((e: V2DiscussError) => e.reason)
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
    share.mockImplementationOnce(() => new Promise<V2Share>(() => {}))
    const going = d.discuss(request, () => true).catch((e: V2DiscussError) => e.reason)
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
    const going = d.discuss(request, () => true).catch((e: V2DiscussError) => e.reason)
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
    const late = withDeadline(new Promise(() => {}), 100).catch((e: V2DiscussError) => e.reason)
    await vi.advanceTimersByTimeAsync(100)
    expect(await late).toBe('timeout')
  })
})
