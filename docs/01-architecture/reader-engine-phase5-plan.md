# Reader engine — Phase 5 slice plan (PDF as the `fixed` layout)

Phase 5 of [ADR-025](adr/ADR-025-reader-engine-package.md): an Original-layout PDF ([ADR-012](adr/ADR-012-pdf-original-first-lazy-parse.md))
opens through `packages/reader-engine` as `layout: 'fixed'`, on web and mobile, behind a flag.
Reflow stays as it is. Old PDF code is deleted in Phase 6.

Status: **done 2026-10-14.** Owner took all 8 recommendations (see "Owner answers"). PR A #830 (slices 1–2, engine), #832 (web), #833 (mobile), #834 (`@reader-pdf` smoke + CORS `Content-Range`); owner checked web + phone; flags on for everyone: web #836, mobile EAS `EXPO_PUBLIC_READER_ENGINE_PDF=true` + OTA `6b3e3e8f`. Rollback: delete the web line and merge / `eas env:delete` + OTA. Next: Phase 6 (delete the old code), [plan](reader-engine-phase6-plan.md). Written from a read-only survey at the
end of Phase 4. Phase 3 ([plan](reader-engine-phase3-plan.md)) and Phase 4 ([plan](reader-engine-phase4-plan.md)) are done; both flags are on for everyone.

## What the engine and the apps have today (survey)

- **Engine:** no PDF code. `open()` throws on `layout !== 'reflow'` (`engine.ts:610`). Only the stored
  shapes exist: `pdfAnchorToLocator` / `locatorToPdfAnchor`, `page:<N>` in `mappers.ts`, with fixtures.
  `api.ts` already has `ChapterDoc.pdf` (`data` or `{length, read}`), `ready.pageCount`, `Style.zoom`,
  `'pdf-auth'` / `'pdf-load'`. No `pdfjs-dist` dependency in the package.
- **Two PDF viewers, same job, no shared code but the math.**
  - Web (React): `PdfOriginalView` 762 + `PdfPage` 184 + `usePdfDocument` 125 + `PdfHighlightLayer` 117
    + `pdfOriginal.css` 252. Modern pdf.js 4.10.38, lazy chunk (`ReaderOriginalPdf` → `lazy()`), Vite `?worker`.
    Loads by **URL** with `withCredentials: true` (cookie). Scrolls an **inner div**, so the bars are pinned
    (`reader-page--original`). Zoom buttons (in / out / fit, 0.2–5×) with a page anchor (`capturePageAnchor`).
  - Mobile (vanilla DOM): `apps/web/scripts/pdfViewer/entry.ts` 751, the S4b port of the web view. Legacy
    pdf.js + its worker inlined as a string and started from a Blob URL: `pdfViewerScript.generated.ts`,
    **1.8 MB**, not counted in the 64 KB budget. Loads by **URL** with `Authorization: Bearer` from
    `window.__TS_PDF`; on a 401 RN refreshes and **rebuilds the WebView** at the current page. Window scroll.
    Zoom = native WebView pinch (`setBuiltInZoomControls`), the only document where pinch is on.
    Selection and taps use the **old** `readerBridge` even with the engine flag on.
- **Shared math, both viewers:** `pdfPageWindow` (rings, `resolveOpenPage`, `readingPage`, zoom anchor),
  `pdfHighlightAnchor` (`buildPdfAnchor`, `paintRect`: rects are page-relative, unscaled),
  `pdfPersistGate` (`pdfGateReduce`, the ADR-012 open gate), `pdfResume` (`resolvePdfResumePage`,
  `chapterEndPage`, `chapterSlugForPage`), `pdfProgress` (`page:<N>`).
- **Features today, both apps:** page column with a render window, text layer, selection → highlight
  (`PdfAnchor` = page + rects + `exact`), highlight paint + tap (geometric hit test), page jump with
  `jumpId`, resume `page:<N>`, page bookmarks, newer-page toast, TOC → chapter start page.
  **Not today on either:** in-PDF search (web hides it), vocab marks, chapter-end block.
