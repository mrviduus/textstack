# V2 reader on Android: book bytes without `file://`

**Status:** built (owner decision 2026-11-11: option (a) as a `pnpm patch`), on the dev route; §5 is what was built
and measured. Issue [#1228](https://github.com/mrviduus/textstack/issues/1228). §1–§3 are the investigation as
written before the decision ("today" there means before #1228). Context: ADR-029 Decision 4 (`file://` is dev-only; owner direction
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

## 4. Decisions

1. **Option (a) as a `pnpm patch`** of react-native-webview: decided by the owner (2026-11-11).

Defaults taken where the owner did not answer; **the owner can veto each in the PR**:

2. **Serving scope: the two directories** `files/v2/books/` and `files/v2/staging/`, each restricted to its file-name
   shape (`books/<sha256>.epub`, `staging/[dl-]<ms>.epub`), not one book at a time. One-book serving needs a second
   channel to native (a patched method or prop, with codegen) and buys little: a script that runs already has the open
   book. Never the documents dir, `library.json`, `store/` or anything else.
3. **Staged picks: served from `staging/`** (a second allowed directory): the smaller diff, and no second copy of an
   87 MB file.
4. **The any-frame bridge: fixed in the same patch** (messages from the main frame only).

## 5. As built (#1228)

- **Patch** `patches/react-native-webview@13.16.1.patch` (`patchedDependencies` in `pnpm-workspace.yaml`; `pnpm
  install --frozen-lockfile` applies it everywhere, EAS included): a new `TextStackBookServer.java` and three small
  hunks. `RNCWebViewClient.shouldInterceptRequest` asks it first. It is armed only when `loadSource` gets an HTML
  source with base URL exactly `https://appassets.androidplatform.net/`, so the app's other WebViews are untouched.
  For that host it serves a GET whose encoded path matches `BOOK_PATH` (no port, query, fragment or user info) from
  `files/v2/` after a canonical-path check (the file's real parent must be `books/` or `staging/`: a planted symlink
  is refused), with `Cache-Control: no-store`; anything else on the host is a 404, never the network. It does not use
  `WebViewAssetLoader`: one fixed regex plus the canonical check is less code and stricter than a path handler.
  `RNCWebView`'s message listener drops `!isMainFrame`.
- **Rule in one place:** `apps/mobile/src/lib/v2reader/bookOrigin.mjs` (`BOOK_ORIGIN`, `BOOK_PATH`, `bookUrl`,
  `servedFile`, `BOOK_CONNECT_SRC`). `bookOrigin.test.ts` pins the Java regex to it byte for byte.
- **Host** (`V2ReaderScreen.tsx`): `baseUrl` is the origin; `allowFileAccess*` removed (the library defaults: file,
  universal and content access all off); `openUrl` gets `bookUrl(file)`. `originWhitelist` stays `['*']` on purpose:
  react-native-webview opens a navigation outside the whitelist in another app (`Linking.openURL`), so a narrow
  whitelist would turn a blocked navigation into an external open. `onShouldStartLoadWithRequest` (about:/blob:/data:)
  stays the filter.
- **CSP, per host:** the Android page (`v2ReaderAndroidPageHtml`, carrier.mjs `ANDROID_CSP`) has `connect-src blob:
  data: https://appassets.androidplatform.net/v2/books/ https://appassets.androidplatform.net/v2/staging/`; the page
  as built and the web frame keep `connect-src blob: data:` (the prod-csp check asserts the frame's). `file:` is gone
  from both (ADR-029 Decision 4, amended).
- **Fingerprint:** the Expo fingerprint (`npx expo-updates fingerprint:generate --platform android`, from
  `apps/mobile`) hashes the whole `node_modules/react-native-webview` directory: measured `1b3582e7…` without the
  patch applied and `8227c2d6…` with it. No extra source is needed; an OTA never reaches a build without the patch.
- **Bridge:** The same patch limits the message bridge on that WebView: with `WEB_MESSAGE_LISTENER` (every engine that can run the page, Chrome 117+) only the main frame's messages are delivered; on the `addJavascriptInterface` fallback (older engines, no frame information) only the user-agent answer is, and no book opens there. Other WebViews keep the fallback as it was; on the listener path they too take main-frame messages only (none of them uses iframes).
- **Images:** `patchedDependencies` makes every install read the patch, so `apps/admin/Dockerfile` and
  `apps/web/Dockerfile.ssg-worker` `COPY patches/` before installing (without it: ENOENT, reproduced). The ssg-worker's
  `pnpm deploy` of the web app alone has no react-native-webview, so it passes `--config.allow-unused-patches=true`
  for that command only (workspace-wide, the unused-patch error is what catches a version bump that left the patch
  behind). Both images built locally (`docker build`). The CI and deploy installs run on full checkouts.
- **Desktop checks:** `bookOriginRoute.mjs` routes the origin in Playwright (no `--allow-file-access-from-files`
  anywhere). The sandbox check uses the interceptor's rule plus scope rows; the format check and the PDF gate use
  the same origin.

**Emulator evidence (2026-11-11, agent).** A local debug dev client (`npx expo run:android`, patch applied) on AVD
`Pixel_7_Pro` (Android 17, WebView 156.0.8078.47), JS from Metro; timings from a throwaway `Date.now()` log at
`openUrl` and `opened` (not committed), as in R4:

| Check | Result |
|---|---|
| 87 MB EPUB (`314d6bff…`, R4's padded book) open | **2.31 s and 2.27 s** (two opens) vs 6.4–7.7 s by `file://` in R4 (same AVD type, R4's build; not a same-day A/B) |
| 87 MB book: page, kill the app, reopen | restored at the same place (14 %, `position: restored`) |
| PDF picked (`staging/<ms>.epub`) | opens (0.7 s), pages; after a kill, reopened from `books/<sha>.epub`, `position: restored` |
| From the page over CDP: served book | 200 |
| `/v2/library.json`, `/v2/store/`, `/v2/books/../library.json` | refused by the CSP |
| `/v2/books/..%2Flibrary.json`, `<book>?x=1` | 404 (interceptor) |
| `file:///…/files/v2/library.json`, `file:///…/databases/` | refused |
| **CSP bypassed** (CDP `Page.setBypassCSP`, as a CSP regression): same rows | out-of-scope paths all **404**, `file:` still refused: the interceptor and the file flags hold alone |
| Symlink `books/<64 c>.epub → files/v2/library.json` | **404** (served book beside it: 200) |
| Bridge: `postMessage` from a `blob:` iframe vs the main frame | iframe message dropped, main-frame message delivered |
| AVD `TS_API28` (WebView 66), same APK | the update screen, not the reader |

**Re-run after the review fixes (second dev client: the fallback-bridge guard, host-specific CSP, page rebuilt):**

| Check | Result |
|---|---|
| WebView 156: 87 MB EPUB open | 2.12 s |
| Served book / out-of-scope rows, CSP on and bypassed | as above: 200; CSP refusals; with the CSP bypassed every out-of-scope path 404, `file:` refused |
| Bridge from a `blob:` iframe vs the main frame | iframe dropped, main frame delivered |
| WebView 66 (fallback bridge, `servesBooks`): the `ua` answer | delivered: the update screen shows |
| **Legacy reader** (`ReaderShell`, catalog EPUB "Alice", WebView 156, process-wide bridge change) | opens and renders; long-press a word: the selection bar (Translate, Explain, Listen, Save) comes up over the bridge; a yellow highlight saved; scrolled 4 screens, app killed, "Continue Reading" (book page showed 3 %) reopened at the same paragraph; the highlight is still drawn |
| **Legacy PDF viewer** (`ReaderShell` original layout) | **not run**: only a user upload has one, and the dev client talks to production; uploading a test file there was not done. Owner, on the device |

Every `<WebView` in the app: `src/components/reader/ReaderShell.tsx` (legacy reader: reflow, and the PDF original
layout) and `src/components/v2reader/V2ReaderScreen.tsx` (V2). Only the reflow half of the first and the second
were run.

Not run here: a physical device (owner); the hostile book on the device (the desktop sandbox check covers the CSP
under this origin); an ENOSPC import on this build; the legacy PDF viewer (above).

**Owner, physical device:** build a dev client with the patch (`cd apps/mobile && npx expo run:android` with the phone
on USB, or `npm run build:dev:android` on EAS and install it; Expo Go cannot run it). Then
`adb shell am start -a android.intent.action.VIEW -d textstack://dev/epub-v2`: pick a large EPUB and a PDF, page,
kill, reopen (the place is kept); open a legacy book in the normal reader once (unchanged).

**Upgrade procedure** (react-native-webview bump): `pnpm patch react-native-webview@<new>`, re-apply the hunks from
the old `.patch`, `pnpm patch-commit <dir>`, delete the old `.patch`, run `bookOrigin.test.ts` and the emulator rows
above. A patch that no longer applies fails `pnpm install` loudly; a hunk applied to moved code is what the emulator
rows catch.
