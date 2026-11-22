/**
 * The WebView floor of the V2 reader page on Android (#1228; owner decision 2026-11-11, ADR-029 Decision 6). The page
 * needs Chrome 117 (foliate calls `Object.groupBy`) whatever its esbuild syntax target, and on an older engine it
 * fails to parse, so it cannot say so itself. The host injects `USER_AGENT_PROBE` before the page's content: it runs
 * as its own script (react-native-webview evaluates it on page start), so a page that does not parse still answers.
 */
export const MIN_WEBVIEW_CHROME = 117

/** ES5 only: it must run on WebView 66 and older. Answered as `{ type: 'ua', ua }`. */
export const USER_AGENT_PROBE = "window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ua', ua: String(navigator.userAgent) }))"

/** The Chromium major in a user agent (`… Chrome/66.0.3359.158 Mobile …`); null when absent or garbled. */
export function chromeMajor(userAgent: unknown): number | null {
  if (typeof userAgent !== 'string') return null
  // `\b`: not `HeadlessChrome/`. A real version is dotted (`Chrome/120.0.0.0`, also the reduced UA).
  const m = /\bChrome\/(\d{1,4})\.\d/.exec(userAgent)
  return m ? Number(m[1]) : null
}

/**
 * - `ok`: the page can run.
 * - `outdated`: older than the floor; the update screen instead of the reader.
 * - `unknown`: no readable version: not blocked. The page loads; the `ready` deadline (deadlines.mjs) is the backstop.
 */
export type WebViewVerdict = 'ok' | 'outdated' | 'unknown'

export function verdictOf(userAgent: unknown): WebViewVerdict {
  const major = chromeMajor(userAgent)
  if (major === null) return 'unknown'
  return major >= MIN_WEBVIEW_CHROME ? 'ok' : 'outdated'
}

/**
 * The verdict for the process: the first answer wins and is kept. A WebView provider is loaded once per process,
 * so a later page load cannot see another version (an update applies after the app is reopened).
 */
export function createWebViewCheck() {
  let verdict: WebViewVerdict | null = null
  return {
    verdict: () => verdict,
    answer: (userAgent: unknown) => (verdict ??= verdictOf(userAgent)),
  }
}

/**
 * The Play Store package to update. The provider package itself is native-only (`WebView.getCurrentWebViewPackage`)
 * and no installed module exposes it, so it is taken from the SDK level: Android 7–9 (SDK 24–28) render WebViews
 * with Chrome, Android 10+ with Android System WebView. A vendor provider (no Google services) is not knowable
 * here; the copy names both, so the reader can still find theirs.
 */
export const webViewStorePackage = (sdk: number) => (sdk <= 28 ? 'com.android.chrome' : 'com.google.android.webview')
