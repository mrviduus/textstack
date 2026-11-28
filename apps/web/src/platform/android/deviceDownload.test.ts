import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'

// The plugins faked at the module boundary: a memory file system with the filesystem plugin's calls (paths under
// `doc/`, the app's data directory), the WebView's file read over it, and the session's token.
const files = new Map<string, Uint8Array<ArrayBuffer>>()
const dirs = new Set<string>()
/** A rename out of staging/ fails for good (a disk error). */
let renameBroken = false
const downloads: Array<{ url: string; headers: Record<string, string> }> = []
/** What the next download writes before it ends; `fail`: it then throws (a full disk). */
let serve: { bytes: Uint8Array<ArrayBuffer>; fail?: boolean } = { bytes: new Uint8Array() }

const doc = (o: { path: string }) => `doc/${o.path}`
const missing = (p: string) => Object.assign(new Error(`${p} does not exist`), { code: 'OS-PLUG-FILE-0008' })
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    stat: async (o: { path: string }) => {
      if (dirs.has(doc(o))) return { type: 'directory', size: 0 }
      const f = files.get(doc(o))
      if (!f) throw missing(doc(o))
      return { type: 'file', size: f.length }
    },
    deleteFile: async (o: { path: string }) => {
      if (!files.delete(doc(o))) throw missing(doc(o))
    },
    mkdir: async (o: { path: string }) => {
      if (dirs.has(doc(o))) throw new Error('Directory exists')
      const segments = doc(o).split('/')
      for (let i = 2; i <= segments.length; i++) dirs.add(segments.slice(0, i).join('/'))
    },
    // Like a rename that does not overwrite: a target that is there is an error.
    rename: async (o: { from: string; to: string }) => {
      const from = `doc/${o.from}`
      const to = `doc/${o.to}`
      if ((renameBroken && from.includes('/staging/')) || files.has(to)) throw new Error(`rename ${from} failed`)
      if (!files.has(from)) throw missing(from)
      files.set(to, files.get(from)!)
      files.delete(from)
    },
    getUri: async (o: { path: string }) => ({ uri: `file:///${doc(o)}` }),
    downloadFile: async (o: { url: string; path: string; headers: Record<string, string> }) => {
      downloads.push({ url: o.url, headers: o.headers })
      files.set(doc(o), serve.fail ? serve.bytes.slice(0, 3) : serve.bytes)
      if (serve.fail) throw new Error('No space left on device')
      return { path: `/data/${doc(o)}` }
    },
  },
}))
vi.mock('@capacitor/core', () => ({ Capacitor: { convertFileSrc: (uri: string) => uri.replace('file:///', 'https://localhost/_capacitor_file_/') } }))
vi.mock('@capacitor-community/sqlite', () => ({ CapacitorSQLite: {}, SQLiteConnection: class {} }))
vi.mock('./api', () => ({ APP_HEADERS: { 'X-App-Version': '1.2.3' }, freshAccessToken: async () => 'tok' }))

const { downloadIo } = await import('./deviceDownload')

const book = Uint8Array.from({ length: 2000 }, (_, i) => (i * 7) & 0xff)
const SHA = createHash('sha256').update(book).digest('hex')
const staged = () => [...files.keys()].filter((p) => p.startsWith('doc/v2/staging/'))

describe('downloadIo.fetch', () => {
  beforeEach(() => {
    files.clear()
    dirs.clear()
    renameBroken = false
    downloads.length = 0
    // The WebView's read of a device file: its bytes by its file:// uri.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const f = files.get(url.replace('https://localhost/_capacitor_file_/', ''))
      return f ? { ok: true, status: 200, blob: async () => new Blob([f]) } : { ok: false, status: 404, blob: async () => new Blob([]) }
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('fetch_BytesMatch_ReturnsTheStagedName', async () => {
    serve = { bytes: book }
    const name = await downloadIo.fetch('http://api/me/v2/books/b/files/f/content', SHA)
    expect(name).toMatch(/^staging\/dl-\d+\.epub$/)
    expect(files.get(`doc/v2/${name}`)).toEqual(book)
    expect(downloads).toEqual([{ url: 'http://api/me/v2/books/b/files/f/content', headers: { 'X-App-Version': '1.2.3', Authorization: 'Bearer tok' } }])
  })

  it('fetch_BytesDiffer_FileDeletedAndRejects', async () => {
    serve = { bytes: book.slice(1) }
    await expect(downloadIo.fetch('http://api/c', SHA)).rejects.toThrow('downloaded bytes do not match the book')
    expect(staged()).toEqual([])
  })

  it('fetch_DownloadFails_NoPartialFileLeft', async () => {
    serve = { bytes: book, fail: true }
    await expect(downloadIo.fetch('http://api/c', SHA)).rejects.toThrow('No space left on device')
    expect(staged()).toEqual([])
  })

  it('retain_ADamagedCopyThere_TheStagedBytesReplaceIt', async () => {
    serve = { bytes: book }
    const name = await downloadIo.fetch('http://api/content', SHA)
    files.set(`doc/v2/books/${SHA}.epub`, new Uint8Array(0))
    await downloadIo.retain(name, SHA)
    expect(files.get(`doc/v2/books/${SHA}.epub`)).toEqual(book)
    expect(staged()).toEqual([])
  })

  it('retain_RenameFails_TheRetainedCopyIsKept', async () => {
    serve = { bytes: book }
    const name = await downloadIo.fetch('http://api/content', SHA)
    const old = Uint8Array.from([1, 2, 3])
    files.set(`doc/v2/books/${SHA}.epub`, old)
    renameBroken = true
    await expect(downloadIo.retain(name, SHA)).rejects.toThrow(/rename/)
    expect(files.get(`doc/v2/books/${SHA}.epub`)).toEqual(old)
  })
})