- **Host jobs that stay:** `useReaderPdfOriginal` 156 (web), `useReaderPdf` 285 + `PdfReaderChrome` 277
  (mobile): resume, gate, toasts, bookmarks, chrome, the file URL and auth.
- **Tests:** unit tests on both viewers and the shared math. **No PDF e2e** on web or mobile. The only PDF
  in the repo is `tests/TextStack.IntegrationTests/Fixtures/sample_textlayer.pdf` (613 B, one page).
  Spike check 8 (anchors on the text layer) passed off-device only.

Size: ~1,440 web lines + ~900 mobile lines (`entry.ts`, `buildPdfViewerHtml`, PDF parts of `readerBridge`)
the engine replaces; host hooks and chrome stay. `entry.ts` is the natural source: vanilla DOM, es2017,
already proven in the WebView.

## Gaps between the engine API and the hosts

1. **Where pdf.js comes from.** The engine must not bundle pdf.js (64 KB budget: 62,412 used, 3 KB free;
   the fixed layout alone is ~15–20 KB). Needs a host-given seam: today `EngineOptions` is "tests only".
2. **`read()` needs `length` first.** The API returns no file size. The host must probe (`HEAD`, or
   `Range: bytes=0-0` → `Content-Range`) before `open`. pdf.js gets bytes via `PDFDataRangeTransport`.
3. **How `read()` reports a 401.** The API does not say. Needs a rule (e.g. reject with
   `{ code: 'pdf-auth' }`), and whether the host retries inside `read()` after a refresh (no reload, no
   lost page — the mobile 17-pages-lost class goes) or the engine re-opens.
4. **Scroller.** Web PDF scrolls an inner div, the engine reflow uses the window. One model for both.
5. **Zoom.** Web: buttons → `setStyle({ zoom })`. Mobile: native pinch, the engine never sees it.
6. **`jumpId` → `opId`.** Every `goTo({ position })` emits one `relocated` with its op; `pdfGateReduce`
   is fed from engine events (like Phase 4 decision 4), deleted or kept in Phase 6.
7. **Locator on a page.** `relocated` gives `locations.position` (+ `progression` inside the page?). A text
   anchor on the text layer is optional; the stored shape stays `page:<N>` (frozen).
8. **Selection / decorations on fixed.** `selection.locator` must carry page + `ext.rects` so
   `locatorToPdfAnchor` writes today's bytes. `decorate('highlight')` paints from `ext.rects`, not ranges.
9. **No chapter on a PDF.** `href` is absent; the host maps page → chapter (`chapterSlugForPage`).
   `setFooter` / `chapterEnd` / `markWords` / `find` have no PDF use today.

## Slices (draft)

Same rules as Phases 3–4: red test first; old tests sorted keep / rewrite / drop in the PR; package,
web and mobile tests, `build`, Playwright green; the flag off changes nothing.

1. **Fixed layout core (engine only).** Port `entry.ts` into `src/fixed.ts` behind the API; pdf.js comes
   through the seam (gap 1), so jsdom tests use a fake pdf.js (pages, viewports, no canvas). `open` with
   `read()` (range transport), page column + render window (shared rings), `ready.pageCount`,
   `relocated` with `position` and the op model (replaces `jumpId`), `goTo` page, `'pdf-auth'` /
   `'pdf-load'`. Playground PDF page + a committed fixture; Playwright: a jump lands on page N, the window
   keeps the canvas count bounded.
2. **Zoom, text layer, selection, highlights (engine only).** `setStyle({ zoom })` keeps the page under
   the top line; text layer; `selection` / `hold` / `tap` / `scrollDir` over it; locator with page + rects
   (gap 8); `decorate('highlight')` + `'dot'` + `decorationTap`. Playwright: selection rects round-trip
   through `PdfAnchor`, paint sits on the text at 1× and 2×. Spike check 8 rerun on the fixture.
3. **Web adopts.** `ReaderOriginalPdf` mounts the engine instead of `PdfOriginalView`; host `read()` with
   the cookie + length probe; zoom buttons → `setStyle`; `relocated` → the page save path and gate;
   `selection` → `SelectionToolbar` / `PdfHighlightPopup`; old PDF listeners off when the flag is on.
