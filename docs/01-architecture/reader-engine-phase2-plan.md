# Reader engine — Phase 2 slice plan

Phase 2 of [ADR-025](adr/ADR-025-reader-engine-package.md): engine core, reflow, test-first;
`reader-overlay`, the DOM anchor half and the ADR-019 modules move in. **Ships nothing to users** — no
app imports the engine until Phase 3 (mobile) and Phase 4 (web).

Rules the engine promises, in plain words: [reader-engine.md](../05-features/reader-engine.md).

How every slice works: a red vitest against the engine API first, then the minimum code, then green.
Old tests are sorted keep / rewrite / drop in the slice's commit. Each slice ends with
`pnpm -C packages/reader-engine test` and `typecheck` green. No slice changes `apps/` behaviour: old
code stays where it is until the platform's flag flips, and is deleted in Phase 6.

## Slices

1. **The `goTo` resolution ladder, pure.** `resolveLocator(locator, href, chapterText)` → `exact` /
   `fuzzy` / `fraction` / `legacyOffset` / `start`, or null for another chapter. Fixes the spike's
   `charOffset` tie-break test-first (it may only break a real tie). No DOM, no new dependency.
2. **The chapter as text (DOM anchor half).** One text walker (from `reader-overlay`), chapter text
   with the decoration exclusions, offset ↔ `Range`, `Range` → `Locator` (TextQuoteSelector), a
   caret → position `Locator`. Finding the caret at the reading line is geometry: slice 3, with the
   `measure` seam. jsdom tests; the cross-app anchor fixtures must resolve to the same offsets as
   web's `createTextAnchor` and the phone's `getSelectionAnchor`.
3. **Engine core, reflow.** `createEngine` with `open` / `goTo` / `setStyle` / `current` / `on` /
   `destroy`: one `relocated` per op with its `opId` before the promise resolves, `superseded`,
   `reason:'scroll'` only after the last op settled, re-anchor on style change and late image loads.
   Test seams (`scroller`, `measure`, `viewport`, `schedule`, `observeResize`, `fontsReady`; slice 4 adds `rects`). Pins
   ADR-019 rules 3, 7 and 8 at the engine level.
4. **Decorations.** `Overlayer` moves in from `reader-overlay`; `decorate('highlight' | 'search')`,
   `find`, `markWords` with inline translations drawn over the text (no `<mark>`, no text-node
   change — the root fix for the STATUS "legacy `<mark>` vocab path" item); `decorationTap`.
   *Done 2026-10-12:* rules E13–E19; `reader-overlay` is now a re-export (D3); the vocab key rules
   (`tokenizeVocabWords`, `normalizeVocabKey`) moved to shared so web and the engine match the same words.
5. **ADR-019 pure rules join the engine API.** `newerPosition`, `progressPrecedence`, `pdfPersistGate`:
   the engine re-exports them from shared and owns one pinning test each (rules 1–8 table). The code
   stays in shared until Phase 6 — shared re-exporting from the engine would be an import cycle (D2).
   `readerMovedSince`'s pixel tolerance goes ("moved" = a `'scroll'` arrived).
   *Done 2026-10-12:* `src/positionRules.test.ts` pins rules 1–8; found and fixed rule 6 in the engine
   (`open` waited on `fonts.ready` with no deadline: now 4 s).
6. **Events + mobile bundle.** `selection` (with `rect`), `hold`, `tap`, `scrollDir`, `linkClick`,
   `imageTap`, `chapterEnd`, `setFooter`; the esbuild IIFE in `apps/web/scripts/mobile-bundles.mjs`
   with the 60 KB unminified budget asserted in CI (drift-checked, not yet loaded by the app).
   *Done 2026-10-12:* rules E20–E24 (`src/events.test.ts`); a `caret` test seam (jsdom has no
   `caretPositionFromPoint`). The bundle is `createEngine` alone, `window.__TSEngine`, 49 KB: the
   mappers and ADR-019 rules run in the host, not the WebView. Taps ride on `click` like
   `decorationTap`; the old bridge used `touchend` (click unreliable in the RN WebView): Phase 3 checks it on a device.
7. **Playground + Playwright geometry.** A page that runs the engine on real chapters in a real
   browser. Checks what jsdom cannot: the engine's reading line against the apps' caret probe (same
   text within one line), and scroll cost on a long chapter. Gate for Phase 3.

## Decisions (owner, 2026-10-12)

- **D1** `goTo` with another chapter's locator: **no move, and an `error` event** naming the locator's
  chapter. Always a host bug; a silent jump to the start would hide it (ADR-015).
- **D2** ADR-019 rules: **code stays in shared, the engine re-exports it**; moves in Phase 6 when the
  apps switch. No `apps/` change in Phase 2, no shared ↔ engine import cycle.
- **D3** `reader-overlay`: **kept as a thin re-export of the engine until Phase 6** (web and the mobile
  bundle keep their imports; no OTA).
- **D4** jsdom as an engine dev dependency (catalog version): **OK** (merged in #786).
