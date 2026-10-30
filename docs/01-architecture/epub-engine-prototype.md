# Local EPUB engine prototype

**Status: Scoped prototype · 2026-10-29.** Owner approved testing a ready-made EPUB parsing/rendering
core before implementing local import around the current renderer. This is not approval to replace
the production reader or to accept the V2 schema. Implementation is a separate Code Agent task below.

**Decision record:** [ADR-029 — foliate-js renders V2 EPUBs](adr/ADR-029-foliate-for-v2-epub.md) (Proposed, 2026-10-30).

## Goal

Determine whether a library-owned EPUB parser and renderer can replace enough custom infrastructure
to simplify TextStack while preserving translation, annotations, resume and chapter context for MCP.
Start with foliate-js as the candidate, not a commitment. No wholesale application fork.

## Scope

- An isolated development harness, outside production reader routes. One EPUB at a time, no account.
- Open a local EPUB through the candidate's parser **and renderer**, not by extracting HTML into our
  existing renderer. Resolve book CSS, fonts, images and chapter links locally.
- Validate the same core in a desktop browser and the existing Android WebView environment. Browser
  setup may come first for fast feedback; browser success alone does not satisfy the Android gate.
- Use existing translation/annotation concepts through a small adapter. Identify reusable code and
  assumptions tied to the old DOM, scroll positions or chapter representation.
- Use app-managed local bytes and prototype-only storage. No production progress or library writes.

Not included: production import UX, duplicate/replacement implementation, catalog conversion, sync,
MCP authorization/sharing persistence, PDF changes, Dapper work, database migrations or Tauri adoption.
Do not implement a second EPUB parser or a general multi-engine framework for this experiment.

## Behaviors to demonstrate

| Behavior | Evidence required |
|---|---|
| Local reading | Open retained EPUB bytes with the API unavailable; navigate chapters and internal links; load embedded images/CSS/fonts where present. |
| Word interaction | Tap a word and obtain the correct text and coordinates on both clients. Use an actual translation response when available; a recorded translation may isolate layout tests but must be labeled. |
| Inline translation | Show the translation above the selected word using the intended product interaction. Check scrolling, font-size changes and chapter navigation; a detached tooltip alone does not prove compatibility. |
| Highlight | Select a multiword range, save quoted text plus a candidate locator, reopen and display the saved highlight. Report unsupported cases. |
| Resume | Save a candidate location, close/reopen, and restore it after a font-size or viewport change. A raw scroll offset alone is insufficient evidence. |
| MCP context boundary | Extract the chosen chapter's readable text and selected notes with source provenance. Inspect the payload locally; no live MCP/server integration is needed. Do not include later chapters implicitly. |

Use at least two non-sensitive, redistributable EPUB fixtures: one ordinary reflow book and one with
images/styles and internal links. Record fixture provenance. Do not copy a user's private book into
the repo. Fixed-layout, DRM and legacy-location migration are not claimed supported by this experiment.

## Validation and decision

Before coding, record the exact dependency source/revision and verify license obligations for the
selected package and any borrowed source. Pin the candidate; distinguish upstream code from patches.
Do not pull an entire application fork to get its engine. If available APIs require extensive patches,
document that cost instead of hiding it inside the adapter.

Add focused integration checks for adapter outputs (word/range mapping, serialized location and
chapter-context boundaries). Run the relevant existing reader checks for any reused code changed.
Use real browser/WebView checks for selection, layout and resource access; mocked DOM tests alone
cannot establish these behaviors. No coverage target or exhaustive engine test suite for the spike.

Report a pass/partial/fail/not-run matrix by behavior, fixture and client, with exact reproduction
steps. Note startup time and obvious memory problems as observations, not production benchmarks.
If Android/device access is unavailable, report that gate as not run and leave the conclusion provisional.

Recommend one outcome:

1. Proceed to a production local-EPUB PDD using the candidate core.
2. Retain the current renderer and evaluate only a library-based format loader.
3. Reject this candidate, with concrete blocking evidence.

Assess reduction in **owned responsibilities**, not only lines of adapter code. Account for locations,
DOM hooks, resources, security, dependency patches and the future migration of existing annotations.
The prototype need not solve legacy migration; it must expose its incompatibilities.

