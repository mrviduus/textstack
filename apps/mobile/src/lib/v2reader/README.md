# V2 reader page

The page that renders a local EPUB in the V2 reader's WebView ([ADR-029](../../../../../docs/01-architecture/adr/ADR-029-foliate-for-v2-epub.md)).
foliate-js parses and renders the book; our code adds word tap, the inline translation label, highlights and
the reading position. Slice R1 of [v2-plan.md](../../../../../docs/01-architecture/v2-plan.md) §7: the page
and its build only. No route, no WebView host, no UI yet (R2).

| File | What |
|---|---|
| `page.mjs` | Runs in the WebView. The whole adapter: our EPUB loader (SHA-1 for obfuscated fonts), the navigation queue, word tap, translation label, highlights, save/restore by CFI + quote, `meta refresh` stripped. |
| `store.mjs` | Reader data shape (v1), one entry per book **file** (SHA-256 + size); the quote fold; pure-JS SHA-256 / SHA-1. |
| `library.mjs` | V2 local library (pure): identical bytes → the existing entry, never a duplicate or reset. |
| `*.test.ts` | Unit tests for the two pure modules (mobile vitest). |
| `patches/*.patch` | Our changes to foliate-js, applied in order on every build. |
| `build.mjs` | Pinned clone → patches → esbuild IIFE → `v2ReaderPage.generated.ts`. |
| `v2ReaderPage.generated.ts` | **Generated, committed.** `V2_READER_PAGE_HTML`. Never edit by hand. |
| `repro.mjs` | Test-only entry: the page + `__fol.reproRenderDuringLoad` (the reproducer behind patch 0001). |
| `fixtures.mjs` | Writes crafted EPUBs to `fixtures/` (gitignored): `tsfonts.epub` (one font plain, IDPF-, Adobe-obfuscated) and `tshostile.epub` (book scripts + every external request kind). Needs `zip`. |

## Build

```bash
pnpm -C apps/web build:v2-reader     # rewrite v2ReaderPage.generated.ts
pnpm -C apps/web check:v2-reader     # CI: exit 1 if it is stale or over budget
node apps/mobile/src/lib/v2reader/build.mjs --repro   # + .vendor/v2ReaderPage.repro.html (test only)
```

- **foliate-js** `https://github.com/johnfactotum/foliate-js` @ `78914aef4466eb960965702401634c2cb348e9b1`
  (2026-05-01), cloned into the gitignored `.vendor/`. Every build checks out the pin, resets the tree
  (`git checkout -- .`) and applies `patches/*.patch`; a patch that no longer applies fails the build. A bump is a PR
  that re-runs every ADR-029 Decision 6 check. Needs network (CI clones it too).
- **Patch** `0001-paginator-render-while-loading.patch`: `Paginator.render()` returns while the current view has no
  `body` yet (a resize or attribute change during a section load threw). Offer it upstream; drop it on the bump
  that fixes it. Reproduce with the `--repro` page: `await __fol.reproRenderDuringLoad(20)` → `errors: 0` (without
  the patch it was 1–5 per 6 loads in Chromium, hundreds on Android).
- esbuild comes from `apps/web` (no new dependency). Target `chrome90`, not the engine bundle's es2017: foliate
  uses private methods, static blocks and `\p{}` regexes. PDF/MOBI/FB2/CBZ/TTS/search are stubbed out.
- **Size:** 232,847 characters of script (unminified), ~241 KB generated file. Reader-engine's 64 KB budget does
  not apply; this page's own budget is `BUDGET` in `build.mjs` (its first committed size), raised only by a
  deliberate PR.
- **Licences** stay in the output (`legalComments: 'inline'`): foliate-js MIT © John Factotum; zip.js BSD-3-Clause.
- The page imports only foliate, `packages/shared` (`tokenizeVocabWords`) and `packages/reader-engine`
  (`rangeToLocator`). Nothing from `apps/`.

## Sandbox

The section iframes are `sandbox="allow-same-origin allow-scripts"`, so the page CSP is the only script barrier
(ADR-029 Decision 4; changing a directive is a change to that ADR):

```
default-src 'none'; script-src 'nonce-tsfoliate'; style-src blob: 'unsafe-inline'; img-src blob: data:;
font-src blob: data:; media-src blob: data:; frame-src blob:; connect-src blob: data: file:; form-action 'none'; base-uri 'none'
```

**Known gap:** the nonce is a constant in a public repo, so a book that writes `<script nonce="tsfoliate">` passes
it. The host has to swap in a per-load random nonce before this page sees a book outside the dev route.

## Host ↔ page contract

The host injects calls as fire-and-forget JS (`injectJavaScript('window.__fol.…;true')`); the page answers with
`window.ReactNativeWebView.postMessage(JSON)`. Order: `ready` → `openUrl` → `opened` → host calls
`restore(stored)` → `restored`. The page sends no `store` before `restored`.

**Host → page** (`window.__fol`)

| Call | Does |
|---|---|
| `openUrl(url, name)` | Reads the retained EPUB by XHR (`file://…`) and opens it. Answers `opened` or `open-failed`. |
| `restore(json \| null)` | The answer to `opened`: the JSON last sent in `store` for that `book.sha256`, or null. |
| `highlightSelection()` | The last non-empty selection becomes a highlight; sends `store` and `highlighted`. |
| `goTo(target)` | CFI, href or section index. Queued behind the previous navigation. |
| `section(±1)`, `next()`, `prev()` | Section / page step, queued. |
| `font(delta)` | Font size ±px, clamped 12–32; returns the new size. |
| `flow('scrolled' \| 'paginated')` | foliate layout; default `scrolled`. |
| `showTranslation(cfi, index, text)` | The answer to `word`: draws `text` above that word. |

**Page → host** (`{ type, … }`)

| `type` | Fields | Host does |
|---|---|---|
| `ready` | — | may call `openUrl` |
| `opened` | `book {sha256, size, name}`, `title`, `author` (either may be `''`), `sections`, `toc [{label, href}]` | calls `restore` with the stored JSON for `book.sha256` |
| `open-failed` | `name`, `error` | must not keep the file |
| `restored` | `found`, `rejected`, `position` (`none` / `restored` / `quote mismatch, stayed at start`), `highlights [{id, status}]` | — |
| `store` | `key` (= `book.sha256`), `json` | keeps `json` under `key`, verbatim |
| `relocate` | `index`, `sections`, `fraction`, `toc`, `cfi` | progress UI |
| `word` | `index`, `word`, `sentence`, `cfi`, `rect {x, y, w, h}` (host viewport) | translates, then `showTranslation` |
| `tap` | — | a tap not on a word (chrome toggle) |
| `highlighted` | `id`, `cfi`, `quote` | — |
| `openLink` | `href` | an external link; the page never navigates |
| `log` | `level`, `msg` | page errors (window errors, failed navigation / open / restore) |

A stored position or highlight is applied only while the text at its CFI still reads as its saved quote
(`foldText`); otherwise it is reported in `restored` and left out, never drawn elsewhere.

**WebView, dev route only** (prototype host; ADR-029 Decision 4 until the R4 security review):
`source={{ html: V2_READER_PAGE_HTML, baseUrl: <app documents dir> }}`, `allowFileAccess`,
`allowFileAccessFromFileURLs`, `originWhitelist={['*']}`. The `file://` origin lets the page read the retained
file itself, so no book bytes cross the bridge. Universal file access stays off.
