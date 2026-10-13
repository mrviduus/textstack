# packages/reader-engine — rules

The reader engine: how a chapter is shown and where the reader is. Decision, API and plan:
[ADR-025](../../docs/01-architecture/adr/ADR-025-reader-engine-package.md). Read it first, then
[ADR-015](../../docs/01-architecture/adr/ADR-015-reader-position-is-logical.md) (position = place in the
text) and [ADR-019](../../docs/01-architecture/adr/ADR-019-reader-position-rules.md) (the 8 position rules).

## Status

Phase 1: the contract (`src/api.ts`) and the stored-shape mappers (`src/mappers.ts`). Phase 2
([slice plan](../../docs/01-architecture/reader-engine-phase2-plan.md)), slice 1: the `goTo`
resolution ladder (`src/resolve.ts`); slice 2: the chapter as text (`src/text.ts`); slice 3: the engine core, reflow (`src/engine.ts`: `open` / `goTo` / `setStyle` / `current` / `on` / `destroy`); slice 4: decorations (`decorate` / `find` / `markWords` / `decorationTap`, drawn on an SVG beside the chapter; `Overlayer` and `textWalker` moved in from `reader-overlay`, which re-exports them until Phase 6); slice 5: ADR-019 pure rules re-exported from shared, one pinning test per rule (`src/positionRules.test.ts`). Slice 6: events (`selection`, `hold`, `tap`, `linkClick`, `imageTap`, `scrollDir`, `chapterEnd`), `setFooter`, `clearSelection` (`src/events.test.ts`); the mobile IIFE (64 KB budget, 60 until 2026-10-12, checked by `pnpm -C apps/web check:mobile-overlay`). Slice 7: the playground (`playground/`, a Vite page on three real chapters) and Playwright geometry (E25–E27: reading line = the apps' caret probe, scroll cost); the reading line is read by the caret, the estimate is the fallback when there is none. Phase 3 gate prep: E28 double tap, E29 scroll anchoring. Phase 3 PR A + B: the mobile engine page (`apps/mobile/src/lib/readerEnginePage.ts`: position, style, selection, highlights, vocab) imports it and is the mobile bundle's entry, behind `EXPO_PUBLIC_READER_ENGINE` (on for everyone since 2026-10-12, EAS production). Phase 4 slice 1: web `ReaderSection` mounts the engine behind `VITE_READER_ENGINE` (`?engine=1` override), `useReaderScrollSync` drives it; E30 scroll anchoring off on the scroller. Phase 5 slice 1 ([plan](../../docs/01-architecture/reader-engine-phase5-plan.md)): the fixed layout (`src/fixed.ts`, PDF; E32–E37 in `src/fixed.test.ts` on a fake pdf.js, `playground/fixed.e2e.ts` on the committed fixture `playground/pdf/fixture.pdf`); the host brings pdf.js through `createEngine(root, { fixed: fixedLayout(pdfjs) })`. Apps keep the old reader until each platform's flag flips.

Engine rules in plain words (IDs `E1`… used in test names): [docs/05-features/reader-engine.md](../../docs/05-features/reader-engine.md).
Tests read as rules: plumbing (fake layout, driver) lives in `src/engine.testkit.ts`.

## Boundary (enforced by `src/boundary.test.ts`)

- No imports from `apps/`, no `@/` aliases, no React / React Native / Expo.
- No `fetch` or XHR. The host loads chapters and PDF bytes; the engine is handed them.
- Import `packages/shared` by **relative path**, not `@textstack/shared`: the mobile WebView gets this
  package as an esbuild IIFE (same reason as `packages/reader-overlay`).
- Never change the chapter's text nodes. Decorations draw over the text.
- `playground/` is not the engine: it imports web's `readReadingLine` on purpose, as the yardstick E25
  measures against (its own tsconfig carries the `@textstack/shared` alias).

## Contract

- `src/api.ts` is the contract. Changing it amends ADR-025 in the same PR.
- **Stored shapes are frozen.** `TextPosition` v1, `TextAnchor`, `PdfAnchor`, `page:<N>`,
  `chapter:<slug>`, `scroll:<slug>:<px>`: every fixture under
  `packages/shared/src/reader/__fixtures__/{anchors,stored}/` must round-trip byte-identically.
  A new stored variant adds a fixture row first.

## How we work here

- **TDD.** Behaviour → red test against the engine API → minimal code → green → refactor.
  Exceptions: the Android spike (throwaway), pixel geometry (jsdom has no layout — Playwright on the
  playground, `playground/geometry.e2e.ts`), the playground UI.
- **Old tests are reviewed, not copied.** When code moves in from an app, sort each old test:
  keep (pins a user-visible behaviour, an ADR-019 rule or an R1–R4 bug), rewrite (right behaviour,
  wrong level — e.g. a source-text wiring guard), drop (implementation detail, duplicate). Put the list
  in the PR description. Every R1–R4 bug keeps one test.
- Every bug fix adds a fixture row or a test that failed before it.
- Test seams (`EngineOptions`: `scroller`, `measure`, `schedule`, `rects`, `caret`, …) are for tests; hosts pass nothing, except `fixed` (pdf.js) for a PDF. Never import `pdfjs-dist` in `src/`.

```bash
pnpm -C packages/reader-engine test        # includes the boundary test
pnpm -C packages/reader-engine typecheck
pnpm -C packages/reader-engine test:geometry   # Playwright, real Chromium (E25–E30; PDF E33–E36)
pnpm -C packages/reader-engine playground      # http://localhost:5180/?chapter=ulysses-15
```
