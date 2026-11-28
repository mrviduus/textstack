import { describe, expect, it, vi } from 'vitest'

const bytes = new Uint8Array([1, 2, 3]).buffer
const SHA = 'ab'.repeat(32)
const book = { id: 'b1', sha256: SHA, size: 3, original_name: 'dune.epub', format: 'epub', file_id: 'f1' as string | null, server_file_id: 'f1' as string | null, server_sha256: SHA as string | null, server_size: 3, server_format: 'epub' }
let row = { ...book }
let retained: { uri: string; format: string | null } | null = null
const retainBook = vi.fn(async () => { retained = { uri: 'file:///v2/books/x.epub', format: 'epub' }; return true })

const addSession = vi.fn(async (_sha: string, _s: unknown, _id: () => string) => true)
const syncNow = vi.fn(async (_retry?: boolean) => 'done')
const syncAfterSave = vi.fn()
let serverFile: { id: string; hasToc: boolean } | null = { id: 'f1', hasToc: false }
vi.mock('./android/deviceDownload', () => ({ retainedFile: async () => retained, retainBook }))
vi.mock('./android/deviceLibrary', () => ({ deviceLocalLibrary: () => ({ book: async () => row, addSession }) }))
vi.mock('./android/library', () => ({ syncNow }))
vi.mock('./android/native', () => ({ deviceFileBlob: async () => new Blob([bytes]), uuid: { v4: () => 'u' } }))
vi.mock('./android/account', () => ({ sessionEpoch: () => 7 }))
vi.mock('./android/readerSync', () => ({ createDeviceReaderSync: vi.fn(), syncAfterSave }))
vi.mock('@textstack/shared', async (original) => ({
  ...(await original<object>()),
  syncApi: { findBySha256: async () => (serverFile ? { currentFile: serverFile } : null) },
}))

const { reader } = await import('./android.reader')
const open = () => reader.openBook('b1', { signal: new AbortController().signal, onActivity: () => {}, onPercent: () => {} })

describe('the Android reader (the retained file)', () => {
  it('openBook_FileOnTheDevice_ItsBytesAndTheLocalSyncTarget_NoDownload', async () => {
    row = { ...book }
    retained = { uri: 'file:///v2/books/x.epub', format: 'epub' }
    const b = await open()
    expect(new Uint8Array(b!.bytes)).toEqual(new Uint8Array([1, 2, 3]))
    expect(b).toMatchObject({ name: 'dune.epub', sync: { bookId: 'b1', fileId: 'f1', format: 'epub', sha256: SHA, size: 3, name: 'dune.epub' } })
    expect(retainBook).not.toHaveBeenCalled()
    // The server's answer lands beside the open (Expo openedToc): a file without a TOC gets the page's.
    await vi.waitFor(() => expect(b!.sync!.hasToc).toBe(false))
  })

  it('openBook_TheServersFileIsOtherBytes_LocalFileId_NoTocAsked', async () => {
    row = { ...book, file_id: 'f-local', server_sha256: 'cd'.repeat(32), server_file_id: 'f2' }
    retained = { uri: 'file:///v2/books/x.epub', format: 'epub' }
    const b = await open()
    expect(b!.sync).toMatchObject({ fileId: 'f-local' })
    await new Promise((r) => setTimeout(r, 0))
    expect(b!.sync!.hasToc).toBeUndefined()
  })

  it('openBook_NoLocalFileId_TheServersOnlyWhenItIsTheseBytes', async () => {
    retained = { uri: 'file:///v2/books/x.epub', format: 'epub' }
    row = { ...book, file_id: null }
    expect((await open())!.sync).toMatchObject({ fileId: 'f1' })
    row = { ...book, file_id: null, server_sha256: 'cd'.repeat(32) }
    expect((await open())!.sync).toBeUndefined()
  })

  it('queueSession_IntoTheDeviceLibraryByTheBooksBytes_ThenAPass', async () => {
    row = { ...book }
    const s = { userBookId: 'b1', clientSessionId: 'c1', startedAt: 'a', endedAt: 'b', durationSeconds: 60, wordsRead: 10, startPercent: 0.1, endPercent: 0.2 }
    reader.queueSession(s)
    await vi.waitFor(() => expect(syncAfterSave).toHaveBeenCalled())
    expect(addSession).toHaveBeenCalledWith(SHA, s, expect.any(Function))
  })

  it('flushSessions_ThePassThatRetriesFailedEntries', async () => {
    await reader.flushSessions()
    expect(syncNow).toHaveBeenCalledWith(true)
    expect(reader.accountEpoch()).toBe(7)
  })

  it('openBook_NotOnTheDevice_DownloadedFirst', async () => {
    retained = null
    expect(await open()).not.toBeNull()
    expect(retainBook).toHaveBeenCalledTimes(1)
  })

  it('openBook_NoReadableFile_Null', async () => {
    retained = null
    retainBook.mockResolvedValueOnce(false)
    expect(await open()).toBeNull()
  })

  it('ready_NoNetworkNeeded', async () => {
    expect(reader.readyNow()).toBe(true)
    await expect(reader.ready()).resolves.toBeUndefined()
  })
})
