# V2 reader page

The page that renders a local EPUB, MOBI/AZW3, FB2 or CBZ (see Formats) in the V2 reader's WebView ([ADR-029](../../../../../docs/01-architecture/adr/ADR-029-foliate-for-v2-epub.md)).
foliate-js parses and renders the book; our code adds word tap, the inline translation label, highlights and
the reading position. Slice R1 of [v2-plan.md](../../../../../docs/01-architecture/v2-plan.md) §7: the page
and its build only. Dev route: `app/dev/epub-v2.tsx` → `V2ReaderScreen.tsx` (R2); hidden from production Metro, see metro.config.js.

| File | What |
|---|---|
| `page.mjs` | Runs in the WebView. The whole adapter: routing a file to its reader, our EPUB loader (SHA-1 for obfuscated fonts), the format-reader runner, the navigation queue, word tap, translation label, highlights, save/restore by CFI + quote, `meta refresh` stripped, flow + its telemetry. |
| `formats.mjs` | Which reader a file goes to, from its bytes (pure): zip → EPUB/FBZ/CBZ by entry names, `BOOKMOBI` → MOBI (DRM, KF8, truncated refused; combo → MOBI6 half), FB2 root (UTF-16 re-encoded, entities refused), PDF/KFX/unknown refused; CBZ page names and types. |
| `store.mjs` | Reader data shape (v1), one entry per book **file** (SHA-256 + size); the quote fold; pure-JS SHA-256 / SHA-1. |
| `tap.mjs` | What a tap hands the host: the word's sentence (reader-engine's `sentenceAround`) and an external link, only if `http(s)`. |
| `saveScheduler.mjs` | The debounced `store` message: key and payload are fixed when the save is asked for, so a save can never land on the next book. |
| `overlays.mjs` | What is drawn over a range. foliate keys an overlay by its CFI, so a highlight and a word's translation over the same range are one overlay carrying both. |
| `library.mjs` | V2 local library (pure): identical bytes → the existing entry, never a duplicate or reset. |
| `library.d.mts` | Hand-written types for `library.mjs` (apps/web type-checks it without `allowJs`); a change to one must update the other. |
| `hostStorage.ts` | The host's files under `<documents>/v2/` (R2): staging, retained `books/<sha256>.epub`, `library.json`, `store/<sha256>.json`; tmp-then-move writes, one queue for reads and writes, lower-cased keys. |
| `*.test.ts` | Unit tests (mobile vitest) for the pure modules and hostStorage. |
| `build.mjs` | Pinned fork clone → esbuild IIFE (+ one per format reader) → `v2ReaderPage.generated.ts`. |
| `carrier.mjs` | The page shell (pure): CSP, nonce placeholder, `formatsJs` (readers as escaped strings), `html`. Tested by `carrier.test.ts`. |
| `v2ReaderPage.generated.ts` | **Generated, committed.** `v2ReaderPageHtml(nonce)`. Never edit by hand. |
| `repro.mjs` | Test-only entry: the page + `__fol.reproRenderDuringLoad` (the reproducer behind the fork's paginator fix). |
| `fixtures.mjs` | Writes crafted books to `fixtures/` (gitignored): `tsfonts.epub` (one font plain, IDPF-, Adobe-obfuscated), `tshostile.epub` (one row of `hostileVectors` per sandbox vector; `.mobi`/`.fb2` twins are written by the check), and `tsformat.{epub,mobi,fb2,fbz,cbz}`, `tsdrm.mobi`, `tskf8.mobi`, `tscombo.mobi`, `tsupper.cbz`, `tsutf16.fb2`, every byte written by the file itself (MOBI6 by hand: PDB + PalmDOC + MOBI header). Needs `zip`. |
| `sandbox.check.mjs` | The hostile-book check (see Sandbox). |
| `formats.check.mjs` | The format check (see Formats): one small book per format through the committed page in Chromium. |
| `bigbook.mjs` | The large-book gate's fixture (ADR-029 Decision 6, R4): `node bigbook.mjs <in.epub> <out.epub> [MB=88]` pads a real EPUB to about MB MiB with PNG plates foliate renders. Needs `zip`/`unzip`; the output path is the caller's (put it in the gitignored `fixtures/`). |

## Build

```bash
pnpm -C apps/web build:v2-reader     # rewrite v2ReaderPage.generated.ts
pnpm -C apps/web check:v2-reader     # CI: exit 1 if it is stale or over budget (page or any format reader)
pnpm -C apps/web check:v2-reader-formats   # CI: every format opens as Formats says
node apps/mobile/src/lib/v2reader/build.mjs --repro   # + .vendor/v2ReaderPage.repro.html (test only)
```

- **foliate-js fork** `https://github.com/mrviduus/foliate-js` @ `d73682a48a0779ca989f25074386784602437fbf`
  (branch `textstack-pin` = upstream `78914aef` 2026-05-01 + our commits, ADR-032), cloned into the gitignored
  `.vendor/`. Every build checks out the pin and resets the tree (`git checkout -- .`); an untracked file in
  that tree fails the build by name (delete `.vendor/` to rebuild from the pin). A bump is a PR that re-runs
  every ADR-029 Decision 6 check. Needs network (CI clones it too).
- **Fork commit** `d73682a` (was `patches/0001-paginator-render-while-loading.patch`): `Paginator.render()`
  returns while the current view has no `body` yet (a resize or attribute change during a section load threw).
  Offer it upstream; drop it on the bump that fixes it. Reproduce with the `--repro` page:
  `await __fol.reproRenderDuringLoad(20)` → `errors: 0` (without
  the fix it was 1–5 per 6 loads in Chromium, hundreds on Android).
- esbuild comes from `apps/web` (no new dependency). Target `chrome90`, not the engine bundle's es2017: foliate
  uses private methods, static blocks and `\p{}` regexes. view.js's own format imports, PDF, TTS and search are
  stubbed out of the page; MOBI/FB2/CBZ come in as format readers (Formats).
- **Size:** the page script (unminified) is at most `BUDGET` characters in `build.mjs`, and each format reader
  at most its `FORMAT_BUDGET` entry: those constants are the one source for the numbers. Reader-engine's 64 KB
  budget does not apply; a budget is raised only by a deliberate PR.
- `BUDGET` is a tripwire by design, not a ceiling: it equals the committed size, so any growth fails `--check`
  until the PR that grows the page says so.
- **Licences** stay in the output (`legalComments: 'inline'`): foliate-js MIT © John Factotum; zip.js BSD-3-Clause.
- The page imports only foliate, `packages/shared` (`tokenizeVocabWords`) and `packages/reader-engine`
  (`rangeToLocator`, `chapterText`, `offsetOf`, `sentenceAround`). Nothing from `apps/`.

## Formats

#1128, ADR-029 as amended for all formats. The page routes a file by its **bytes** (`formats.mjs`), never by name:
the Android host stages and retains every format as `*.epub`, the web host opens a `blob:` URL.

| Format | Detected by | Reader | Text features |
|---|---|---|---|
| EPUB | zip with `META-INF/container.xml` | the page's own (`EPUB` + our SHA-1) | all |
| MOBI (MOBI6; a MOBI/KF8 combo as its MOBI6 half) | `BOOKMOBI` at byte 60, header version < 8 | fork `mobi.js` + `vendor/fflate.js` | all |
| FB2 / FBZ | `<FictionBook` in the first 4 KiB (UTF-8 or UTF-16) / zip with a `.fb2` | fork `fb2.js` | all |
| CBZ | zip with images, no container, no `.fb2` | fork `comic-book.js` (fixed layout) | **none** |
| AZW3 (KF8) | `BOOKMOBI`, header version ≥ 8 | refused: "AZW3 (KF8) is not supported yet" | — |
| PDF, KFX, other | `%PDF-`, `\xeaDRMION\xee`, anything else | refused with `open-failed` | — |

- **Loaded only when needed.** Each format reader is its own esbuild IIFE, carried in the page's one script as a
  string (`var __TS_FORMATS`, every `<` escaped as `\u003c`, so nothing in it can end or bend the script
  element) and **run on first use**: `formatModule()` inserts a `<script>` carrying the page's own nonce
  (`document.currentScript.nonce`) with that text; the reader registers itself on `window.__tsFormats`. An EPUB
  runs none of them. Why this shape: the CSP is `script-src 'nonce-…'` only — no `blob:`, no `'unsafe-eval'`, no
  network — so esbuild `splitting` (separate ESM files), `import()` of a `blob:` URL, `new Function`/`eval` are all
  refused, and widening any directive is an ADR-029 change. A nonce'd inline script is admitted whoever inserts it;
  the nonce is fresh per load and no book script can run to read it. The strings are parsed with the page (cheap);
  only their evaluation is deferred.
- **A refusal touches nothing.** `sniffFormat` runs before the open book is closed or the open seq turns over
  (like a failed read, #1168): a PDF, DRM, KF8, entity-declaring FB2 or unknown file answers `open-failed` and the
  book on screen keeps reading, saving and its telemetry session. (An FBZ's inner FB2 is checked only once the
  zip is read, inside the open: that refusal does replace the book.)
- **DRM:** a MOBI whose PalmDOC `encryption` is non-zero, and any KFX, answer `open-failed` with
  "…DRM-protected…". A `BOOKMOBI` too short for its record 0 is "truncated or damaged", never DRM. EPUB DRM is
  not detected here (foliate fails on the encrypted content).
- **KF8 (AZW3) is refused** at this pin (d73682a). The fork's KF8 reader is unverified (no KF8 fixture; one needs
  SKEL/FRAG/INDX records) and has a confirmed bug: `mobi.js` `KF8.loadResourceBlob` builds
  `new Blob([newData], { newType })` — the option is `type`, so every CSS/image/font/SVG resource blob is untyped
  (SVG images will not render). Its section HTML also bypasses `transformTarget`, the page's refresh-meta strip.
  A combo file (MOBI6 record 0 + an EXTH 121 KF8 boundary) is read as its MOBI6 half: the page sets the boundary
  to 0xffffffff in its copy of the bytes (after hashing), which foliate reads as "no KF8".
- **FB2 encodings and entities:** foliate decodes FB2 as UTF-8 before reading its declaration, so the page
  re-encodes a UTF-16 file (BOM or not, either order) to UTF-8 first. Any `<!ENTITY` before the root is refused
  before parsing ("unsupported FB2: custom entities"): a flat entity referenced tens of thousands of times hangs
  the page and kills the renderer at larger counts (Blink stops only *nested* expansion), and real FB2 files
  declare none.
- **CBZ** is images only: every tap is a `tap` (no `word`), no selection is kept, `highlightSelection()` and
  `showTranslation()` are ignored, `opened.textual` is `false` so the host hides them. Its position is saved
  **without a quote** (there is no text at any CFI): `{ cfi, page, index, fraction, at }`, `page` = the image's
  entry name, checked on restore (`store.mjs`). How the server stores such a position is open. Page names are
  handed to foliate with lower-case extensions (`comicName`: it keeps `.jpg`, never `.JPG`), each name once, and
  each page blob is typed by its extension (an untyped SVG is no image). `opened.reflowable` is `false`: `flow()`
  changes nothing on a fixed layout, is not counted as a switch, and the hosts disable their toggle.
- **Refresh metas:** EPUB sections pass through `transformTarget`; MOBI6 has none, so the page wraps its
  `createDocument`. FB2 and CBZ sections are rebuilt by foliate from whitelisted elements / one `<img>`.
- **Hostile input:** every reader runs inside the same page and CSP. The sandbox check opens a hostile MOBI (the
  EPUB's HTML vectors) and FB2 (an external image) beside the EPUB; the format check refuses a nested
  (billion-laughs), a flat (×30k) and an external-entity FB2 before parsing. Not covered, accepted: zip bombs (a
  CBZ/EPUB entry is inflated whole when shown, an FBZ's `.fb2` whole at open: a memory DoS inside the WebView, as
  for EPUB today). The Android host stops reopening a book after its second renderer crash.

```bash
pnpm -C apps/web check:v2-reader-formats   # needs Chromium (playwright install chromium)
```

## Sandbox

The section iframes are `sandbox="allow-same-origin allow-scripts"`, so the page CSP is the only script barrier
(ADR-029 Decision 4; changing a directive is a change to that ADR):

```
default-src 'none'; script-src 'nonce-__V2_READER_NONCE__'; style-src blob: 'unsafe-inline'; img-src blob: data:;
font-src blob: data:; media-src blob: data:; frame-src blob:; connect-src blob: data: file:; form-action 'none'; base-uri 'none'
```

**The hostile-book check** (ADR-029 Decision 6) loads the committed page as `file://` in Chromium with file access
(the dev route's origin), opens `tshostile.epub`, `.mobi` and `.fb2` (Formats) through `__fol.openUrl` and exits 1 if any vector gets through: a
book script ran (`__pwned` in any frame), a request reached its logging server (a free local port), a sibling file of
the EPUB was read, `<base>` took effect, a refresh meta survived the page's strip, or the section frame left the
book. It then removes or widens one directive at a time and must catch the vectors that directive stops, so a check
that cannot fail fails itself. Every vector in `fixtures.mjs` declares how it is observed (`mark`, `request`,
`probe`, `sandbox`) and which directive `stops` it; the check refuses to start (exit 2) when the two files disagree.
Each page call is bounded (10 s; a timeout is an escape) and the whole check has a 3-minute deadline (exit 1 with the
partial table).

**What it proves, and where:** the CSP, in desktop headless Chromium, with the page opened by `page.goto(file://…)`
and `--allow-file-access-from-files`. Not the Android System WebView (`loadDataWithBaseURL`, Android's file-access
flags, `content:`/`intent:` URLs): R4 (#1036) runs the book on the device.

```bash
pnpm -C apps/web exec playwright install chromium   # once
pnpm -C apps/web check:v2-reader-sandbox            # real CSP holds, every mutation is caught
node --experimental-strip-types apps/mobile/src/lib/v2reader/sandbox.check.mjs --mutate=base-uri   # one mutation: exits 1
```

**Blind spots** — vectors the check reports blocked but cannot show the CSP blocking:

- **`form-action 'none'`**: removing it still passes. foliate's section iframe has no `allow-forms`, so the sandbox
  stops the submit first; the `form` row prints "by the iframe sandbox, not by the CSP".
- **`object` / `embed`**: they reach the server only with both `default-src` (object-src) and `frame-src` opened, so no
  single-directive mutation shows them; plugin content is also stopped by the sandbox.
- **`svg-file-script`**: an SVG document with a script, as `<object>`/`<embed>`; stopped by object-src before
  script-src is asked. (As `<img>` an SVG can never run script, so the fixture does not carry that half.)
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
| `openUrl(url, name)` | Reads the retained book by XHR (`file://…`) and opens it, whatever its format (Formats). Answers `opened` or `open-failed`. A second call supersedes the first, which then answers nothing. |
| `restore(json \| null)` | The answer to `opened`: the JSON last sent in `store` for that `book.sha256`, or null. |
| `highlightSelection()` | The last non-empty selection becomes a highlight; sends `store` and `highlighted`. Ignored on a CBZ. A selection with no text (an image) or over 4000 UTF-16 units (`SyncLimits.MaxSelectedText`) is ignored with a `warn` log. |
| `goTo(target)` | CFI, href or section index. Queued behind the previous navigation. |
| `section(±1)`, `next()`, `prev()` | Section / page step, queued. |
| `font(delta)` | Font size ±px, clamped 12–32; returns the new size. No-op before `opened`. |
| `flow('paginated' \| 'scrolled')` | foliate layout; default `paginated` (ADR-029 Decision 1). Switches the open book in place (no reload, position kept). Before `opened` it sets what the next open uses: hosts send the reader's stored setting right after `ready`. Anything else is ignored with a `warn`. |
| `showTranslation(cfi, index, text)` | The answer to `word`: draws `text` above that word. Ignored on a CBZ. |

**Page → host** (`{ type, … }`)

| `type` | Fields | Host does |
|---|---|---|
| `ready` | — | may call `openUrl` |
| `opened` | `book {sha256, size, name}`, `format` (`epub`/`mobi`/`fb2`/`cbz`), `textual` (false: hide highlight, translation, vocabulary), `reflowable` (false: disable the flow toggle), `title`, `author` (either may be `''`), `sections`, `toc [{label, href}]` | calls `restore` with the stored JSON for `book.sha256` |
| `open-failed` | `name`, `error` (shown as is: unreadable, unsupported format, PDF, DRM) | must not keep the file |
| `restored` | `found`, `rejected`, `position` (`none` / `restored` / `quote mismatch, stayed at start` / `page not found, stayed at start` (CBZ) / `navigation failed, stayed at start`), `highlights [{id, status}]` | — |
| `store` | `key` (= `book.sha256`), `json` | keeps `json` under `key`, verbatim |
| `relocate` | `index`, `sections`, `fraction`, `toc`, `cfi` | progress UI |
| `word` | `index`, `word`, `sentence`, `cfi`, `rect {x, y, w, h}` (host viewport) | translates, then `showTranslation` |
| `tap` | — | a tap not on a word (chrome toggle) |
| `highlighted` | `id` (v4 UUID), `cfi`, `quote` (first ≤64 code points), `selectedText` (the full selection) | — |
| `openLink` | `href` | the page forwards only `http(s)` links and the host allowlists again before opening: a stated rule, not an accident. Any other scheme is dropped with a `warn` log (`mailto:`/`tel:` noted on #1069); the page never navigates |
| `telemetry` | `event: 'reader-flow'`, `mode` (the flow in use), `format`, `switchedInFirst5Min` | one per opened book, 5 min after `opened` or when the next book opens first (a page that dies earlier sends none). Hosts log it: there is no analytics pipeline in the app yet |
| `log` | `level`, `msg` | `error`: window errors and a failed open or restore. `warn`: a call that was ignored (a highlight or a restore before the book is ready) and a previous book that would not close. foliate logs its own navigation failures to the console, not here — a position that did not land is reported in `restored` instead. |

A stored position or highlight is applied only while the text at its CFI still reads as its saved quote
(`foldText`; a highlight compares its `selectedText`, or its `quote` if stored before #1078); otherwise it is reported in `restored` and left out, never drawn elsewhere. Stored items with no
quote at all are dropped when the entry is read. `highlightSelection()` before `restored` is ignored with a
`log` of level `warn`: there is no entry to add to yet, and saving then would overwrite the stored one.

## Host responsibilities

- A **fresh random nonce per load** into `v2ReaderPageHtml(nonce)`; the length check is not an entropy check, so the host picks the source of randomness (R2).
- **Keep every `store` payload verbatim** under its `key`, and hand the same JSON back to `restore`. Lower-case hex keys: `sha256()` emits lower case and the key is compared byte for byte.
- **Serialise library writes.** `library.mjs` is pure; two concurrent imports writing `library.json` can still lose one (R2).
- The R2 host passes its file path (`staging/<ts>.epub` or `books/<sha256>.epub`) as `openUrl`'s `name` to match each answer to its open, so the page's stored `book.name` is that path until the contract gains an explicit open id (#1069).
- `<documents>/v2/` is not yet counted in Device Storage nor wiped on sign-out (#1070, R6).

**WebView, dev route only** (prototype host; ADR-029 Decision 4 until the R4 security review):
`source={{ html: v2ReaderPageHtml(nonce), baseUrl: <app documents dir> }}`, `allowFileAccess`,
`allowFileAccessFromFileURLs`, `originWhitelist={['*']}`. The `file://` origin lets the page read the retained
file itself, so no book bytes cross the bridge. Universal file access stays off.
