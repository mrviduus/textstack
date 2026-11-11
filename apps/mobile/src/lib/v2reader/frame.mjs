// The web host's frame (#1219, #1225): the generated page split in two files, served as its own same-origin
// document and embedded with `<iframe src>`. Not srcdoc: a srcdoc frame inherits the app's CSP, which refuses
// the page's nonce'd scripts (prodCsp.check.mjs, README "Web, its own document").
//   - the shell, V2_READER_FRAME_PATH: the page's head (its CSP), the host shim inline, and a `<script src>` of
//     the page code, all under one nonce placeholder filled per response. Small and `no-store`.
//   - the page script, `page.<hash>.js`: the page's one script, unchanged, content-hashed and `immutable`, so
//     opening a book does not download 3.75 MB again (ADR-029 Decision 4 as amended 2026-11-11).
// `serveV2ReaderFrame` is the one place that serves both: the Vite dev and preview servers use it and the check
// tests it; the production build writes the same two files (`v2ReaderFrameFiles`) for nginx.
// Android does not use this module: it keeps the inline page (`v2ReaderPageHtml(nonce)`).
import { createHash, randomBytes } from 'node:crypto'
import { V2_READER_DIR, V2_READER_FRAME_PATH, V2_READER_SCRIPT_PATH } from './framePath.mjs'
import { v2ReaderPageHtml } from './v2ReaderPage.generated.ts'

export { V2_READER_DIR, V2_READER_FRAME_PATH, V2_READER_SCRIPT_PATH }

/**
 * The shell's nonce placeholder. Fails closed: `%` is outside the CSP nonce grammar, so a shell served unfilled
 * has no valid script source (every script refused, the page script too), and no book script can carry a nonce
 * that matches it. Not the page's own placeholder (`__V2_READER_NONCE__`), which is a valid nonce-source.
 * Whoever serves the file replaces it per response (nginx: `sub_filter` with `$request_id`).
 */
export const FRAME_NONCE_PLACEHOLDER = '%V2_READER_FRAME_NONCE%'

/**
 * The shell's own response headers. Its own CSP is the page's meta one; this header adds only what a meta CSP
 * cannot carry. A location serving the file must send all of these itself: nginx drops every server-level
 * add_header there (#857), and those include `frame-ancestors 'none'` and X-Frame-Options DENY, which would
 * refuse the frame.
 */
export const V2_READER_FRAME_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "frame-ancestors 'self'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

/** The page script's headers: a JS type under nosniff, cached for a year (its name changes with its bytes). */
export const V2_READER_SCRIPT_HEADERS = {
  'Content-Type': 'text/javascript; charset=utf-8',
  'Cache-Control': 'public, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff',
}

/**
 * Stands in for react-native-webview, under the shell's nonce, before the page script. Out:
 * `ReactNativeWebView.postMessage(json)` goes to the parent, at this document's own origin only. In: `{ call,
 * args }` from the parent window at that origin only becomes `window.__fol[call](...args)`; `openBytes` hands
 * the page a blob: URL of the transferred bytes for `openUrl`. `self.origin`, not `location.origin`: the same
 * in a document of its own (same-origin with its host), and still the real origin where a document has no URL
 * of its own (srcdoc).
 */
const HOST_SHIM = `
window.ReactNativeWebView = { postMessage: (json) => parent.postMessage(json, self.origin) };
let bookUrl = null;
addEventListener('message', (e) => {
  if (e.source !== parent || e.origin !== self.origin || !Array.isArray(e.data?.args)) return;
  const { call, args } = e.data;
  if (call !== 'openBytes') return Object.hasOwn(window.__fol, call) && window.__fol[call](...args);
  if (bookUrl) URL.revokeObjectURL(bookUrl);
  bookUrl = URL.createObjectURL(new Blob([args[0]]));
  window.__fol.openUrl(bookUrl, args[1]);
});`

const PAGE_TAIL = '</script></body></html>'
let files
/**
 * The two files: `shell` (FRAME_NONCE_PLACEHOLDER in its CSP and both script tags), `script` (the page's one
 * script, byte for byte what the inline page runs) and `scriptPath`. The script tag carries `integrity`: the
 * shell is the only thing that names the script, so a swapped file is refused rather than run under the nonce.
 * The format readers stay inside the script as strings and run as inline scripts under the same nonce
 * (page.mjs reads it from `document.currentScript`, which an external script has as well).
 */
export function v2ReaderFrameFiles() {
  if (files) return files
  // v2ReaderPageHtml takes a real nonce only: fill a random one, then swap it for the placeholder. Random,
  // so it cannot already occur in the page (a fixed string might, in pdf.js's base64 cMaps).
  const sentinel = randomBytes(16).toString('hex')
  const page = v2ReaderPageHtml(sentinel)
  const open = `<body><script nonce="${sentinel}">`
  const at = page.indexOf(open)
  if (page.split(sentinel).length !== 3 || at < 0 || !page.endsWith(PAGE_TAIL))
    throw new Error('v2ReaderFrameFiles: the page must be its head, then <body> with one nonce\'d script and nothing after it')
  const script = page.slice(at + open.length, -PAGE_TAIL.length)
  const sha384 = createHash('sha384').update(script).digest()
  const scriptPath = `${V2_READER_DIR}page.${sha384.toString('hex').slice(0, 16)}.js`
  const head = page.slice(0, at).split(sentinel).join(FRAME_NONCE_PLACEHOLDER)
  const N = FRAME_NONCE_PLACEHOLDER
  const shell = `${head}<body><script nonce="${N}">${HOST_SHIM}</script>`
    + `<script nonce="${N}" src="${scriptPath}" integrity="sha384-${sha384.toString('base64')}"></script></body></html>`
  return (files = { shell, script, scriptPath })
}

/** The shell, nonce unfilled: what the build writes and nginx fills. */
export const v2ReaderFrameTemplate = () => v2ReaderFrameFiles().shell

/** The template with `nonce` filled: what the server does per response. Only nginx's `$request_id` form. */
export function fillNonce(template, nonce) {
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error('fillNonce: the nonce must be 32 lower-case hex chars (16 random bytes)')
  const filled = template.split(FRAME_NONCE_PLACEHOLDER).join(nonce)
  if (filled === template) throw new Error('fillNonce: the template carries no nonce placeholder')
  return filled
}

/**
 * Serves anything under V2_READER_DIR (any query): GET/HEAD of the shell, with its headers and a fresh nonce
 * per response; of the current page script, with its immutable headers; 404 for any other path there (a stale
 * script name, never the SPA's index.html). Returns false outside V2_READER_DIR (the caller goes on). Node
 * `http` request/response, as a Vite (connect) middleware or a plain server gets them.
 */
export function serveV2ReaderFrame(req, res) {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  if (!path.startsWith(V2_READER_DIR)) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return true
  }
  const { shell, script, scriptPath } = v2ReaderFrameFiles()
  const body = (b) => (req.method === 'HEAD' ? undefined : b)
  if (path === V2_READER_FRAME_PATH) res.writeHead(200, V2_READER_FRAME_HEADERS).end(body(fillNonce(shell, randomBytes(16).toString('hex'))))
  else if (path === scriptPath) res.writeHead(200, V2_READER_SCRIPT_HEADERS).end(body(script))
  else res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(body('not found'))
  return true
}
