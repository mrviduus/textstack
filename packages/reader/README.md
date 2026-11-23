# Shared reader

Shared book renderer, host protocol and browser checks for the web and Android apps.
Source and tests live in `src/`. Build with `pnpm --filter @textstack/reader build`;
check the committed bundle with `pnpm --filter @textstack/reader check`.

Mobile-only storage, SQLite, sync and WebView version checks remain in
`apps/mobile/src/lib/reader/` (from the repository root). Their entries below describe
those mobile adapters. The Android host stays in `apps/mobile/src/components/reader/`;
the web host stays in `apps/web/src/components/reader/`.

The page that renders a local EPUB, MOBI/AZW3, FB2, CBZ or PDF (see Formats) in the V2 reader's WebView ([ADR-029](../../docs/architecture/adr/ADR-029-foliate-for-v2-epub.md)).
foliate-js parses and renders the book; our code adds word tap, the inline translation label, highlights and
the reading position. Slice R1 of [v2-plan.md](../../docs/internal/v2/v2-plan.md) §7: the page
and its build only. Hosted by `ReaderScreen.tsx` (R2): in production on the reader route `app/my-books/read/[bookId]/…` when V2 is on (M5 #1031); the dev route `app/dev/epub.tsx` (its library list) is hidden from production Metro, see metro.config.js.

| File | What |
|---|---|
| `page.mjs` | Runs in the WebView. The whole adapter: routing a file to its reader, our EPUB loader (SHA-1 for obfuscated fonts), the format-reader runner, the navigation queue, word tap, translation label, highlights, save/restore by CFI + quote (a PDF by page), `meta refresh` stripped, flow + its telemetry. |
| `formats.mjs` | Which reader a file goes to, from its bytes (pure): zip → EPUB/FBZ/CBZ by entry names, `BOOKMOBI` → MOBI6/KF8 (DRM, truncated and KF8 without its indexes refused; combo → KF8 half), FB2 root (UTF-16 re-encoded, entities refused), `%PDF-` in the first KiB → PDF, KFX/unknown refused; CBZ page names and types. |
| `clip.mjs` | Pure, page only (owner decision 5): an HTML clip as a one-section foliate book (`clipBook`): the bytes parsed with DOMParser, the body sanitized (`sanitizeClip`: an element allowlist, other elements unwrapped, script/style/frames/objects/forms/svg/math removed whole, attributes allowlisted, `href` only `http(s):`/`mailto:`/`#`, an image only with a `data:image/` src (the CSP's `img-src blob: data:`), any other becomes its alt text, comments removed; decoded as UTF-8, the only encoding clips are stored in), copied into a fresh document with a declared charset, served as a `blob:` URL. The CSP is unchanged: this is the second wall. `clip.test.ts`. |
| `store.mjs` | Reader data shape (v1), one entry per book **file** (SHA-256 + size); the quote fold; pure-JS SHA-256 / SHA-1. |
| `tap.mjs` | What a tap hands the host: the word's sentence (text.ts `sentenceAround`) and an external link, only if `http(s)`. For a selection (#1268): its range without edge whitespace (`trimRange`) and its sentence (`sentenceOfRange`, element points too, never throws). `rectInPage`: a box in a section frame as the page viewport shows it, the fixed-layout renderer's `scale()` of a pre-paginated page included (`word` and `selection`). |
| `text.ts` | A section as text, DOM only (moved from the retired reader engine at M6): `textNodes`, `rangesIn`, `rangeToLocator` (a highlight's quote, as every stored anchor), `matchWords`, `blockOf`, `sentenceAround` (TR-1), `SELECTION_SETTLE_MS`. |
| `lightbox.mjs` | #1265: the image lightbox, in the page's own document: `imageAt` (the tapped `<img>` or SVG `<image>`, its `blob:`/`data:` source and alt), `clampPan` / `zoomAt` (pure: zoom about a focus, pan kept on screen), `createLightbox` (the overlay dialog: pinch, wheel and double-tap zoom, drag to pan, Tab kept, Escape and its close button). |
| `selection.mjs` (+ `.d.mts`) | Pure, page and both hosts (#1268): the `selection` message's builder (`selectionMessage`) and the hosts' validator (`readSelection`), with the caps they share; the text cap and its cut are `packages/shared`'s (`MAX_SELECTED_TEXT`, `clip`). The format check bundles it with esbuild first: plain node does not resolve `packages/shared`'s extensionless imports. |
| `describe.mjs` (+ `.d.mts`) | #1426, page and both hosts (bundled, it imports packages/shared): the page's `bookMeta` (foliate's metadata as `{ title, author, lang, description }`: a language map's value in the UI language else its first, every author joined with ", ", the language's primary subtag, the description's HTML parsed inert by DOMParser and kept as text; caps 500 / 500 / 35 / 4000) and `coverJpeg` (the cover blob through `createImageBitmap` onto a canvas, long side ≤ 800 px, JPEG q0.85, q0.6 once if over 1.5 MB, else none); the hosts' validator `readDescribed`, in `readSelection`'s style (the same caps; a cover only as a `data:image/jpeg;base64,` URL of at most 2 MB decoded). |
| `chrome.mjs` (+ `.d.mts`) | Pure, page and both hosts (#1263, #1264): `navKey` (the page: which keydown becomes a `key` message, a closed list), the hosts' readers `readTap`, `readDir`, `readKey` in `readSelection`'s style, and `keyAction` (what a key does: `prev`, `next`, `bars`), the one rule both hosts follow; the host decisions `hidesBarsOnRelocate` and Android back's order `backAction` (Host responsibilities, "Reader chrome"). |
| `fonts.mjs` (+ `.d.mts`) | Applies the selected reading font to section text; preserves emphasis and code faces. |
| `settings.mjs` (+ `.d.mts`) | Pure, page and both hosts (#1260): the reading settings (size, family, line height, alignment, theme): defaults, the closed lists, `readChosen` / `readSettings` / `parseChosen` / `choose` (what a host stores and sends) and `settingsCss` (the section stylesheet the page injects). See "Reading settings". |
| `saveScheduler.mjs` | The debounced `store` message: key and payload are fixed when the save is asked for, so a save can never land on the next book; `flush()` writes a pending one at once (the swap) and returns the latest `store` (#1286); `forget()` at the swap drops it. |
| `overlays.mjs` | What is drawn over a range. foliate keys an overlay by its CFI, so a highlight, a saved word's mark (#1271) and a word's translation over the same range are one overlay carrying all of them. |
| `library.mjs` | V2 local library (pure): identical bytes → the existing entry, never a duplicate or reset. |
| `library.d.mts` | Hand-written types for `library.mjs` (apps/web type-checks it without `allowJs`); a change to one must update the other. |
| `hostStorage.ts` | The host's files under `<documents>/v2/` (R2): staging, retained `books/<sha256>.epub`; lower-cased keys. A picked file comes as the picker's own URI (no picker cache copy) and is copied straight into `staging/`; a failed copy (full disk) leaves no partial file (#1080 items 4–5). The `store` payload goes to the local library; R2's `library.json` + `store/<sha256>.json` are imported into it once (non-UUID ids remapped), then deleted; `library.json` and each store entry fall back to their `.tmp` when the target does not parse, and when neither parses both are renamed `.corrupt-<ms>` with a warning, never deleted or written over (#1081). |
| `localLibrary.ts` | R6 (#1038): SQLite database `textstack-v2` — `books`, `reading_state`, `annotations` (the page's position/highlight JSON per row, keyed by client v4 UUIDs), `reading_sessions` (#1313, until pushed), `vocabulary` (#1271: the reader's live saved words as the vocabulary feed last sent them, pull-only, what the marks read offline), `outbox` (one coalescing entry per row, `gen` per re-queue, `failures` per gen: any entry kept and skipped after N, reset every session and by "Try again" = `unpark`, #1186), `meta` (cursors, file-sync setting). The page's entry is rebuilt from rows on `restore` and split into rows on `store`, through `@textstack/shared`'s `pageEntry` (the web host's mapping too, #1226); the entry's shape and checks are `pageStore.ts` there (`store.mjs` re-exports them). Sign-out (#1070): `signOutLoss` and `wipe` / `wipeV2Library`, below. |
| `sync.ts` | R6: the sync client to `/me/v2/*` (PDD v2-sync-protocol.md): pull the library/reading/annotations feeds, push, then pull the vocabulary feed (#1271, its failure its own) by cursor, push the outbox in order, opt-in file sync (shared `uploadFile`), download on demand; conflicts per the PDD's codes, reading state by ADR-019 re-keyed on CFI + spine index; every answer under the shared `whileCurrent` epoch guard. |
| `deviceLibrary.ts` / `.web.ts` | The device's library over expo-sqlite (a failed open is retried, never cached) and its files: `v2Root()` (`<documents>/v2/`, the one definition: host, wipe, measure), `makeV2Dirs`, `clearV2Files` (the one place files are wiped: the root deleted and its three directories made again whenever it ran, so a half-failed call is retried whole), `deviceV2Bytes` (Profile's Device Storage; creates nothing), `deviceV2SignOutLoss`, `wipeDeviceV2Library`. The web twin keeps expo-sqlite out of the web bundle and mirrors every export. |
| `sqliteShim.ts` | Tests only: localLibrary's `Db` over node:sqlite. |
| `*.test.ts` | Unit tests (mobile vitest) for the pure modules and hostStorage. |
| `build.mjs` | Pinned fork clone → esbuild IIFE (+ one per format reader) → `readerPage.generated.ts`. |
| `carrier.mjs` | The page shell (pure): CSP, nonce placeholder, `formatsJs` (readers as escaped strings), `html`. Tested by `carrier.test.ts`. |
| `readerPage.generated.ts` | **Generated, committed.** `readerPageHtml(nonce)`. Never edit by hand. |
| `repro.mjs` | Test-only entry: the page + `__fol.reproRenderDuringLoad` (the reproducer behind the fork's paginator fix). |
| `fixtures.mjs` | Writes crafted books to `fixtures/` (gitignored): `tsfonts.epub` (one font plain, IDPF-, Adobe-obfuscated), `tshostile.epub` (one row of `hostileVectors` per sandbox vector; `.mobi`/`.fb2` twins are written by the check), and `tsformat.{epub,mobi,fb2,fbz,cbz}`, `tsdrm.mobi`, `tskf8.mobi`, `tscombo.mobi`, `tsupper.cbz`, `tsutf16.fb2`, `tsformat.pdf`, `tscjk.pdf`, `tslocked.pdf` (and `hostilePdf`, written by the format check), every byte written by the file itself (MOBI6 and PDF by hand). Needs `zip`. |
| `kf8fixture.mjs` | The recipe for the committed **synthetic** KF8 books in `synthetic/` (#1182): Calibre `ebook-convert` over an original EPUB it writes (and over `tshostile.epub`), then `normalise()`; `SYNTHETIC` records each file's SHA-256, asserted by `formats.test.ts`. CI has no Calibre and only reads the committed files. See `synthetic/README.md`. |
| `sandbox.check.mjs` | The hostile-book check (see Sandbox). |
| `formats.check.mjs` | The format check (see Formats): one small book per format through the committed page in Chromium. |
| `pdfgate.mjs` | The ADR-032 PDF gate (#1128 S5): `node --experimental-strip-types pdfgate.mjs <corpusDir> [--map <file>] [--only 3,7]` opens every PDF under a directory through the committed page, one fresh page each (open, page 1 drawn and inked, `next` ×3, chosen `goTo` last page, save + reopen, text layer + selection, peak JS heap, longest main-thread task). Since #1228 the file comes through a Playwright route, so its open timings include that transfer and are not comparable with the earlier file:// runs. Prints indexes (`pdf-NN`), size buckets, pass/fail and error classes only, never a name, path, title or text: the corpus is private and stays outside the repo. |
| `pdfPolyfills.mjs` | Runtime APIs pdf.js 5.5 calls that an older WebView lacks (S5 review), run first in the carried `pdf` reader; installed only where missing. |
| `frame.mjs`, `framePath.mjs` (+ `.d.mts`) | Web only (#1219, #1225): the page as a no-store shell + a content-hashed page script, and the one handler that serves both (dev, preview, the check; the build writes the same files for nginx). See Host responsibilities, "Web, its own document". `frame.test.ts` pins the split. |
| `prodCsp.check.mjs` | The production-CSP gate (CI): shell + script under the app CSP read from nginx; the refused variants; nginx's reader locations against the handler's headers. |
| `openTracker.mjs` (+ `.d.mts`) | Pure, both hosts: which page answer belongs to which open — the open in flight, a book the page kept on screen while a newer open failed, a stale `restored` (dropped). |
| `toc.mjs` (+ `.d.mts`) | Pure, both hosts (#1261): `readToc` (a host's read of `opened.toc`: malformed entries dropped, each kept one with its `index` in the page's list, the one `relocate.tocIndex` names; at most 5000 places, labels cut to 200, depth 0 to 6) and `tocAround` (the current entry and the nearest ones before and after that lead somewhere else, an entry with the current one's href being the same place: the contents dialog's mark, the title beside the percent, and the section controls, which go by title with `goTo(href, true)`; a host marks a chosen entry at once, since a jump within the view on screen may send no relocate, and clears the place where an open starts, since a book's first relocate comes before its `opened`). `withTitle` fills a label with a title as text. A book with no entries has no contents button and no section controls; no host shows a section number. |
| `chapters.mjs` (+ `.d.mts`) | The page and both hosts (#1316; bundled, it imports packages/shared): what a chapter is, ONE rule by the document's order (`placeOf`, `startsIn`: where each entry starts in its file, a file-level entry at the top, a dead anchor nowhere; `segmentsIn`, `fileSummary`, `hasContents`, `chapterKey`), its text (`textBetween`, a section document's text as paragraphs: text only, without page-break markers and what the markup hides; `fitText`, the server's 200 KB cap, `cut` said), and the hosts' reads `readChapterEnd` (of `relocate.chapterEnd` and `chapter-end`; the title cut never through a surrogate pair), `readChapterText` (of `chapter-text`) and `offersDiscuss` (not front and back matter by title, the legacy `isReviewableChapter`). See "Discuss this chapter". |
| `movedTracker.mjs` (+ `.d.mts`) | Pure, any host: the open book as ADR-019 sees it (`decideServerState`'s `reader`): restored yet, whether the reader moved since (the page's `relocate.moved`, never a CFI comparison; a host `goTo` clears it), the spine index of the last relocate, the opening one included (#1278). |
| `sessionTracker.mjs` (+ `.d.mts`) | Pure, both hosts (#1313): the reading session, the legacy readers' rules (starts on the first activity, time up to 3 min after the last, 5 min idle ends it, under 10 s not kept, at most 4 h), words read from `relocate` by the page's `relocate.cause` (`readRelocate`): `turn` counts the ground past the session's furthest place × `words` (at most 800 wpm of the counted time since the last counted step), `nav` (a navigation's landing) counts nothing and resets the baseline and furthest place, `layout` (anything else, the default) counts nothing and keeps the furthest place; whenever the seconds sent are fewer than the time counted, the words scale down with them. `open` / `bind` / `relocate` / `activity` / `tick` / `end`; an ended session is returned for the host to send. |
| `tapZone.mjs` (+ `.d.mts`) | Pure, both hosts (#1263): what a page `tap` does (turn back, turn on, toggle the bars). See Host responsibilities, "Reader chrome" and "Bars and tap zones, web". |
| `highlights.mjs` (+ `.d.mts`) | Pure, page and both hosts (#1312): the four colours (`HIGHLIGHT_COLORS`, the legacy readers'; `HIGHLIGHT_FILL` what the page draws; `colorOf`: one off the list, another client's, is drawn yellow), the page's `highlightList` (drawn ones, in book order by foliate's CFI compare, text cut to 200 code points; then the quotations, #1195: legacy `textstack-anchor-v1` annotations, `quotation: true`, `cfi` '', never drawn, never stored, no place to go: the hosts' lists show them, not as links), the hosts' readers `readHighlightList`, `readHighlightTap`, `readHighlightRemoved` in `readSelection`'s style, `noteOf` (a note as saved: trimmed, never cut: the server has no cap; blank is none) and `noteChange` (what a save writes: nothing when the draft is the note it was typed over). See Host responsibilities, "Highlights". |
| `bookmarks.mjs` (+ `.d.mts`) | Pure, page and both hosts (#1314): a bookmark is an entry highlight of colour `BOOKMARK_COLOR` (`packages/shared`, the one constant), never drawn. `bookmarkRange` (the range a bookmark keeps: from the first non-white-space character on screen, at most `BOOKMARK_TEXT` = 120 UTF-16 units of the book's text, never past the screen's end or inside a surrogate pair, no trailing white space) and `bookmarkText` (its text, as a label reads: a space between blocks and `<br>` lines), both over text.ts `textNodes` / `rangesIn` / `blockOf` (no script, style or noscript); `atTop` and `lineCount` (a bookmark is at the top of the screen, by the live layout), `startsWithin`; the page's `bookmark-list` builder and the hosts' reader `readBookmarkList`, on highlights.mjs's `listItems` / `readItems` (one list builder and one item reader for both). See "Bookmarks". |
| `search.mjs` (+ `.d.mts`) | Pure, page and both hosts (#1315): in-book search. `readQuery` (the query a host may send: one-spaced, at least 2 characters as `queryLength` counts them, 1 in a script written without spaces, at most 100 UTF-16 units), the page's `searchItems` (foliate's hits as `search-results` items, strings capped), the hosts' reader `readSearchResults` in `readSelection`'s style, the hosts' state `searchStart` / `searchTake` / `searchReset` / `searchOpened` (a new id per search; an older search's answer is dropped; nothing searchable from an open's start until its `opened`), the two status lines `searchStatusKeys`, `SEARCH_DEBOUNCE_MS`, `createSearchRenders` (streamed results on screen at most once per `SEARCH_RENDER_MS`), `MAX_RESULTS`, `SEARCH_FILL`. The one CFI check, `isCfi`, is `selection.mjs`'s (highlights use it too). See Host responsibilities, "In-book search". |
| `finishBook.mjs` (+ `.d.mts`) | Pure, both hosts (#1266): `showsFinishBook`, when the end-of-book block shows. See Host responsibilities, "Finish book". |
| `listen.mjs` (+ `.d.mts`) | Pure, page and both hosts (#1272): `ttsLang` (the book's language → the `lang` `/tts` is sent, the V2 reader on both hosts (the legacy readers keep their own): the primary subtag only, ISO 639-2 codes in both forms, `nb`/`nn`/`iw`/`in` and `tl` → `fil` folded, `und`/`mul`/`zxx`/`mis` to the fallback, never English for another language, null for Ukrainian), `TTS_SPEEDS` / `readSpeed` / `TTS_SPEED_KEY` / `createSpeedChoice` (Android's async store: a pick before the read wins), `createListener` (Listen's rule: it owns the phase), `speakingJs` (Android's injected call), `SPOKEN_FILL`. See Host responsibilities, "Listen". |
| `vocabSave.mjs` (+ `.d.mts`) | Pure, both hosts (#1270): `saveOutcome`, a vocabulary save's answer as the host shows it (saved, deleted → restore, pending, lookup); `savesWords`, whether a book's `opened.lang` lets its words be saved. See Host responsibilities, "Saving a word". |
| `wordMarks.mjs` (+ `.d.mts`) | Pure, page and both hosts (#1271): saved-word marks. `readMarkWords` (the page's read of `markWords`: word ≤ 200, gloss ≤ 500, at most 20,000; a stage off 0–4 is new), `STAGE_COLORS` (the legacy readers' five underlines), `wordMarksIn` (where words stand in a section, text.ts `matchWords` + `rangesIn`), `sameMark`; the gloss setting `readGlosses` / `withGlosses` (the legacy `showInlineTranslations`). See Host responsibilities, "Saved-word marks". |
| `vocabWords.mjs` (+ `.d.mts`) | Pure, DOM-free, both hosts (#1271): `langOf`, `ofBook` (a card is the book's language), `wordId` (key + language), `markWordsOf` (what a host sends), `backfillTranslations` (the once-per-open rule: serial writes, a 429 stops it, cancelled by the host). |
| `readerVocab.ts` | Android (#1271): `forBook`, `backfillable`, `answerRow` (the row a save's answer card makes: V2 cards only, `routeOf`; none for another user's), `ownsLibrary`, `serverTranslation`, `nudgeCount`. |
| `wordPopup.mjs` (+ `.d.mts`) | Pure, both hosts (#1269): `readWord` (a host's read of `word`, `readSelection`'s caps; the rect through `selection.mjs` `readRect`), `readLang` (`opened.lang` as a two-letter primary subtag, or null: a three-letter code gives the host's fallback), and `popupStep`: what a `word`, `tap`, `selection`, `selection-cleared` or a move does to the word popup / selection toolbar and to the tap zones. See Host responsibilities, "Word popup and selection toolbar". |
| `deadlines.mjs` (+ `.d.mts`) | Pure (setTimeout only), both hosts (#1227): the `ready` and `opened` deadlines and their calibration constants. See Host responsibilities, "Deadlines and states". |
| `hostErrors.ts` | Android host: a full disk (`ENOSPC`, `SQLITE_FULL`, quota) as one human message, `NotReadableError` as "could not be read", anything else as is (#1080 item 6). |
| `bigbook.mjs` | The large-book gate's fixture (ADR-029 Decision 6, R4): `node bigbook.mjs <in.epub> <out.epub> [MB=88]` pads a real EPUB to about MB MiB with PNG plates foliate renders. Needs `zip`/`unzip`; the output path is the caller's (put it in the gitignored `fixtures/`). |

**Sign-out and identities** (#1070; owner 2026-11-12: V2 books belong to the account, PDD "Sign-out, account deletion, quota"). The library's owner is `meta.account` plus `meta.account_guest` (a guest or not, from `capabilitiesFor(user).isGuest`); `identityStep` (`localLibrary.ts`) is the one decision:

| Stored owner vs the user | Sign-in (`claimV2LibraryFor`, AuthContext) | A sync pass (`sync.ts` `account`) |
|---|---|---|
| nobody (never synced, or wiped) | nothing | `claim`: the user takes it, rows included |
| the same user | nothing (kept) | go on (a guest promoted in place is recorded as an account) |
| a guest | nothing (carried) | `carry`: `forgetServerState` (the server's knowledge goes; own rows and queue go to the user); normally `adoptV2LocalAccount` did it first |
| another real account | wipe, the loss logged with the counts (bounded, 5 s) | refused: nothing pulled, pushed or recorded; never a wipe |

- *Sign-out* (Profile → `createAccountSignOut` in `profileActions.ts`; the row is busy meanwhile, a second tap joins the first): one push of the outbox in its own slot, no pulls (`pushV2BeforeSignOut`, `SIGN_OUT_SYNC_MS`), then `signOutLoss` (bounded, `V2_LOSS_CHECK_MS`); anything lost → a confirm with the counts; a check that fails or times out → a generic confirm (fails closed). Then AuthContext `signOut` bumps the epoch and runs `wipeDeviceV2Library` under a 5 s deadline (a failure or a late wipe only warns: the owner stays, so another account's passes are refused and its sign-in wipes).
- *The wipe* (`wipeV2Library`): rows, the owner included (every table, one transaction, on the library's queue: a write queued before it is wiped with it), then files (`clearV2Files`: the root deleted and the three directories made again, whenever it ran). A failed row wipe stops before the files.
- *Sign-in* (`claimV2LibraryFor`): `signInWithTokens` (before the guest adoption), a guest mint, and a restored session at start (not awaited; retries a wipe that failed or ran late). Before the session's user is set; needs no server.
- *Late rows*: a pass asked before a session change is dropped unrun (`syncV2Library` keeps the asker's epoch); an open whose session ended before its row was queued is refused and its moved file removed (`createV2Storage`'s `sessionSince`). Rows added with no session belong to nobody until the first pass claims them.
- *Saved words* (#1271): the `vocabulary` rows are wiped with the rest and never counted: a pull-only copy of the server's.
- *What `signOutLoss` counts*: a device book unless the server holds this very file with its bytes (never pushed, file sync off, replaced, bytes removed, book removed there); changes of books not counted: queued positions and highlights, and own highlights the server never took and nothing will send (over the cap, dropped after a refusal). *Not counted*: a fraction-only position (the server's own), an edit of an already-synced highlight dropped after a refusal. The warning is a lower bound for those.

## Build

```bash
pnpm -C apps/web build:reader     # rewrite readerPage.generated.ts
pnpm -C apps/web check:reader     # CI: exit 1 if it is stale or over budget (page or any format reader)
pnpm -C apps/web check:reader-formats   # CI: every format opens as Formats says
node packages/reader/src/build.mjs --repro   # + .vendor/readerPage.repro.html (test only)
```

- **foliate-js fork** `https://github.com/mrviduus/foliate-js` @ `686afc4200006874a24071a6a57510e027a4cc32`
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
  "reading 'document'"; predates #1182); `73d4259` paginator: `afterScroll` does nothing once `destroy()` nulled
  the view (the scroll listener's 250 ms debounce fired after a book closed in scrolled flow, #1291); `fe04665`
  paginator: `#justAnchored` keeps the scroll offset an anchored relocate left and swallows a debounced scroll only
  while the container still sits there (it swallowed the reader's next scroll: one continuous scroll right after a
  jump sent no `relocate`, #1297); `686afc4` search (#1315): `view.search` takes a `limit` (matching, registering
  and drawing stop at it; none: as before), each hit carries the contents entry it is under (`label`), a section
  that throws is skipped and reported (`{ index, error }`), and `makeExcerpt` keeps the middle of a hit over three
  or more text nodes.
- esbuild comes from `apps/web` (no new dependency). Target `chrome90`, not the engine bundle's es2017: foliate
  uses private methods, static blocks and `\p{}` regexes. view.js's own format imports, PDF and TTS are
  stubbed out of the page; MOBI/FB2/CBZ/PDF come in as format readers (Formats). The fork's `search.js` is in the
  page since #1315 (`view.search`).
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
- The page imports only foliate, `packages/shared` (`tokenizeVocabWords`) and its own `text.ts`
  (`rangeToLocator`, `textNodes`, `blockOf`, `sentenceAround`; moved from the retired reader engine at M6).

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
| HTML clip (owner decision 5) | never by bytes: the host passes the server's file format (`openUrl(url, name, 'html')`; web `openBytes(bytes, name, format)`); markup without it is refused as before | `clip.mjs` (one section, sanitized) | all |
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
- **A refusal leaves the shown book intact.** `sniffFormat` runs before the open book is closed
  (like a failed read, #1168): a DRM, damaged KF8, entity-declaring FB2 or unknown file answers `open-failed` and the
  book on screen keeps reading, saving and its telemetry session.
- **The open order** (#1128 S5). Two counters: `openSeq`, the latest open attempt (only ever goes up), and
  `viewSeq`, the view on screen (turns over at the swap, never earlier). An open: `++openSeq` → read → sniff →
  hash → **make** the book (`makeBookFor`: the zip read, the MOBI/FB2 parsed, the PDF
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
  entry name, checked on restore (`store.mjs`), synced as `page-name` (#1188). Page names are
  handed to foliate with lower-case extensions (`comicName`: it keeps `.jpg`, never `.JPG`), each name once, and
  each page blob is typed by its extension (an untyped SVG is no image). `opened.reflowable` is `false`: `flow()`
  changes nothing on a fixed layout, is not counted as a switch, and the hosts disable their toggle.
- **PDF (#1128 S5): the V2 page only.** The page is reachable from the dev hosts alone (Android `__DEV__` route,
  web `/dev/reader` on the dev server); **the ADR-012 pdf.js viewer remains the production PDF reader** and is
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
    layers again, duplicating spans and links (2 → 4 spans on one resize); **the PDF's bytes are held 2–3 times** (the page's read buffer, the `File` made of it, pdf.js's own
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
pnpm -C apps/web check:reader-formats   # needs Chromium (playwright install chromium)
```

## Sandbox

The section iframes are `sandbox="allow-same-origin allow-scripts"`, so the page CSP is the only script barrier
(ADR-029 Decision 4; changing a directive is a change to that ADR):

```
default-src 'none'; script-src 'nonce-__V2_READER_NONCE__'; style-src blob: 'unsafe-inline'; img-src blob: data:;
font-src blob: data:; media-src blob: data:; frame-src blob:; connect-src blob: data:; form-action 'none'; base-uri 'none'
```

That is the page as built and the web frame's. The Android page (`readerAndroidPageHtml`, #1228) differs in
`connect-src` only: `blob: data: https://appassets.androidplatform.net/v2/books/ https://appassets.androidplatform.net/v2/staging/`,
the two directories its interceptor serves (`bookOrigin.mjs`) and nothing above them. No `file:` on either host, so
even a script that got past the nonce reaches no app file.

**The hostile-book check** (ADR-029 Decision 6) loads the committed page under the Android host's origin in Chromium
(`bookOriginRoute.mjs`: Playwright routes `https://appassets.androidplatform.net/` with the interceptor's own rule,
`bookOrigin.mjs` `servedFile`; no file access), opens `tshostile.epub`, `.mobi`, `.fb2` and `tshostile-kf8.azw3` (Formats) through `__fol.openUrl` and exits 1 if any vector gets through: a
book script ran (`__pwned` in any frame), a request reached its logging server (a routed `https://evil.tst:44443`: an http
server from an https page is stopped by mixed content, not by the CSP), a sibling file of the book in the served
directory was read, `<base>` took effect, a refresh meta survived the page's strip, or the section frame left the
book. It then removes or widens one directive at a time and must catch the vectors that directive stops, so a check
that cannot fail fails itself. Every vector in `fixtures.mjs` declares how it is observed (`mark`, `request`,
`probe`, `sandbox`) and which directive `stops` it; the check refuses to start (exit 2) when the two files disagree.
Each page call is bounded (10 s; a timeout is an escape) and the whole check has a 3-minute deadline (exit 1 with the
partial table). After the real-CSP EPUB run, **scope rows** fetch from the page's own script, as one that got past
the nonce would: the served book must load (the positive control); a path outside the served directories, a store
entry, an encoded slash, a dot segment (plain and encoded), a query, a `file:` URL and another origin must be
refused (by the CSP or the interceptor's 404).

The hostile KF8 is committed (CI has no Calibre): `kf8fixture.mjs` converts `tshostile.epub` written with
placeholder addresses (`HOSTILE_KF8`), uncompressed, and the check swaps them byte for byte for this run's server
and sibling directory (same lengths: the evil URL is 22 characters, the served directory's URL is padded to 200
with `/.` segments, which every URL parse drops; every occurrence must be found). It carries the EPUB's vectors except `KF8_DROPPED` (sandbox.check.mjs): what Calibre's
conversion removed, so no mutation can show them in it.

**What it proves, and where:** the CSP and the serving rule, in desktop headless Chromium, with the interceptor
emulated by a Playwright route. Not the Android System WebView, the Java interceptor or the bridge patch
(`loadDataWithBaseURL`, `content:`/`intent:` URLs): the emulator run of #1228 (`docs/internal/v2/
v2-reader-android-bytes.md`) and R4 (#1036) run those on the device. The format check and the PDF gate use the same
route (lenient on fixture names).

```bash
pnpm -C apps/web exec playwright install chromium   # once
pnpm -C apps/web check:reader-sandbox            # real CSP holds, every mutation is caught
node --experimental-strip-types packages/reader/src/sandbox.check.mjs --mutate=base-uri   # one mutation: exits 1
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
can carry); `readerPageHtml(nonce)` fills the CSP and the script tag and rejects anything but base64/hex of
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
| `openUrl(url, name)` | Reads the book by XHR (Android: the host's served URL, `bookOrigin.mjs`; web: a `blob:` URL) and opens it, whatever its format (Formats). Answers `opened` or `open-failed`. A second call supersedes the first, which then answers nothing. |
| `restore(json \| null, more = false)` | The answer to `opened`: the JSON last sent in `store` for that `book.sha256`, or null. Its position may be fraction-only, `{ fraction, at }` (a transitional `textstack-*` server locator, #1187), or a PDF page `{ page, index, fraction, at }`. Ignored (a `warn`) unless the view on screen is the one that answered `opened` (not one still opening); answered for the book on screen even while a newer open is being made. Takes its slot in the navigation queue when called: a `goTo` sent after it runs after it. `more` (#1314): the host says more annotations follow by `addHighlights` (the web host's pull): until that call has finished, `bookmark-list.can` is false and `addBookmark` is refused, so no twin of a bookmark still coming is made. |
| `addHighlights(list)` | Highlights the host learned after `restore` (the web host draws the server's when their pull lands, #1226): each drawn where its text still is (the restore check), added to the entry, not saved (the host holds them). The reader is not moved. Queued behind the restore. Ignored where `annotatable` is false. Answered by `highlights`, then `highlight-list`. A bookmark in the list (#1314) is kept, not drawn; a quotation (#1195, `quotation: true`) is listed (`listed`), never drawn nor stored, and a `removeHighlight` of it only drops it from the list (no `highlight-removed`). An empty list is a call too: it ends the wait `restore(json, true)` began. Answered also by `bookmark-list` (`can` false at the call, as it stands at its end). |
| `highlightSelection(color = 'yellow')` | The live selection becomes a highlight in `color` (#1312: one of `HIGHLIGHT_COLORS`; any other is refused with a `warn`), settled or not, on screen or not, described exactly as a `selection` message for it would be (#1268: its range and text, edge whitespace dropped; the same refusals); with no live selection (a host's button press may collapse it first), the last `selection` sent. Ends the selection at once as `clearSelection` does (`selection-cleared` if one was sent: a tap on the new highlight right after is its `highlight-tap`, never the selection's dismissal), then sends `store`, `highlighted` and `highlight-list`. A range that is exactly a drawn highlight's (its CFI) adds none: it is that highlight, recoloured if the colour differs, and `highlighted` names it (#1312 review: a second one over it would own the taps while the hosts' diff took it for the first's twin). Ignored on a CBZ and a PDF (`annotatable: false`). A selection with no text (an image) or over 4000 UTF-16 units (`SyncLimits.MaxSelectedText`) is ignored with a `warn` log. |
| `recolorHighlight(id, color)` | #1312: a highlight drawn here takes `color` (one of `HIGHLIGHT_COLORS`): redrawn, saved (`store`), `highlight-list` sent. A colour off the list, an id not drawn here (another book's, one not drawn for its text, one removed), or before `restored`: ignored with a `warn`. The same colour again: nothing. |
| `removeHighlight(id)` | #1312: a highlight drawn here leaves the entry and the screen (a translation label over the same range stays), saved (`store`), then `highlight-removed` and `highlight-list`. Refused as `recolorHighlight` is. The entry's absence alone is never a delete (`entryChanges` reads a missing highlight as nothing): the host tombstones on `highlight-removed`. |
| `addBookmark()` | #1314: a bookmark at the place on screen: the first words there (`bookmarkRange`) and their CFI, kept in the entry as a highlight of colour `bookmark` with `selectedText` = `bookmarkText` (no context, never drawn), saved (`store`), then `bookmark-list` with it as `here`. Refused with a `warn`: before `restored`; while bookmarks are still being placed (a restore or an `addHighlights` running, or `restore(json, true)` still waiting for its `addHighlights`); where there is no text to keep (`annotatable` false, a pre-paginated EPUB, an image-only or blank screen); where the place being read has a bookmark (`here`: no duplicate, no twin). A bookmark further down the screen does not refuse it. |
| `removeBookmark(id)` | #1314: that bookmark leaves the entry, wherever in the book it is (the hosts' toggle passes `here`, their list rows their own id), saved (`store`), then `highlight-removed` (the hosts tombstone it exactly as a highlight: one kind of row) and `bookmark-list`. An id that is no bookmark of the entry (a highlight's, one removed, another book's): ignored with a `warn`. `recolorHighlight` and `removeHighlight` ignore a bookmark's id (it is not drawn). |
| `goTo(target, chosen = false)` | A position as stored (CFI + quote, a named page `{ cfi, page, index }` of a CBZ or pre-paginated EPUB, found by `page` only, PDF page `{ page }`, or fraction-only `{ fraction, at }` with 0 the text start), a CFI, an href or a section index; an object that is no valid position, or a position that does not fit the book (a CFI or fraction on a PDF, a page number elsewhere; a raw CFI string on a PDF too), or a PDF page past the book's end, is ignored with a `warn`. Queued behind the previous navigation; an open supersedes every queued or in-flight one. Not `chosen` (the host moving the view: a sync adopt or move): nothing is saved and no `store` is sent, the host already holds that position; a position target becomes the entry's own. `chosen` (the reader's own choice: a taken offer): the place it landed on is saved (one `store`), built exactly as a relocate's save. One that did not arrive changes nothing and logs a `warn`. |
| `section(±1)`, `next()`, `prev()` | Section / page step, queued. |
| `settings(raw)` | #1260: the whole reading settings object, `{ fontSize, lineHeight, fontFamily, textAlign, theme }`, read in the page through `readSettings` (settings.mjs): `fontSize` a number, rounded and clamped 14–28; `lineHeight` one of 1.5 / 1.6 / 1.65 / 1.8; `fontFamily` `serif` / `sans` / `dyslexic`; `textAlign` `book` (the book's own: no rule of ours) / `left` / `center` / `justify`; `theme` `light` / `sepia` / `dark`. A missing field, a value off its list or of another type is that field's default (20, 1.6, `serif`, `book`, `light`); anything that is not an object is all defaults; unknown fields are ignored. Applied live: the open book is restyled where it is (a re-layout: `relocate.moved` false, nothing saved). Before `opened` it sets what the next open uses: hosts send the reader's stored settings right after `ready`, and again on every change. Returns the settings in effect. A fixed-layout book takes the theme on the page around it and nothing else. See "Reading settings". |
| `font(delta)` | Font size ±px: `settings` with only the size changed (clamped 14–28); returns the new size. Kept for the format check's re-layout rows; no host calls it. |
| `flow('paginated' \| 'scrolled')` | foliate layout; default `paginated` (ADR-029 Decision 1). Switches the open book in place (no reload, position kept). Before `opened` it sets what the next open uses: hosts send the reader's stored setting right after `ready`. Anything else is ignored with a `warn`. |
| `flush()` | #1264: a `store` still debounced (a page turn's, 400 ms) is written now; nothing pending, nothing sent. Hosts call it on background, unmount and close. The page also flushes by itself when its document turns hidden (`visibilitychange`: a tab switch, the app backgrounded) and on `pagehide`. **Returns** the latest `store` message (`{ type, key, json }`: the pending one, now posted, or the last one sent; `null` before any, and after a new open until the reader moves: the swap forgets it): #1286, the web host calls it synchronously (the frame is same-origin) where a posted `store` comes too late — its own `pagehide` (the page's is a postMessage to a window that is unloading) and its unmount (a layout cleanup, while the frame is still in the document; the message listener is gone after). The host reads the value as an untrusted `store` (`readStore`: each field once, strings only, the synced book's key) inside a try: any failure is today's behaviour. The session takes it without a pass on `pagehide` (the keepalive write is the one write) and joins it to its last pass on close; the same payload posted again later is no change. Android ignores the value. |
| `showTranslation(cfi, index, text)` | Draws `text` above that word (the web dev route's stub label only; no host draws a translation yet). Ignored where `annotatable` is false (CBZ, PDF). |
| `markWords(words, show)` | #1271: the reader's saved words, `[{ word, stage, gloss }]` (read through `readMarkWords`: a malformed item dropped), and whether their glosses show (the reader's setting). Replaces the list held, kept across opens. The section on screen is marked again at once (a mark no longer wanted removed, an unchanged one left, every one with a gloss redrawn when `show` changed); every other section is marked when it loads (`create-overlay`), never the whole book, and a section that left keeps no marks. Each occurrence by the vocabulary key (whole words, any case, a phrase before its words), underlined in its stage's colour (`STAGE_COLORS`), its gloss above it as SVG text only. Keyed by the occurrence's CFI: one over a highlight's or a tapped translation's range is that overlay (a removed highlight keeps the mark; a word no longer sent keeps the highlight). A tap on a marked word is still its `word`. Ignored where `annotatable` is false. |
| `markedWords()` | Test-only (no check reads it any more): how many saved-word marks the page holds, a count and no book data. |
| `speaking(cfi, index)` | #1272: the host speaks that range (a `word`'s or `selection`'s CFI and section): underlined in `SPOKEN_FILL` (listen.mjs), the previous one removed (one at a time), kept over section reloads; a highlight or label over the same range stays (one overlay). `speaking(null)`: the speech ended or stopped, the mark goes. Saves nothing, sends nothing. Ignored with a `warn` where `annotatable` is false (a PDF word has no CFI) or for a value that is no range CFI (over 1024 chars, a non-integer index). Returns true when drawn. A new open drops it. |
| `drawnRanges()` | Test-only (no check reads it any more): how many drawn highlight ranges the page holds, a count and no book data. The ranges of a section no longer loaded (its frame gone) are dropped when a section's overlayer is made and on every tap (#1312 review). |
| `clearSelection()` | #1269: the host is done with the selection (its toolbar closed after Copy, a translation or explanation closed): removed from every shown section, `selection-cleared` sent at once if a `selection` was sent (none otherwise), and `highlightSelection()` has no last selection to fall back on. |
| `search(query, id)` | #1315: searches the open book for `query` (through `readQuery`) and answers in `search-results` messages carrying `id` (the host's own safe integer). Ends the search running, if any (that one answers no more), and removes the hits it drew. `search(null)`, or a query that is none: only that, nothing answered. Every hit is drawn in its section until then. See "In-book search". |
| `closeLightbox()` | #1265: the image lightbox closes (Android back, a host Escape with focus outside the frame), `lightbox` closed sent. None open: nothing sent. |
| `labels({image, close})` | #1267: the lightbox's two words in the reader's language, sent by both hosts on every `ready` (the page has no i18n): `image` names the dialog of an image with no alt text, `close` its close button. Through `lightbox.mjs` `readLabels`: a non-blank string up to 200 characters, else the word held (English until the first call). The next opening takes them; sends nothing. |
| `chapterText(request, tocIndex, section)` | #1316: the text of one chapter, answered with one `chapter-text` under the host's `request` id (a string of 1 to 64 chars; anything else gets no answer): contents entry `tocIndex` (its index in `opened.toc`) from its start to the place before the next entry that leads somewhere else, wherever the file boundary is (over every linear section between, and into the next entry's file up to its anchor); or, in a book with no contents (the page's rule: no entry leads anywhere) only, spine section `section`. Read from the book's own section documents (not the screen), text only, in paragraphs, at most 200 KB as UTF-8 (the server's cap on a share; longer is cut at a paragraph and says `cut`). `unavailable` for an entry whose anchor its file does not have when an earlier entry leads into the same file (it cannot be told from that one). No answer when another book opened meanwhile. |
| `describe(id, url = null)` | #1426: the book's details and cover, answered with one `described` under the host's `id` (a string of 1 to 64 chars; anything else gets no answer, a `warn`). With `url` (a served file, as `openUrl`'s), a book of its own is made from the file (sniffed as an open is) and destroyed after: no open is superseded, the view is not touched. Without, the book on screen. Web: the frame shim's `describeBytes(blob, id)` posts the File itself (a Blob is cloned by reference) and calls `describe(id, <its blob: URL>)`; `apps/web/src/lib/describeBook.ts` runs it in a hidden frame on upload. Both hosts call it without `url` after a signed-in, online `opened` to fill in a book still on revision 1 (shared `fillBookMeta`). |

**Page → host** (`{ type, … }`)

| `type` | Fields | Host does |
|---|---|---|
| `ready` | — | may call `openUrl` |
| `opened` | (Also for a book swapped in while a newer open is under way: see Formats, the open order.) `book {sha256, size, name}`, `format` (`epub`/`mobi`/`fb2`/`cbz`/`pdf`), `textual` (false: no word taps, hide translation and vocabulary), `annotatable` (false: hide highlight and the translation label; CBZ and PDF), `bookmarkable` (#1314: a bookmark can be made somewhere in this book: text at a CFI; false on a CBZ, a PDF and a pre-paginated EPUB, where a host offers no bookmark control unless the book holds bookmarks already), `reflowable` (false: disable the flow toggle), `dir` (`ltr` / `rtl`, #1263: the direction the renderer pages in, `pagedDir`: a fixed layout by the book's page-progression direction (EPUB spine, MOBI/KF8 EXTH 527), a reflowable book by its shown section's own direction as foliate's paginator reads it (`dir` attributes, else the computed `direction`, which foliate sets from the book's language); unknown is `ltr`; `relocate` carries it too), `title`, `author` (either may be `''`), `lang` (#1269: the book's first metadata language as written, at most 35 chars, or `''`; hosts read it through `readLang`), `sections`, `toc [{label, href, depth}]` (flat, in reading order; `depth` 0 = top level, #1261), `searchable` (#1315: true where the book has section documents to search; false on a CBZ and a PDF; hosts offer search only for strictly `true`) | calls `restore` with the stored JSON for `book.sha256` |
| `open-failed` | `name`, `error` (shown as is: unreadable, unsupported format, DRM, password-protected PDF) | must not keep the file |
| `restored` | `key` (= the book's `sha256`, as `store`'s: a host drops one for a book it is not reading), `found`, `rejected`, `position` (`none` / `restored` / `restored by fraction` / `quote mismatch, stayed at start` / `page not found, stayed at start` (CBZ, pre-paginated EPUB, PDF) / `wrong position kind, stayed at start` (a CFI or fraction on a PDF, a page number elsewhere) / `navigation failed, stayed at start`), `highlights [{id, status}]` | — |
| `highlights` | `key` (= the book's `sha256`), `highlights [{id, status}]` (`restored` / `quote mismatch, not drawn` / `already drawn` / `not a highlight`) | the answer to `addHighlights`; a host logs the ones not drawn |
| `store` | `key` (= `book.sha256`), `json` | keeps `json` under `key`, verbatim |
| `relocate` | `index`, `sections`, `fraction`, `toc` (the current entry's label), `tocIndex` (its index in `opened.toc`, or null: labels repeat, so a host marks the current entry by this), `cfi`, `dir` (as `opened`'s, for the section now shown), `sectionEnd` (the book fraction where the shown section ends) and `words` (the book's length in words, estimated from the shown section: its words over its share of the book, so it shifts between sections; null for CBZ and PDF; #1262, for a host's time left), `atEnd` (the end of the book is on screen: the end of its last linear section, in a fixed layout that section's spread; #1266, hosts never derive it from `fraction`), `chapterEnd` (#1316: the chapter whose end is on screen, `{ tocIndex, section, title }`, or null; `tocIndex` is the entry's index in `opened.toc` and `title` its label, both null in a book with no contents (no entry of them leads anywhere: the page's rule, hosts do not re-derive it), where the spine section is the chapter; it may name the entry BEFORE `tocIndex`'s, since foliate names an entry current as soon as its start shows; the end is the chapter's last drawn line being on screen (geometry, not foliate's visible range, which runs past the screen over text that is not drawn); null for a chapter with nothing to read, while the page does not know yet (then said by `chapter-end`), and always on a CBZ, a PDF and a fixed layout; hosts read it through `readChapterEnd` and never derive it from `fraction`, `tocIndex` or their own contents list), `moved` (the reader moved the place: the save rule's own test, below — not a re-layout by resize, rotation, `settings` (`font`) or `flow`, not the same place again, not the host moving the view (an open until its restore, a non-`chosen` `goTo`); a host's `prev()`/`next()` counts as the reader's), `cause` (#1313, what moved the place, for a host's reading session: `turn` the reader's own turn — a swipe, a scroll, a tap or key turn, `prev()`/`next()`, across a section in paginated flow (foliate reports that with the reason a jump has, so the page decides from the navigations it made itself; scrolled flow's crossing is foliate re-anchoring the next section, `layout`); `nav` the landing of a navigation — `openUrl`/`restore`, a `goTo` chosen or not, `section()`, a followed link in the book (the page follows it through its own chain); the open itself until its restore lands, unless the reader acts first (a press, the wheel, a key, a touch, a turn: a restore that never comes does not make the visit a navigation); a navigation of a closed view, or one (not a restore) still unsettled after 15 s, no longer counts; `layout` anything that did not move the place (the same CFI, whatever asked for it) and, outside a navigation, a re-layout; hosts read it through `readRelocate`, anything else is `layout`). In scrolled flow the first scroll after a jump or an anchored re-layout is the reader's move (fork `fe04665`, #1297) | progress UI; hosts keep the latest `dir` (`readDir`) for the arrow keys |
| `word` | `index`, `word`, `sentence`, `cfi` (null where `annotatable` is false), `rect {x, y, w, h}` (page viewport, `rectInPage`) | through `readWord` (#1269): `popupStep` opens its popup, or turns the page for a word on an edge in paginated flow (Host responsibilities, "Word popup and selection toolbar"). A later `selection` supersedes it (below, taps and selections) |
| `tap` | `x`, `y` (#1263: where it landed, page-viewport px, the space of `word.rect`; a scaled fixed-layout frame mapped as `rectInPage` does) | a tap not on a word, an image book's every tap, and a tap on the page's own document (the paginator's margins and outer columns, beside a letterboxed fixed-layout page; only once a book is on screen): the host decides edge (turn) or centre (chrome toggle) from `x`, `y`. Hosts read it through `readTap` (numbers within ±100,000 px, else dropped). A tap that dismisses a selection, wherever it lands, sends no `tap` (below) |
| `pointer-move` | none | A mouse (`pointerType` `mouse`, never touch) moved over the page's document or a section's, at most one per 250 ms. The web host on a fine pointer shows its bars and hides them again 3 s after the last move (never while the pointer or focus is on a bar); there a click in the book turns no page (no tap zones: the footer's arrows and the keys turn). Android ignores it (no case for it) |
| `key` | `key` (`ArrowLeft`, `ArrowRight`, `PageUp`, `PageDown`, `Space`, `Escape`), `shift`, `repeat` (the key is held) | #1263: a navigation key pressed in a section document (its own frame) or in the page's own document (where focus falls when foliate replaces the focused section). Only those keys; never with Ctrl/Alt/Meta; never an arrow with Shift (it extends a selection); only when pressed on the document itself (its `body` or root), so a focused control, link, `summary`, media, field or editable part of the book keeps its keys. The page prevents their default, so the frame does not move by itself. No other key is ever sent. Hosts read it through `readKey` (a key off the list, `shift` or `repeat` not a boolean: dropped), drop repeats (one press, one turn) and act by `keyAction` with the latest `dir`: `prev`/`next` turn the book; `bars` (Escape) does nothing until the bars land |
| `selection` | `index`, `text` (the selection as rendered, `Selection.toString()`: blocks and a PDF's lines apart; edge whitespace dropped; at most 4000 UTF-16 units, `MAX_SELECTED_TEXT`, a longer one cut there by `clip`), `cfi` (the CFI of the range without its edge whitespace, the scheme highlights use; null where `annotatable` is false, where `highlightSelection` would refuse it (its DOM text over 4000: source whitespace the screen collapses counts), when the text was cut, or past 1024 chars), `sentence` (≤1000; the sentence around that range in its start's block, `sentenceAround`), `rect {x, y, w, h}` (the part of that range's box inside the page viewport, a scaled pre-paginated frame included, either flow) | #1268. Sent once the selection stops changing for text.ts `SELECTION_SETTLE_MS` (220 ms; a drag is one message), and again when it moved: after every `relocate` (a page turn, the re-layout of a `font` or `flow` change), scroll of the renderer and window resize, only if the message differs; its text, CFI and sentence are computed once per range, a move recomputes the box only. One selection at a time: a new one in one shown section document removes the one in another (a spread), and one timer reads every shown document (`getContents()`). A selection with no text (whitespace, an image), or with no part inside the page viewport (a page turned or scrolled away from it), is none. Not on a CBZ. Hosts take it only through `readSelection` (`selection.mjs`), which adds `tooLong` (over 500 UTF-16 units, text.ts `SELECTION_MAX_CHARS`, the translate/TTS cap) itself: a wrong type, whitespace-only text, a string over its cap, a CFI of another scheme, an index over 100,000, a non-finite coordinate, \|x\| or \|y\| over 100,000 px, w or h negative or over 100,000 px drops the whole message, never throws; only the known fields are kept. Opens the selection toolbar (#1269) |
| `selection-cleared` | — | the selection last sent is gone: dismissed by a press (at once, below), collapsed, its section frame gone (a fixed-layout page turned away), its box off the page viewport, or the book replaced (sent at the swap, before the new book's `opened` or `open-failed`) |
| `highlighted` | `id` (v4 UUID), `cfi`, `quote` (first ≤64 code points), `selectedText` (the full selection), `color` | — |
| `highlight-list` | #1312: `key` (= `book.sha256`), `highlights [{id, cfi, color, text, at}]`: the highlights drawn on screen (a stored one whose text no longer reads at its CFI is not), in book order (foliate's CFI compare; a tie by `at`), `text` its first 200 code points, at most 5000. Sent after `restored`, `addHighlights`' answer, `highlightSelection`, `recolorHighlight` and `removeHighlight` | through `readHighlightList` (a malformed item dropped): the host's list, the jump target (`goTo(cfi, true)`) and the editor's text. Untrusted: shown as text only |
| `highlight-tap` | #1312: `id`, `rect {x, y, w, h}` (the highlight's box, `rectInPage`), `x`, `y` (where the tap landed, `tap`'s space). A tap on a drawn highlight (its rects hit-tested, before the word): no `word` or `tap` then | through `readHighlightTap`: `popupStep`'s `highlight` event (a word's edge rule; elsewhere its editor). Dropped with no book on screen (`takenWithoutBook`) |
| `highlight-removed` | #1312: `key`, `id` (a highlight's, or a bookmark's after `removeBookmark`, #1314) | through `readHighlightRemoved`: the host tombstones it (web: the session's `DELETE`; Android: the row's `deleted_at` + outbox) |
| `bookmark-list` | #1314: `key` (= `book.sha256`), `bookmarks [{id, cfi, text, at}]` (the entry's bookmarks whose text still reads at their CFI, in book order, `text` the first 200 code points, at most 5000; built when the set changes, not per relocate), `here` (the id of the bookmark the place being read has, or null: see "Bookmarks"), `can` (a bookmark can be made here **now**: false while a restore or an `addHighlights` is placing bookmarks, and after `restore(json, true)` until its `addHighlights` has finished). `placing` (#1314 review: bookmarks are still being placed, so `can` false says nothing about this screen yet). Sent after a restore begins and ends, when `addHighlights` is called and when it ends, after `addBookmark`, `removeBookmark`, a jump to a bookmark and every `relocate` (after its position save; a failure there is logged and stops nothing), only when something in it changed | through `readBookmarkList` (malformed items dropped, `here` only if listed): the host's button adds (`can`) or removes (`here`), its list jumps with `goTo(cfi, true)` and removes with `removeBookmark(id)`. Hosts follow `can`, never the timing of their own pull. Another book's (`key`) is dropped |
| `search-results` | #1315: `key` (= `book.sha256`), `id` (the `search` call's), `results [{cfi, pre, match, post, label}]` (hits in book order: the range's CFI, the hit as the book writes it, up to 60 characters before and after it in its text node with foliate's `…`, the title of the contents entry it is under or `''`), `done` (the search ended), `more` (a hit past `MAX_RESULTS` exists: never for exactly that many), `incomplete` (on the `done` message: part of the book could not be read, so hits there are missing). One per section with hits, then one with `done` and no results; a superseded search sends no `done` | through `readSearchResults` (a malformed item dropped) and `searchTake` (another id, or after the end: dropped); another book's `key` is dropped. Untrusted: shown as text only. A result is a jump target, `goTo(cfi, true)` |
| `lightbox` | #1265: `open` (boolean): an EPUB image was tapped in the middle zone and is shown full screen in the page (no `tap`, `word` or `highlight-tap` for that tap), or it closed (Escape, its close button, `closeLightbox()`, a new open at the swap) | through `readLightbox`: open, the popup closes and the bars hide; Android back calls `closeLightbox()` first after the offer; web: a key on the host document turns nothing, Escape calls `closeLightbox()`. A `ready` resets it |
| `chapter-text` | #1316, the answer to `chapterText`: `request` (the host's id), then `text` and `cut` (true: the chapter is over 200 KB and the text is its first part, to a whole paragraph), or `error`: `empty` (no text in that chapter) or `unavailable` (no such entry; an entry that cannot be told from another; a section asked of a book that has contents; a fixed layout, CBZ or PDF; before `opened`) | hosts take it only through `readChapterText` (a text over the cap or an unknown request is dropped), then share it ("Discuss this chapter") |
| `chapter-end` | #1316: `chapterEnd`, as `relocate`'s: the chapter end of the place last reported, said once the page knows it (where the contents lead is found out after `opened`, one entry at a time, and a chapter that runs into the next file needs that file read). Only for the latest relocate, never after a newer one | hosts read it through `readChapterEnd`, as the relocate's |
| `described` | #1426, the answer to `describe`: `id`, `meta {title, author, lang, description}` (each a string, '' when the file has none; a CBZ has no title: the host falls back to its file name), `cover` (a `data:image/jpeg;base64,` URL or null), or `meta` and `cover` null with `error` (not a book this page reads, unreadable, DRM- or password-protected, no book open) | through `readDescribed` (describe.mjs): a malformed one is dropped |
| `openLink` | `href` | the page forwards only `http(s)` links and the host allowlists again before opening: a stated rule, not an accident. Any other scheme is dropped with a `warn` log (`mailto:`/`tel:` noted on #1069); the page never navigates |
| `telemetry` | `event: 'reader-flow'`, `mode` (the flow in use), `format`, `switchedInFirst5Min` | one per opened book, 5 min after `opened` or when the next book opens first (a page that dies earlier sends none). Hosts log it: there is no analytics pipeline in the app yet |
| `log` | `level`, `msg` | `error`: window errors and a failed open or restore. `warn`: a call that was ignored (a highlight or a restore before the book is ready) and a previous book that would not close. foliate logs its own navigation failures to the console, not here — a position that did not land is reported in `restored` instead. |

**Taps and selections** (#1268): `word` and `tap` are sent at once. A press (`pointerdown`) while a selection is
sent is that selection's dismissal, decided at the press whatever its length: the selection is removed from every
shown section, `selection-cleared` is sent at once, and the press's click is no `word`/`tap`. A double-click is a tap and then a selection, so
it sends `word` then `selection`: **a `selection` supersedes a `word`** for the host (it closes a word popup when a
selection arrives).

A stored position or highlight is applied only while the text at its CFI still reads as its saved quote
(`foldText`; a highlight compares its `selectedText`, or its `quote` if stored before #1078); otherwise it is reported in `restored` and left out, never drawn elsewhere. Stored items with no
quote at all are dropped when the entry is read. A fraction-only position (#1187) has no CFI or quote to
check: it lands approximately (the legacy fraction counts words, foliate's bytes); fraction 0 (never read
on the other device) is not navigated to at all, the text start `opened` already shows. A fraction that
did not arrive (foliate's goTo resolves with its target either way, so the renderer is asked) is reported
as `navigation failed, stayed at start`. One outside [0, 1] is dropped when the entry is read.

**The save rule** (any book, any restore): a `relocate` saves the position only when the reader moved —
foliate's reason for it is not `'anchor'` (re-laying the page out: a resize, a `settings` or `flow` change)
AND its CFI differs from the previous relocate's (foliate relocates again where it already is: after a
landing, and the snap of every touchend) AND the host is not moving the view (from `openUrl` until its
restore has run, and during a non-`chosen` `goTo`). So opening a book, a restore and a sync adopt or
move never save (nor rewrite the server's transitional locator as a CFI); the first page turn, swipe,
scroll, `next`/`prev`/`section` or followed link does, and so does coming back to the landed place after
one. A pre-paginated EPUB (#1196: foliate's fixed-layout renderer reports no range, so no text position)
saves its page as a CBZ does, `{ cfi, page, index, fraction, at }` with `page` the spine item's href (foliate's
section id: the manifest href resolved against the OPF, from the file's bytes alone), restored by that name and
synced as `page-name`. A host `goTo` of such a named-page position (CBZ or pre-paginated EPUB) lands by `page`,
never by the CFI beside it (another device may order a CBZ's entries differently): a name the book lacks does
not land. For a fixed-layout book a
target in the spread already shown counts as arrived (foliate shows it without a relocate). `highlightSelection()` before `restored` is ignored with a
`log` of level `warn`: there is no entry to add to yet, and saving then would overwrite the stored one.

**Reading settings** (#1260, `settings.mjs`). Android exposes Pages/Scroll in the open book’s settings sheet; the choice is saved under `v2reader.flow` and applied live. Fixed-layout books disable it. One call, `settings(raw)`, carries the whole object; the page reads
it through `readSettings`, so only numbers and members of the module's own lists ever reach the stylesheet
(`settingsCss`): the host is trusted, but that CSS is injected into book documents. What it sets:

- *In each section* (foliate's `setStyles`): `html, body` get size, line height, text colour and background;
  text blocks (`p, li, blockquote, dd`) inherit line height. `alignment.mjs` makes an explicit alignment win
  over publisher classes and inline rules, including text in `div`. `book` restores the original alignment.
  `fonts.mjs` applies the chosen family over publisher fonts while preserving bold and italic styles.
  Code and explicitly styled headings retain their publisher faces except in the accessibility font,
  and return to their original faces when leaving that font. Dark mode recolours text and puts images/SVG on a light plate.
- *Mobile selection:* one action card translates any settled selection inline (200 ms request debounce),
  not separate word/phrase modes. Words and expressions up to the API's 200 UTF-16-character vocabulary
  limit save with context and book provenance; oversized entries are refused rather than truncated.
  Translation/TTS retain their 500-character cap; Explain retains its 100-character server cap.
  `saveQuotation()` stores an anchored annotation with `color: 'quote'` (up to 4000 characters), listed
  with highlights but never painted; its source position, removal and offline sync use existing annotations.
  PDF selection can translate/copy/save vocabulary; quotations still require an annotatable book/CFI.
  Long translations expand into a bounded scroll area inside the same card. Placed quotations and
  bookmarks have separate state, so saving or visiting a quotation cannot block adding a bookmark.
- *Mobile controls:* centre taps (including text) toggle panels; side taps page in paginated mode.
  Native text selection handles word/phrase actions. In scroll mode a deliberate 24 px movement back reveals
  controls, forwards hides them; chapter changes and small reversals start a new baseline. Insets reserve
  the text viewport inside a full-screen paper/shadow shell, so controls do not resize the text.
- *On the page itself:* the theme's background and text colour (the margins, the letterbox around a fixed-layout
  page, the translation label). A fixed-layout book (CBZ, PDF, pre-paginated EPUB) has no styles to set, so that
  is all a theme does there; the hosts disable their typography controls (`opened.reflowable` false).
- *Offline fonts:* Literata (default serif), Source Sans 3 (sans), and OpenDyslexic are embedded as carried font
  chunks (`serif`, `sans`, `dyslexic` in `build.mjs`). Serif and sans families include regular, bold, italic and bold
  italic WOFF2 faces. Each chosen family is decoded once into cached `blob:` URLs; no font needs network
  access or a CSP change. Literata, Source Sans 3 and OpenDyslexic retain their OFL notices. A failed chunk logs a
  warning and leaves a system fallback. Shared reading fonts work in the web frame and Android WebView.
- *The place holds:* foliate anchors every re-layout to the text that was on screen after the reader's last move,
  so several changes in a row do not drift.
- *Hosts* keep only what the reader chose (`choose`, JSON under `SETTINGS_KEY`: localStorage on the web,
  AsyncStorage on Android; `parseChosen` drops a damaged or older value), so a default that changes later still
  reaches whoever never chose; they send `readSettings(chosen)` after `ready` and on every change, and colour
  their bars by the theme (`THEMES`; the web through `<html data-theme>`, reader.css). The legacy reader's
  settings are not migrated; its "auto-save words on tap" and `ttsVoiceEn` are not ported.

### Bookmarks (#1314)

A bookmark is **an annotation of colour `bookmark`**, on the page and on the server (owner decision 2026-11-15:
ADR-031 "Amended 2026-11-15", v2-sync-protocol.md "Annotations"): the entry highlight `{ id, cfi, index, quote,
selectedText, prefix: '', suffix: '', color: 'bookmark', at }`, where `selectedText` is the first words at the place.

- **Stored and synced as a highlight.** It rides the entry (`store`), the hosts' diff (`entryChanges`), the same
  write (`highlightWrite`: `color: "bookmark"`), the same pull (`annotationHighlight`, `addHighlights` / `restore`),
  the same tombstone (`highlight-removed`), the same re-key map. No host has bookmark storage of its own.
- **Never drawn, never a highlight.** The page keeps it out of the overlays, so `highlight-list`, `highlight-tap`,
  `recolorHighlight`, `removeHighlight` and `sameRangeHighlight` never see it. A host that lists annotations as
  highlights leaves it out (`isBookmark`): the Android dev highlights screen, the transitional reader's list.
- **Found again by its text.** Kept only while `bookmarkText` of the range at its CFI is still its `selectedText`
  (white space ignored), else reported (`quote mismatch, not drawn`) and not listed. The label is made for bookmarks
  only; if it fails the range's own text is compared, and a highlight is never touched by it.
- **A twin is an alias** (#1314 review). A page bookmark the hosts' diff skips as the twin of a row they hold (the same
  CFI and words; on Android a row a sync pulled while the book was open, which the page never received) is that row
  from then on: `entryChanges` names it in `aliases`, the host records it in the same old→new map as an `id_conflict`
  re-key, so the page's removal tombstones the held row. A row whose removal is still to be sent is not live: the
  same bookmark made again there is written under its new id.
- **`here`: the place being read is bookmarked.** Not "a bookmark is somewhere on screen":
  - *At the top of the screen* (`atTop`, by the live layout: the client rects of the text between the bookmark's
    start and the screen's first words, counted in lines, so it holds at any font size, line height or DPR). The
    bookmark starts where the screen does, or later on its first line. In scrolled flow also up to two lines above
    the screen's first whole line: foliate's visible range there begins at the first line wholly below the
    viewport's top, so the line a jump anchors at the top is one line before it, and a reopen at the place that
    jump saved shows it one line further up. In paginated flow what is before the screen's start is the page before.
  - *Kept while the reader has not moved:* after a bookmark is added, after a jump to a bookmark's own CFI, and
    through a re-layout (a font change, a flow switch, a resize; a relocate whose `cause` is `layout`), it stays the
    one here while it is on screen, even mid-screen. A turn or a navigation asks the top rule again.
  - A bookmark further down the screen is never `here`: it does not refuse an add at the top, and the hosts' toggle
    never removes it. It is removed from its row in the list.
- **`can`: the page says when.** False while bookmarks are being placed (`restore`, `addHighlights`) and, after
  `restore(json, true)`, until the host's `addHighlights` has finished. A bookmark made earlier could be the twin of
  one still coming (a new id the host's diff takes for the pulled one and never saves).
- **Where it can be made:** where there is text at a CFI (`opened.bookmarkable`). Not on a CBZ, a pre-paginated EPUB
  or a PDF: the protocol takes no `page-name` or location-only annotation. Follow-up: [#1350](https://github.com/mrviduus/textstack/issues/1350).
- **Hosts:** web: a bars button (one name, "Bookmark", its state in `aria-pressed`; disabled, never hidden, while `can`
  is false and none is here, so the bars do not shift) and a Bookmarks tab beside Contents
  and Highlights; Android: the top bar's bookmark icon (filled while the place has one) opens the sheet: the same
  button and the list. Each row jumps on a tap and has its own remove button, named by the bookmark's words. Offered
  where the book is `bookmarkable` or holds bookmarks already; the empty list says they are loading (`placing`), how to add one,
  or that this page cannot be bookmarked (`can` false once placing is done). A bookmark tombstoned by a pull leaves the page (`removeBookmark`), as a
  highlight does.

## Host responsibilities

- A **fresh random nonce per load** into `readerPageHtml(nonce)`; the length check is not an entropy check, so the host picks the source of randomness (R2).
- **Keep every `store` payload** under its `key`, and hand back to `restore` an entry the page accepts. The web dev host keeps it verbatim; the web production host keeps it on the server (#1226); the Android host (R6) splits it into SQLite rows (`localLibrary.ts`) and rebuilds it — same position, same highlights (only those in this file version, none tombstoned). Lower-case hex keys: `sha256()` emits lower case and the key is compared byte for byte.
- **Serialise library writes.** `library.mjs` is pure; two concurrent imports writing `library.json` can still lose one (web dev host). The web dev host never writes over a stored library that does not parse: it says so and adds nothing (#1081). The Android host runs every row write on one queue.
- The R2 host passes its file path (`staging/<ts>.epub` or `books/<sha256>.epub`) as `openUrl`'s `name` to match each answer to its open, so the page's stored `book.name` is that path until the contract gains an explicit open id (#1069).
- **Sync (R6, Android):** opportunistic, never on the reading path: with a session, on screen open, on each book open and 10 s after a save. ADR-019 needs the host's view of the open book, kept by `movedTracker.mjs` (restored yet, moved since by `relocate.moved`, the spine index of the last `relocate`); a newer position from another device is gone to (`adopt`/`move`) or offered (`prompt`). File sync is a per-device setting, off by default.
- **Reading sessions (#1313), both hosts:** `sessionTracker.mjs`, bound to a synced book only (web: the server book whose file the bytes are; Android: the bytes' sha256, resolved to the row when the session ends, so a re-key while reading still finds it). Ended by another open, the book closed, a hidden tab / the app in the background, another identity, the unmount, or 5 min idle. Web: queued in the legacy reader's localStorage session queue and sent at once (`PUT /me/v2/reading/sessions/{id}`; retried at the next reader's flush; 404 / 400 dropped). Android: a `reading_sessions` row and a `session` outbox entry (pushed after states, its book first; the row leaves with the entry), no token, no network. The server counts them in `/me/reading/pace` (`V2PaceTotals`).
- **Discuss this chapter (#1316), both hosts:** host UI, never injected into the book, on a synced book only.
  A chapter is a contents entry (owner decision 2026-11-15); a book with no contents (no entry leads anywhere:
  the page's rule) has its spine sections for chapters. ONE rule, the document's order (chapters.mjs `startsIn`),
  for both the chapter that ended and its text: each entry starts at its place in its file (an href with no
  fragment at the file's top; an element that contains another entry's element before it; an anchor the file does
  not have at the top for the file's first entry in the list, and nowhere for a later one: never named, its text
  `unavailable`); entries at one place are one chapter, named by the last of them in the list; a chapter runs to
  the next start in reading order, whatever the order of the list and wherever the file boundary is. The chapter
  that ended is the last one of the file on screen whose last drawn line is on screen and that ends there;
  foliate's current entry (which goes by the list) is not used. The page finds out where the contents lead after `opened`, one entry at a
  time: an open never waits for it. The block shows while the page's `chapterEnd` (`relocate`, `chapter-end`) names
  a chapter and `offersDiscuss` takes it: not front or back matter by its title (Cover, Copyright, Contents…, the
  legacy `isReviewableChapter`; its 800-word minimum is not applied: the page does not count a chapter's words at
  a page turn), and the page names no chapter with nothing to read. The title shown and shared is the page's.
  A tap asks the page for that chapter's text (`chapterText`), POSTs it as a share
  (`POST /me/v2/books/{id}/shares`: the book, its file when the server holds this very version, `chapterKey`
  `toc-<index>` or `section-<index>`, the title, an operation id kept per chapter and open book so a retry
  replays), and only with the server's answer builds the message: one sentence and
  `(TextStack: book <bookId>, share <shareId>)`. The assistant reads it with `get_shared_chapter` (the caller's
  own shares only; in parts of 40,000 characters). The logic is `createDiscuss` (packages/shared
  `lib/discuss.ts`), one for both hosts.
  - Never a dead id: a failed, refused or offline share, a chapter with no text, a page that does not answer in
    20 s or a server that does not in 30 s (`timeout`; the retry replays the same operation) is said with a retry
    and opens no chat. A chapter over the cap is shared in part, and that is said on screen and in the message.
  - The identity guard: the share starts under this open and this account (web: the store epoch; Android: the
    user, `resetSince()` and the open bytes); once any changed, nothing is sent, shown or opened. Where an open
    starts, the previous book's chapter end, server book, shares and operation ids are dropped.
  - Assistants: ONE decision from ONE source, both hosts (shared `runDiscuss`): the connected apps are asked once
    per tap, with a deadline; a failed or slow request is said as offline or a timeout with a retry, never read as
    "none"; none connected is the `connect` state (nothing shared, the connect dialog or sheet). The chat is opened
    from the grants that run found (`ready.grants`), never asked again, so it never hangs nor turns into a connect
    sheet after the share. The legacy assistant launcher decides nothing here (Android uses its pick Alert only).
  - Another account, or none, ends every run: the block is idle at once (no "Sharing…" left from the old session).
  - Web: two clicks, "Discuss this chapter" then "Open the chat", so the chat opens inside a click (no popup
    blocker) and never before the share landed; the pick between two assistants opens upward; the landed share
    takes the focus only from the block's own button or the body. Android: one tap shares and opens; the pill then
    keeps "Open the chat". One run per chapter and open book on both (`createDiscussLocks`). Online only on both:
    nothing is queued.
  - Not on a CBZ, a PDF or a fixed-layout EPUB (the page reads no chapter text there).
- **Finish book (#1266), both hosts:** host UI, never injected into the book. The block shows while `relocate.atEnd`
  is true (`showsFinishBook`; never guessed from the fraction), on every format: a CBZ's completion travels on its
  `page-name` position (#1188). A finished book shows the finished label instead of the button, and keeps its real fraction.
  `atEnd` is cleared where an open starts, never on `opened`: a book one screen long sends its only relocate (its
  end) before `opened`. The block is out of flow over the book (web: fixed above the bottom bar, its height
  measured; Android: the pill), never in the states box: resizing the frame re-lays out the book, `atEnd` turns
  false, the block hides, and it loops.
  - Android: local first (`localLibrary.finish`, keyed by the bytes' sha256 so a sync re-keying the open book still
    finishes its current row: `reading_state.completed_at`, set once), no token and no network; the `state` outbox
    entry carries it (`pushState` sends `completedAt` with the place while it stands). With no place the server takes
    (none yet, fraction-only) the entry stays queued, never dropped, and a sign-out counts it. Every server state
    taken (a pull, a write's answer, an own write on a conflict, a `reset` 409's current) takes the server's
    `completedAt` (`takeState`: a finish tapped while a write without it was in flight is kept); a reset the device
    has not seen (a pull's `resetRevision` past the revision last seen) clears it; a completion made on another file
    version is not carried to a new one; an adopted position keeps a finish the server does not have queued. The
    list shows "Finished".
  - Web: online, through the open book's session (`readerSync.complete`: the state as the server holds it plus
    `completedAt`, on its revision, which the session then holds). A state read there on an unseen revision goes
    through the lost-write check (own write, or another device's place offered); lost to the session's own position
    write, it is written once more; a close waits for it. Every state the session takes tells the host the
    completion, so a reset elsewhere brings the button back. A failure is said with a retry; no place saved yet says
    to move first. The library reads `completedAt` from the reading feed.
- `<documents>/v2/` is not yet counted in Device Storage nor wiped on sign-out (#1070): local books belong to the device until the owner decides otherwise; a sign-out forgets what the server told that identity, never unpushed rows.

**Reader chrome** (Android, #1263/#1264; the decisions are `tapZone.mjs` and `chrome.mjs`, the bars and footer are the legacy
reader's `ReaderTopBar`/`ReaderFooter`/`useReaderBars`, keep-awake `useKeepReaderAwake`, all already in the app):

- A book on screen shows a top bar (back, title) and a bottom bar (place from `relocate`, prev/next page) over the
  WebView; they auto-hide 3 s after each open (a replayed open too); a centre tap toggles them; in either flow a
  relocate with `moved` (the reader's swipe or scroll; never a re-layout, an open/restore or a sync `goTo`) hides
  them, except one a bar button or the taken offer caused (`createHostMoves`: its first relocate plus 1 s for the
  snap after it), so the bars stay under the finger. Reduced motion: no slide or fade. What the chrome shows and
  follows comes through `readRelocate` (bounded numbers, a capped string, strict `moved`); the position code reads
  `relocate` as before.
- Tap zones (`tapZone.mjs` `tapAction`, the web host's too): in paginated flow, and always on a fixed-layout book,
  the outer 25 % of each side turns the page, the middle toggles. `tap.x` (through `readTap`) against the WebView's
  width; the latest direction (`opened.dir`, then every `relocate.dir`, through `readDir`) swaps the edges of an rtl
  book. A link and a press that dismissed a selection send no `tap`. A `word` goes through `popupStep` (#1269, below).
- Keys (a hardware keyboard): `key` through `readKey` (a held key's repeats dropped) and `keyAction` with the same
  direction: `prev`/`next` turn the page and hide the bars, `bars` (Escape) shows them.
- Android back: the offer, then the image lightbox (`closeLightbox()`), then the word popup or selection toolbar, then the book (back to the list), then the route. No exit prompt.
- **Closing a book** (back, the top bar) shows the list at once and injects `CLOSE_BOOK_JS`: `flush()` (its `store`
  is posted synchronously), then a `book-closed` marker; on the marker the book ends as the open one (no `ready`
  reopens it, its per-book state is reset). No page loaded: it ends at once; a page gone before the marker: the
  next `ready` ends it. With no book on screen the page is hidden from accessibility, and its `tap`, `key`, `word`,
  `selection` and a late `opened` are dropped.
- Notices over a book (a failed save, an offer) have a Dismiss button; the overdue alert keeps its Retry.
- The screen stays awake and the status bar follows the bars while a book is on screen; the page keeps the top
  inset it had with the status bar shown, so a toggle never re-lays the book out.
- **Save on leave:** `flush()` on background lands (`useFlushOnLeave`). On unmount it is called too, but saves
  nothing: the `store` comes back to a handler that is gone. The path that saves is closing the book first (above),
  which back and the top bar do.

**Image lightbox** (#1265, `lightbox.mjs`): an in-page overlay, not the host's.

- *How the image gets there:* the overlay is a dialog appended to the page's own document (the WebView's on Android, the
  reader frame's on the web), above `foliate-view`. Its `<img>` takes the `src` the section's image already has: a
  `blob:` URL the page itself made from the book's zip (or a `data:` URL), allowed by the existing `img-src blob: data:`.
  Any other source is not an image to it. No CSP directive is widened, no protocol added, and no image bytes cross the
  bridge to a host. Book strings reach it as attributes and text only (the alt text as `aria-label` and `alt`).
- *What opens it:* a tap on an `<img>` or an SVG `<image>` in a reflowable EPUB (not a comic, a fixed-layout page, a
  PDF, MOBI or FB2) in the middle zone, before the highlight and word hit tests. In paginated flow the edges still turn
  the page (the tap is a `tap`, as anywhere else on an edge: the page reads `tapZone.mjs` `tapAction` with its own
  width, the hosts' rule), so a page-filling image does not take every tap; scrolled flow has no edge zones. A link
  around the image still wins (foliate owns links), and so does a press that dismisses a selection.
- *While open:* `foliate-view` is `inert`, and the overlay keeps every key (no `key` is forwarded); Tab and Shift+Tab
  stay on its one control (`aria-modal`). Opening it sets scale 1 and focuses the dialog (labelled by the alt text,
  else the host's `labels` `image`, "Image" before any); closing it gives focus back to the section's frame through its window, as foliate does (focusing the
  frame element would scroll foliate's container and move the place). Zoom 1–8× about the focus (`zoomAt`): pinch
  about the fingers' midpoint, the wheel about the pointer, a double tap or click about that point (2.5×, or back to
  fit). Drag pans once zoomed; the pan stops where the image's edge meets the screen's, and a side it does not fill
  stays centred (`clampPan`). A cancelled pointer (the system took the gesture) is never a tap.
- *Closing:* Escape (in the page), its × button, `closeLightbox()` (Android back; the web host's Escape with focus on
  the host document), or a new open (at the swap). Each sends `lightbox` closed. A new page load (Android: a crash
  reload, Retry, an overdue open given up; web: Retry's fresh frame) has none: the hosts drop their flag there and on
  `ready`, and Android back counts a lightbox only while the page is ready (`backAction`'s `ready`).

**Word popup and selection toolbar** (#1269, `wordPopup.mjs`, one rule for both hosts):

- *The tap rule* (`popupStep`): a word whose centre is in an edge zone (`tapZone.mjs`, the outer 25 %) in paginated
  flow turns the page as a tap there would, so page turning stays reliable on text; any other word (the centre,
  scrolled flow) opens its popup at once, no delay. A `tap` closes what is open; on an edge it still turns, in the
  centre it does nothing more (it was the dismissal). A `selection` replaces what is open; `selection-cleared` closes
  the toolbar, never a word popup; a `relocate` with `moved` closes a word popup (its word left), never the toolbar.
  A new open closes both.
- *Fetched by the host* (the page has no network): the translation from the book's language (`opened.lang` via
  `readLang`; else web `en`, Android the app's language through `readerTextLanguage`, the legacy readers' defaults)
  into the reader's native language, with the word's sentence; the same language is definition mode (the legacy
  rule). No book id is sent with the translation.
- *Web*: the legacy reader's `WordPopup` (the native-language picker inside), `SelectionToolbar` (the four highlight
  colours, #1312), `TranslationPopup`, `ExplanationPopup` (explain streamed, `useExplain`), positioned by
  the page's rects plus the frame's offset (`ReaderPopups.tsx`). A failed word translation says so in the popup.
  Highlight is offered where the top bar's is (`annotatable`, and on the production route once the server's
  highlights are in).
- *Android*: the legacy reader's `SelectionActionBar` (a word's gloss; its native-language line opens
  `TranslationSheet`, whose picker asks), `TranslationSheet`, `ExplanationSheet` (one answer, not streamed: the
  mobile client has no streaming). Highlight on a selection where `annotatable`, signed in (the legacy bar's gate).
  A failed gloss shows "Could not translate"; nothing on it touches the reading path.
- *Listen* (#1272): the web popup's speaker and the toolbar's Listen, the Android bar's Listen; see "Listen" below.
- *Over 500 characters* (`readSelection`'s `tooLong`): translate and explain are disabled with the legacy notice.
- *Closing*, both hosts: Copy, a translation's or explanation's close, Escape with the toolbar open, and on Android
  the bar's × and back, call `clearSelection()` (on Android a closed sheet closes its bar too); Highlight is
  `highlightSelection()`, which clears the selection itself. Escape with a popup open (a `key` from the book or the
  host's own keydown) closes it and does nothing else; with nothing open it shows the bars.
- *The footer* "Pick your native language to save words" (legacy `WordPopup`, a reader who never confirmed a
  language) is true on the web production route: picking a language saves the word on screen (below).
- *Saving a word* (#1270, `vocabSave.mjs` `saveOutcome`: what each answer shows, one rule for both hosts). No page
  message is added: `word` carries the sentence, the host knows the book. The save is the legacy reader's, through
  the app's vocabulary API, which speaks V2 (`PUT /me/v2/vocabulary/words`, the shared `createVocabulary`) with
  the flag on: the word, the book's language, its sentence, the book (id and the `opened` title) and the translation.
  - *Web*: as the legacy reader, automatic on a tap, once the reader confirmed a native language, and only for the
    production route's server book (the bytes are its file's; the dev route saves nothing), and only once the
    reader's saved words have loaded (`loaded`): a tap while they load saves when they land, so a word already saved
    never gets another example; after a failed load a tap retries the load, it never saves blind. `useReaderVocabulary`:
    guests' words kept in IndexedDB until the third mints the session, nudges at 3 and 10. The translation follows
    the save when it arrives (TR-2: fills an untranslated card; one switched to mid-popup is display-only, a language
    picked in the footer is not a switch).
  - *Android*: as the legacy reader, the bar's Save (signed in or a guest session; without one `saveWordIntent`'s
    "needs an account" toast), three tries for a network failure (a V2 server answer is not retried, except
    `v2_unavailable`), no offline queue (the legacy reader has none); a failure is a toast and reading goes on. One
    save in flight per word; another word saves meanwhile. The book id is sent; `book_not_found` saves it without
    one. A saved card without a translation gets one (`lib/savedWord.ts` `fillSavedTranslation`, the legacy reader's
    TR-2 fill). A word saved, already saved, restored or added anyway shows ✓ for the rest of the open, never Save
    again. The "Added" toast, or a guest's nudge at 3 and 10 (`claimGuestNudge`, counted on the whole vocabulary: the words in memory once the vocabulary feed was pulled, else the server's list, #1271 `nudgeCount`).
  - *A language that does not read* (`opened.lang` present, `readLang` null: `deu`, `fre`; `savesWords`): nothing is
    saved on either host (no auto-save on web, no Save on Android), as the fallback would file the words under another
    language's cards. Translate and explain still use the fallback for display.
  - *Outcomes*: `deleted` offers Restore (the tombstone's id; never shown as saved: the legacy Android reader did,
    not ported); `pending` says "queued for tomorrow"; `lookup`/`lookup_pending` show the rare-word notice with
    "Add to SRS anyway". V2 answers only `srs` and `deleted`; the other two are legacy answers, kept as legacy shows
    them. Mark as known stays out.
- Untrusted text (word, sentence, selection, a search result) reaches the screen only as React / React Native text, and no host
  injects any of it into the page: the calls the hosts inject carry no book text (`search` carries the reader's own query).

**Saved-word marks** (#1271, `wordMarks.mjs`, `vocabWords.mjs`; audit §2.5). The page draws; the host sends the words.

- *Which words*: the cards of the book's language only (`vocabWords.mjs` `ofBook`: primary subtags compared, `en-GB`
  is `en`), the V2 reader only: the legacy reader's map keeps every card, as before. The language is the one words are
  saved under (`savesWords`' rule): `opened.lang` through `readLang`, else the host's fallback when the book declares
  none; a declared language that does not read (`deu`, `fre`) marks and fills nothing. A card with no language (the
  legacy list, when V2 is not answering) is not the book's: no mark, no fill. The same rule bounds the backfill: no translation is ever written to a card of
  another language.
- *What the host sends*: `markWordsOf` (word, stage, translation as the gloss), oldest first, a word just saved last
  (over 20,000 the page keeps the newest); never a sentence or any book text. Sent after each open's words are in,
  after each change (a save, a restore, an "add anyway", a backfilled translation), on a `ready` (a new frame) when
  there are words, and when the setting switches; an unchanged list is not sent again. ponytail: the whole list each
  time; delta calls if a large vocabulary makes a save jank.
- *The setting* is the legacy readers' own `showInlineTranslations` ("Show translations for saved words"), one choice for
  both readers on a device: web `reader.settings.v1` (`readGlosses` / `withGlosses`, every other field kept), Android
  `useReaderSettings`. The switch is in the V2 settings panel where `annotatable`.
- *Drawn*: foliate's underline (vertical writing included) in the stage's colour; the range being spoken (#1272)
  over it, so it stays visible; the gloss as SVG text.
- *Web*: its own hook, `useReaderVocabulary` (ReaderPopups): the legacy saves, guest queue and mint, with V2's rules. One read per load, each card with its language,
  filtered to the book's, loaded again for a new identity (a guest becoming an account); kept in memory, and what is
  saved while a load is in flight is replayed over its words when it commits; a save, a flushed guest word or a footer-picked translation updates it
  (another language's queued word is not added, nor given this book's card's translation by key). Missing
  translations are backfilled once per authenticated load, for the language it was filtered for (a language change
  waits for its own load), over the words it brought (never on the no-session branch, never for a word saved later:
  the save's TR-2 fill has it), by the shared `backfillTranslations`, cancelled by a newer load (identity, language,
  retry) or the unmount; the map takes the translation the server kept. "Already saved" (the auto-save's guard, the
  popup's ✓) is a card of the book's language or one with no language (the legacy list, V2 down), so no word is saved
  twice; a card of another language is another word. Every late answer (a save, a flushed word, a recorded card, a
  TR-2 fill) applies nothing when the identity it was asked under is no longer the reader (anonymous → guest is the
  same person), and a save is not sent when the identity changed while its flush ran. A guest's nudge counts the whole vocabulary, every language. The map goes to the host
  through `onMarks`.
- *Android*: the saved words are the local library's `vocabulary` rows, offline too (no token or network on the
  reading path). The feed's rows, and this device's own: a save's answer card (saved, already saved, restored, added
  anyway) is upserted as the pull writes it (`answerRow`: only for a save that went through V2; dropped when the user
  changed since the save was asked), and the translation the server holds after a write (the card its PATCH answers
  with: `onlyIfEmpty` may keep another; the backfill's, TR-2's `onStored`) is written to its row. Only a V2 card makes
  a row: the mobile vocabulary API marks each answer with the route the call itself took (`routeOf`), so a re-probe
  after it never turns a legacy card into one; an "add anyway" (a legacy promote) never does. Every own write carries,
  from memory when its save was asked (a save never waits on the database), the asking user and the session
  (`WriteGuard`); inside its job it lands only while that session is current (every sign-in and sign-out bumps it) and
  the library is nobody's or the asker's own (claimed by them mid-save, or adopted to them). A library another identity owns (a wipe that failed) is neither read for
  marks nor written (`ownsLibrary`). A pull replaces rows by id,
  a tombstone deletes one, a wipe, a guest carried on and an adoption clear them and pull again (the account's ids).
  The rows are read at each open, after each own write and after each sync pass; the bar's ✓ is the book's language's
  rows. A user change reads them anew and latches the backfill again. Missing translations are backfilled once per
  (open, user, native language) by the shared `backfillTranslations` (`backfillable`: the book's language, no
  translation, none whose TR-2 fill (until its write settles) is in flight; `cachedTranslate`, then the card's `onlyIfEmpty` PATCH awaited before the next word; a 429 stops it, so
  do a new open, a user change, a new native language, which restarts it for what is still missing, and leaving the
  screen). A guest's nudge counts the rows once the feed was pulled (V2 on, a vocabulary cursor), else the server's
  list as before (`nudgeCount`).
- *The feed*: pull-only; a tombstone removes the row, the server's row replaces it. Pulled after the pushes, and its
  failure is its own: it never holds a write back or fails the pass (offline, the server down or a session change end
  the pass as for any pull). A wipe deletes
  the rows (nothing counted as lost: they are the server's); a guest carried to the next identity and a guest →
  account adoption drop them and pull from the start (the merge keeps the account's card ids).
- *Measured* (desktop Chromium, Frankenstein, 78,499 words in 32 sections; the page's `markWords` on the section on
  screen to the next frame): 500 saved words of mid frequency → 8,941 marks in the book, 18 ms median per section,
  the densest (890 marks) 74 ms; 2,000 words → 26,756 marks, 41 ms median, densest (2,806) 247 ms; the 50 commonest
  words → 37,007 marks, densest (3,920) 391 ms. A page turn's `relocate` is not held up (42 ms with marks, 41
  without): a section is marked in the task after it is shown. ponytail: no cap on a section's occurrences (one
  overlay each, `getClientRects` on every re-layout); draw only those near the viewport if real vocabularies make it felt.

**Listen** (#1272, `listen.mjs`; audit §2.7). The host fetches and plays (the page has no network); the page marks.

- *What:* a tapped word (the popup's speaker on the web, the bar's Listen on Android) or a selection (the toolbar's
  Listen), up to 500 characters (`tooLong`: none, the server's cap). Through the legacy players (`useTts`, web and
  mobile) and `GET /tts`. No continuous read-aloud, no word-by-word overlay, no background audio (Android stops on
  leaving the foreground), no Listen in the translation sheet.
- *Language:* `ttsLang(opened.lang, fallback)`: the book's language, its primary subtag only (`pt-BR` → `pt`; ISO
  639-2 codes in both forms folded: `deu`/`ger` → `de`, `ron`/`rum` → `ro`; `nb`/`nn` → `no`, the server's key), else
  the translation's fallback (web `en`, Android the app's language); a code that names no language (`und`, `mul`,
  `zxx`, `mis`) is the fallback; Tagalog is `fil` (the Edge voices' code). Only the language is sent: the server picks
  the voice by it (`TtsConfiguration.DefaultVoices`), and one spelling per language keeps one V2 cache entry. The
  players keep their legacy handling of what they are given (mobile: English as `en-US`, its cache file names), and
  the legacy readers send their own language as before; a V2 word shares a legacy cache entry only where both send
  the same spelling (mobile: always, through the same player; web: a two-letter `bookLanguage`). A language without a region is never mapped to `en-US`
  (audit §3, the legacy mobile defect). Ukrainian: no Listen (the server refuses it). Known server gap: a language
  outside its defaults, on a server that has not loaded its voice list yet, still gets en-US there.
- *Speed:* 0.75–2× (`TTS_SPEEDS`), the settings panel's last row, kept by the host under `TTS_SPEED_KEY` (never sent
  to the page); on Android a speed picked before the stored one is read wins (`createSpeedChoice`). The web audio
  cache is keyed by speed (`makeTtsKey(lang, text, speed)`; 1× keeps the key used so far); mobile's already was.
- *No word tracking:* V2 asks `useTts` for no word timestamps (`timestamps: false`): no `/tts/timestamps` request
  (it takes the same rate-limit permits) and no per-frame loop.
- *The rule* (`createListener`, both hosts; it owns the phase, set synchronously, the hosts only render it): a press
  is `loading` at once (web: a spinner, "Loading speech, tap to cancel"; Android: the bar's spinner), `playing` once
  the player says it plays (Stop), `idle` when it ends (the players' `onEnd(failed)`, once per playback), fails or is
  stopped. A press on the range speaking (its text, CFI and section) stops it, also while loading; the same word
  elsewhere is spoken there. Closing the word popup or toolbar that started it (or opening another) stops it
  (`follow`; `spokenOf` is what each host's open popup speaks). The host calls `speaking(cfi, index)` at the press and `speaking(null)` when it is idle again; a range
  with no CFI (a PDF) is spoken unmarked. A new open, closing the book, leaving the route and (Android) the app
  leaving the foreground stop it, through the listener. A failure (`onEnd(true)`, a throw, no audio module) says so on
  both hosts (`reader.listenFailed`); an end the host caused (a stop, a newer request, unmounting) never does. A
  rejected `play()` of audio a newer call paused belongs to that older call: it touches nothing (web `useTts`).

**In-book search** (#1315, `search.mjs`; audit §6 decision 2). The page searches; the host lists.

- *How:* foliate's own search (`view.search`, the fork's `search.js`, no longer stubbed out of the build; fork commit
  `686afc4` for the limit, the per-hit title and the skipped section): each
  section's own document (`createDocument`, the book's bytes; no network, no host round trip per section), any case,
  accents folded, whitespace runs (a source line break inside a phrase) as one space, parts of words too. What folds
  is decided by the section's own `lang`, else the book's language (the page passes it: `defaultLocale`), else English;
  never by the reader's browser (under a Turkish one "in" would miss "In"). Results in
  book order, one `search-results` message per section with hits, then one with `done`.
- *Which books:* `opened.searchable`, true where the book has section documents: EPUB (a pre-paginated one too), MOBI,
  AZW3, FB2/FBZ. **Not a CBZ** (images, no text) and **not a PDF**: the fork's PDF reader makes no section documents
  (pdf.js draws each page into its own frame), so there is nothing for `view.search` to read; a PDF search needs a fork
  change (`sections[i].createDocument` from `page.getTextContent()`, and a `pdf-page` result), not a page one. Hosts
  show no search button for either, and a `search` call there answers `done` with nothing.
- *One at a time, cancellable:* a `search` call ends the one running (it stops before its next section and never says
  `done`) and starts after it; a call superseded while it waited touches nothing (the view may be another book's by
  then). The host's `id` comes back on every message, so an older search's answer is dropped (`searchTake`). The swap
  ends the open book's search. A task between sections: input and paint come first; a search ended during it reads
  no further section (foliate's generator is closed).
- *A section that cannot be read* (its document fails to load, or has no body: an SVG spine item) is skipped by
  foliate, which says so (`{ index, error }`), and the rest of the book is searched; the `done` message then says
  `incomplete`, and the hosts say part of the book could not be searched. Anything else that fails inside the search
  ends it with `done` and `incomplete`.
- *The cap:* `MAX_RESULTS` (500) hits are listed. The page asks foliate for 501 (`limit`): matching, registering and
  drawing stop there, so a two-letter query in a one-file book costs 501 hits, not tens of thousands. `more` is said
  only when that 501st hit came (in the same section, or a later one: the search goes on until it finds one or the
  book ends), so a book with exactly 500 hits is not "the first 500". The 501st is drawn in its section and not
  listed. ponytail: no paging past it.
- *One section is one task* up to the limit: the matcher runs through a section's document synchronously until the
  section ends or the 501st hit, so a section with few hits in a very large file still holds the main thread for the
  time it takes to read it (measured below per 54 KB section; not on a device).
- *Titles and text:* each hit's `label` is the contents entry it is under (two hits in one file may have different
  ones); a hit over inline markup is listed whole, and one over a source line break on one line (whitespace runs in
  the listed hit are one space; its CFI is the book's own text).
- *The query* (`readQuery`): at least 2 characters, counted without what only joins the character before (a
  combining mark, a variation selector, a skin tone: one emoji or a decomposed "é" is one); 1 is enough in Thai,
  Hangul, kana and Han, where a word may be one character and no space sets it apart. Not `Intl.Segmenter`: the
  Android host's engine has none and the page and the hosts must agree. A typed text that is no query yet gets a
  status line saying so (`searchStatusKeys`: `tooShort`); a query typed that the page was not asked yet (the
  debounce) says nothing.
- *The hit in the page:* every hit of the query is drawn (`SEARCH_FILL`, foliate's highlight) in its section as that
  section loads, until `search(null)`, a new search or a new open. A result's `cfi` is a `goTo` target: the hosts call
  `goTo(cfi, true)` (the reader's choice: saved where it lands), exactly as for a highlight in the list. On a
  fixed-layout EPUB the jump lands on the hit's page and nothing is drawn (no overlayer there).
  ponytail: the chosen hit is drawn like the others (several on one screen look alike); a `found` decoration on the
  page's own overlay, as `speaking` has, if readers need it told apart.
- *Hosts* (one rule, `search.mjs`): a Search button on the bars where `searchable`, gone from an open's start until its
  `opened` (`searchReset` / `searchOpened`); the reader's text, debounced `SEARCH_DEBOUNCE_MS`, through `readQuery`; results as text only (the hit, up to 60
  characters each side, the title of the contents entry it is under), a status line (`searchStatusKeys`: too short, searching, the count, none, the first 500; and that part of the book could not be searched); streamed results put on screen at most once per `SEARCH_RENDER_MS` (a book of hundreds of sections is not hundreds of renders of the whole reader), the end at once; a
  result jumps and closes the list; the search stays until cleared, so reopening shows the same list. A new open (or a
  closed book) ends it. Web: `ReaderSearch.tsx`, the legacy search drawer's dialog (opened on results, focus goes to the first of them, not the field: no phone keyboard over the list). Android: `V2SearchSheet.tsx`, the
  contents sheet's modal (the keyboard comes up only on an empty sheet, and a drag on the list puts it away, so a
  reopened sheet's rows are reachable). The query is the one string a host puts into the page that the reader typed (never book
  text): as an argument (web `postMessage`, Android `JSON.stringify` into the injected call), read by `readQuery`.
- *Measured* (desktop Chromium, a generated 5.4 MB FB2 of 100 sections, about ten novels): a phrase found once per
  section, first answer after 29 ms, the whole book in 2.8 s; a query with no hit, 2.3 s; no main-thread task over 50 ms.
  Not measured on a device.

**Highlights** (#1312, `highlights.mjs`; audit §2.6). The page draws and lists; the host keeps notes and writes.

- *Colours:* the legacy four (yellow, green, pink, blue), chosen in the selection toolbar; the page draws each in its
  `HIGHLIGHT_FILL`. A stored colour off the list (the server does not enumerate them) is drawn and listed as yellow;
  its row is not rewritten for that.
- *A tap on a highlight* (`highlight-tap`) opens its editor where the toolbar would be: the four colours
  (`recolorHighlight`: the change reaches the host as the page's `store`, like any highlight change), the note, Delete
  (`removeHighlight` → `highlight-removed` → the host's tombstone). On an edge in paginated flow it turns the page as a
  word does (the list still reaches it). A move or a cleared selection keeps the editor open (a note being typed).
- *Notes are the host's*: the page never holds one (no user text is injected into it). Every annotation write carries
  the note the host holds (`highlightWrite`'s `noteText`: the PUT replaces the row, so leaving it out would clear
  another device's note). On `stale_revision` the retry keeps the server's note unless this device edited it; the
  colour is the page's form, re-applied once (the PDD's rule, unchanged).
- *The list* is the page's `highlight-list`: drawn ones only, in book order, the text and the note as text. A tap
  jumps there, `goTo(cfi, true)` (the reader's choice: the place is saved).
- *Web*: the editor is the legacy `PdfHighlightPopup`; the list is a Highlights tab beside Contents in the contents
  drawer (the Contents button shows for a book with no contents too, then on that tab). The production route offers
  highlights once the server's are in (as before); `?highlight=<id>` jumps to it once the page lists it (once per
  open; never if it is not drawn). Notes and removals go through the session (`readerSync.ts`: `setNote`, `remove`,
  `note`): a note diffed with the page's form, a removal a `DELETE` before any write of that highlight (a 404, never on
  the server, is done), both retried on the next pass and sent by keepalive on `pagehide`. The dev route keeps notes
  in memory only.
- *Never losing a note* (#1312 review), both hosts:
  - One rule for every save, every close path (`noteChange(draft, from)`): nothing is written when the trimmed draft is
    the note it was typed over (`from`: web, the note when the popup opened; Android, the note shown when typing began,
    the editor following the note while untouched). A note is never cut (the server has no cap; one written elsewhere
    may be long).
  - A recolour in the open editor keeps the draft. Web: the draft is the host's (`PdfHighlightPopup` `onDraft`), written
    whatever ends the editor: another popup, a tap or a word in the book, Escape, ×, Save, a new open, leaving the route
    (before the session's close), the tab hidden or closed (before the keepalive writes; what it wrote becomes the
    baseline, so Cancel, back to the note at opening, writes that back); Delete discards it. One the server holds as
    deleted (a 409 `deleted`, another device) is not edited: tapped or saved, it leaves the page, nothing is saved.
    Android: `notes()` sorts a book's highlights into known (note or none), unknown (a row from before notes, not pulled
    yet: the field waits, Save is off, focus comes when it turns editable) and deleted (tombstoned by a pull: it leaves
    the page and the sheet, an editor on it closes); until this open's notes are read every editor waits; an id in none
    is a highlight just made, no note. The notes are read again after a `store` that follows a changed highlight list,
    and after each sync pass; an editor is new only for another highlight.
  - No re-key on the page: after an `id_conflict` re-key the page and the UI keep the old id until the next open (its
    restore reads the rows: the new id). Each host keeps one in-memory old → new map, never persisted, and one
    `real(id)` that every way in goes through. Web: the session's (`real`), from the re-keyed write's landing: the page's
    forms (the last one with a close included), `setNote`, `remove`, `note`, `deleted`, the deep link's match; edits made
    under the old id while it flew move then. Android: the local library instance's (`realId`), recorded once the re-key
    transaction committed, cleared once a wipe committed: `applyEntry` (the page's stores), `setNote`, `removeHighlight`
    and the deep link's match; `notes()` answers a re-keyed row under its old page id too, so every lookup by page id
    works. A failed notes read is tried once more, then again with the next highlight list (editors wait meanwhile).
  - The keepalive writes skip a body over what is left of the budget (a long note) and send the ones after it.
- *Web, the link*: once the jump to `?highlight=<id>` is made, the route drops the parameter (replace, no history
  entry): a reload opens at the saved place, never jumps (and saves) again.
- *Android, the upgrade* (rows from before notes were kept): once per database, in one transaction with its `meta`
  marker (`upgrade:notes`; a kill before it commits runs it at the next start; a sign-out's wipe keeps it), every row the server has with no note
  edited here is marked not known (`note_known` 0) and the annotations feed restarts from the start. A row not known is never pushed (its PUT would clear
  the server's note; the sign-out push pulls nothing, so it skips it); the pull takes its note, a queued one's too
  (never over a note edited here);
  a feed read to its end marks the rest known (not on the server: no note to keep). The notes are read by the book's
  bytes as `readEntry` finds it (a pulled book not imported yet included) and again after every sync pass.
- *Android, the list* needs no account (the top bar's button shows for everyone on the V2 route; making a highlight
  keeps the legacy bar's sign-in gate). The highlights screen's V2 section reads again each time it is shown.
- *Android*: local first, no token or network on any of it. A new highlight takes the last colour chosen (the legacy
  bar's one swatch, `lastHighlightColor`'s rule: a colour tap in the editor sets it for the next). The editor is the
  legacy `HighlightNoteModal`. Notes and removals are rows (`localLibrary.ts`: `note`, `note_dirty`; a removal sets
  `deleted_at` and queues the row, so restore draws it no more and a later `store` holding it is skipped), written in
  the page's message order (`hostStorage.ts`, after the queued `store`s). The push (`sync.ts`) sends the note with
  every write and a DELETE for a removal (404: the server never had it, done); a pull of a live row never undoes a
  queued removal (the queued-row rule). The list is a sheet (the top bar's Highlights button, for everyone, above). The highlights screen of a dev build lists this device's V2 highlights (`V2DeviceHighlights`) and opens the dev
  route at one (`?book=<id>&highlight=<id>`: the book from this device, then the jump once listed).

**Deadlines and states** (#1227, `deadlines.mjs`, one rule for both hosts; the numbers are its named constants):

- `ready` is due a fixed time after each page load: `READY_DEADLINE_MS` 10 s for a page the host carries (Android's
  inline page, the dev server's frame), `READY_DEADLINE_NETWORK_MS` 30 s for the web production route (shell + a
  cold-cache 1.6 MB gzipped script). A reload (Retry, a renderer crash) starts a new wait and ends an open's.
- `opened` (or `open-failed`) is due after the open is sent: `OPENED_FLOOR_MS` 20 s + `OPENED_MS_PER_MB` 1 s per
  MiB, capped at `OPENED_CAP_MS` 180 s. The R4 gate opened 87 MB in ~7 s on the emulator (~12 MB/s); the rule
  allows ~1 MB/s. A newer open restarts it.
- A missed deadline is an alert with Retry; a late `ready`/`opened` clears it (slow, not dead). Retry is a new page
  load. Android reopens the open in flight from its file, and gives an open up after `OPENED_OVERDUE_LIMIT` (2)
  overdues in a row (dropped with its staged file, the reader told, as a book that crashes the reader). Web: bytes still held (no `ready` yet) open on the new
  frame's `ready`; bytes the old frame took are gone, so the host asks its route for the book again (`onReload`;
  the dev route has none: pick again).
- Web production route states (`ReaderPage.tsx`): downloading (percent from `Content-Length`, never past 99 %
  before the bytes are in; no header: "Loading the book…"; no byte for `DOWNLOAD_STALL_MS` 30 s: a stalled-download
  alert with Retry; aborted on unmount, Retry or another book), opening (`Opening <name>`), open-failed (the page's
  message), and a failed load by cause: 401 session ended, 404 book or file gone (no Retry: it cannot help; said only
  after a fresh library pull still gives a 404 or no file, since `liveBook` answers from the session's copy), offline
  (a failed body read only; an allocation or other failure keeps its own message),
  503 `v2_unavailable` and anything else (Retry). A failed open shows no title (#1168): web blank, Android
  "Pick a book".
- Android (#1080 item 6): the open's error line (pick, download, open-failed, import, crash) is apart from the
  other one (library, settings, sync, saves), so a later `store` failure never overwrites why a book did not open; a
  full disk reads as one human message and `NotReadableError` as "could not be read" (`hostErrors.ts`; raw text logged).
- **WebView floor** (#1228, ADR-029 Decision 6): the reader WebView's `injectedJavaScriptBeforeContentLoaded`
  (`USER_AGENT_PROBE`, ES5, evaluated on page start as its own script, so it answers even where the page fails to
  parse) posts `{ type: 'ua', ua }`. `webViewVersion.ts` reads `Chrome/<major>` against `MIN_WEBVIEW_CHROME` (117);
  the first answer is the verdict for the process. Older: the reader is swapped for the update screen (a Play Store
  button for Chrome on Android 7–9, else Android System WebView; no "try again": the provider is loaded once per
  process, the copy says to reopen the app). No readable version: not blocked, and a missed `ready` names an
  outdated WebView as a likely cause (not when the version is known to be fine).
- Errors are `role="alert"` (web) / `accessibilityRole="alert"` with a polite live region (Android); Retry is a button.

**Bars and tap zones, web** (#1263; the same decisions as Android's "Reader chrome" above, `tapZone.mjs` and
`chrome.mjs`; the bars are the legacy reader's `useImmersiveMode` and `reader.css` bar rules):

- Layout: the states box (not saved, the newer place, read-failed Retry, a deadline or open error, the route's load
  error; on the dev route the restore line and the library) sits in layout space under the top bar's height, the
  frame takes the rest; nothing covers the book but the bars. The top bar (back to the library, the title, the
  reader's buttons) and the bottom bar (‹ Prev, the place, Next ›) float over the frame.
- The opening and downloading states are the top bar's title: a new open (and a fresh frame) shows the bars and
  they do not auto-hide until `opened`; then they hide 3 s later. Until a book is on screen (`opened`), taps, keys,
  words and selections from the page do nothing (`takenWithoutBook`), and the host's own keys turn nothing.
- Hiding: a page turn by tap or key, and a `relocate` with `moved` in either flow (`readRelocate`,
  `hidesBarsOnRelocate`), except one a bar button or the taken offer caused (`createHostMoves`): Next › keeps the bars
  under the cursor; a resize, a flow switch, a sync `goTo` never hide them. A centre tap toggles them, Esc and focus
  on a bar show them; when they hide with focus inside, focus moves to the reader's main region, so no invisible
  control is focused. Reduced motion: no transition.
- Taps and words (`popupStep` on `readTap` / `readWord`, #1269), with the effective flow (a fixed-layout book pages
  whatever the setting) and the latest `dir`; a malformed one is dropped.
- Keys: chrome.mjs `keyAction` with the latest `dir`, for the page's `key` (`readKey`, focus in the book) and the
  host's own keydown (`hostNavKey`: no Ctrl/Alt/Meta, no Shift+arrow; a focused control keeps only the keys it uses,
  Space on a button or link and every key in a field, so after a click on Next › the arrows still turn; Escape
  always shows the bars). A held key turns once per press on both paths.

**WebView** (Android, #1228; ADR-029 Decision 4 as amended): `source={{ html: readerPageHtml(nonce), baseUrl:
'https://appassets.androidplatform.net/' }}`, no file access at all (the library's defaults: `allowFileAccess`,
`allowFileAccessFromFileURLs`, universal and content access all off). The base URL arms the patched
react-native-webview's interceptor (`patches/react-native-webview@13.16.1.patch`, `TextStackBookServer.java`): it
serves exactly `bookOrigin.mjs` `BOOK_PATH` (`/v2/books/<sha256>.epub`, `/v2/staging/[dl-]<ms>.epub`) from
`files/v2/`, checks the canonical file is still in `books/` or `staging/` (a symlink cannot lead out), and answers
404 to anything else on that host, so nothing on it reaches the network. The page reads the book by XHR from it,
streamed, so no book bytes cross the bridge. The same patch limits the message bridge on that WebView: with `WEB_MESSAGE_LISTENER` (every engine that can run the page, Chrome 117+) only the main frame's messages are delivered; on the `addJavascriptInterface` fallback (older engines, no frame information) only the user-agent answer is, and no book opens there. Other WebViews keep the fallback as it was; on the listener path they too take main-frame messages only (none of them uses iframes). `originWhitelist={['*']}` on purpose: react-native-webview opens a navigation outside
the whitelist in another app; `onShouldStartLoadWithRequest` (about:/blob:/data: only) is the filter. These props live
once, in `src/components/reader/pageWebView.ts`, for every WebView of the page: the reader's and the upload screen's
hidden `V2Describer` (#1426), which copies the pick into `staging/`, calls `describe(id, <its URL>)` and unmounts.

**Web, its own document** (#1219, production route #1225): `frame.mjs` splits the page into two files under
`/reader/` (paths: `framePath.mjs`):

- **the shell**, `/reader/frame.html` (1,326 bytes, #1312): the page's head (its meta CSP), the host shim inline, and
  `<script src="/reader/page.<hash>.js" integrity="sha384-…">`, all under one nonce placeholder
  `%READER_FRAME_NONCE%`. It fails closed: `%` is outside the CSP nonce grammar, so a shell served unfilled has
  no valid script source and runs nothing (not the shim, not the page script, not a script carrying the
  placeholder). Sent `no-store` with a fresh nonce per response (16 random bytes, hex, nginx's `$request_id`;
  `fillNonce` takes nothing else) and its own headers (`READER_FRAME_HEADERS`: `frame-ancestors 'self'`,
  `no-store, no-transform`, nosniff, `no-referrer`, `X-Robots-Tag: noindex`).
- **the page script**, `/reader/page.<first 16 hex of its SHA-384>.js` (3,865,725 bytes; 1,775,611 gzipped by node's zlib default, #1315; #1260: OpenDyslexic adds about 120 KB of it):
  the page's one script, byte for byte what the inline page runs, sent `public, max-age=31536000, immutable`,
  `text/javascript; charset=utf-8` (it is not ASCII), nosniff. A book open fetches the shell only; the script
  comes from the HTTP cache (ADR-029 Decision 4 as amended 2026-11-11). The format readers stay inside it as
  strings and run as inline scripts under the same nonce, which page.mjs reads from `document.currentScript`
  (an external script has it too; the check opens a MOBI to prove it). `integrity` pins the script to the shell
  that names it: a swapped file is refused, not run under the nonce.

`serveReaderFrame` is the one handler: the Vite dev server (from source) and `vite preview` (from the built
`dist/reader/`, `readerDistFiles`, so CI's e2e runs what nginx ships) through plugin `reader-frame`, which
loads frame.mjs on the first `/reader/` request, and the check use it; any other path under `/reader/` is a 404,
never the SPA. A production build writes the same two files to `dist/reader/` (`readerFrameFiles`), the
shell unfilled; nginx fills it (`location = /reader/frame.html`, `sub_filter … $request_id`) and serves the
script (`location ~ ^/reader/page\.[0-9a-f]{16}\.js$`, server-level headers, `$cache_immutable`).
`apps/web/scripts/assert-no-dev-reader.mjs` fails the build unless `dist/reader/` is exactly those two files
(the name is the hash, the shell pins it) and no other file carries the page code or the dev route.

One host component, `apps/web/src/components/reader/ReaderHost.tsx`, serves the dev route (`/dev/reader`, a
picked file, dev server only) and the production route (`/:lang/library/my/:id/read`, `/read-v2` an alias:
the current file's bytes from `/me/v2/books/{id}/files/{fileId}/content`, transferred). It embeds the shell with
`<iframe sandbox="allow-scripts allow-same-origin" src>`, checks every message's source and origin, tracks opens
with `openTracker.mjs`, and runs the deadlines below. Reader data: localStorage on the
dev route (keyed on the route, `dev`); on the production route the server only (#1226,
`apps/web/src/lib/readerSync.ts`, one session per open). No reading-state read, no session: `restore` gets
the server's place, and when the read fails the page gets no `restore` (an error with Retry), so nothing is
written. The book's annotations (this file version's, live) follow by `addHighlights` when a fresh pull lands
(answered by `highlights`; ones not drawn are logged); until then highlighting is not offered, no highlight is
written, and a status line says so (the pull retried on the next `store` and when the tab hides). Each `store` is diffed against what the server is known to hold (`entryChanges`,
`packages/shared/src/reader/pageEntry.ts`, the mapping `localLibrary.ts` uses; twins only within one file
version) and written with the expected revisions. Conflicts: own write = success; `stale_revision`
written once more on their revision (#1232). The web host never moves the reader by itself: a position write
exists only because the reader moved, so ADR-019 (`decideServerState` with a reader who moved, against the place
this tab last saved or restored, never the move being written) only keeps or asks. Theirs provably newer: a bar
offers it ("stay here / go to their place": stay dismisses it, go is `goTo(theirs, chosen)`, the page saving where
it lands; a later one shows the newest, a new open clears it). The state of this tab's previous write whose answer
was lost is its own: no bar. No write waits for an answer; `reset` written once more on their revision; an annotation re-applied once,
then the server's kept and the page's form not sent again until it changes; a tombstone wins; `id_conflict`
re-keyed once. Terminal: `file_replaced`/`unknown_file`/`book_not_found` stop the session's writes ("reopen"
line); `invalid_payload`/`chapter_not_found`/400/422: not resent until it changes, "not saved" meanwhile. Online-first, no outbox:
a failed write stays a difference, retried on the next `store` and when the tab hides; `pagehide` sends what is
left by keepalive (position first, highlights within a 60 KB budget); a "not saved" line until it lands. A new
take or leaving the route closes the session after one last pass; a later open of the same book reads after
it, whatever was open between (another book never waits). The position never waits for the annotations pull;
a book without highlights (a PDF, a CBZ) pulls none.
Bytes that are not the server file's are not synced. A CBZ page position syncs as `page-name` (#1188), as on
Android. The shim posts to `self.origin` only and takes messages from `parent` at that origin
only; the frame is same-origin with its host, so that is the host's origin. **Android keeps the inline page**
(`readerPageHtml(nonce)`): nothing here changes it.

Not `srcdoc`, measured (`prodCsp.check.mjs`): a srcdoc document inherits the app's CSP (`infra/nginx/textstack.conf`)
on top of its own, and the app's `script-src` refuses the page's nonce'd scripts, so the page never sends `ready`;
the same document as srcdoc under a host without CSP works (the `srcdoc-control` row), so the CSP is the reason.
Making srcdoc work took five app-wide additions (measured on the experiment branch, `exp/v2-reader-prod-csp`) (a per-response script nonce; `blob:` in `connect-src`, the
`openUrl` read; in `frame-src`, the section frames; in `style-src` and `font-src`, a book's CSS and fonts). As its
own document the page carries only its own policy, and the app needs `frame-src 'self'` plus a location that sends
the frame's headers itself (nginx drops server-level `add_header` there, #857, and those carry `frame-ancestors
'none'` and `X-Frame-Options: DENY`). Still one origin: a script past the page CSP reaches the app through `parent`
(`docs/internal/v2/v2-reader-web-hosting.md`).

```bash
pnpm -C apps/web check:reader-prod-csp   # CI, ~15 s: shell + script work under the app CSP read from nginx (EPUB, fonts, MOBI); srcdoc, header-less, foreign-framed, unfilled, un-nonced script and tampered script do not; nginx's reader locations send the handler's headers
```
