// How the Android host hands the page a book without `file://` (#1228, ADR-029 Decision 4, docs/01-architecture/
// v2-reader-android-bytes.md): the page is loaded under BOOK_ORIGIN, the origin Android reserves for app content,
// and a native interceptor (patches/react-native-webview@*.patch, RNCWebViewClient.shouldInterceptRequest) serves
// exactly the files BOOK_PATH matches from the app's `files/v2/`, nothing else. Pure: the host, the CSP
// (carrier.mjs), the sandbox check's emulation of the interceptor and bookOrigin.test.ts all read it.

export const BOOK_ORIGIN = 'https://appassets.androidplatform.net'

/**
 * The only request paths served, as sent (still percent-encoded): a retained book `books/<sha256>.epub` or a staged
 * one `staging/<ms>.epub` / `staging/dl-<ms>.epub` (V2ReaderScreen names them). One fixed shape per directory, so
 * no `..`, `%2F`, `%2e`, `/` or any other byte can reach a file outside them. The interceptor's Java copy of this
 * regex must stay byte-identical (bookOrigin.test.ts reads the patch to assert it).
 */
export const BOOK_PATH = '^/v2/(books/[0-9a-f]{64}|staging/(dl-)?[0-9]{1,16})\\.epub$'
const bookPath = new RegExp(BOOK_PATH)

/** The CSP `connect-src` sources: the two directories, nothing above them. */
export const BOOK_CONNECT_SRC = `${BOOK_ORIGIN}/v2/books/ ${BOOK_ORIGIN}/v2/staging/`

/** The page's URL for a host file name (`books/…` or `staging/…`, relative to `files/v2/`); throws for any other. */
export function bookUrl(file) {
  const path = `/v2/${file}`
  if (!bookPath.test(path)) throw new Error(`bookUrl: not a servable book file: ${JSON.stringify(file)}`)
  return BOOK_ORIGIN + path
}

/**
 * What the interceptor serves for a request URL: the file name under `files/v2/`, or null (it answers 404 and never
 * lets the request reach the network). Only https on BOOK_ORIGIN, no query, no fragment, the encoded path as sent.
 */
export function servedFile(url) {
  const m = /^https:\/\/appassets\.androidplatform\.net(\/.*)$/.exec(String(url))
  return m && bookPath.test(m[1]) ? m[1].slice('/v2/'.length) : null
}
