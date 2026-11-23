import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readerSyncApi, type SyncTarget } from '../../lib/readerSync'
import { ReaderHost } from './ReaderHost'

// #1426: a signed-in open of the server's own file asks the page to describe the book on screen and hands the
// answer to the shared fill (fillBookMeta, its rules tested in packages/shared).

const fill = vi.fn()
const tocSync = vi.fn()
vi.mock('@textstack/shared', async (real) => ({ ...(await real<object>()), fillBookMeta: (...a: unknown[]) => fill(...a), syncTocIfMissing: (...a: unknown[]) => tocSync(...a) }))
let signedIn = true
vi.mock('../../context/AuthContext', () => ({ useAuth: () => (signedIn ? { isAuthenticated: true, user: { id: 'u1' }, isGuest: false } : { isAuthenticated: false, user: null, isGuest: false }) }))

const SHA = 'a'.repeat(64)
const T: SyncTarget = { bookId: 'b1', fileId: 'f1', format: 'epub', sha256: SHA, size: 8, name: 'b1.epub', hasToc: false }
const META = { title: 'Walden', author: 'Thoreau', lang: 'en', description: '' }

afterEach(() => { cleanup(); vi.restoreAllMocks(); fill.mockReset(); tocSync.mockReset(); signedIn = true })

async function open() {
  vi.spyOn(readerSyncApi, 'getReadingState').mockResolvedValue(null)
  vi.spyOn(readerSyncApi, 'annotations').mockResolvedValue([])
  const view = render(<ReaderHost book={null} />)
  const frame = (screen.getByTitle('Book text') as HTMLIFrameElement).contentWindow!
  const post = vi.spyOn(frame, 'postMessage').mockImplementation((() => {}) as never)
  const fromPage = (m: object) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame }))
    await new Promise((r) => setTimeout(r, 0))
  })
  await fromPage({ type: 'ready' })
  view.rerender(<ReaderHost book={{ bytes: new ArrayBuffer(8), name: T.name, sync: T }} />)
  await fromPage({ type: 'opened', title: 'Walden', book: { sha256: SHA, size: 8, name: `1/${T.name}` } })
  return { post, fromPage }
}

describe('ReaderHost fills an old upload in on open', () => {
  it('signedIn_TheOpenBooksDescriptionGoesToTheFill', async () => {
    const { post, fromPage } = await open()
    expect(fill).toHaveBeenCalledWith(SHA, expect.any(Function))
    const described = fill.mock.calls[0][1]() as Promise<unknown>
    const id = (post.mock.calls.map((c) => c[0] as { call: string; args: unknown[] }).find((m) => m.call === 'describe')!.args[0])
    await fromPage({ type: 'described', id, meta: META, cover: null })
    await expect(described).resolves.toMatchObject({ meta: META, cover: null })
  })

  it('signedIn_AFileWithNoServerToc_GetsTheTocOfTheSameDescription', async () => {
    const { post, fromPage } = await open()
    expect(tocSync).toHaveBeenCalledWith('b1', 'f1', expect.any(Function), false)
    const meta = fill.mock.calls[0][1]() as Promise<unknown>
    const toc = tocSync.mock.calls[0][2]() as Promise<unknown>
    const asks = post.mock.calls.map((c) => c[0] as { call: string; args: unknown[] }).filter((m) => m.call === 'describe')
    expect(asks).toHaveLength(1)
    const entries = [{ key: 'toc-0', title: 'Economy', depth: 0, fraction: 0 }]
    await fromPage({ type: 'described', id: asks[0].args[0], meta: META, cover: null, toc: entries })
    await expect(toc).resolves.toEqual(entries)
    await expect(meta).resolves.toMatchObject({ meta: META })
  })

  it('signedOut_NothingIsFilled', async () => {
    signedIn = false
    await open()
    expect(fill).not.toHaveBeenCalled()
    expect(tocSync).not.toHaveBeenCalled()
  })
})
