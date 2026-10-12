# Reader engine — Phase 2 slice plan

Phase 2 of [ADR-025](adr/ADR-025-reader-engine-package.md): engine core, reflow, test-first;
`reader-overlay`, the DOM anchor half and the ADR-019 modules move in. **Ships nothing to users** — no
app imports the engine until Phase 3 (mobile) and Phase 4 (web).

How every slice works: a red vitest against the engine API first, then the minimum code, then green.
Old tests are sorted keep / rewrite / drop in the slice's commit. Each slice ends with
`pnpm -C packages/reader-engine test` and `typecheck` green. No slice changes `apps/` behaviour: old
code stays where it is until the platform's flag flips, and is deleted in Phase 6.

## Slices

1. **The `goTo` resolution ladder, pure.** `resolveLocator(locator, href, chapterText)` → `exact` /
   `fuzzy` / `fraction` / `legacyOffset` / `start`, or null for another chapter. Fixes the spike's
   `charOffset` tie-break test-first (it may only break a real tie). No DOM, no new dependency.
2. **The chapter as text (DOM anchor half).** One text walker (from `reader-overlay`), chapter text
   with the decoration exclusions, offset ↔ `Range`, `Range` → `Locator` (TextQuoteSelector), the
   reading-line probe. jsdom tests; the cross-app anchor fixtures must resolve to the same offsets as
   web's `createTextAnchor` and the phone's `getSelectionAnchor`.
3. **Engine core, reflow.** `createEngine` with `open` / `goTo` / `setStyle` / `current` / `on` /
   `destroy`: one `relocated` per op with its `opId` before the promise resolves, `superseded`,
   `reason:'scroll'` only after the last op settled, re-anchor on style change and late image loads.
   Test seams (`scroller`, `measure`, `viewport`, `schedule`, `observeResize`, `fontsReady`). Pins
   ADR-019 rules 3, 7 and 8 at the engine level.
4. **Decorations.** `Overlayer` moves in from `reader-overlay`; `decorate('highlight' | 'search')`,
   `find`, `markWords` with inline translations drawn over the text (no `<mark>`, no text-node
   change — the root fix for the STATUS "legacy `<mark>` vocab path" item); `decorationTap`.
5. **ADR-019 pure rules move in.** `newerPosition`, `progressPrecedence`, `pdfPersistGate` get their
   home in the engine, one pinning test each (rules 1–8 table). `readerMovedSince`'s pixel tolerance
   goes ("moved" = a `'scroll'` arrived). Shared keeps a re-export until the apps re-point.
6. **Events + mobile bundle.** `selection` (with `rect`), `hold`, `tap`, `scrollDir`, `linkClick`,
   `imageTap`, `chapterEnd`, `setFooter`; the esbuild IIFE in `apps/web/scripts/mobile-bundles.mjs`
   with the 60 KB unminified budget asserted in CI (drift-checked, not yet loaded by the app).

## Unresolved questions (owner)

1. `goTo` with another chapter's locator: no move + `'start'`, or an `error` event? (Slice 1 returns
   null and leaves it to the core.)
2. Slice 5: may shared keep thin re-exports of the moved ADR-019 modules until Phase 3/4, or should
   the apps re-point their imports in Phase 2?
3. `reader-overlay`: keep the package as a re-export until Phase 6, or delete it when the engine
   owns its code (web and the mobile bundle still import it)?
4. jsdom as a dev dependency of the engine package (slice 2), same version as `apps/web` — OK?
