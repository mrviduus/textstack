import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Selection } from '../hooks/useReaderSelection'

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
    expect(upload.match(/if \(!live\(\)\) return/g)).toHaveLength(4)
  })

  it('an upload left while the picker was open does nothing, and keeps its copy for deletion', () => {
    expect(upload).toMatch(/pickedUri = file\.uri\s*\/\/[^\n]*\n\s*if \(!live\(\)\) return\s*setFileName/)
  })

  it('a superseded upload never moves the progress bar', () => {
    expect(upload).toContain('p => { if (live()) setUploadProgress(p) }')
  })

  it('only the current upload resets the screen in finally', () => {
    const fin = upload.slice(upload.lastIndexOf('} finally {'))
    expect(fin).toMatch(/if \(live\(\)\) \{\s*setUploading\(false\)\s*xhrRef\.current = null/)
  })

  it('the picker copy is deleted in finally, best-effort', () => {
    const fin = upload.slice(upload.lastIndexOf('} finally {'))
    expect(fin).toMatch(/if \(pickedUri\) try \{ new File\(pickedUri\)\.delete\(\) \} catch \{\}/)
  })
})

// #1151 (what hid #1139): the selection's anchor is typed, so an offset-less one is a tsc error, not a 400.
// ponytail: the WebView message itself is JSON (`any`); this binds every TS-side producer and consumer.
describe('#1139 — the selection anchor carries its offsets', () => {
  it('an anchor without startOffset/endOffset does not type-check', () => {
    const anchor = { prefix: 'p', exact: 'quote', suffix: 's', startOffset: 1, endOffset: 6 }
    const ok: Selection = { text: 'quote', sentence: '', selectionId: 1, mode: 'drag', anchor }
    // @ts-expect-error — the pre-#1139 page shape: no offsets.
    const old: Selection = { text: 'quote', sentence: '', selectionId: 1, mode: 'drag', anchor: { prefix: 'p', exact: 'quote', suffix: 's' } }
    expect([ok.anchor, old.anchor]).toHaveLength(2)
  })
})
