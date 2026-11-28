// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@textstack/shared'
import { createLocalLibrary, type LocalLibrary } from './localLibrary'
import { memoryDb } from './sqliteShim'

// The device library is a real one over node:sqlite; the server (the web calls), the session and the files are faked.
let lib: LocalLibrary
let token: string | null = 'at'
let mayList = true
let server: { books: () => Promise<unknown[]> } = { books: async () => [] }
/** What the shared client throws when the request never reached the server. */
const offline = () => Object.assign(new ApiError(0, 'Failed to fetch'), { isNetworkError: true })

vi.mock('./api', () => ({
  APP_HEADERS: {},
  getAccessToken: async () => token,
  freshAccessToken: async () => token,
  onUnauthorized: async () => (token = 'at-2'),
}))
vi.mock('./syncClient', () => ({ startSyncProbe: async () => ({ enabled: true, maxPartBytes: 1000 }) }))
let sent: { url: string; auth: string | null }[] = []
vi.mock('../../api/sync', () => ({
  // The web upload sequence, reduced to one part: the sender is what this tests.
  uploadBook: async (file: File, _max: number, sendPart: (url: string, part: Blob, onLoaded: (n: number) => void) => Promise<void>) => {
    await sendPart('http://api/me/v2/books/b/files/f/parts/0', file, () => {})
    return { userBookId: 'b', jobId: '', status: 'Ready' }
  },
}))
vi.mock('./account', () => ({ storedUser: async () => null }))
vi.mock('./deviceDownload', () => ({ deleteBook: vi.fn(async () => {}), retainBook: vi.fn(async () => true) }))
vi.mock('./deviceLibrary', () => ({
  deviceLocalLibrary: () => lib,
  deviceRemovals: async () => new Set((await lib.outbox('removal')).map((i) => i.target)),
  signedOutMayList: async () => mayList,
}))
vi.mock('../../api/userBooks', () => ({
  getUserBooks: () => server.books(),
  getUserBook: async () => { throw offline() },
  getUserBookProgress: async () => { throw offline() },
  getUserTags: async () => { throw offline() },
}))

const { library } = await import('./library')
const { deleteBook, retainBook } = await import('./deviceDownload')

const SHA = 'ab'.repeat(32)
async function bookOnDevice() {
  let n = 0
  await lib.addOpened({ sha256: SHA, size: 10, title: 'Dune', author: 'Herbert', originalName: 'dune.epub', format: 'epub' }, () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`)
  return (await lib.books())[0].id
}

describe('the Android library (server online, the device offline)', () => {
  beforeEach(() => {
    lib = createLocalLibrary(memoryDb())
    token = 'at'
    mayList = true
    server = { books: async () => [] }
  })

  it('getUserBooks_Online_TheServerListWithoutBooksDeletedHere', async () => {
    const id = await bookOnDevice()
    server = { books: async () => [{ id, title: 'Dune' }, { id: 'b2', title: 'Emma' }] }
    await lib.removeBook(id)
    expect((await library.getUserBooks()).map((b) => b.id)).toEqual(['b2'])
  })

  it('getUserBooks_Offline_TheBooksOnThisDevice', async () => {
    const id = await bookOnDevice()
    server = { books: async () => { throw offline() } }
    const books = await library.getUserBooks()
    expect(books).toMatchObject([{ id, title: 'Dune', status: 'Ready', slug: '' }])
  })

  it('getUserBooks_ServerFails_TheErrorIsTheCallers', async () => {
    server = { books: async () => { throw Object.assign(new Error('boom'), { status: 500 }) } }
    await expect(library.getUserBooks()).rejects.toThrow('boom')
  })

  it('getUserBooks_NoSession_DeviceBooksOnlyWhileNoSignOutWipeIsOwed', async () => {
    const id = await bookOnDevice()
    token = null
    expect((await library.getUserBooks()).map((b) => b.id)).toEqual([id])
    mayList = false
    expect(await library.getUserBooks()).toEqual([])
  })

  it('getUserBook_Offline_TheDeviceDetail_NotHere404', async () => {
    const id = await bookOnDevice()
    expect(await library.getUserBook(id)).toMatchObject({ id, title: 'Dune', status: 'Ready', hasFile: true })
    await expect(library.getUserBook('elsewhere')).rejects.toMatchObject({ status: 404 })
  })

  it('getUserBook_ServerError_TheDeviceCopy_SignedOutWithAWipeOwed404', async () => {
    const id = await bookOnDevice()
    expect(await library.getUserBook(id)).toMatchObject({ id })
    token = null
    mayList = false
    await expect(library.getUserBook(id)).rejects.toMatchObject({ status: 404 })
    expect(await library.getUserBookProgress(id)).toBeNull()
  })

  it('uploadUserBook_APartRefused401_RefreshedAndSentAgainWithTheBearer', async () => {
    sent = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization ?? null
      sent.push({ url, auth })
      return new Response(null, { status: auth === 'Bearer at-2' ? 200 : 401 })
    }))
    await library.uploadUserBook(new File([new Uint8Array(3)], 'b.epub'))
    expect(sent.map((s) => s.auth)).toEqual(['Bearer at', 'Bearer at-2'])
    vi.unstubAllGlobals()
  })

  it('uploadUserBook_Done_TheBookIsKeptOnThisDeviceForTheReader_AFailureIsNotTheUploads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
    vi.mocked(retainBook).mockClear().mockRejectedValueOnce(new Error('disk full'))
    const result = await library.uploadUserBook(new File([new Uint8Array(3)], 'b.epub'))
    expect(vi.mocked(retainBook)).toHaveBeenCalledWith(result.userBookId, expect.any(Function))
    vi.unstubAllGlobals()
  })

  it('bulkDeleteUserBooks_EachOffTheDeviceFirst_OneFailsTheRestGo', async () => {
    vi.mocked(deleteBook).mockClear().mockImplementation(async (id: string) => { if (id === 'b2') throw new Error('disk busy') })
    expect(await library.bulkDeleteUserBooks(['b1', 'b2', 'b3'])).toEqual({ succeeded: ['b1', 'b3'], failed: [{ id: 'b2', reason: 'disk busy' }] })
    expect(vi.mocked(deleteBook)).toHaveBeenCalledTimes(3)
  })

  it('getUserTags_Offline_None', async () => {
    expect(await library.getUserTags()).toEqual([])
  })
})