## Acceptance

- Runnable isolated harness and setup instructions; production reader and PDF routes remain unchanged.
- Exact dependency and fixture provenance documented.
- The six behaviors above have reproducible evidence or explicit failures/not-run labels.
- No production user data, server schema or existing saved positions changed.
- Written recommendation with trade-offs; no automatic decision to replace the production engine.

## Code Agent task

Implement the isolated prototype described in this document. First read the repository instructions,
the current reader API and the translation/annotation integrations. Inspect the candidate's actual APIs
and license, pin its revision, then choose the smallest development harness that exercises both its
EPUB parser and renderer. Keep the production engine intact and avoid unrelated refactors.

Demonstrate local reading, word interaction, inline translations, persisted highlights, durable resume
after layout changes, and selected-chapter context extraction. Validate in a browser and Android's
existing WebView path. Keep every persisted experiment record separate from production records.
Do not call production write APIs or add backend endpoints for this spike.

Deliver the harness, focused checks, exact run instructions and a result matrix. Distinguish real
translation calls from fixtures, automated checks from manual inspection, and tested clients from
unavailable ones. Finish with a recommendation and the minimum next slice. Do not commit, push or
create a PR unless separately authorized.

## Unresolved questions

- Dependency/patch compatibility and license: verify the exact selected revision.
- Android runtime available? Otherwise its gate stays not run.
- Existing positions/highlights compatible? Record evidence; design migration separately.

## R4 adoption gates — evidence (2026-10-30)

ADR-029 Decision 6, run by an agent on emulators; the physical device is the owner's. Dev build of `main` @
`5d48e2e5` (debug JS from Metro, so app-process memory is not a production number), dev route
`textstack://dev/epub-v2`. **Emulator A:** AVD `Pixel_7_Pro`, Android 17 (API 37), Android System WebView
145.0.7632.218. **Emulator B:** new AVD `TS_API28`, `system-images;android-28;google_apis;arm64-v8a`, WebView
66.0.3359.158. Open timings come from a throwaway host patch that logs `[v2] PROBE openUrl|opened|relocate` with
`Date.now()` (not committed); memory is `adb shell dumpsys meminfo <pid>` TOTAL PSS.

