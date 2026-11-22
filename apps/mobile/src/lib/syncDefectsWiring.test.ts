import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source guards for the #1142/#1143 wiring in a context and screens react-dom cannot mount here.
 * The logic is tested in offlineDb.v2.test (the change notification) and v2.test (cancel in the hash).
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')

describe('#1191 — a V2 store reset never lets a listing delete downloads', () => {
  it('the orphan sweep re-lists after a reset during or after the listing, and stops marking on one', () => {
    const ctx = read('src/context/DownloadContext.tsx')
    const listing = ctx.indexOf('const epoch = syncEpoch()')
    const orphans = ctx.indexOf('markUnlistedLeftovers(', listing)
    expect(listing).toBeGreaterThan(-1)
    const before = ctx.slice(listing, orphans)
    expect(before).toContain('if (!resetSince()) throw err')
    expect(before).toContain('if (!listed || resetSince()) {')
    expect(before).toContain('autoRerunRef.current = true')
    // #1193: the sweep marks instead of deleting; `resetSince` stops the marking per id (localLeftovers)
    // and a reset during it re-lists instead of queueing the previous account's books.
    const after = ctx.slice(orphans, ctx.indexOf('chooseAutoDownloads(', orphans))
    expect(after).toContain("'v2', resetSince)")
    expect(after).toContain('if (resetSince()) { autoRerunRef.current = true; continue }')
    expect(read('src/lib/localLeftovers.ts')).toMatch(/for \(const id of chooseNewlyDeleted\([^)]*\)\) \{\s*if \(stale\(\)\) break\s*await markDeletedOnServer\(id\)/)
  })

  it('the library screen re-loads instead of failing when a reset dropped its load, and a sign-out supersedes it', () => {
    const lib = read('app/(tabs)/library.tsx')
    expect(lib.indexOf('const myGen = ++loadGenRef.current')).toBeLessThan(lib.indexOf('if (!isAuthenticated) { setLoading(false); return }'))
    expect(lib).toContain('if (syncEpoch() !== epoch) return void loadData()')
  })
})

describe('#1142 — cached uploads changed by V2 reach the download state', () => {
  it('DownloadContext re-reads SQLite and forgets finished downloads of the affected books', () => {
    const ctx = read('src/context/DownloadContext.tsx')
    const start = ctx.indexOf('useEffect(() => onCachedUserBooksChanged(')
    expect(start).toBeGreaterThan(-1)
    const body = ctx.slice(start, ctx.indexOf('}), [])', start))
    // A download still running for a dropped book is cancelled, not left to end 'complete' (#1142 review).
    expect(body).toContain("if (status === 'downloading') cancelledRef.current.add(id)")
    expect(body).toContain('next.delete(id)')
    expect(body).toContain('getAllCachedUserBooks().then(setCachedUserBooks)')
  })

  it('the book page asks SQLite again when its own rows changed', () => {
    const page = read('app/my-books/[id].tsx')
    expect(page).toMatch(/onCachedUserBooksChanged\(ids => \{\s*if \(!id \|\| !ids\.includes\(id\)\) return\s*isUserBookFullyCached\(id\)/)
  })
})

describe('#1143 — the upload screen honours Cancel and drops the picker copy', () => {
  const upload = read('app/my-books/upload.tsx')

  it('each pick has its own cancel token; a cancelled or superseded upload never navigates', () => {
    expect(upload).not.toContain('v2CancelledRef')
    // The next pick marks the previous one, so one flag answers for Cancel, unmount and superseded.
    expect(upload).toMatch(/if \(uploadRef\.current\) uploadRef\.current\.cancelled = true\s*const upload = \{ cancelled: false \}\s*uploadRef\.current = upload/)
    expect(upload).toContain('const live = () => !upload.cancelled')
    expect(upload).toContain('deviceUploadIo(() => upload.cancelled)')
    expect(upload.match(/if \(!live\(\)\) return/g)).toHaveLength(3)
  })

  it('an upload left while the picker was open does nothing', () => {
    expect(upload).toMatch(/const file = result\.assets\[0\]\s*\/\/[^\n]*\n\s*if \(!live\(\)\) return\s*setFileName/)
  })

  it('a superseded upload never moves the progress bar', () => {
    expect(upload).toContain('p => { if (live()) setUploadProgress(p) }')
  })

  it('only the current upload resets the screen in finally', () => {
    const fin = upload.slice(upload.lastIndexOf('} finally {'))
    expect(fin).toContain('if (live()) setUploading(false)')
  })

  it('the picker makes no cache copy: the upload\'s one copy is the staged one (#1426, deleted by uploadPicked)', () => {
    expect(upload).toContain('copyToCacheDirectory: false')
    expect(upload).toContain('await uploadPicked(')
  })
})