4. **Mobile adopts.** The PDF document = engine IIFE + a PDF bundle (pdf.js, worker, `fixed.ts`) in place of
   `PDF_VIEWER_SCRIPT`; bootstrap calls `open` (bytes via `read()` inside the WebView, bearer token);
   messages feed `useReaderPdf`; token refresh without a reload (gap 3); old `readerBridge` PDF path off.
   Emulator pass on a real upload: spike check 8 on device, memory on a 300+ page PDF.
5. **Smoke on and off, then the flags.** A new web Playwright `reader-pdf` smoke (needs a PDF in the CI
   seed; none exists), flag on and off; mobile emulator pass; then the flags, web first.

Three PRs: A = slices 1–2 (engine only, ships nothing), B = slice 3 (web), C = slice 4 (mobile); slice 5
per platform after its PR. Not in Phase 5: in-PDF `find`, vocab on PDF, a text-anchor position — each
an issue.

## Questions for the owner

1. **Which app first?** (a) web first, (b) mobile first. *Recommend (a):* no bundle question, Playwright
   + playground are on web, no OTA, Phase 4 just put the engine on web; mobile follows in the same phase.
   Against it: Android is the primary platform, and `entry.ts` is the mobile code.
2. **Flags.** (a) reuse `VITE_READER_ENGINE` / `EXPO_PUBLIC_READER_ENGINE` with a per-layout check,
   (b) new `VITE_READER_ENGINE_PDF` / `EXPO_PUBLIC_READER_ENGINE_PDF`. *Recommend (b):* a PDF rollback must
   not roll reflow back; both deleted in Phase 6. Owner-only override (`?engine=pdf`) or straight on?
3. **pdf.js seam.** (a) a host option `createEngine(root, { fixed })` — a factory that brings pdf.js and
   `fixed.ts` (web: lazy `import()`, mobile: a global from the PDF bundle), (b) the engine `import()`s
   pdf.js itself, mobile marks it external, (c) raise the 64 KB budget. *Recommend (a):* one seam solves
   the budget and the boundary, and tests inject a fake. Amends ADR-025 ("hosts pass nothing").
4. **Bytes.** (a) `read()` as the ADR says (length probe, host retries after a refresh), (b) keep pdf.js
   loading by URL with headers (amend the ADR). *Recommend (a):* no fetch near the engine, and a 401 no
   longer reloads the mobile viewer. Cost: one probe request, a less-used pdf.js path.
5. **Scroller on web PDF.** (a) window scroll like mobile and reflow (bars hide on scroll, as in reflow),
   (b) keep the inner div. *Recommend (a):* one model in the engine; drops `reader-page--original`.
6. **Zoom on mobile.** (a) keep native pinch, (b) engine zoom (re-rendered, sharp) with + / − in
   `PdfReaderChrome`. *Recommend (a)* in Phase 5 (no change for users); (b) as an issue.
7. **Position.** (a) page only (`page:<N>`, as today), (b) page + a text anchor in the locator, still
   stored as `page:<N>`. *Recommend (a);* (b) waits for the normalisation note (anchors > 100 chars miss).
8. **Fixture.** (a) generate a ~40-page text PDF from a playground chapter (Chromium print, < 300 KB,
   committed), (b) a real public-domain PDF (e.g. the Raft dissertation, CC BY, a few MB). *Recommend (a)*
   for CI + (b) for the manual memory pass only, not committed.

## Owner answers (2026-10-13)

All recommendations taken: 1a web first · 2b new `VITE_READER_ENGINE_PDF` / `EXPO_PUBLIC_READER_ENGINE_PDF`,
web keeps an owner-only `?engine=pdf` override like Phase 4 · 3a host option `createEngine(root, { fixed })`
(ADR-025 amended in PR A) · 4a `read()` + length probe, host retries after a refresh · 5a window scroll on web
PDF · 6a native pinch on mobile, engine zoom → an issue · 7a page only · 8a generated ~40-page fixture in CI,
a real PDF for the manual memory pass only.

Open items that touch this phase: #813 (one redraw per highlight), #824 (e2e blind spots).
