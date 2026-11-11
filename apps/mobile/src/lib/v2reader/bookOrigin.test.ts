import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOOK_CONNECT_SRC, BOOK_ORIGIN, BOOK_PATH, bookUrl, servedFile } from './bookOrigin.mjs'
import { CSP } from './carrier.mjs'

const SHA = 'ab'.repeat(32)
const PATCH = readFileSync(resolve(__dirname, '../../../../../patches/react-native-webview@13.16.1.patch'), 'utf8')

describe('V2 book origin (#1228)', () => {
  it('bookUrl_HostFileNames_TheirServedUrl', () => {
    expect(bookUrl(`books/${SHA}.epub`)).toBe(`${BOOK_ORIGIN}/v2/books/${SHA}.epub`)
    expect(bookUrl('staging/1793400532565.epub')).toBe(`${BOOK_ORIGIN}/v2/staging/1793400532565.epub`)
    expect(bookUrl('staging/dl-1793400532565.epub')).toBe(`${BOOK_ORIGIN}/v2/staging/dl-1793400532565.epub`)
  })

  it('bookUrl_AnythingElse_Throws', () => {
    for (const f of [
      'library.json', `store/${SHA}.json`, `books/${SHA}.json`, `books/${SHA.toUpperCase()}.epub`, `books/${SHA.slice(2)}.epub`,
      `books/${SHA}0.epub`, `books/../${SHA}.epub`, `books/..%2F${SHA}.epub`, `books/%2e%2e/${SHA}.epub`, `books//${SHA}.epub`,
      `staging/../library.json`, 'staging/abc.epub', 'staging/1.epub/', 'staging/1.epub?x', 'staging/12345678901234567.epub',
      `books/${SHA}.epub\n`, `/books/${SHA}.epub`, '', 'staging/.epub', 'staging/dl-.epub', `x/v2/books/${SHA}.epub`, `../v2/books/${SHA}.epub`,
    ]) expect(() => bookUrl(f), f).toThrow()
  })

  it('servedFile_OnlyTheServedShapes', () => {
    expect(servedFile(`${BOOK_ORIGIN}/v2/books/${SHA}.epub`)).toBe(`books/${SHA}.epub`)
    expect(servedFile(`${BOOK_ORIGIN}/v2/staging/dl-1.epub`)).toBe('staging/dl-1.epub')
    for (const u of [
      `${BOOK_ORIGIN}/v2/library.json`, `${BOOK_ORIGIN}/v2/books/..%2Flibrary.json`, `${BOOK_ORIGIN}/v2/books/%2e%2e/library.json`,
      `${BOOK_ORIGIN}/v2/books/${SHA}.epub?x=1`, `${BOOK_ORIGIN}/v2/books/${SHA}.epub#x`, `${BOOK_ORIGIN}:443/v2/books/${SHA}.epub`,
      `http://appassets.androidplatform.net/v2/books/${SHA}.epub`, `https://appassets.androidplatform.net.evil/v2/books/${SHA}.epub`,
      `https://x@appassets.androidplatform.net/v2/books/${SHA}.epub`, `file:///data/user/0/app/files/v2/books/${SHA}.epub`,
      `${BOOK_ORIGIN}/v2/books/${SHA}.epub/`, `${BOOK_ORIGIN}/v2/BOOKS/${SHA}.epub`, `${BOOK_ORIGIN}/`, `${BOOK_ORIGIN}/x/v2/books/${SHA}.epub`, `https://evil.example/${BOOK_ORIGIN}/v2/books/${SHA}.epub`, null, undefined,
    ]) expect(servedFile(u as string), String(u)).toBeNull()
  })

  it('csp_ConnectsOnlyToTheServedDirectories_NoFile', () => {
    const connect = /connect-src ([^;]*)/.exec(CSP)![1].split(' ')
    expect(connect).toEqual(['blob:', 'data:', `${BOOK_ORIGIN}/v2/books/`, `${BOOK_ORIGIN}/v2/staging/`])
    expect(BOOK_CONNECT_SRC.split(' ')).toEqual(connect.slice(2))
    expect(CSP).not.toMatch(/file:/)
  })

  // The interceptor is Java (patches/react-native-webview@13.16.1.patch): its rule must be this one, byte for byte.
  it('nativePatch_SameRuleOriginAndMainFrameBridge', () => {
    expect(PATCH).toContain(`Pattern.compile(${JSON.stringify(BOOK_PATH)})`)
    expect(PATCH).toContain(`BOOK_ORIGIN = ${JSON.stringify(BOOK_ORIGIN)}`)
    expect(PATCH).toContain('if (!isMainFrame) return;')
    expect(PATCH).toContain('view.servesBooks = baseUrl == TextStackBookServer.BOOK_ORIGIN + "/"')
  })
})
