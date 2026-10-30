# V2 reader page

The page that renders a local EPUB in the V2 reader's WebView ([ADR-029](../../../../../docs/01-architecture/adr/ADR-029-foliate-for-v2-epub.md)).
foliate-js parses and renders the book; our code adds word tap, the inline translation label, highlights and
the reading position. Slice R1 of [v2-plan.md](../../../../../docs/01-architecture/v2-plan.md) §7: the page
and its build only. No route, no WebView host, no UI yet (R2).

| File | What |
|---|---|
| `page.mjs` | Runs in the WebView. The whole adapter: our EPUB loader (SHA-1 for obfuscated fonts), the navigation queue, word tap, translation label, highlights, save/restore by CFI + quote, `meta refresh` stripped. |
| `store.mjs` | Reader data shape (v1), one entry per book **file** (SHA-256 + size); the quote fold; pure-JS SHA-256 / SHA-1. |
| `tap.mjs` | What a tap hands the host: the word's sentence (reader-engine's `sentenceAround`) and an external link, only if `http(s)`. |
| `saveScheduler.mjs` | The debounced `store` message: key and payload are fixed when the save is asked for, so a save can never land on the next book. |
| `overlays.mjs` | What is drawn over a range. foliate keys an overlay by its CFI, so a highlight and a word's translation over the same range are one overlay carrying both. |
| `library.mjs` | V2 local library (pure): identical bytes → the existing entry, never a duplicate or reset. |
| `*.test.ts` | Unit tests for the two pure modules (mobile vitest). |
| `patches/*.patch` | Our changes to foliate-js, applied in order on every build. |
| `build.mjs` | Pinned clone → patches → esbuild IIFE → `v2ReaderPage.generated.ts`. |
| `v2ReaderPage.generated.ts` | **Generated, committed.** `v2ReaderPageHtml(nonce)`. Never edit by hand. |
| `repro.mjs` | Test-only entry: the page + `__fol.reproRenderDuringLoad` (the reproducer behind patch 0001). |
| `fixtures.mjs` | Writes crafted EPUBs to `fixtures/` (gitignored): `tsfonts.epub` (one font plain, IDPF-, Adobe-obfuscated) and `tshostile.epub` (one row of `hostileVectors` per sandbox vector). Needs `zip`. |
| `sandbox.check.mjs` | The hostile-book check (see Sandbox). |

## Build

```bash
pnpm -C apps/web build:v2-reader     # rewrite v2ReaderPage.generated.ts
pnpm -C apps/web check:v2-reader     # CI: exit 1 if it is stale or over budget
node apps/mobile/src/lib/v2reader/build.mjs --repro   # + .vendor/v2ReaderPage.repro.html (test only)
```

- **foliate-js** `https://github.com/johnfactotum/foliate-js` @ `78914aef4466eb960965702401634c2cb348e9b1`
  (2026-05-01), cloned into the gitignored `.vendor/`. Every build checks out the pin, resets the tree
  (`git checkout -- .`) and applies `patches/*.patch`; an untracked file in that tree fails the build by name (delete
  `.vendor/` to rebuild from the pin); a patch that no longer applies fails the build. A bump is a PR
  that re-runs every ADR-029 Decision 6 check. Needs network (CI clones it too).
- **Patch** `0001-paginator-render-while-loading.patch`: `Paginator.render()` returns while the current view has no
  `body` yet (a resize or attribute change during a section load threw). Offer it upstream; drop it on the bump
  that fixes it. Reproduce with the `--repro` page: `await __fol.reproRenderDuringLoad(20)` → `errors: 0` (without
  the patch it was 1–5 per 6 loads in Chromium, hundreds on Android).
- esbuild comes from `apps/web` (no new dependency). Target `chrome90`, not the engine bundle's es2017: foliate
  uses private methods, static blocks and `\p{}` regexes. PDF/MOBI/FB2/CBZ/TTS/search are stubbed out.
