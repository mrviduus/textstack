// The props every WebView that hosts the reader page takes (V2ReaderScreen, V2Describer, #1426): one place, so a
// second WebView of the page cannot drift from the reader's.
import type { WebViewProps } from 'react-native-webview'
import { PAGE_URL } from '../../../../../packages/reader/src/bookOrigin.mjs'
import { readerAndroidPageHtml } from '../../../../../packages/reader/src/readerPage.generated'

/** #1426: how long the page may take to describe a book (its cover drawn on a canvas). */
export const DESCRIBE_MS = 20_000

/** The page under `nonce`. The base URL arms the patched WebView's book interceptor (bookOrigin.mjs) and gives the page that https origin. */
export const pageSource = (nonce: string) => ({ html: readerAndroidPageHtml(nonce), baseUrl: PAGE_URL })

/**
 * README "WebView": no file access at all (the library's defaults, stated here); the page reads its book by XHR from the
 * interceptor, so no book bytes cross the bridge. `*`: react-native-webview opens a navigation outside originWhitelist in
 * another app, so the filter is onShouldStartLoadWithRequest: the page never navigates; only its own about:/blob:/data:
 * loads pass.
 */
export const PAGE_WEBVIEW_PROPS = {
  originWhitelist: ['*'],
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  onShouldStartLoadWithRequest: ({ url }: { url: string }) => /^(about|blob|data):/.test(url),
} as const satisfies Partial<WebViewProps>
