# packages/reader-engine — rules

The reader engine: how a chapter is shown and where the reader is. Decision, API and plan:
[ADR-025](../../docs/01-architecture/adr/ADR-025-reader-engine-package.md). Read it first, then
[ADR-015](../../docs/01-architecture/adr/ADR-015-reader-position-is-logical.md) (position = place in the
text) and [ADR-019](../../docs/01-architecture/adr/ADR-019-reader-position-rules.md) (the 8 position rules).

## Status

All six ADR-025 phases are done (2026-10-15): web and mobile (reflow and PDF) read only through this package; the old readers are deleted. Source of truth: [ADR-025](../../docs/01-architecture/adr/ADR-025-reader-engine-package.md); per-slice history: `git log` and the changelog archive.

Engine rules in plain words (IDs `E1`… used in test names): [docs/05-features/reader-engine.md](../../docs/05-features/reader-engine.md).
Tests read as rules: plumbing (fake layout, driver) lives in `src/engine.testkit.ts` (reflow) and `src/fixed.testkit.ts` (PDF: a fake pdf.js and text layer).

## Boundary (enforced by `src/boundary.test.ts`)

- No imports from `apps/`, no `@/` aliases, no React / React Native / Expo.
- No `fetch` or XHR. The host loads chapters and PDF bytes; the engine is handed them.
- Import `packages/shared` by **relative path**, not `@textstack/shared`: the mobile WebView gets this
  package as an esbuild IIFE (`apps/web/scripts/mobile-bundles.mjs`; esbuild there has no package aliases).
- Never change the chapter's text nodes. Decorations draw over the text.
- `playground/` is not the engine: it uses `playground/readingLine.ts` (the old web caret probe, moved there) on purpose, as the yardstick E25
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
pnpm -C packages/reader-engine test:geometry   # Playwright, real Chromium (E25–E30; PDF E33–E41, spike check 8)
pnpm -C packages/reader-engine playground      # http://localhost:5180/?chapter=ulysses-15
```
