# Reader engine — Phase 6 slice plan (delete the old reader)

Phase 6 of [ADR-025](adr/ADR-025-reader-engine-package.md): every platform reads through
`packages/reader-engine`, so the old reader, the four flags and the shims go. Deletion only: no new
behaviour, no API change.

Status: **done 2026-10-15** — slice 0 #843 and PR A #848 merged 2026-10-14, follow-ups #852 merged; PR B #866 (mobile, slices 3–4) merged 2026-10-15 (owner: no wait for the Play launch); PR C #868 (slice 5, cleanup) opened 2026-10-15. Left: EAS variables after the bake (#867), test review #846. Owner answered 2026-10-14 (see Owner answers), from a read-only survey right after Phase 5. All four flags are on for
everyone: mobile reflow since 2026-10-12, web reflow 2026-10-13, web + mobile PDF 2026-10-14
(`apps/web/production.env`, EAS production + OTA). The owner's prod pass of Phase 4 is still pending (STATUS).

## What is dead behind an always-on flag (survey)

Checked by grepping imports; "live" = still imported by code that runs with the flags on.

**Web reflow** (`VITE_READER_ENGINE`)
- Flag code: `lib/readerEngine.ts` 59 (`readerEngineEnabled`, both `?engine=` overrides, `READER_ENGINE*`)
  + `readerEngine.test.ts` 70. The module slot (`setMountedEngine` / `mountedEngineFor`) is **live**: used
  by `ReaderSection`, `PdfEngineView`, `ReaderHighlights`, `useHighlightEdit`, `useInBookSearch`,
  `useTextSelection`, `useReaderScrollSync`. It stays (see question 6).
- Old renderer branch in `ReaderSection` 143 (the `dangerouslySetInnerHTML` article + `ReaderOverlay`).
- Overlay layers, only rendered when `!READER_ENGINE`: `ReaderOverlay` 64, `HighlightOverlayLayer` 141,
  `VocabOverlayLayer` 130, `VocabTranslationOverlay` 123, `SearchOverlayLayer` 134, `WordHint` 140,
  `useOverlayReflow` 110, `useOverlayAnnotations` 73, `useContainerMutationObserver` 53. Traps:
  `ReaderHighlights` imports `INACTIVE_COLOR` from `SearchOverlayLayer` (move it); `ReviewedMarks` 43 and
  `TtsHighlightOverlay` 85 are **live** (TTS stays a host overlay, ADR-025).
- Old branches inside live hooks: `ReaderHighlights` 526 (the `!engineOn` block), `useTextSelection` 123
  (DOM listeners), `useInBookSearch` (the `findTextOffsets` path), `useReaderPositionSync`,
  `useReaderScrollSync` 605 (DOM capture: `readReadingLine`, `rangeAtCharOffset`, `reflowAnchorRef`,
  `captureBeforeReflow`). `lib/textAnchor.ts` 353 is **half live**: `highlightChapterKey`,
  `chapterForHighlight`, `vocabChapterId`, `findTextByAnchor`, `createTextAnchor` stay.
- `ReaderPage.tsx`: the `!READER_ENGINE` search layer and `WordHint` mount.

**Web PDF** (`VITE_READER_ENGINE_PDF`)
- `PdfOriginalView` 762, `PdfPage` 184, `usePdfDocument` 125 (the `?worker` pdf.js path),
  `PdfHighlightLayer` 117 (but `PdfEngineView` imports its `COLOR_MAP`: move it first).
- `pdfOriginal.css` 301 is **shared** with `PdfEngineView`: only the old viewer's selectors go.
  `reader.css` `.reader-page--original` rules + `pinnedOriginal` in `ReaderPage` (the pinned inner-div
  scroller, Phase 5 answer 5a). `PdfHighlightPopup` 183 is **live**.
- `pdfGateReduce`, `jumpId`, `capturePageAnchor`: **live** (`PdfEngineView`, mobile `useReaderPdf`,
  `fixed.ts`). Not dead code, a refactor (question 6).

