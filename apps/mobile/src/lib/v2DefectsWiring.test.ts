import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source guards for the #1142/#1143 wiring in a context and screens react-dom cannot mount here.
 * The logic is tested in offlineDb.v2.test (the change notification) and v2.test (cancel in the hash).
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')

describe('#1142 — cached uploads changed by V2 reach the download state', () => {
  it('DownloadContext re-reads SQLite and forgets finished downloads of the affected books', () => {
    const ctx = read('src/context/DownloadContext.tsx')
    const start = ctx.indexOf('useEffect(() => onCachedUserBooksChanged(')
    expect(start).toBeGreaterThan(-1)
    const body = ctx.slice(start, ctx.indexOf('}), [refreshCachedBooks])', start))
    expect(body).toContain("status !== 'downloading'")
    expect(body).toContain('next.delete(id)')
    expect(body).toContain('refreshCachedBooks()')
  })

  it('the book page asks SQLite again when its own rows changed', () => {
    const page = read('app/my-books/[id].tsx')
    expect(page).toMatch(/onCachedUserBooksChanged\(ids => \{\s*if \(!id \|\| !ids\.includes\(id\)\) return\s*isUserBookFullyCached\(id\)/)
  })
})

describe('#1143 — the upload screen honours Cancel and drops the picker copy', () => {
  const upload = read('app/my-books/upload.tsx')

  it('a cancelled V2 upload never navigates', () => {
    expect(upload).toContain('if (unmountedRef.current || v2CancelledRef.current) return')
  })

  it('the picker copy is deleted in finally, best-effort', () => {
    const fin = upload.slice(upload.lastIndexOf('} finally {'))
    expect(fin).toMatch(/if \(pickedUri\) try \{ new File\(pickedUri\)\.delete\(\) \} catch \{\}/)
  })
})