- **Size:** 236,602 characters of script (unminified), ~241 KB generated file. Reader-engine's 64 KB budget does
  not apply; this page's own budget is `BUDGET` in `build.mjs`, raised only by a deliberate PR.
- `BUDGET` is a tripwire by design, not a ceiling: it equals the committed size, so any growth fails `--check`
  until the PR that grows the page says so.
- **Licences** stay in the output (`legalComments: 'inline'`): foliate-js MIT © John Factotum; zip.js BSD-3-Clause.
- The page imports only foliate, `packages/shared` (`tokenizeVocabWords`) and `packages/reader-engine`
  (`rangeToLocator`, `chapterText`, `offsetOf`, `sentenceAround`). Nothing from `apps/`.

## Sandbox

The section iframes are `sandbox="allow-same-origin allow-scripts"`, so the page CSP is the only script barrier
(ADR-029 Decision 4; changing a directive is a change to that ADR):

```
default-src 'none'; script-src 'nonce-__V2_READER_NONCE__'; style-src blob: 'unsafe-inline'; img-src blob: data:;
font-src blob: data:; media-src blob: data:; frame-src blob:; connect-src blob: data: file:; form-action 'none'; base-uri 'none'
```

**The hostile-book check** (ADR-029 Decision 6) loads the committed page as `file://` in Chromium with file access
(the dev route's origin), opens `tshostile.epub` through `__fol.openUrl` and exits 1 if any vector gets through: a
book script ran (`__pwned` in any frame), a request reached its logging server (a free local port), a sibling file of
the EPUB was read, `<base>` took effect, or the section frame left the book. It then removes or widens one directive
at a time and must catch the vectors that directive stops, so a check that cannot fail fails itself.
Every vector in `fixtures.mjs` declares how it is observed (`mark`, `request`, `probe:<id>`, `sandbox`); the check
refuses to start (exit 2) on one it cannot observe. Each page call is bounded (10 s; a timeout is an escape) and the
whole check has a 3-minute deadline (exit 1 with the partial table).

**What it proves, and where:** the CSP, in desktop headless Chromium, with the page opened by `page.goto(file://…)`
and `--allow-file-access-from-files`. Not the Android System WebView (`loadDataWithBaseURL`, Android's file-access
flags, `content:`/`intent:` URLs): R4 (#1036) runs the book on the device.

```bash
pnpm -C apps/web exec playwright install chromium   # once
pnpm -C apps/web check:v2-reader-sandbox            # real CSP holds, every mutation is caught
node --experimental-strip-types apps/mobile/src/lib/v2reader/sandbox.check.mjs --mutate=no-base-uri   # one mutation: exits 1
```

**Blind spots** — vectors the check reports blocked but cannot show the CSP blocking:

- **`form-action 'none'`**: removing it still passes. foliate's section iframe has no `allow-forms`, so the sandbox
  stops the submit first; the `form` row prints "by the iframe sandbox, not by the CSP".
- **meta refresh**: covered by `page.mjs` stripping it before the section loads, and by Chromium's `frame-src`. No
  mutation removes the strip.
- **`object` / `embed`**: they reach the server only with both `default-src` (object-src) and `frame-src` opened, so no
  single-directive mutation shows them; plugin content is also stopped by the sandbox.
- **`svg-file-script`**: an SVG in `<img>` can never run script, so that half of the row is decoration; the
  `<object>`/`<embed>` half is stopped by object-src before script-src is asked.
- **`link-prefetch`** escapes whenever *any* directive gains `http:` or `*`, even with `default-src 'none'`. A
  widened `connect-src` is caught only through it, because no book script runs to use `connect-src`.

The artifact carries only the placeholder `__V2_READER_NONCE__` (a fixed nonce in a public repo is one a book
can carry); `v2ReaderPageHtml(nonce)` fills the CSP and the script tag and rejects anything but base64/hex of
16+ chars. The host supplies a fresh random nonce per load.

## Host ↔ page contract

The host injects calls as fire-and-forget JS (`injectJavaScript('window.__fol.…;true')`); the page answers with
`window.ReactNativeWebView.postMessage(JSON)`. Order: `ready` → `openUrl` → `opened` → host calls
`restore(stored)` → `restored`. The page sends no `store` before `restored`.

**Host → page** (`window.__fol`)

| Call | Does |
|---|---|
| `openUrl(url, name)` | Reads the retained EPUB by XHR (`file://…`) and opens it. Answers `opened` or `open-failed`. A second call supersedes the first, which then answers nothing. |
| `restore(json \| null)` | The answer to `opened`: the JSON last sent in `store` for that `book.sha256`, or null. |
| `highlightSelection()` | The last non-empty selection becomes a highlight; sends `store` and `highlighted`. |
| `goTo(target)` | CFI, href or section index. Queued behind the previous navigation. |
| `section(±1)`, `next()`, `prev()` | Section / page step, queued. |
| `font(delta)` | Font size ±px, clamped 12–32; returns the new size. No-op before `opened`. |
| `flow('paginated' \| 'scrolled')` | foliate layout; default `paginated` (ADR-029 Decision 1). No-op before `opened`. |
| `showTranslation(cfi, index, text)` | The answer to `word`: draws `text` above that word. |

**Page → host** (`{ type, … }`)

| `type` | Fields | Host does |
|---|---|---|
| `ready` | — | may call `openUrl` |
| `opened` | `book {sha256, size, name}`, `title`, `author` (either may be `''`), `sections`, `toc [{label, href}]` | calls `restore` with the stored JSON for `book.sha256` |
| `open-failed` | `name`, `error` | must not keep the file |
| `restored` | `found`, `rejected`, `position` (`none` / `restored` / `quote mismatch, stayed at start` / `navigation failed, stayed at start`), `highlights [{id, status}]` | — |
| `store` | `key` (= `book.sha256`), `json` | keeps `json` under `key`, verbatim |
| `relocate` | `index`, `sections`, `fraction`, `toc`, `cfi` | progress UI |
| `word` | `index`, `word`, `sentence`, `cfi`, `rect {x, y, w, h}` (host viewport) | translates, then `showTranslation` |
| `tap` | — | a tap not on a word (chrome toggle) |
| `highlighted` | `id`, `cfi`, `quote` | — |
| `openLink` | `href` | an external `http(s)` link; the page never navigates, and any other scheme (`mailto:` and `tel:` too, for now: #1069) is dropped with a `warn` log |
| `log` | `level`, `msg` | `error`: window errors and a failed open or restore. `warn`: a call that was ignored (a highlight or a restore before the book is ready) and a previous book that would not close. foliate logs its own navigation failures to the console, not here — a position that did not land is reported in `restored` instead. |

A stored position or highlight is applied only while the text at its CFI still reads as its saved quote
(`foldText`); otherwise it is reported in `restored` and left out, never drawn elsewhere. Stored items with no
quote at all are dropped when the entry is read. `highlightSelection()` before `restored` is ignored with a
`log` of level `warn`: there is no entry to add to yet, and saving then would overwrite the stored one.

## Host responsibilities

- A **fresh random nonce per load** into `v2ReaderPageHtml(nonce)`; the length check is not an entropy check, so the host picks the source of randomness (R2).
- **Keep every `store` payload verbatim** under its `key`, and hand the same JSON back to `restore`. Lower-case hex keys: `sha256()` emits lower case and the key is compared byte for byte.
- **Serialise library writes.** `library.mjs` is pure; two concurrent imports writing `library.json` can still lose one (R2).

**WebView, dev route only** (prototype host; ADR-029 Decision 4 until the R4 security review):
`source={{ html: v2ReaderPageHtml(nonce), baseUrl: <app documents dir> }}`, `allowFileAccess`,
`allowFileAccessFromFileURLs`, `originWhitelist={['*']}`. The `file://` origin lets the page read the retained
file itself, so no book bytes cross the bridge. Universal file access stays off.
