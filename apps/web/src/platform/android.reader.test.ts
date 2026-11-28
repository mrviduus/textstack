import { describe, expect, it, vi } from 'vitest'

const bytes = new Uint8Array([1, 2, 3]).buffer
const row = { sha256: 'ab'.repeat(32), size: 3, original_name: 'dune.epub', format: 'epub', file_id: 'f1', server_file_id: 'f1', server_format: 'epub' }
let retained: { uri: string; format: string | null } | null = null
const retainBook = vi.fn(async () => { retained = { uri: 'file:///v2/books/x.epub', format: 'epub' }; return true })

vi.mock('./android', () => ({ notYet: () => () => { throw new Error('not yet') } }))
vi.mock('./android/deviceDownload', () => ({ retainedFile: async () => retained, retainBook }))
vi.mock('./android/deviceLibrary', () => ({ deviceLocalLibrary: () => ({ book: async () => row }) }))
vi.mock('./android/library', () => ({ syncNow: async () => 'done' }))
vi.mock('./android/native', () => ({ deviceFileBlob: async () => new Blob([bytes]) }))

const { reader } = await import('./android.reader')
const open = () => reader.openBook('b1', { signal: new AbortController().signal, onActivity: () => {}, onPercent: () => {} })

describe('the Android reader (the retained file)', () => {
  it('openBook_FileOnTheDevice_ItsBytes_NoDownload_NoSyncTargetYet', async () => {
    retained = { uri: 'file:///v2/books/x.epub', format: 'epub' }
    const book = await open()
    expect(new Uint8Array(book!.bytes)).toEqual(new Uint8Array([1, 2, 3]))
    expect(book).toMatchObject({ name: 'dune.epub' })
    expect(book!.sync).toBeUndefined()
    expect(retainBook).not.toHaveBeenCalled()
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
