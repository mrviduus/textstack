import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source guards for the #1191/#1143 wiring in screens react-dom cannot mount here.
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')

describe('#1191 — a V2 store reset never lets a listing delete downloads', () => {
  it('the library screen re-loads instead of failing when a reset dropped its load, and a sign-out supersedes it', () => {
    const lib = read('app/(tabs)/library.tsx')
    expect(lib.indexOf('const myGen = ++loadGenRef.current')).toBeLessThan(lib.indexOf('if (!isAuthenticated) { setLoading(false); return }'))
    expect(lib).toContain('if (syncEpoch() !== epoch) return void loadData()')
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
