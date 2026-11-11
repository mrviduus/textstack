// The web host's frame document (#1219): the generated page plus the host shim, served as its own
// same-origin document and embedded with `<iframe src>`. Not srcdoc: a srcdoc frame inherits the app's
// CSP, which refuses the page's nonce'd scripts (prodCsp.check.mjs, README "Web, its own document").
// `serveV2ReaderFrame` is the one place that serves it: the Vite dev server uses it and the check tests it.
import { randomBytes } from 'node:crypto'
import { V2_READER_FRAME_PATH } from './framePath.mjs'
import { v2ReaderPageHtml } from './v2ReaderPage.generated.ts'

export { V2_READER_FRAME_PATH }

/**
 * The frame template's nonce placeholder. Fails closed: `%` is outside the CSP nonce grammar, so a document
 * served unfilled has no valid script source (every script refused), and no book script can carry a nonce
 * that matches it. Not the page's own placeholder (`__V2_READER_NONCE__`), which is a valid nonce-source.
 * Whoever serves the file replaces it per response (nginx: `sub_filter` with `$request_id`).
 */
export const FRAME_NONCE_PLACEHOLDER = '%V2_READER_FRAME_NONCE%'

/**
 * The frame document's own response headers. Its own CSP is the page's meta one; this header adds only what
 * a meta CSP cannot carry. A location serving the file must send all of these itself: nginx drops every
 * server-level add_header there (#857), and those include `frame-ancestors 'none'` and X-Frame-Options DENY,
 * which would refuse the frame.
 */
export const V2_READER_FRAME_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "frame-ancestors 'self'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

/**
 * Stands in for react-native-webview, under the page's nonce. Out: `ReactNativeWebView.postMessage(json)`
 * goes to the parent, at this document's own origin only. In: `{ call, args }` from the parent window at
 * that origin only becomes `window.__fol[call](...args)`; `openBytes` hands the page a blob: URL of the
 * transferred bytes for `openUrl`. `self.origin`, not `location.origin`: the same in a document of its own
 * (same-origin with its host), and still the real origin where a document has no URL of its own (srcdoc).
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

/** The frame document with FRAME_NONCE_PLACEHOLDER in its CSP and both script tags. */
export function v2ReaderFrameTemplate() {
  // v2ReaderPageHtml takes a real nonce only: fill a random one, then swap it for the placeholder. Random,
  // so it cannot already occur in the page (a fixed string might, in pdf.js's base64 cMaps).
  const sentinel = randomBytes(16).toString('hex')
  const page = v2ReaderPageHtml(sentinel)
  if (page.split(sentinel).length !== 3) throw new Error('v2ReaderFrameTemplate: the page must carry its nonce exactly twice')
  const framed = page.replace('<body>', `<body><script nonce="${sentinel}">${HOST_SHIM}</script>`)
  if (framed === page) throw new Error('v2ReaderFrameTemplate: no <body> in the generated page to put the host shim in')
  return framed.split(sentinel).join(FRAME_NONCE_PLACEHOLDER)
}

/** The template with `nonce` filled: what the server does per response. Only nginx's `$request_id` form. */
export function fillNonce(template, nonce) {
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error('fillNonce: the nonce must be 32 lower-case hex chars (16 random bytes)')
  const filled = template.split(FRAME_NONCE_PLACEHOLDER).join(nonce)
  if (filled === template) throw new Error('fillNonce: the template carries no nonce placeholder')
  return filled
}

let template
/**
 * Serves the frame document if `req` asks for it: GET/HEAD on V2_READER_FRAME_PATH (any query), the frame
 * headers and a fresh nonce per response. Returns false for any other path (the caller goes on). Node
 * `http` request/response, as a Vite (connect) middleware or a plain server gets them.
 */
export function serveV2ReaderFrame(req, res) {
  if (new URL(req.url ?? '/', 'http://x').pathname !== V2_READER_FRAME_PATH) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return true
  }
  template ??= v2ReaderFrameTemplate()
  res.writeHead(200, V2_READER_FRAME_HEADERS)
  res.end(req.method === 'HEAD' ? undefined : fillNonce(template, randomBytes(16).toString('hex')))
  return true
}