**Mobile** (`EXPO_PUBLIC_READER_ENGINE`, `EXPO_PUBLIC_READER_ENGINE_PDF`)
- Flags: `readerEngineFlag.ts`, `readerEnginePdfFlag.ts`; branches in `useReaderDocument` and `useReaderPdf`.
- `readerHtml.ts` 1655: `buildReaderHtml` (~1,220 lines of JS in strings) and `buildPdfViewerHtml`
  (~105) go; `readerStyle`, `IMAGE_LIGHTBOX`, `buildEngineReaderHtml`, `buildPdfEngineHtml` stay.
- `readerBridge.ts` 691: `READER_SELECTION_BRIDGE` (~600) goes; `SCROLL_DIR_DETECTOR` is **live** (both
  engine documents inline it).
- Generated bundles used only by the old builders: `readerOverlayScript.ts` + `.generated` (22 KB),
  `readerAnchorScript.generated` (7 KB), their two `BUNDLES` rows in `apps/web/scripts/mobile-bundles.mjs`.
- Old PDF viewer: `apps/web/scripts/pdfViewer/entry.ts` 751 + `entry.test.ts` 352, `PDF_VIEWER_SCRIPT`
  (11 KB of the 1.9 MB generated file; `PDF_JS_SCRIPT` and `PDF_ENGINE_SCRIPT` stay) and its step in
  `pdfViewer/bundle.mjs`.
- WebView-rebuild-on-401: the `!READER_ENGINE_PDF` branches in `useReaderPdf` (rebuild at the tracked
  page) and the `token` field of `pdfDocumentKey` (always `null` with the engine). `pdfReloadNonce`,
  `rebuildRestore`, `restoreId`, `pdfInitialJump`, `pdfWritePolicy`: **live**.
