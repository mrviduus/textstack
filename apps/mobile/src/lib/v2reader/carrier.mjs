// The page's HTML shell (ADR-029): its CSP, the nonce placeholder, and how the script and the format
// readers ride in it. Pure: build.mjs writes the page with it, carrier.test.ts attacks it.

// The CSP is the book sandbox (ADR-029 Decision 4): sections are blob: documents that inherit this
// policy, so a book's own <script> (no nonce) cannot run, while foliate's iframes still need
// allow-scripts. default-src 'none' + blob:/data: only: nothing a book references outside its zip is
// fetched. connect-src BOOK_CONNECT_SRC is where the Android host serves the book (bookOrigin.mjs: its two
// directories under an https origin, #1228), read by our own (nonce) script; no file:, so no app file is reachable.
// The web hosts hand bytes in as blob: (frame.mjs) and never need it.
// The nonce is a placeholder, never a value: a fixed nonce in a public repo is one a book can carry.
// v2ReaderPageHtml(nonce) fills it per load.
import { BOOK_CONNECT_SRC } from './bookOrigin.mjs'

export const NONCE = '__V2_READER_NONCE__'
export const CSP = [`default-src 'none'`, `script-src 'nonce-${NONCE}'`, `style-src blob: 'unsafe-inline'`, `img-src blob: data:`,
  `font-src blob: data:`, `media-src blob: data:`, `frame-src blob:`, `connect-src blob: data: ${BOOK_CONNECT_SRC}`, `form-action 'none'`, `base-uri 'none'`].join('; ')

/**
 * The format readers as one JS object of strings, ahead of the page in its one script: never run until
 * page.mjs runs one under the page's own nonce. `<` is escaped in each string, so no `</script` or
 * `<!--` in a reader can end or bend the script element it travels in.
 */
export const formatsJs = (chunks) => `var __TS_FORMATS = {${Object.entries(chunks).map(([k, v]) => `${k}: ${JSON.stringify(v).replace(/</g, '\\u003c')}`).join(',\n')}};\n`

/** The page: `js` in its one nonce'd script, any `</script` in it escaped (case kept). */
export const html = (js) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>html,body{margin:0;height:100%;background:#fbf8f3;color:#1f1b16}foliate-view{display:block;height:100%}</style>
</head><body><script nonce="${NONCE}">${js.replace(/<\/(script)/gi, '<\\/$1')}</script></body></html>`
