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

vi.mock('./api', () => ({ getAccessToken: async () => token }))
vi.mock('./account', () => ({ storedUser: async () => null }))
vi.mock('./deviceDownload', () => ({ deleteBook: vi.fn(async () => {}) }))
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

  it('getUserTags_Offline_None', async () => {
    expect(await library.getUserTags()).toEqual([])
  })
})
