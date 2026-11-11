// The web host's frame document (#1219): the generated page plus the host shim, served as its own
// same-origin document and embedded with `<iframe src>`. Not srcdoc: a srcdoc frame inherits the app's
// CSP, which refuses the page's nonce'd scripts (prodCsp.check.mjs, README "Web host").
// The nonce stays a placeholder here; whoever serves the file fills it per response (the Vite dev server
// now, nginx `sub_filter` with `$request_id` later), as v2ReaderPageHtml requires.
import { NONCE } from './carrier.mjs'
import { v2ReaderPageHtml } from './v2ReaderPage.generated.ts'

/** Where the app serves the frame document (dev server today). */
export const V2_READER_FRAME_PATH = '/reader-v2/frame.html'

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
 * goes to the parent, to this document's own origin only (the frame is same-origin with its host, so
 * `location.origin` is the host's origin). In: `{ call, args }` from the parent window only becomes
 * `window.__fol[call](...args)`; `openBytes` hands the page a blob: URL of the transferred bytes for `openUrl`.
 */
const HOST_SHIM = `
window.ReactNativeWebView = { postMessage: (json) => parent.postMessage(json, location.origin) };
let bookUrl = null;
addEventListener('message', (e) => {
  if (e.source !== parent || e.origin !== location.origin || !Array.isArray(e.data?.args)) return;
  const { call, args } = e.data;
  if (call !== 'openBytes') return Object.hasOwn(window.__fol, call) && window.__fol[call](...args);
  if (bookUrl) URL.revokeObjectURL(bookUrl);
  bookUrl = URL.createObjectURL(new Blob([args[0]]));
  window.__fol.openUrl(bookUrl, args[1]);
});`

/** The frame document with the nonce placeholder in its CSP and both script tags. */
export function v2ReaderFrameTemplate() {
  // The placeholder passes v2ReaderPageHtml's nonce rule, so this is the page with the placeholder kept.
  const html = v2ReaderPageHtml(NONCE)
  const framed = html.replace('<body>', `<body><script nonce="${NONCE}">${HOST_SHIM}</script>`)
  if (framed === html) throw new Error('v2ReaderFrameTemplate: no <body> in the generated page to put the host shim in')
  return framed
}

/** The template with `nonce` filled: what the server does per response. */
export const fillNonce = (template, nonce) => template.split(NONCE).join(nonce)
