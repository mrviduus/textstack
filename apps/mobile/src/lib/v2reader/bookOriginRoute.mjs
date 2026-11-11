// The desktop checks' stand-in for the Android interceptor (#1228): Playwright routes BOOK_ORIGIN, so the page runs
// under the origin and CSP it has on Android, with no --allow-file-access-from-files. Checks only, never the app.
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { BOOK_ORIGIN } from './bookOrigin.mjs'

/** Where the page is loaded (the host's baseUrl). */
export const PAGE_URL = `${BOOK_ORIGIN}/`
/** A fixture under the served books directory, by its file name. */
export const bookAt = (name) => `${BOOK_ORIGIN}/v2/books/${encodeURIComponent(name)}`

/** Lenient mapping for the format checks: any fixture name in `dir` under `/v2/books/`. */
const fromDir = (dir) => (url) => {
  const prefix = `${BOOK_ORIGIN}/v2/books/`
  return url.startsWith(prefix) ? resolve(dir, basename(decodeURIComponent(url.slice(prefix.length)))) : null
}

/**
 * `target` (a Page or BrowserContext) gets `dir/page.html` at PAGE_URL and, for any other URL on the origin, the
 * file `fileFor(url)` names, or a 404: nothing on the origin reaches the network, as on Android.
 */
export async function routeBookOrigin(target, dir, fileFor = fromDir(dir)) {
  await target.route(`${BOOK_ORIGIN}/**`, (route) => {
    const url = route.request().url()
    if (url === PAGE_URL) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: readFileSync(resolve(dir, 'page.html')) })
    const file = fileFor(url)
    return file && existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' })
  })
}
