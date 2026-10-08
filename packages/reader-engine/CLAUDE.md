# packages/reader-engine — rules

The reader engine: how a chapter is shown and where the reader is. Decision, API and plan:
[ADR-025](../../docs/01-architecture/adr/ADR-025-reader-engine-package.md). Read it first, then
[ADR-015](../../docs/01-architecture/adr/ADR-015-reader-position-is-logical.md) (position = place in the
text) and [ADR-019](../../docs/01-architecture/adr/ADR-019-reader-position-rules.md) (the 8 position rules).

## Status

Phase 1: the contract (`src/api.ts`) and the stored-shape mappers (`src/mappers.ts`). Nothing renders
yet and no app imports this package. Apps keep the old reader until each platform's flag flips.

## Boundary (enforced by `src/boundary.test.ts`)

- No imports from `apps/`, no `@/` aliases, no React / React Native / Expo.
- No `fetch` or XHR. The host loads chapters and PDF bytes; the engine is handed them.
- Import `packages/shared` by **relative path**, not `@textstack/shared`: the mobile WebView gets this
  package as an esbuild IIFE (same reason as `packages/reader-overlay`).
- Never change the chapter's text nodes. Decorations draw over the text.

## Contract

- `src/api.ts` is the contract. Changing it amends ADR-025 in the same PR.
- **Stored shapes are frozen.** `TextPosition` v1, `TextAnchor`, `PdfAnchor`, `page:<N>`,
  `chapter:<slug>`, `scroll:<slug>:<px>`: every fixture under
  `packages/shared/src/reader/__fixtures__/{anchors,stored}/` must round-trip byte-identically.
  A new stored variant adds a fixture row first.

## How we work here

- **TDD.** Behaviour → red test against the engine API → minimal code → green → refactor.
  Exceptions: the Android spike (throwaway), pixel geometry (jsdom has no layout — Playwright on the
  playground once it exists), the playground UI.
- **Old tests are reviewed, not copied.** When code moves in from an app, sort each old test:
  keep (pins a user-visible behaviour, an ADR-019 rule or an R1–R4 bug), rewrite (right behaviour,
  wrong level — e.g. a source-text wiring guard), drop (implementation detail, duplicate). Put the list
  in the PR description. Every R1–R4 bug keeps one test.
- Every bug fix adds a fixture row or a test that failed before it.
- Test seams (`EngineOptions`: `scroller`, `measure`, `schedule`, …) are for tests; hosts pass nothing.

```bash
pnpm -C packages/reader-engine test        # includes the boundary test
pnpm -C packages/reader-engine typecheck
```
