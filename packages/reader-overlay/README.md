# @textstack/reader-overlay

A thin re-export of the reader engine's overlay (`packages/reader-engine/src/overlay.ts`,
`textWalker.ts`) until Phase 6 of [ADR-025](../../docs/01-architecture/adr/ADR-025-reader-engine-package.md)
(decision D3): web and the mobile WebView bundle keep their imports. Ports of foliate-js's
`overlayer.js` and `text-walker.js` (MIT, © John Factotum).

## Consumers

- **apps/web** — imports `@textstack/reader-overlay`.
- **apps/mobile** — `src/mobileBootstrap.ts` and `src/anchorBootstrap.ts` are bundled into
  `apps/mobile/src/lib/reader{Overlay,Anchor}Script.generated.ts` by
  `pnpm -C apps/web build:mobile-overlay`; CI drift-checks them (`check:mobile-overlay`). A change to
  the engine's overlay must be regenerated.