- `clearSelectionJs` (`readerSelectionJs.ts`) is **live**: the engine page answers it.
- `apps/mobile/scripts/smoke-reader-html.mjs` 87: tests the old bridge only, not in CI (#815).

**Package:** `packages/reader-overlay` 194 = `index.ts` (re-exports the engine's `Overlayer` / `textWalker`)
+ `mobileBootstrap.ts` / `anchorBootstrap.ts` (the two dead mobile bundles). After the web and mobile
slices its only importer is gone. Also: aliases in `apps/web/{vite,vitest}.config.ts` + `tsconfig.json`,
`scripts/bench-reader-overlay.mjs` 205, a path in `locales/__tests__/unusedKeys.test.ts`.

**Stored shapes: not dead.** `scroll:<slug>:<px>` is written by web (`useReaderScrollSync`), the engine
(`mappers.ts`), shared (`progressPayload.ts`, `api/readingProgress.ts`), mobile sources, **the MCP server**
(`McpToolCatalog.cs` writes `scroll:<slug>:0`) and asserted by `reader-smoke.spec.ts`; the server keys
`LocatorSpace` on it, and DB rows hold it for good. `legacyScrollY` is its engine-side field.

**CI.** The main e2e gate and the full (non-blocking) suite build web with the flags **off**, so the full
suite tests a reader prod no longer ships; a second build runs three reader specs with the flags on
(`ci.yml` ~776–823). `check:mobile-overlay` checks the two dead bundles too. Mobile e2e is not in CI.

**Tests that die or move** (sort keep / rewrite / drop in each PR; every R1–R4 bug keeps one test):
- Web, ~2,800 lines: `PdfOriginalView.{jump,loadError,persistGate}`, `PdfPage`, `PdfHighlightLayer`,
  `HighlightOverlayLayer`, `SearchOverlayLayer`, `VocabOverlayLayer`, `VocabTranslationOverlay`,
  `ReaderSection.test`, `useOverlay{Reflow,Annotations}`, `useContainerMutationObserver`, `readerEngine.test`.
  **Rewrite, not drop:** `useReaderScrollSync.{test,r4,reflow}` (1,134 lines, R1–R4 pins on the DOM path).
- Mobile: `qa007.test` 457, `crossAppAnchors.test` 211 (the web↔mobile anchor pin: keep, on the engine
  page), `capturePosition.test`, `readerPositionScript` / `readerProgressScript` / `reader{R2,R3,R4,Resume}Wiring`
  (source-text guards on the old strings), `readerOverlayMobileBundle`, `readerBridgeSentence`,
  `highlightPaint`, `readerHtml.test`, `scrollDirDetector` (keep the detector half), `useReaderPersistence.test` mocks.
- Engine: #795 — the 52 `overlay` / `textWalker` tests moved from `reader-overlay`, and dead `Overlayer`
  draws (`squiggly`, `strikethrough`, `pulse`).

Size: ~6,500 lines of code + ~4,500 of tests, plus 40 KB of generated mobile scripts.

## The safety net after the flags

Today a rollback is a one-line flag change (~15 min, ADR-025 answer 1). After deletion it is a
`git revert` + deploy / OTA, the same ~15 min, if each PR stays revertable on its own. So:

1. ~~**Bake first.** No deletion PR until its flag has been on for everyone ≥ 7 days, the owner's prod pass
   for that platform is done, and nothing in Sentry or the issues is an engine regression that needs the
   old path.~~ Owner answer 1b: no bake, delete now. Mobile no longer waits for the Play launch (answer 2a, 2026-10-15).
2. **Pure deletions.** A deletion PR changes no behaviour and mixes in no refactor; then a revert is safe.
3. **A tag** `reader-legacy-final` on `main` before the first deletion: the old code stays one checkout away.
4. **EAS variables last.** Delete `EXPO_PUBLIC_READER_ENGINE*` from EAS only after the mobile PR has baked:
   a revert of that PR with the variables gone would silently switch the old reader back on.

## Slices

Same rules as Phases 3–5: tests sorted in the PR description; package, web and mobile tests, `build`,
Playwright, bundle checks green. A mobile merge is an OTA to testers (and the public after launch).

0. **CI tests what prod ships** (#843). The main e2e gate and the full suite build with
   both `VITE_READER_ENGINE*=true`; the second engine-on build goes. No user change. Old-path regressions
   are then invisible — fine, the old path has no users.
1. **Web reflow.** Remove `VITE_READER_ENGINE` + `?engine=1/0`; the old `ReaderSection` article, the overlay
   layers, `WordHint`, the DOM branches of `useTextSelection` / `useInBookSearch` / `useReaderScrollSync` /
   `ReaderHighlights` / `useReaderPositionSync`, the dead half of `textAnchor`. Rewrite the
   `useReaderScrollSync` R1–R4 pins against the engine. Closes #818 (only the dead path has the bug).
2. **Web PDF.** Remove `VITE_READER_ENGINE_PDF` + `?engine=pdf/pdf0`; `PdfOriginalView`, `PdfPage`,
   `usePdfDocument`, `PdfHighlightLayer` (move `COLOR_MAP`), old `pdfOriginal.css` selectors,
   `.reader-page--original`. `lib/readerEngine.ts` keeps only the mount slot.
3. **Mobile reflow.** Remove `EXPO_PUBLIC_READER_ENGINE`; `buildReaderHtml`, `READER_SELECTION_BRIDGE`,
   `readerOverlayScript` / `readerAnchorScript` + their `BUNDLES` rows, `smoke-reader-html.mjs` (closes #815).
   `crossAppAnchors` and the QA-007 pins move onto the engine page.
4. **Mobile PDF.** Remove `EXPO_PUBLIC_READER_ENGINE_PDF`; `buildPdfViewerHtml`, `entry.ts` + its test,
   `PDF_VIEWER_SCRIPT`, the rebuild-on-401 branches, `pdfDocumentKey.token`. Emulator smoke on one
   upload (open, jump, highlight, kill / reopen) before merge.
5. **Cleanup.** Delete `packages/reader-overlay` and its aliases / bench / test path; #795 (prune engine
   tests, dead `Overlayer` draws — changes the engine bundle, so an OTA); EAS variables (after the bake of
   slice 3–4); docs: `CLAUDE.md` "Shared Frontend Packages" (owner's file), `docs/claude/key-files.md`,
   the engine `CLAUDE.md` status, ADR-025 plan row 6 → done; `grep` for every deleted name = 0. Exception:
   the CSS variables `--reader-overlay-*` and the `data-reader-overlay` / `data-vocab-overlay` attributes keep
   their names; they are live (a rename is churn in live CSS).

Three PRs: **A** = slices 1–2 (web), **B** = slices 3–4 (mobile, one OTA), **C** = slice 5; slice 0 is a
tiny PR now.

**Not in Phase 6** (each an issue): stop writing `scroll:` + `legacyScrollY` (question 4); refactors of
live shims — `useReaderScrollSync` onto the engine's op model, `pdfGateReduce` / `jumpId` → `opId`,
the mobile `restoreId` / `readerMovedSince` protocol, the mount slot (question 6); footnote popups
(ADR-025 answer 3, after Phase 6).

## Open issues that touch this phase

- #818 web tap — fixed by the engine; closed by slice 1. #815 smoke script — closed by slice 3.
- #795 engine test pruning — slice 5.
- #792 search hit as outline — Phase 4 decision 3 said colour fill is fine: close it, or keep as a feature.
- #813 (O(N²) highlight redraw), #814 (cross-file links), #829 (scrollbar drag during a PDF jump),
  #835 (no Discuss on PDF), #811 (scroll lost on kill), #824 (e2e blind spots): engine / host bugs or
  features, **not** blocked by and not blocking the deletion. #824 matters more after slice 0, when
  e2e is the only guard left.
- #839 CI e2e builds web with the flags off = **slice 0**. #840 the `scroll:` locator, out of Phase 6.
- #841 Dim button contrast (`pdfOriginal.css`, shared, stays), #842 Android native handles on a PDF
  long press: not blocking.

## Owner answers (2026-10-14)

1b **delete now**, no bake (tag `reader-legacy-final` and EAS-variables-last still hold) · 2a web first,
mobile PR B ≥ 7 days after the Play launch (owner 2026-10-15: PR B now, no wait) · 3a three PRs + slice 0 · 4a `scroll:` later (#840) ·
5a delete `packages/reader-overlay` in slice 5 · 6a deletion only, shims → issues · 7a slice 0 now.

## Questions for the owner

1. **Bake.** (a) 7 days per flag + the owner's prod pass + quiet Sentry, (b) delete now, (c) longer (30 days).
   *Recommend (a):* earliest web PR A ~2026-10-21; it costs nothing to wait, and the PDF flags are one day old.
2. **Order.** (a) web first, mobile after the Play launch settles, (b) mobile first. *Recommend (a):* web
   rolls back by deploy, Playwright gates it, and no big OTA lands in Play launch week (~2026-10-16).
   Mobile PR B ≥ 7 days after launch.
3. **PR count.** (a) three PRs (web, mobile, cleanup) + slice 0, (b) one per slice. *Recommend (a):*
   bundle slices; reflow and PDF flags on each platform are one day apart, so they bake together.
4. **`scroll:` locator.** (a) later, its own small plan + issue, (b) in Phase 6. *Recommend (a):* it is
   written by MCP and shared code and read by the server, not only the reader; DB rows keep it, so the
   readers keep reading it for good; what replaces the write needs a decision (never `chapter:` for
   "unknown", ADR-025). ADR-025 answer 4 already says "one PR with `LocatorSpace`".
5. **`packages/reader-overlay`.** (a) delete it in slice 5, (b) keep the package. *Recommend (a):* after
   slices 1 and 3 nothing imports it; one name less in `CLAUDE.md`.
6. **Deletion only, or also the shims.** (a) Phase 6 deletes dead code only; refactors of live shims
   (scroll sync → op model, `pdfGateReduce` / `jumpId`, mobile `restoreId`, the mount slot) become
   issues, (b) do them in Phase 6. *Recommend (a):* keeps each PR a safe revert; ADR-025's "grep old names
   = 0" then means the deleted names.
7. **Slice 0 now?** (a) yes, during the bake, (b) with PR A. *Recommend (a):* today the full e2e suite
   tests the old reader, so it reports nothing about what users run.
