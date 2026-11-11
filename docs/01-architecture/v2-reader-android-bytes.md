# V2 reader on Android: book bytes without `file://`

**Status:** proposed — the owner decides. Issue [#1228](https://github.com/mrviduus/textstack/issues/1228) (half B,
investigation only; nothing here is built). Context: ADR-029 Decision 4 (`file://` is dev-only; owner direction
2026-10-30: native, limited file serving over https), the R4 security review in
[`epub-engine-prototype.md`](epub-engine-prototype.md#gate-file-security-review), R8 audit §2.1 and §7 wave A.

Versions read for this (installed, 2026-11-11): `react-native-webview` 13.16.1 (`androidx.webkit:webkit` 1.14.0,
its own Gradle dependency), React Native 0.86.3 (new architecture), Expo SDK 57 with CNG (`/android` is not
committed; `app.json` `runtimeVersion.policy: fingerprint`), `minSdkVersion` 24.

## 1. How the page and the bytes reach the WebView today

- **The page:** `V2ReaderScreen.tsx` passes `source={{ html: v2ReaderPageHtml(nonce), baseUrl: Paths.document.uri }}`.
  `RNCWebViewManagerImpl.loadSource` turns that into `loadDataWithBaseURL("file:///data/user/0/<pkg>/files/", html,
  "text/html", "UTF-8", null)`, so the document's origin is `file://` (the app's documents dir).
- **The bytes:** the host calls `window.__fol.openUrl("file:///…/files/v2/books/<sha256>.epub", name)`; the page
  reads it with `XMLHttpRequest` (`responseType: 'arraybuffer'`, `page.mjs` `openUrl`). One streamed read in the
  renderer, no bytes over the bridge; 87 MB opens in 6.4–7.7 s (R4).
