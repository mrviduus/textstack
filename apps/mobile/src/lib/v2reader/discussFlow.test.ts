import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, SHARE_MS, V2DiscussError, type V2DiscussShared } from '@textstack/shared'
import { createDiscussLocks, runDiscuss, type DiscussFlowDeps } from './discussFlow'

const shared: V2DiscussShared = { shareId: '5ba7ed00-0000-4000-8000-000000000001', cut: false, brief: 'I\'m reading "Dracula" in TextStack.\n\n(TextStack: book b, share s)' }
const CLAUDE = [{ clientName: 'Claude' }]
const offline = () => Object.assign(new ApiError(0, 'down'), { isNetworkError: true })

const base = () => ({
  canConnect: true,
  grants: vi.fn<DiscussFlowDeps['grants']>(async () => CLAUDE),
  serverBook: vi.fn<DiscussFlowDeps['serverBook']>(async () => ({ bookId: 'b', fileId: 'f' })),
  share: vi.fn<DiscussFlowDeps['share']>(async () => shared),
  current: () => true,
  showConnect: vi.fn<DiscussFlowDeps['showConnect']>(),
  openChat: vi.fn<DiscussFlowDeps['openChat']>(),
})
const flow = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over })

describe('runDiscuss (#1316, the Android host)', () => {
  afterEach(() => vi.useRealTimers())

  it('shares under the server ids of the open bytes, then opens the chat with that share', async () => {
    const d = flow()
    expect(await runDiscuss(d)).toEqual({ phase: 'ready', shared })
    expect(d.share.mock.calls).toEqual([[{ bookId: 'b', fileId: 'f' }]])
    expect(d.openChat.mock.calls).toEqual([[shared]])
    expect(d.showConnect).not.toHaveBeenCalled()
  })

  it('with no assistant connected shares nothing and shows how to connect one: no chat, and none with an empty message', async () => {
    const d = flow({ grants: vi.fn<DiscussFlowDeps['grants']>(async () => [{ clientName: 'Some other app' }]) })
    expect(await runDiscuss(d)).toBeUndefined()
    expect(d.showConnect).toHaveBeenCalledTimes(1)
    expect(d.serverBook).not.toHaveBeenCalled()
    expect(d.share).not.toHaveBeenCalled()
    expect(d.openChat).not.toHaveBeenCalled()
  })

  it('reads a grants request that fails as that, with a retry: not as "none connected"', async () => {
    const d = flow({ grants: vi.fn<DiscussFlowDeps['grants']>(async () => { throw offline() }) })
    expect(await runDiscuss(d)).toEqual({ phase: 'failed', reason: 'offline' })
    expect(d.showConnect).not.toHaveBeenCalled()
    expect(d.share).not.toHaveBeenCalled()
    expect(d.openChat).not.toHaveBeenCalled()
  })

  it('gives a grants request that never answers a deadline', async () => {
    vi.useFakeTimers()
    const d = flow({ grants: vi.fn<DiscussFlowDeps['grants']>(() => new Promise<never>(() => {})) })
    const going = runDiscuss(d)
    await vi.advanceTimersByTimeAsync(SHARE_MS)
    expect(await going).toEqual({ phase: 'failed', reason: 'timeout' })
    expect(d.showConnect).not.toHaveBeenCalled()
  })

  it('asks nothing for a user who may not connect an assistant: the connect sheet', async () => {
    const d = flow({ canConnect: false })
    expect(await runDiscuss(d)).toBeUndefined()
    expect(d.grants).not.toHaveBeenCalled()
    expect(d.showConnect).toHaveBeenCalledTimes(1)
    expect(d.openChat).not.toHaveBeenCalled()
  })

  it('says a book this device does not hold is not on the server, and a failed share by its cause; no chat', async () => {
    const none = flow({ serverBook: vi.fn<DiscussFlowDeps['serverBook']>(async () => null) })
    expect(await runDiscuss(none)).toEqual({ phase: 'failed', reason: 'noBook' })
    expect(none.share).not.toHaveBeenCalled()
    const failed = flow({ share: vi.fn<DiscussFlowDeps['share']>(async () => { throw new V2DiscussError('timeout') }) })
    expect(await runDiscuss(failed)).toEqual({ phase: 'failed', reason: 'timeout' })
    expect(none.openChat).not.toHaveBeenCalled()
    expect(failed.openChat).not.toHaveBeenCalled()
  })

  it('does nothing more once the identity or the book changed: after the grants, after the ids, after the share, after a failure', async () => {
    for (const leaveAfter of ['grants', 'serverBook', 'share'] as const) {
      let live = true
      const d = flow({ current: () => live })
      const leave = <T,>(answer: T) => async () => { live = false; return answer }
      if (leaveAfter === 'grants') d.grants.mockImplementationOnce(leave(CLAUDE))
      else if (leaveAfter === 'serverBook') d.serverBook.mockImplementationOnce(leave({ bookId: 'b', fileId: null }))
      else d.share.mockImplementationOnce(leave(shared))
      expect(await runDiscuss(d)).toBeUndefined()
      expect(d.openChat).not.toHaveBeenCalled()
      expect(d.showConnect).not.toHaveBeenCalled()
      if (leaveAfter !== 'share') expect(d.share).not.toHaveBeenCalled()
    }
    // Gone by the time the grants answer "none": no connect sheet over another user's screen.
    let here = true
    const none = flow({ current: () => here, grants: vi.fn<DiscussFlowDeps['grants']>(async () => { here = false; return [] }) })
    expect(await runDiscuss(none)).toBeUndefined()
    expect(none.showConnect).not.toHaveBeenCalled()
    let live = true
    const failed = flow({ current: () => live, share: vi.fn<DiscussFlowDeps['share']>(async () => { live = false; throw offline() }) })
    expect(await runDiscuss(failed)).toBeUndefined()
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
