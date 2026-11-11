/**
 * The Android System WebView floor of the V2 reader page (#1228; owner decision 2026-11-11,
 * docs/01-architecture/v2-reader-web-hosting.md §8). The page needs Chrome 117 (foliate calls `Object.groupBy`),
 * whatever its esbuild syntax target, and on an older engine it cannot even report that: it fails to parse.
 * So the host asks first, with an ES5 probe document (`WEBVIEW_PROBE_HTML`) that posts `navigator.userAgent`.
 */
export const MIN_WEBVIEW_CHROME = 117

/**
 * The probe: ES5 only (it must run on WebView 66 and older), no network, no file access. It answers once,
 * on the bridge every react-native-webview page has.
 */
export const WEBVIEW_PROBE_HTML =
  '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'">' +
  '<script>window.ReactNativeWebView.postMessage(String(navigator.userAgent))</script>'

/** The Chromium major in a user agent (`… Chrome/66.0.3359.158 Mobile …`); null when absent or garbled. */
export function chromeMajor(userAgent: unknown): number | null {
  if (typeof userAgent !== 'string') return null
  // `\b`: not `HeadlessChrome/`. A real version is dotted (`Chrome/120.0.0.0`, also the reduced UA).
  const m = /\bChrome\/(\d{1,4})\.\d/.exec(userAgent)
  return m ? Number(m[1]) : null
}

/**
 * - `ok`: the page can run.
 * - `update`: the WebView is older than the floor; the update screen instead of the reader.
 * - `unknown`: no version (no answer, no or a garbled `Chrome/`): not blocked. The page loads and the `ready`
 *   deadline (deadlines.mjs) is the backstop, its message naming an old WebView as a likely cause.
 */
export type WebViewGate = 'ok' | 'update' | 'unknown'

export function webViewGate(userAgent: unknown): WebViewGate {
  const major = chromeMajor(userAgent)
  if (major === null) return 'unknown'
  return major >= MIN_WEBVIEW_CHROME ? 'ok' : 'update'
}

/** How long the probe may take before the gate gives `unknown` (a WebView's first start is the slow part). */
export const WEBVIEW_PROBE_DEADLINE_MS = 5_000

/** Android System WebView's Play Store package (`openPlayStorePage`). */
export const WEBVIEW_PACKAGE = 'com.google.android.webview'