- **Settings that requires** (the library's defaults are all off, `RNCWebViewManagerImpl.createViewInstance`):
  `allowFileAccess` (load `file:` at all), `allowFileAccessFromFileURLs` (a `file:` document may XHR other `file:`
  URLs), the page CSP's `connect-src … file:`, and `originWhitelist={['*']}` (JS-side navigation filter only; the
  host's `onShouldStartLoadWithRequest` already limits navigation to `about:`/`blob:`/`data:`).
  `allowUniversalAccessFromFileURLs` stays false, `allowContentAccess` is hard-coded false (no prop).
- **What a book script could reach because of that** (only if it runs: a CSP regression, a leaked nonce, a Chromium
  CSP bug — the nonce is the one barrier): every file the app's uid can read, by XHR, incl. directory listings —
  `files/` (all retained books, `library.json`, `store/`), `files/SQLite/` (the offline DB), `databases/RKStorage`
  (AsyncStorage), `shared_prefs/`, `cache/` (R4, measured on the emulator). Network exfiltration is blocked by the
  CSP, but the bridge is not: `ReactNativeWebView` is registered with `WebViewCompat.addWebMessageListener(…,
  Set.of("*"), …)` and `RNCWebView.onMessage` does not check `isMainFrame`, so any frame (book sections share the
  page's window) can post `openLink` with `https://…?<data>` (the host opens a browser) or `store`. Narrowing
  `connect-src file:` to one file is not expressible (Chromium rejects a `file:` path as a CSP source).

## 2. Options

The book is 87 MB in the worst measured case; the renderer is already ~190 MB with it open (R4).

| | Option | What it needs | Cost | Risk | 87 MB |
|---|---|---|---|---|---|
| a | **Native interception under an https origin**: `baseUrl = https://appassets.androidplatform.net/` (the domain Android reserves for this), `WebViewAssetLoader` + `InternalStoragePathHandler` on `files/v2/books/`, served from `shouldInterceptRequest`; both `allowFileAccess*` off; CSP `connect-src blob: data: https://appassets.androidplatform.net/v2/books/` | No new dependency (`androidx.webkit` 1.14 is already in `react-native-webview`). `RNCWebViewClient` has no `shouldInterceptRequest` and no JS API, so: a **`pnpm patch` of `react-native-webview`** (`patchedDependencies` in `pnpm-workspace.yaml`, applied on EAS's install) — ~40 lines Java: the override in `RNCWebViewClient`, armed per view only when `loadSource` gets that base URL (no new prop, so no codegen spec change). Alternatives to the patch: a fork of the library (heavier), or a local Expo module registering a subclassed view manager (Fabric needs its own component spec; needs a spike). | S–M: one native patch, `openUrl` URL change in the host, a CSP change for the Android build (ADR-029 D4), sandbox check under an emulated https origin | Low–medium: the patch is re-applied on every `react-native-webview` bump (pnpm fails loudly if it no longer applies). A script in the page then reaches **only `v2/books/*`** (the handler resolves paths only inside its directory; androidx also refuses some sensitive app dirs as a root), no listings, no SQLite/AsyncStorage. The bridge exposure (`openLink`/`store`) is unchanged | **Yes.** Same single streamed read as today (`WebResourceResponse` over a `FileInputStream`), no bridge copy, nothing in the JS heap |
| b | Localhost http(s) server in the app | A new native dependency (a static server / NanoHTTPD in a module), cleartext exception for `127.0.0.1` (Android 9+), per-launch token | M–L | **High**: localhost is shared by every app on the device, so the server needs a secret on every request; https needs a cert; lifecycle (server killed in background, port in use); a new network component for Play Data Safety review | Yes (streamed) |
| c | Chunks over the existing bridge (base64 `injectJavaScript`, page builds a `Blob` → `blob:` URL; `connect-src blob:` already allowed) | JS only, no native change | S | Low security risk, high UX risk | **No.** Measured in the prototype: 35.8 MB in 27.9 s (≈68 s for 87 MB vs ~7 s), with several transient copies in two JS heaps (Hermes + renderer). Acceptable only under ~10 MB |
| d | The page fetches from the API with a token | CSP `connect-src` to the API, a token in the page | S | **Rejected**: breaks the rule that the reading path needs neither token nor network (CLAUDE.md), does not work for local-only books (file sync is off by default), and puts a bearer token where a book script could reach it | Network-bound |
| e1 | `content://` via a FileProvider + `allowContentAccess` | A patch anyway (`allowContentAccess` is hard-coded false), FileProvider config | M | Content URLs are a local scheme: cross-origin XHR from a non-`file:` origin is not reliably allowed; same blast-radius questions as `file:` | Unproven |
| e2 | Native → page binary messages (`JavaScriptReplyProxy`/`WebViewCompat.postWebMessage` with `ArrayBuffer`, chunked into a `Blob`) | A native module that can reach the `RNCWebView` instance (patch or module), the WebView feature `WEB_MESSAGE_ARRAY_BUFFER` (support by version not verified here) | M | Low–medium; the file goes through the Java heap in chunks | Probably, unmeasured; strictly more work than (a) for the same result |

iOS (later): the equivalent of (a) is a `WKURLSchemeHandler` on a custom scheme; `react-native-webview` has no API for
it either, so the same patch would grow an iOS half.

## 3. Recommendation and slice plan

**Recommend (a), as a `pnpm patch` of `react-native-webview`.** It is the R4 recommendation made concrete: no new
dependency, no network component (Play Data Safety unchanged), the same performance as `file://`, and the blast
radius of a page script drops from "the app's data dir" to "the retained books". (b) adds the most risk, (c) does
not carry an 87 MB book, (d) breaks the offline rule.

Optional hardening in the same design, owner's call: serve only the book currently being opened (the host tells
native the one allowed `<sha256>` before `openUrl`) instead of the whole `v2/books/` directory. It needs a channel to
native (another small patched method) and buys little: a running script already has the open book.

**Slice (one PR):**
1. `patches/react-native-webview@13.16.1.patch` + `patchedDependencies`: `RNCWebViewClient.shouldInterceptRequest`
   → `WebViewAssetLoader` (`/v2/books/` → `InternalStoragePathHandler(context, files/v2/books)`), armed only for a view
   loaded with base URL `https://appassets.androidplatform.net/`; everything else on that host → 404 (never the
   network).
2. Host: `baseUrl` = that origin, `allowFileAccess`/`allowFileAccessFromFileURLs` removed, `openUrl` with
   `https://appassets.androidplatform.net/v2/books/<sha256>.epub`. Staged picks (`staging/…`) need a path too:
   either a second handler on `v2/staging/`, or move the pick into `books/` under a temp name first.
3. CSP: drop `file:` from `connect-src`, add the https path (ADR-029 Decision 4 amended; README "Sandbox"). The web
   shell's CSP comes from the same page today, so the Android-only source must be per host or harmless on the web.
4. Checks: `sandbox.check.mjs` serves the fixtures under the https origin with Playwright `page.route` (it emulates
   the interceptor) and adds a vector "read a sibling of `books/`" that must fail; `prodCsp.check.mjs` updated.
5. Emulator (Claude): API 37 (WebView 145+) — the 87 MB book opens in about the same time as by `file://`; the R4
   hostile book over CDP: 30/30 blocked, and with CSP bypassed, XHR to `file:///…/databases/` and `/v2/../` now fail;
   a kill/restore; an ENOSPC import. Physical device (owner): the same open and the timing.
6. Build: a native change moves the Expo fingerprint, so **a new dev client (`npm run build:dev:android` or `npx expo
   run:android`) is needed to test, and the change ships only with a store build** (`mobile-ota.yml` will not send it
   to old runtimes, by design). Expo Go cannot run it.

## 4. Open questions for the owner

1. (a) as a `pnpm patch` vs a fork of `react-native-webview` vs a local module spike?
2. Directory-scoped (`v2/books/*`) or one-book-at-a-time serving?
3. Staged picks: second handler on `staging/`, or stage inside `books/`?
4. The bridge accepts messages from every frame (`Set.of("*")`, no `isMainFrame` check): fix it in the same patch?
