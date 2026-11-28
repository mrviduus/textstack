import { describe, expect, it, vi } from 'vitest'

const bytes = new Uint8Array([1, 2, 3]).buffer
const SHA = 'ab'.repeat(32)
const book = { id: 'b1', sha256: SHA, size: 3, original_name: 'dune.epub', format: 'epub', file_id: 'f1' as string | null, server_file_id: 'f1' as string | null, server_sha256: SHA as string | null, server_size: 3, server_format: 'epub' }
let row = { ...book }
let retained: { uri: string; format: string | null } | null = null
const retainBook = vi.fn(async () => { retained = { uri: 'file:///v2/books/x.epub', format: 'epub' }; return true })

const kept = new Map<string, string>()
const addSession = vi.fn(async (sha: string, _s: unknown, id: () => string) => { kept.set(id(), sha); return true })
let token: string | null = 't'
const syncNow = vi.fn(async (_retry?: boolean) => 'done')
const syncAfterSave = vi.fn()
let serverFile: { id: string; hasToc: boolean } | null = { id: 'f1', hasToc: false }
vi.mock('./android/deviceDownload', () => ({ retainedFile: async () => retained, retainBook }))
vi.mock('./android/deviceLibrary', () => ({ deviceLocalLibrary: () => ({ book: async () => row, addSession, session: async (id: string) => (kept.has(id) ? { id } : null) }) }))
vi.mock('./android/library', () => ({ syncNow }))
vi.mock('./android/native', () => ({ deviceFileBlob: async () => new Blob([bytes]), uuid: { v4: () => 'u' } }))
vi.mock('./android/account', () => ({ sessionEpoch: () => 7 }))
vi.mock('./android/api', () => ({ getAccessToken: async () => token }))
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

  const ended = (id: string) => ({ userBookId: 'b1', clientSessionId: id, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationSeconds: 60, wordsRead: 10, startPercent: 0.1, endPercent: 0.2 })
  const queued = () => JSON.parse(localStorage.getItem('v2reader:pendingSessions') ?? '[]') as { clientSessionId: string }[]

  it('queueSession_KeptAtOnce_ThenInTheDeviceLibraryByTheBooksBytes_ThenAPass', async () => {
    row = { ...book }
    await open()
    reader.queueSession(ended('c1'))
    // Synchronously (pagehide waits for nothing).
    expect(queued().map((s) => s.clientSessionId)).toEqual(['c1'])
    await vi.waitFor(() => expect(syncAfterSave).toHaveBeenCalled())
    expect(addSession).toHaveBeenCalledWith(SHA, expect.objectContaining({ clientSessionId: 'c1' }), expect.any(Function))
    expect(kept.get('c1')).toBe(SHA)
    expect(queued()).toEqual([])
  })

  it('queueSession_TheDeviceWriteFails_StaysQueued_MovedByTheNextFlush', async () => {
    addSession.mockRejectedValueOnce(new Error('SQLITE_BUSY'))
    reader.queueSession(ended('c2'))
    await vi.waitFor(() => expect(addSession).toHaveBeenCalledWith(SHA, expect.objectContaining({ clientSessionId: 'c2' }), expect.any(Function)))
    await new Promise((r) => setTimeout(r, 0))
    expect(queued().map((s) => s.clientSessionId)).toEqual(['c2'])
    await reader.flushSessions()
    expect(kept.get('c2')).toBe(SHA)
    expect(queued()).toEqual([])
  })

  it('openBook_NoSession_NoTocAsked', async () => {
    row = { ...book }
    token = null
    retained = { uri: 'file:///v2/books/x.epub', format: 'epub' }
    const b = await open()
    await new Promise((r) => setTimeout(r, 0))
    expect(b!.sync!.hasToc).toBeUndefined()
    token = 't'
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