| Gate | Result | Numbers | Steps | Date | Who |
|---|---|---|---|---|---|
| Physical Android device | **not run** | — | — | — | owner (device, pending) |
| Book ≥ 80 MB | **pass** | 87,278,407 B, 117 sections, plates render. `openUrl`→`opened` 7.01 s (import), 7.65 s (re-import, same bytes adopted), 6.37 s (cold relaunch, retained copy); `opened`→`restored` 0.07–0.29 s. Renderer PSS 63.6 MB idle → 184–192 MB after open → 108–116 MB reading. Relaunch: `position: "restored"`, fraction 0.13186 → 0.13186 | [below](#gate-book--80-mb) | 2026-10-30 | agent (emulator A) |
| ENOSPC during import | **partial** | 4 failure points made real. No library entry without its file and `staging/` clean every time; a failed `library.json` write leaves an orphan `books/<sha256>.epub` and 0 B `.tmp` files that survive relaunch (findings 1–2) | [below](#gate-enospc-during-import) | 2026-10-30 | agent (emulator A) |
| Oldest supported System WebView | **fail on WebView 66**; recommendation | `SyntaxError: Unexpected token ?` before `ready`; the host waits forever. The committed page's real floor is **Chrome 117** (`Object.groupBy`), not `chrome90` | [below](#gate-oldest-supported-system-webview) | 2026-10-30 | agent (emulator B + desktop Chromium) |
| `file://` security review | **written**; recommendation, owner decides | one barrier (the nonce); behind it, the app's whole data dir is readable and the bridge can carry it out | [below](#gate-file-security-review) | 2026-10-30 | agent |
| Hostile book asserts, mutations caught | **pass** | R3 in CI: `check:v2-reader-sandbox` re-run, 30/30 blocked, 9/9 mutations caught. Re-run on the emulator through the dev route: **30/30 blocked**; positive control (CSP bypassed) 21/30 escape | [below](#gate-file-security-review) | 2026-10-30 | agent (desktop + emulator A) |

### Gate: book ≥ 80 MB

- **Book.** Project Gutenberg eBook #28885, *Alice's Adventures in Wonderland*, illustrated by Arthur Rackham
  (OPF `dc:rights`: "Public domain in the USA"; Carroll d. 1898, Rackham d. 1939; redistributable under the Project
  Gutenberg licence), 1,475,456 B, 15 sections with its own illustrations. Padded by
  `apps/mobile/src/lib/v2reader/bigbook.mjs` with 102 generated PNG plates (1200×1600 RGB: diagonal bands plus 6
  noisy bits per channel so they do not compress away), each a manifest item with an `<img>` in its own spine
  section → 87,278,407 B (sha256 `314d6bff…77739f78` for R4's file; zip timestamps change the hash per run). Plate 1
  rendered as section 4/117 (screenshot checked); the cover and the book's own plates render.
- **Steps.** `node apps/mobile/src/lib/v2reader/bigbook.mjs pg28885.epub apps/mobile/src/lib/v2reader/fixtures/alice-80mb.epub`
  → `adb push … /sdcard/Download/` → dev route → Pick EPUB → Downloads → the book, with
  `adb logcat -v epoch -s ReactNativeJS:*`. Read to section 5 (stored `store/<sha256>.json` checked with
  `adb shell run-as app.textstack.mobile cat …`), `am force-stop`, relaunch, tap the library row:
  `restored {"found":true,"position":"restored"}`, then `relocate` at the same fraction.
- **Observations.** The open grows with the file: the page hashes the bytes in pure JS (`crypto.subtle` is missing at
  this origin, see `page.mjs`); the same SHA-256 takes 2.1 s for this file in Node on the host Mac. The open also
  needs roughly the book's size in free disk: Chromium spills the 87 MB `File` blob to disk, and with ~9 MB free the
  open fails with `NotReadableError` (ENOSPC point B).

### Gate: ENOSPC during import

`/data` (16 GB) filled with `adb shell fallocate -l <n> /data/local/tmp/fill*`; a `fallocate` larger than the free
space keeps what it got, so it fills to 0. Android fights back: on low storage `installd` purges app caches (logcat
`Failed to free up 1048576000 on /data`), so the fill was re-applied after each purge. State read with
`adb shell run-as app.textstack.mobile ls -la files/v2 files/v2/staging files/v2/books files/v2/store cache/DocumentPicker`.

| Failure point | How | Reported | State left |
|---|---|---|---|
| A. Picker copy, before our move into `staging/` | 15 MB free, pick the 87 MB book (again: 1.4 MB free, 1.4 MB book) | screen: `pick: Error: java.io.IOException: sendfile failed: ENOSPC` | `staging/` empty, library unchanged. expo-document-picker's partial copy stays in `cache/DocumentPicker/<uuid>.epub` (15,679,488 B; 1,425,408 B), also after relaunch |
| B. Page open (blob spill) | ~96 MB free after the system purge: the copy lands, ~9 MB left | page `error: open: NotReadableError …` → `open-failed` | staged file dropped, no entry. Pass |
| C. `library.json` write, retained copy already moved | new book (330,622 B); `/data` filled to 0 the moment the host logged `openUrl` (an on-device `logcat -d` poll, then `fallocate`) | log `[v2] opened failed: … FileSystemFile.write … ENOSPC`; the book stays open and readable; every page turn then shows `store: … ENOSPC`, which replaces the `opened` error on screen | `books/41746405….epub` retained **with no library entry**; `library.json` (946 B, 3 entries) intact; `library.json.tmp` **0 B**; `store/41746405….json.tmp` **0 B**; `staging/` empty |
| D. `store` write while reading | `/data` filled to 0 after a good import | `store: … ENOSPC` on every relocate | no `store/<sha256>.json` for that book, a 0 B `.tmp`; once space came back the next save landed (406 B) |

**Next launch** (space freed, `am force-stop`, relaunch): `deviceFiles()` does wipe `staging/` (recreated empty).
The orphan `books/41746405….epub`, `library.json.tmp` and `store/…json.tmp` (both 0 B) remain; the library lists 3
books and the orphan is invisible and counted nowhere. Reading is unharmed: `readRecovering` prefers the target, and
an empty `.tmp` reads as no entry.

**Also seen:** retained copies are owned by group `u0_a231_cache` (moved, not copied, out of the picker's cache
copy), and `installd` counted them as this app's cache (`used=112750592 quota=125194981` with ~20 MB of real cache),
which makes the app a first purge target.

### Gate: oldest supported System WebView

- **Emulator B (WebView 66).** Dev APK pulled from emulator A and installed (`minSdk 24`). The dev route renders its
  buttons; `adb logcat chromium:*` shows `"Uncaught SyntaxError: Unexpected token ?", source: file:///data/user/0/app.textstack.mobile/files/ (28)`
  (optional chaining or `??`, Chrome 80 syntax) before any `log` message. No `ready`, so the host never calls
  `openUrl`: a picked book sits in `staging/1793400532565.epub` under "Pick an EPUB", with no error, until the next
  launch wipes it (finding 3).
- **Lower target.** A local copy of `build.mjs` with only the target changed: `chrome69` builds (260,142 chars,
  +23,476 = +9.9 % over `BUDGET` 236,666), `chrome61` too (264,301). esbuild lowers the syntax (no private-method
  calls left at `chrome69`) but does not polyfill APIs, and the pinned foliate calls `Object.groupBy`/`Map.groupBy`
  (Chrome 117), `findLastIndex` (97), `.at()` (92), `replaceAll` (85), `Object.fromEntries` (73).
- **API floor of the committed page** (desktop Chromium, page as `file://`, one API deleted by an init script, open
  PG #28885): nothing deleted → `opened`, relocates; `Object.groupBy` → `open-failed: Object.groupBy is not a function`;
  `Map.groupBy` → `open-failed`; `.at` → `opened`, never relocates (nothing shown); `findLastIndex`, `replaceAll` →
  opens. **The page needs Chrome ≥ 117 today, whatever the esbuild target**; `chrome90` is only its syntax floor.
- **Options.** (1) An "update Android System WebView" screen gated on the WebView's Chrome major ≥ 117: one number to
  keep, no bundle cost; covers devices with Play (per Chromium's support announcements WebView reaches 119 on
  Android 7 and 138 on Android 8–9, both above 117 — verify when building it), not devices without Play. Detection
  must not need the page to boot: an ES5 `injectedJavaScriptBeforeContentLoaded` posting `navigator.userAgent`, or a
  `ready` deadline. (2) Lower target plus hand-written polyfills: ~+10 % bundle before the polyfills, a list that a
  foliate bump can outgrow silently (the pinned foliate already needs 117 while ADR-029 said 90, and nothing
  noticed), and stock Android 7–8 WebViews (Chrome 5x) stay out anyway. **Recommended: (1)**, the owner's to confirm.

### Gate: file security review

**What a hostile EPUB reaches with the CSP intact: nothing outside its zip.** Script: blocked (nonce). Network:
blocked (`default-src 'none'`, every fetch directive `blob:`/`data:`). Sibling files: blocked for `img`, `link` and
`iframe`, and no script runs to use `connect-src file:`. Re-run of R3's `tshostile.epub` (built by `fixtures.mjs`
with siblings = `files/v2/books`) on the Android System WebView of emulator A, through the real host (picker →
`staging/` → `openUrl`), attached over CDP (`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`),
sibling secrets in `files/v2/books/`, a logging server on 127.0.0.1:9876 via `adb reverse`, every section visited
and every `data-ts-click` clicked: **30/30 blocked**. `link-tap` reached the host as `openLink` and the host opened
Chrome, so the clicks reached the book. **Positive control**, the CSP disabled with CDP `Page.setBypassCSP`: 21/30
escape — all 7 script vectors (their marks land in `top.__pwned`: book frames share the page's window and its
`ReactNativeWebView` bridge), `file-sibling-xhr`, sibling `img`/`css`, `<base>` and 10 request vectors carrying the
WebView's user agent. Still blocked with the CSP off: `iframe`, `file-sibling-iframe`, `object`, `embed` (a second
barrier on Android, not identified), both `meta-refresh` rows (the page's strip), `javascript-url`, `form`, `link-tap`.

**What one script in the page's origin reaches** (emulator A, real CSP, XHR from the page): `files/v2/library.json`
and every retained book; **directory listings** of `files/`, `files/SQLite/`, `databases/`, `shared_prefs/`, `cache/`;
the bytes of `databases/RKStorage` (AsyncStorage) and, by name, the offline SQLite `files/SQLite/textstack-offline`
(catalogue and upload chapters); any world-readable file (`/data/local/tmp/secret.json`). Auth tokens live in
SecureStore (Keystore-encrypted), so ciphertext only. The CSP stops the network but not the bridge: `openLink` with
`https://…?<data>` makes the host open a browser on it, and `store` writes any JSON under a 64-hex key. That is the
whole cost of a CSP regression (the 9 mutations: R3's table), a leaked nonce or a Chromium CSP bug.

**What the flags add.** `allowFileAccess` lets the WebView load `file:` at all; `allowFileAccessFromFileURLs` lets a
`file://` page XHR any other file — it is what turns `connect-src file:` into "the app's data dir";
`allowUniversalAccessFromFileURLs=false` only keeps `http(s)` XHR out, already the CSP's job;
`onShouldStartLoadWithRequest` (only `about:`/`blob:`/`data:`) keeps the top frame, which holds the bridge, from
navigating. R3's desktop check cannot see this half (the flags, `content:`, the bridge); the CSP half now has its
on-device run above.

**The three options of ADR-029 Decision 4.**
1. *Keep `file://` + `connect-src file:`.* Works and is the fastest measured (6.4–7.7 s for 87 MB). One barrier: the nonce.
2. *Narrow `connect-src file:` to the one file.* **Not expressible.** A CSP host-source needs a host; Chromium rejects
   `connect-src file:///…/book.epub` and `file:///…/books/` as "an invalid source", and the directive then blocks
   the book too (desktop Chromium, measured; `'self'` at this origin behaves as `file:`). For `file` the only
   choices are all of `file:` or none.
3. *Hand the bytes in another way.* Over the bridge (base64): the prototype measured 35.8 MB in 27.9 s against 4.7 s
   by XHR; linearly ~68 s for this 87 MB book against 6.4–7.7 s, with several transient copies of the book in two JS
   heaps beside a renderer already at ~190 MB — not viable. Natively: an intercepted origin (Android's
   `shouldInterceptRequest`, e.g. `WebViewAssetLoader` on `https://appassets.androidplatform.net/`) serving only
   `books/<sha256>.epub`, a non-`file:` base URL and both `allowFileAccess*` flags off; the CSP can then path-restrict
   `connect-src` to that one https URL. The same streamed read as today, but native code in `react-native-webview`
   (it has no JS API for interception: a patch or a config plugin) and a changed `openUrl`. Not measured.

**R4 recommendation:** option 3 in its native form before any non-dev route; option 1 stays accepted for the dev
route until then. The owner decides (ADR-029 Decision 4).

### Findings for the host (dev route: `V2ReaderScreen.tsx`, `hostStorage.ts`)

1. **Orphan retained copy** (medium): `addOpened` moves `staging/x` → `books/<sha256>.epub`, then the `library.json`
   write fails → the copy stays with no entry, invisible, uncounted and never cleaned (point C).
2. **Empty `.tmp` left behind** (low): `writeAtomically` leaves its 0 B `.tmp` when the write fails.
3. **No deadline on `ready` / `opened`** (medium): on WebView 66 the screen says "Pick an EPUB" forever.
4. **Retained copies carry the cache group** (low): moved out of the picker's cache copy, so Android accounts them as
   app cache. Copying from the picked URI straight into `staging/` also removes point A's partial file.
5. **Partial picker copy on ENOSPC** (low): `cache/DocumentPicker/<uuid>.epub`, see 4.
6. **Error UI** (low): one error line, so the `opened` ENOSPC is replaced by the next `store` error; after an
   `open-failed` the page has already closed the previous book while the heading still names it; a full disk reads
   as a raw `NotReadableError`.
