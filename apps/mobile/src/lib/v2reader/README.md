# V2 reader page

The page that renders a local EPUB, MOBI/AZW3, FB2, CBZ or PDF (see Formats) in the V2 reader's WebView ([ADR-029](../../../../../docs/01-architecture/adr/ADR-029-foliate-for-v2-epub.md)).
foliate-js parses and renders the book; our code adds word tap, the inline translation label, highlights and
the reading position. Slice R1 of [v2-plan.md](../../../../../docs/01-architecture/v2-plan.md) §7: the page
and its build only. Dev route: `app/dev/epub-v2.tsx` → `V2ReaderScreen.tsx` (R2); hidden from production Metro, see metro.config.js.

| File | What |
|---|---|
| `page.mjs` | Runs in the WebView. The whole adapter: routing a file to its reader, our EPUB loader (SHA-1 for obfuscated fonts), the format-reader runner, the navigation queue, word tap, translation label, highlights, save/restore by CFI + quote (a PDF by page), `meta refresh` stripped, flow + its telemetry. |
| `formats.mjs` | Which reader a file goes to, from its bytes (pure): zip → EPUB/FBZ/CBZ by entry names, `BOOKMOBI` → MOBI6/KF8 (DRM, truncated and KF8 without its indexes refused; combo → KF8 half), FB2 root (UTF-16 re-encoded, entities refused), `%PDF-` in the first KiB → PDF, KFX/unknown refused; CBZ page names and types. |
| `store.mjs` | Reader data shape (v1), one entry per book **file** (SHA-256 + size); the quote fold; pure-JS SHA-256 / SHA-1. |
| `tap.mjs` | What a tap hands the host: the word's sentence (reader-engine's `sentenceAround`) and an external link, only if `http(s)`. |
| `saveScheduler.mjs` | The debounced `store` message: key and payload are fixed when the save is asked for, so a save can never land on the next book; `flush()` writes a pending one at once (the swap). |
| `overlays.mjs` | What is drawn over a range. foliate keys an overlay by its CFI, so a highlight and a word's translation over the same range are one overlay carrying both. |
| `library.mjs` | V2 local library (pure): identical bytes → the existing entry, never a duplicate or reset. |
| `library.d.mts` | Hand-written types for `library.mjs` (apps/web type-checks it without `allowJs`); a change to one must update the other. |
| `hostStorage.ts` | The host's files under `<documents>/v2/` (R2): staging, retained `books/<sha256>.epub`; lower-cased keys. The `store` payload goes to the local library; R2's `library.json` + `store/<sha256>.json` are imported into it once (non-UUID ids remapped), then deleted. |
| `localLibrary.ts` | R6 (#1038): SQLite database `textstack-v2` — `books`, `reading_state`, `annotations` (the page's position/highlight JSON per row, keyed by client v4 UUIDs), `outbox` (one coalescing entry per row, `gen` per re-queue, `failures` per gen: any entry kept and skipped after N, reset every session and by "Try again" = `unpark`, #1186), `meta` (cursors, file-sync setting). The page's entry is rebuilt from rows on `restore` and split into rows on `store`, through `@textstack/shared`'s `v2PageEntry` (the web host's mapping too, #1226); the entry's shape and checks are `v2PageStore.ts` there (`store.mjs` re-exports them). |
| `sync.ts` | R6: the sync client to `/me/v2/*` (PDD v2-sync-protocol.md): pull the library/reading/annotations feeds by cursor, push the outbox in order, opt-in file sync (shared `uploadV2File`), download on demand; conflicts per the PDD's codes, reading state by ADR-019 re-keyed on CFI + spine index; every answer under the shared `whileCurrent` epoch guard. |
| `deviceLibrary.ts` / `.web.ts` | The device's library over expo-sqlite (a failed open is retried, never cached); the web twin keeps expo-sqlite out of the web bundle. |
| `sqliteShim.ts` | Tests only: localLibrary's `Db` over node:sqlite. |
| `*.test.ts` | Unit tests (mobile vitest) for the pure modules and hostStorage. |
| `build.mjs` | Pinned fork clone → esbuild IIFE (+ one per format reader) → `v2ReaderPage.generated.ts`. |
| `carrier.mjs` | The page shell (pure): CSP, nonce placeholder, `formatsJs` (readers as escaped strings), `html`. Tested by `carrier.test.ts`. |
| `v2ReaderPage.generated.ts` | **Generated, committed.** `v2ReaderPageHtml(nonce)`. Never edit by hand. |
| `repro.mjs` | Test-only entry: the page + `__fol.reproRenderDuringLoad` (the reproducer behind the fork's paginator fix). |
| `fixtures.mjs` | Writes crafted books to `fixtures/` (gitignored): `tsfonts.epub` (one font plain, IDPF-, Adobe-obfuscated), `tshostile.epub` (one row of `hostileVectors` per sandbox vector; `.mobi`/`.fb2` twins are written by the check), and `tsformat.{epub,mobi,fb2,fbz,cbz}`, `tsdrm.mobi`, `tskf8.mobi`, `tscombo.mobi`, `tsupper.cbz`, `tsutf16.fb2`, `tsformat.pdf`, `tscjk.pdf`, `tslocked.pdf` (and `hostilePdf`, written by the format check), every byte written by the file itself (MOBI6 and PDF by hand). Needs `zip`. |
| `kf8fixture.mjs` | The recipe for the committed **synthetic** KF8 books in `synthetic/` (#1182): Calibre `ebook-convert` over an original EPUB it writes (and over `tshostile.epub`), then `normalise()`; `SYNTHETIC` records each file's SHA-256, asserted by `formats.test.ts`. CI has no Calibre and only reads the committed files. See `synthetic/README.md`. |
| `sandbox.check.mjs` | The hostile-book check (see Sandbox). |
| `formats.check.mjs` | The format check (see Formats): one small book per format through the committed page in Chromium. |
| `pdfgate.mjs` | The ADR-032 PDF gate (#1128 S5): `node --experimental-strip-types pdfgate.mjs <corpusDir> [--map <file>] [--only 3,7]` opens every PDF under a directory through the committed page, one fresh page each (open, page 1 drawn and inked, `next` ×3, chosen `goTo` last page, save + reopen, text layer + selection, peak JS heap, longest main-thread task). Prints indexes (`pdf-NN`), size buckets, pass/fail and error classes only, never a name, path, title or text: the corpus is private and stays outside the repo. |
| `pdfPolyfills.mjs` | Runtime APIs pdf.js 5.5 calls that an older WebView lacks (S5 review), run first in the carried `pdf` reader; installed only where missing. |
| `frame.mjs`, `framePath.mjs` (+ `.d.mts`) | Web only (#1219, #1225): the page as a no-store shell + a content-hashed page script, and the one handler that serves both (dev, preview, the check; the build writes the same files for nginx). See Host responsibilities, "Web, its own document". `frame.test.ts` pins the split. |
| `prodCsp.check.mjs` | The production-CSP gate (CI): shell + script under the app CSP read from nginx; the refused variants; nginx's reader locations against the handler's headers. |
| `openTracker.mjs` (+ `.d.mts`) | Pure, both hosts: which page answer belongs to which open — the open in flight, a book the page kept on screen while a newer open failed, a stale `restored` (dropped). |
| `bigbook.mjs` | The large-book gate's fixture (ADR-029 Decision 6, R4): `node bigbook.mjs <in.epub> <out.epub> [MB=88]` pads a real EPUB to about MB MiB with PNG plates foliate renders. Needs `zip`/`unzip`; the output path is the caller's (put it in the gitignored `fixtures/`). |

## Build

```bash
pnpm -C apps/web build:v2-reader     # rewrite v2ReaderPage.generated.ts
pnpm -C apps/web check:v2-reader     # CI: exit 1 if it is stale or over budget (page or any format reader)
pnpm -C apps/web check:v2-reader-formats   # CI: every format opens as Formats says
node apps/mobile/src/lib/v2reader/build.mjs --repro   # + .vendor/v2ReaderPage.repro.html (test only)
```

- **foliate-js fork** `https://github.com/mrviduus/foliate-js` @ `b3386ef90b806dc3667941d9c26db12cce98b064`
  (branch `textstack-pin` = upstream `78914aef` 2026-05-01 + our commits, ADR-032), cloned into the gitignored
  `.vendor/`. Every build checks out the pin and resets the tree (`git checkout -- .`); an untracked file in
  that tree fails the build by name (delete `.vendor/` to rebuild from the pin). A bump is a PR that re-runs
  every ADR-029 Decision 6 check. Needs network (CI clones it too).
- **Fork commit** `d73682a` (was `patches/0001-paginator-render-while-loading.patch`): `Paginator.render()`
  returns while the current view has no `body` yet (a resize or attribute change during a section load threw).
  Offer it upstream; drop it on the bump that fixes it. Reproduce with the `--repro` page:
  `await __fol.reproRenderDuringLoad(20)` → `errors: 0` (without
  the fix it was 1–5 per 6 loads in Chromium, hundreds on Android).
- **Fork commits of #1182**, on top of `d73682a`, each to offer upstream:
  `fb60d58` mobi: KF8 resource blobs typed (`{ type: newType }`, was `{ newType }`: every CSS/image/font/SVG blob
  untyped, SVG images did not render); `ff826a7` mobi: KF8 section markup dispatched through `transformTarget`
  (the page's refresh-meta strip; it bypassed it); `40dd126` view: the view's `relocate` carries the renderer's
  `reason` (the save rule reads it, page.mjs); `2c6588e` pdf: a null outline destination returns null (upstream
  `ce10f08`); `b38d07c` pdf: nothing fetched or resolved at import time (`makePDF(file, { css, params })`,
  `isEvalSupported: false` forced; what lets the page carry it, Formats, PDF); `b3386ef` paginator: `setStyles`' frame callback
  does nothing once `destroy()` nulled the view (a book closed within a frame of a section load threw
  "reading 'document'"; predates #1182).
- esbuild comes from `apps/web` (no new dependency). Target `chrome90`, not the engine bundle's es2017: foliate
  uses private methods, static blocks and `\p{}` regexes. view.js's own format imports, PDF, TTS and search are
  stubbed out of the page; MOBI/FB2/CBZ/PDF come in as format readers (Formats).
- **Size:** the page script (unminified) is at most `BUDGET` characters in `build.mjs`, and each format reader
  at most its `FORMAT_BUDGET` entry: those constants are the one source for the numbers. Reader-engine's 64 KB
  budget does not apply; a budget is raised only by a deliberate PR.
- `BUDGET` is a tripwire by design, not a ceiling: it equals the committed size, so any growth fails `--check`
  until the PR that grows the page says so.
- **Licences** stay in the output (`legalComments: 'inline'`): foliate-js MIT © John Factotum; zip.js BSD-3-Clause;
  pdf.js Apache-2.0 (its notice opens with `@licstart`, which esbuild drops when minifying, so `build.mjs` restates
  it as a `/*! */` at the top of the PDF reader); pdf.js's cMaps BSD-3-Clause (Adobe), likewise.
- **Minified: the PDF reader only** (`MINIFIED` in `build.mjs`, `keepNames` because pdf.js reads
  `constructor.name`): 1,706,720 characters against 3,180,221 unminified (1,614,390 without `keepNames`). The
  other readers and the page stay readable; their budgets count unminified characters.
- The page imports only foliate, `packages/shared` (`tokenizeVocabWords`) and `packages/reader-engine`
  (`rangeToLocator`, `chapterText`, `offsetOf`, `sentenceAround`). Nothing from `apps/`.

## Formats

#1128, ADR-029 as amended for all formats. The page routes a file by its **bytes** (`formats.mjs`), never by name:
the Android host stages and retains every format as `*.epub`, the web host opens a `blob:` URL.

| Format | Detected by | Reader | Text features |
|---|---|---|---|
| EPUB | zip with `META-INF/container.xml` | the page's own (`EPUB` + our SHA-1) | all |
| MOBI (MOBI6) | `BOOKMOBI` at byte 60, header version < 8 | fork `mobi.js` + `vendor/fflate.js` | all |
| AZW3 (KF8); a MOBI/KF8 combo as its KF8 half | `BOOKMOBI`, header version ≥ 8; or EXTH 121 → a MOBI header | the same | all |
| FB2 / FBZ | `<FictionBook` in the first 4 KiB (UTF-8 or UTF-16) / zip with a `.fb2` | fork `fb2.js` | all |
| CBZ | zip with images, no container, no `.fb2` | fork `comic-book.js` (fixed layout) | **none** |
| PDF (#1128 S5; **dev hosts only**, below) | `%PDF-` in the first KiB, after zip, KFX and MOBI, never in a book or page of markup (an FB2 root in the FB2 window, `<html`/`<!doctype html` in the first KiB); junk before the header that starts with `<` (a server's HTML warning) is still a PDF's | fork `pdf.js` + pdf.js v5.5.207, on the page's main thread | word tap and selection; **no** highlights or translation label (`annotatable: false`) |
| KFX, other | `\xeaDRMION\xee`, anything else | refused with `open-failed` | — |

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
  (like a failed read, #1168): a DRM, damaged KF8, entity-declaring FB2 or unknown file answers `open-failed` and the
  book on screen keeps reading, saving and its telemetry session.
- **The open order** (#1128 S5). Two counters: `openSeq`, the latest open attempt (only ever goes up), and
  `viewSeq`, the view on screen (turns over at the swap, never earlier). An open: sniff (a refusal touches
  nothing) → `++openSeq` → hash → **make** the book (`makeBookFor`: the zip read, the MOBI/FB2 parsed, the PDF
  document loaded) → **swap** → `view.open`/`init` → `opened`. Until the swap the book on screen is fully the
  open one: its relocates are reported and saved, its `goTo`/`next`/`restore` run and answer (every listener
  and queued call is stamped with `viewSeq`). A build swaps in only if it is still the latest attempt.
  - *A failed or refused make touches nothing:* a PDF that needs a password ("this PDF is password-protected…":
    the cheap check, an `/Encrypt` dictionary, cannot tell it from the common owner-password-only PDF that opens
    fine), a broken PDF, a book with no sections ("this PDF has no pages" / "this book has no sections"), an
    FBZ's inner FB2 with entities: `open-failed`, and the book on screen keeps reading, saving and its telemetry
    session. A failure after the swap (foliate's `view.open`/`init`) still replaces the book.
  - *A book swapped in answers `opened` while it is still the view on screen*, even if a newer open is under
    way (that one may yet fail before its swap; the book would otherwise stay on screen unanswered and
    unrestorable). The hosts keep such an answer aside (`openTracker.mjs`) and take it if the newer open fails.
  - *What is destroyed when* (each book's own `destroy()`; `view.close()` does not call it): the replaced book
    at the swap; a build superseded by a newer open, before it could swap in; a build with no sections; a PDF
    load that fails (its pdf.js loading task: `makePDF` keeps none, so the page takes it from `getDocument`,
    which `makePDF` calls before its first await).
  - *The flush:* at the swap a save still debounced (400 ms) for the book on screen is written at once, under
    that book's own key (`saves.flush()`), before anything of the new book exists: a turn made just before
    another book opens is kept, and never written under the new book.
- **DRM:** a MOBI or KF8 whose PalmDOC `encryption` is non-zero (record 0, and a combo's KF8 header too), and any
  KFX, answer `open-failed` with "…DRM-protected…". A `BOOKMOBI` too short for what is read is "truncated or
  damaged", never DRM. EPUB DRM is not detected here (foliate fails on the encrypted content).
- **KF8 (AZW3)** is read by the fork's KF8 reader since the #1182 pin (typed resource blobs, sections through
  `transformTarget`). Evidence is **synthetic only**: Calibre-made books from original text (`synthetic/`,
  `kf8fixture.mjs`); nothing shows real-world Kindle files open (Amazon's tools, retail, fixed layout, fonts,
  RTL). Before teardown, `sniffFormat` requires the KF8 header's SKEL and FRAG indexes to be `INDX` records
  ("truncated or damaged" otherwise): foliate fails on a missing one only inside the open, after the open book
  is gone. That checks the magic only; an index damaged past it still fails inside foliate's reader
  (`open-failed`; whether before or after the swap depends on where foliate reads it, not checked).
- **Combo files** (MOBI6 record 0 + an EXTH 121 KF8 boundary) are read as their **KF8 half**, foliate's own choice
  (CSS, its TOC; one code path with AZW3); a boundary at no MOBI header falls back to MOBI6 inside foliate. Cost,
  accepted because V2 is dev-only with no users: a combo stored before #1182 by its MOBI6 half has other section
  indexes and CFIs, so its saved position fails the quote check and the book restores to the start.
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
- **PDF (#1128 S5): the V2 page only.** The page is reachable from the dev hosts alone (Android `__DEV__` route,
  web `/dev/reader-v2` on the dev server); **the ADR-012 pdf.js viewer remains the production PDF reader** and is
  untouched. **The ADR-032 PDF gate is NOT complete**: its evidence is desktop headless Chromium only
  (`pdfgate.mjs`, `formats.check.mjs`); no Android System WebView or device row has been run.
  - *Where pdf.js's worker runs:* on the page's main thread. The PDF reader's IIFE evaluates `pdf.worker.mjs`
    first, which sets `globalThis.pdfjsWorker`; pdf.js then uses it as a "fake worker" and never constructs a
    `Worker` nor `import()`s a URL. Why: the CSP is `script-src 'nonce-…'` only — a real Worker needs
    `worker-src blob:` (or a served file), a widening this slice does not make. **No CSP change.** The price is
    parsing and rendering on the UI thread: a heavy page stalls input. Its cost on a device is **not measured**.
  - *Nothing fetched:* `isEvalSupported: false` (forced by the fork; the CSP refuses eval anyway), `useWasm: false`,
    no URL for anything. pdf.js's predefined cMaps ride in the page as their own carried chunk (`pdfcmaps`,
    base64, `PdfCMaps` in page.mjs), run the first time a PDF's font names one: without them a CJK font on a
    predefined cMap draws a blank page. pdf.js never runs a PDF's JavaScript here (its scripting sandbox is not
    shipped). A link annotation goes through `external-link` → `openLink`, http(s) only, as in an EPUB (a GoToR to
    an http file spec is handed the same way, as pdf.js makes it a URL); Launch and `javascript:` never are.
  - *Layout and position:* one page per screen (`rendition.spread = 'none'`: inside a two-page spread a step shows
    the other page without a relocate, so the saved page would be the spread's first). Position
    `{ page, index, fraction, at }`, `page` = section index + 1, the `pdf-page` locator (ADR-031,
    `packages/shared` `isPdfPage`), **never a CFI**. The save rule, `hostMoving`, `chosen` and arrival hold as for
    any fixed layout (arrival by spread; with `spread = 'none'` one page each). The scheme fits the file (`fits`
    in page.mjs, beside the server's `SyncValidation.FitsFile`): on a PDF a CFI or a fraction-only position is
    neither restored nor gone to (`wrong position kind, stayed at start`), and a page number never on another
    format. Sync: `positionWrite(…, format)` writes `pdf-page {"page":N}` only for a `pdf` file and never
    `epub-cfi` for one; `statePosition(state, format)` reads `pdf-page` and, on a PDF, nothing else (no
    `textstack-*` fraction fallback).
  - *Capabilities:* `opened.textual` is `true` (word taps answer `word`, with `cfi: null`; the text layer
    selects) and `opened.annotatable` is `false`: `highlightSelection()` is refused with a `warn` and
    `showTranslation()` ignored. A PDF highlight is a `pdf-page` anchor (page + rects) and the fixed-layout
    renderer has no overlayer: **highlights and the translation label are not built**. The web dev host hides
    its Highlight button and asks for no label; the Android dev host offers neither for any format yet.
  - *Known gaps:* **JPEG 2000 images are not drawn** (accepted: pdf.js decodes them with OpenJPEG wasm, which
    needs `'wasm-unsafe-eval'`); the rest of such a page draws. **Standard fonts fall back to system fonts**
    (standard-font data is not carried); glyph shapes on Android may differ, positions come from the PDF.
    **UI-thread parsing cost is not measured on devices.** The fork's text-selection fix (`selecting` class)
    targets Firefox; selection was **verified in Chromium only** (desktop, mouse/script, no long-press). A
    password-protected PDF is refused (see above), not opened with a password. A hostile PDF can burn CPU or
    memory on the UI thread (a freeze, not an escape): **a decompression bomb freezes the main thread** (no
    guard: 1 MB → 12 s on desktop); bounding it needs the fork's PDF reader to pass pdf.js a stream/image size
    cap (or parse in a real Worker), not a page change. **Links on a page are lost when that page has a Named
    action, a ResetForm or an attachment link:** pdf.js's annotation layer calls `linkService.getAnchorUrl`,
    which the fork's `pdf.js` link service lacks, so the layer throws and draws none of that page's links;
    the fork's link service needs `getAnchorUrl` (and the other no-op methods pdf.js calls).
    Found by the S5 review, not fixed (fork work): **visited pages are never released** (the fork's `makePDF`
    caches every rendered page's `blob:` document, never revokes the URLs nor calls `page.cleanup()`); **the
    fork's `render()` is not idempotent**: each zoom/resize callback renders into the same text and annotation
    layers again, duplicating spans and links (`formats.check.mjs` known-bug line: 2 → 4 spans on one
    resize); **the PDF's bytes are held 2–3 times** (the page's read buffer, the `File` made of it, pdf.js's own
    chunks); **the outline is resolved serially before `opened`** (foliate's TOC progress awaits every entry);
    **the page takes pdf.js's loading task from `getDocument`** because `makePDF` keeps none, which depends on
    `makePDF` calling it before its first await (the fork should destroy its own task on failure); **three
    copies of the page-driving harness** (`formats.check.mjs`, `sandbox.check.mjs`, `pdfgate.mjs`).
  - *Older WebViews:* the pdf.js 5.5 modern build calls `Map`/`WeakMap.prototype.getOrInsertComputed`,
    `Promise.withResolvers`, `Promise.try`, `AbortSignal.any`, `Uint8Array.prototype.toHex`/`toBase64`,
    `Uint8Array.fromBase64`, `ArrayBuffer.prototype.transferToFixedLength`, `URL.parse`, `Array.prototype.findLast`,
    `.at()` and async iteration of `ReadableStream`; esbuild's target lowers syntax, not APIs.
    `pdfPolyfills.mjs` stands in for those (checked: they are deleted and the PDF still opens and draws).
    `structuredClone` (pdf.js's main-thread worker clones every message with it) is not polyfilled: without
    it the open answers `open-failed` "this WebView is too old to read PDF", before the swap. Not polyfilled
    either, on paths this page does not take: `Response.prototype.bytes` (fetching), `DecompressionStream`
    (guarded by pdf.js). pdf.js's two layer stylesheets use **native CSS nesting** (`&.highlighting`,
    `&:hover`, …): a WebView older than Chrome 112 drops those nested rules (selection highlight and link
    hover looks), not the layers. No device has been run. The PDF vectors are checked in `formats.check.mjs`
    under the real CSP only, not under `sandbox.check.mjs`'s per-directive mutations: they are pdf.js and
    foliate behaviour, not the CSP's doing.
- **Refresh metas:** EPUB and KF8 sections pass through `transformTarget`; MOBI6 has none, so the page wraps its
  `createDocument`. FB2 and CBZ sections are rebuilt by foliate from whitelisted elements / one `<img>`.
- **Hostile input:** every reader runs inside the same page and CSP. The sandbox check opens a hostile MOBI (the
  EPUB's HTML vectors), a hostile KF8 (the EPUB converted by Calibre, committed) and FB2 (an external image)
  beside the EPUB; the format check refuses a nested
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
(the dev route's origin), opens `tshostile.epub`, `.mobi`, `.fb2` and `tshostile-kf8.azw3` (Formats) through `__fol.openUrl` and exits 1 if any vector gets through: a
book script ran (`__pwned` in any frame), a request reached its logging server (a free local port), a sibling file of
the EPUB was read, `<base>` took effect, a refresh meta survived the page's strip, or the section frame left the
book. It then removes or widens one directive at a time and must catch the vectors that directive stops, so a check
that cannot fail fails itself. Every vector in `fixtures.mjs` declares how it is observed (`mark`, `request`,
`probe`, `sandbox`) and which directive `stops` it; the check refuses to start (exit 2) when the two files disagree.
Each page call is bounded (10 s; a timeout is an escape) and the whole check has a 3-minute deadline (exit 1 with the
partial table).

The hostile KF8 is committed (CI has no Calibre): `kf8fixture.mjs` converts `tshostile.epub` written with
placeholder addresses (`HOSTILE_KF8`), uncompressed, and the check swaps them byte for byte for this run's server
and sibling directory (same lengths: a 5-digit port, a working directory padded to 200 characters; every
occurrence must be found). It carries the EPUB's vectors except `KF8_DROPPED` (sandbox.check.mjs): what Calibre's
conversion removed, so no mutation can show them in it.

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
16+ chars, and the placeholder itself (it fits that rule, so a page "filled" with it would run any script
carrying it). The host supplies a fresh random nonce per load; on the web, whoever serves the frame document fills
it per response (Host responsibilities, "Web, its own document").

## Host ↔ page contract

The host injects calls as fire-and-forget JS (`injectJavaScript('window.__fol.…;true')`); the page answers with
`window.ReactNativeWebView.postMessage(JSON)`. Order: `ready` → `openUrl` → `opened` → host calls
`restore(stored)` → `restored`. The page sends no `store` before `restored`.

**Host → page** (`window.__fol`)

| Call | Does |
|---|---|
| `openUrl(url, name)` | Reads the retained book by XHR (`file://…`) and opens it, whatever its format (Formats). Answers `opened` or `open-failed`. A second call supersedes the first, which then answers nothing. |
| `restore(json \| null)` | The answer to `opened`: the JSON last sent in `store` for that `book.sha256`, or null. Its position may be fraction-only, `{ fraction, at }` (a transitional `textstack-*` server locator, #1187), or a PDF page `{ page, index, fraction, at }`. Ignored (a `warn`) unless the view on screen is the one that answered `opened` (not one still opening); answered for the book on screen even while a newer open is being made. Takes its slot in the navigation queue when called: a `goTo` sent after it runs after it. |
| `addHighlights(list)` | Highlights the host learned after `restore` (the web host draws the server's when their pull lands, #1226): each drawn where its text still is (the restore check), added to the entry, not saved (the host holds them). The reader is not moved. Queued behind the restore. Ignored where `annotatable` is false. |
| `highlightSelection()` | The last non-empty selection becomes a highlight; sends `store` and `highlighted`. Ignored on a CBZ and a PDF (`annotatable: false`). A selection with no text (an image) or over 4000 UTF-16 units (`SyncLimits.MaxSelectedText`) is ignored with a `warn` log. |
| `goTo(target, chosen = false)` | A position as stored (CFI + quote, CBZ page, PDF page `{ page }`, or fraction-only `{ fraction, at }` with 0 the text start), a CFI, an href or a section index; an object that is no valid position, or a position that does not fit the book (a CFI or fraction on a PDF, a page number elsewhere; a raw CFI string on a PDF too), or a PDF page past the book's end, is ignored with a `warn`. Queued behind the previous navigation; an open supersedes every queued or in-flight one. Not `chosen` (the host moving the view: a sync adopt or move): nothing is saved and no `store` is sent, the host already holds that position; a position target becomes the entry's own. `chosen` (the reader's own choice: a taken offer): the place it landed on is saved (one `store`), built exactly as a relocate's save. One that did not arrive changes nothing and logs a `warn`. |
| `section(±1)`, `next()`, `prev()` | Section / page step, queued. |
| `font(delta)` | Font size ±px, clamped 12–32; returns the new size. No-op before `opened`. |
| `flow('paginated' \| 'scrolled')` | foliate layout; default `paginated` (ADR-029 Decision 1). Switches the open book in place (no reload, position kept). Before `opened` it sets what the next open uses: hosts send the reader's stored setting right after `ready`. Anything else is ignored with a `warn`. |
| `showTranslation(cfi, index, text)` | The answer to `word`: draws `text` above that word. Ignored where `annotatable` is false (CBZ, PDF). |

**Page → host** (`{ type, … }`)

| `type` | Fields | Host does |
|---|---|---|
| `ready` | — | may call `openUrl` |
| `opened` | (Also for a book swapped in while a newer open is under way: see Formats, the open order.) `book {sha256, size, name}`, `format` (`epub`/`mobi`/`fb2`/`cbz`/`pdf`), `textual` (false: no word taps, hide translation and vocabulary), `annotatable` (false: hide highlight and the translation label; CBZ and PDF), `reflowable` (false: disable the flow toggle), `title`, `author` (either may be `''`), `sections`, `toc [{label, href}]` | calls `restore` with the stored JSON for `book.sha256` |
| `open-failed` | `name`, `error` (shown as is: unreadable, unsupported format, DRM, password-protected PDF) | must not keep the file |
| `restored` | `key` (= the book's `sha256`, as `store`'s: a host drops one for a book it is not reading), `found`, `rejected`, `position` (`none` / `restored` / `restored by fraction` / `quote mismatch, stayed at start` / `page not found, stayed at start` (CBZ, PDF) / `wrong position kind, stayed at start` (a CFI or fraction on a PDF, a page number elsewhere) / `navigation failed, stayed at start`), `highlights [{id, status}]` | — |
| `store` | `key` (= `book.sha256`), `json` | keeps `json` under `key`, verbatim |
| `relocate` | `index`, `sections`, `fraction`, `toc`, `cfi` | progress UI |
| `word` | `index`, `word`, `sentence`, `cfi` (null where `annotatable` is false), `rect {x, y, w, h}` (host viewport) | translates, then `showTranslation` (not without a `cfi`) |
| `tap` | — | a tap not on a word (chrome toggle) |
| `highlighted` | `id` (v4 UUID), `cfi`, `quote` (first ≤64 code points), `selectedText` (the full selection) | — |
| `openLink` | `href` | the page forwards only `http(s)` links and the host allowlists again before opening: a stated rule, not an accident. Any other scheme is dropped with a `warn` log (`mailto:`/`tel:` noted on #1069); the page never navigates |
| `telemetry` | `event: 'reader-flow'`, `mode` (the flow in use), `format`, `switchedInFirst5Min` | one per opened book, 5 min after `opened` or when the next book opens first (a page that dies earlier sends none). Hosts log it: there is no analytics pipeline in the app yet |
| `log` | `level`, `msg` | `error`: window errors and a failed open or restore. `warn`: a call that was ignored (a highlight or a restore before the book is ready) and a previous book that would not close. foliate logs its own navigation failures to the console, not here — a position that did not land is reported in `restored` instead. |

A stored position or highlight is applied only while the text at its CFI still reads as its saved quote
(`foldText`; a highlight compares its `selectedText`, or its `quote` if stored before #1078); otherwise it is reported in `restored` and left out, never drawn elsewhere. Stored items with no
quote at all are dropped when the entry is read. A fraction-only position (#1187) has no CFI or quote to
check: it lands approximately (the legacy fraction counts words, foliate's bytes); fraction 0 (never read
on the other device) is not navigated to at all, the text start `opened` already shows. A fraction that
did not arrive (foliate's goTo resolves with its target either way, so the renderer is asked) is reported
as `navigation failed, stayed at start`. One outside [0, 1] is dropped when the entry is read.

**The save rule** (any book, any restore): a `relocate` saves the position only when the reader moved —
foliate's reason for it is not `'anchor'` (re-laying the page out: a resize, a `font` or `flow` change)
AND its CFI differs from the previous relocate's (foliate relocates again where it already is: after a
landing, and the snap of every touchend) AND the host is not moving the view (from `openUrl` until its
restore has run, and during a non-`chosen` `goTo`). So opening a book, a restore and a sync adopt or
move never save (nor rewrite the server's transitional locator as a CFI); the first page turn, swipe,
scroll, `next`/`prev`/`section` or followed link does, and so does coming back to the landed place after
one. A text book whose pages carry no text position (a pre-paginated EPUB: foliate's fixed-layout
renderer reports no range) saves no position at all, a taken offer included. For a fixed-layout book a
target in the spread already shown counts as arrived (foliate shows it without a relocate). `highlightSelection()` before `restored` is ignored with a
`log` of level `warn`: there is no entry to add to yet, and saving then would overwrite the stored one.

## Host responsibilities

- A **fresh random nonce per load** into `v2ReaderPageHtml(nonce)`; the length check is not an entropy check, so the host picks the source of randomness (R2).
- **Keep every `store` payload** under its `key`, and hand back to `restore` an entry the page accepts. The web dev host keeps it verbatim; the web production host keeps it on the server (#1226); the Android host (R6) splits it into SQLite rows (`localLibrary.ts`) and rebuilds it — same position, same highlights (only those in this file version, none tombstoned). Lower-case hex keys: `sha256()` emits lower case and the key is compared byte for byte.
- **Serialise library writes.** `library.mjs` is pure; two concurrent imports writing `library.json` can still lose one (web dev host). The Android host runs every row write on one queue.
- The R2 host passes its file path (`staging/<ts>.epub` or `books/<sha256>.epub`) as `openUrl`'s `name` to match each answer to its open, so the page's stored `book.name` is that path until the contract gains an explicit open id (#1069).
- **Sync (R6, Android):** opportunistic, never on the reading path: with a session, on screen open, on each book open and 10 s after a save. ADR-019 needs the host's view of the open book (restored yet, the first CFI after the restore, the one now, the spine index from `relocate`); a newer position from another device is gone to (`adopt`/`move`) or offered (`prompt`). File sync is a per-device setting, off by default.
- `<documents>/v2/` is not yet counted in Device Storage nor wiped on sign-out (#1070): local books belong to the device until the owner decides otherwise; a sign-out forgets what the server told that identity, never unpushed rows.

**WebView, dev route only** (prototype host; ADR-029 Decision 4 until the R4 security review):
`source={{ html: v2ReaderPageHtml(nonce), baseUrl: <app documents dir> }}`, `allowFileAccess`,
`allowFileAccessFromFileURLs`, `originWhitelist={['*']}`. The `file://` origin lets the page read the retained
file itself, so no book bytes cross the bridge. Universal file access stays off.

**Web, its own document** (#1219, production route #1225): `frame.mjs` splits the page into two files under
`/reader-v2/` (paths: `framePath.mjs`):

- **the shell**, `/reader-v2/frame.html` (1,332 bytes): the page's head (its meta CSP), the host shim inline, and
  `<script src="/reader-v2/page.<hash>.js" integrity="sha384-…">`, all under one nonce placeholder
  `%V2_READER_FRAME_NONCE%`. It fails closed: `%` is outside the CSP nonce grammar, so a shell served unfilled has
  no valid script source and runs nothing (not the shim, not the page script, not a script carrying the
  placeholder). Sent `no-store` with a fresh nonce per response (16 random bytes, hex, nginx's `$request_id`;
  `fillNonce` takes nothing else) and its own headers (`V2_READER_FRAME_HEADERS`: `frame-ancestors 'self'`,
  `no-store, no-transform`, nosniff, `no-referrer`, `X-Robots-Tag: noindex`).
- **the page script**, `/reader-v2/page.<first 16 hex of its SHA-384>.js` (3,656,316 bytes; 1,644,100 gzipped):
  the page's one script, byte for byte what the inline page runs, sent `public, max-age=31536000, immutable`,
  `text/javascript; charset=utf-8` (it is not ASCII), nosniff. A book open fetches the shell only; the script
  comes from the HTTP cache (ADR-029 Decision 4 as amended 2026-11-11). The format readers stay inside it as
  strings and run as inline scripts under the same nonce, which page.mjs reads from `document.currentScript`
  (an external script has it too; the check opens a MOBI to prove it). `integrity` pins the script to the shell
  that names it: a swapped file is refused, not run under the nonce.

`serveV2ReaderFrame` is the one handler: the Vite dev server (from source) and `vite preview` (from the built
`dist/reader-v2/`, `v2ReaderDistFiles`, so CI's e2e runs what nginx ships) through plugin `v2-reader-frame`, which
loads frame.mjs on the first `/reader-v2/` request, and the check use it; any other path under `/reader-v2/` is a 404,
never the SPA. A production build writes the same two files to `dist/reader-v2/` (`v2ReaderFrameFiles`), the
shell unfilled; nginx fills it (`location = /reader-v2/frame.html`, `sub_filter … $request_id`) and serves the
script (`location ~ ^/reader-v2/page\.[0-9a-f]{16}\.js$`, server-level headers, `$cache_immutable`).
`apps/web/scripts/assert-no-dev-reader.mjs` fails the build unless `dist/reader-v2/` is exactly those two files
(the name is the hash, the shell pins it) and no other file carries the page code or the dev route.

One host component, `apps/web/src/components/reader/V2ReaderHost.tsx`, serves the dev route (`/dev/reader-v2`, a
picked file, dev server only) and the production route (`/:lang/library/my/:id/read-v2`, behind `Features:V2Api`:
the current file's bytes from `/me/v2/books/{id}/files/{fileId}/content`, transferred). It embeds the shell with
`<iframe sandbox="allow-scripts allow-same-origin" src>`, checks every message's source and origin, tracks opens
with `openTracker.mjs`, and shows an error when no `ready` arrives within 10 s. Reader data: localStorage on the
dev route (keyed on the route, `dev`); on the production route the server only (#1226,
`apps/web/src/lib/v2ReaderSync.ts`, one session per open). `restore` gets the server's reading state as the
entry's position; the book's annotations (this file version's, live) follow by `addHighlights` when their pull
lands. Each `store` is diffed against what the server is known to hold (`entryChanges`,
`packages/shared/src/reader/v2PageEntry.ts`, the mapping `localLibrary.ts` uses; twins only within one file
version) and written with the expected revisions. No position is written before the reading state has been
read (a failed read is retried on the next `store`; a late read adopts the server's place when it is provably
newer, ADR-019 "nothing restored"). Conflicts: own write = success; `stale_revision`/`reset` written once more
on their revision (this tab wins, owner 2026-11-11; the ask UI is #1232); an annotation re-applied once,
then the server's kept and the page's form not sent again until it changes; a tombstone wins; `id_conflict`
re-keyed once. Terminal: `file_replaced`/`unknown_file`/`book_not_found` stop the session's writes ("reopen"
line); `invalid_payload`/`chapter_not_found`/400/422 drop that write until it changes. Online-first, no outbox:
a failed write stays a difference, retried on the next `store` and when the tab hides; `pagehide` sends what is
left by keepalive (position first, highlights within a 60 KB budget); a "not saved" line until it lands. A new
take or leaving the route closes the session after one last pass; a reopen of the same book reads after it.
Bytes that are not the server file's are not synced. The one local exception: a CBZ page position (no server
form yet, #1188) is kept in this browser per book. The shim posts to `self.origin` only and takes messages from `parent` at that origin
only; the frame is same-origin with its host, so that is the host's origin. **Android keeps the inline page**
(`v2ReaderPageHtml(nonce)`): nothing here changes it.

Not `srcdoc`, measured (`prodCsp.check.mjs`): a srcdoc document inherits the app's CSP (`infra/nginx/textstack.conf`)
on top of its own, and the app's `script-src` refuses the page's nonce'd scripts, so the page never sends `ready`;
the same document as srcdoc under a host without CSP works (the `srcdoc-control` row), so the CSP is the reason.
Making srcdoc work took five app-wide additions (measured on the experiment branch, `exp/v2-reader-prod-csp`) (a per-response script nonce; `blob:` in `connect-src`, the
`openUrl` read; in `frame-src`, the section frames; in `style-src` and `font-src`, a book's CSS and fonts). As its
own document the page carries only its own policy, and the app needs `frame-src 'self'` plus a location that sends
the frame's headers itself (nginx drops server-level `add_header` there, #857, and those carry `frame-ancestors
'none'` and `X-Frame-Options: DENY`). Still one origin: a script past the page CSP reaches the app through `parent`
(`docs/01-architecture/v2-reader-web-hosting.md`).

```bash
pnpm -C apps/web check:v2-reader-prod-csp   # CI, ~15 s: shell + script work under the app CSP read from nginx (EPUB, fonts, MOBI); srcdoc, header-less, foreign-framed, unfilled, un-nonced script and tampered script do not; nginx's reader locations send the handler's headers
```
