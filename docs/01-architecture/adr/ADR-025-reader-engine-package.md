# ADR-025 — The reader is one engine package: `packages/reader-engine`

**Status:** Accepted · **Date:** 2026-10-08 · **Supersedes:**
[`reader-engine-evaluation.md`](../reader-engine-evaluation.md) (investigation) · **Amends:**
[ADR-019](ADR-019-reader-position-rules.md) (where the rules live) · **Keeps:**
[ADR-012](ADR-012-pdf-original-first-lazy-parse.md) (PDF original-first),
[ADR-015](ADR-015-reader-position-is-logical.md) (position = place in the text),
[ADR-018](ADR-018-reingest-updates-chapters-in-place.md) · **Starts after:** Phase 0 (#774); no engine
runtime code reaches users before the Play production launch (~2026-10-16)

## Context

The reader is the main component and the one that changes most: 47 findings fixed in R1–R4 in one
week. Its logic lives in three places that are written separately:

| Where | What | Size |
|---|---|---|
| `apps/mobile/src/lib/readerHtml.ts` + `readerBridge.ts` | untyped JS inside strings, run in the WebView | 1582 + 625 lines |
| `apps/web/src/hooks/useReader*.ts`, `components/reader/**`, `lib/textAnchor.ts` | React hooks and overlay layers | ~2500 lines |
| `packages/shared/src/reader/`, `packages/reader-overlay/` | pure rules, anchor resolver, foliate overlay ports | ~1400 lines |

A fix lands in one place and misses the others: the phone has three copies of the same text walker,
and its `getRangeAnchor` lacks what web's has. Nothing stops app code from reaching into reader
internals, and no one place owns "what a reader does".

The 2026-10-05 evaluation asked how much an open-source engine would remove. A consilium on
2026-10-08 found that most of the bugs it would remove are already fixed (font-change re-anchor on both
apps in R2; ADR-019 rules in R4). The owner decided anyway, for **architecture**, not bug count: the
most-changed component gets one isolated, standards-based home with its own rules, tests, CI and agent.

## Decision

**One package, `packages/reader-engine`, owns how a chapter is shown and where the reader is.** Apps
(web React, mobile React Native) become hosts: UI and I/O only.

1. **Monorepo package, strangler migration.** Built beside the old reader; each platform switches
   one piece at a time behind a build-time flag (`VITE_READER_ENGINE`, `EXPO_PUBLIC_READER_ENGINE`);
   the old piece is deleted as soon as the new one is the default. Not a separate repository: the
   engine must meet real chapters, offline storage and stored positions from its first week.
2. **No iframe.** The engine renders into a container the host gives it — a `<div>` on web, the
   WebView document on mobile. Our HTML is sanitised on the server; an iframe would break every popup,
   selection listener and keyboard handler on web, and need a new navigation rule (a store build) on
   mobile.
3. **Scroll only.** No page-turn mode. The API stays layout-neutral (no pixels in it), so a
   `paged` layout can be added later without a redesign.
4. **One engine, two layouts.** `reflow` (server HTML, today's EPUB reader) first; `fixed` (the
   existing pdf.js original-first viewer, ADR-012) moved behind the same API second.
5. **Standards at the API, stored shapes frozen.**
   - Positions and decoration targets are a **Readium `Locator`**; text targets inside it are a
     **W3C Web Annotation `TextQuoteSelector`** (`before / highlight / after`), which our
     `TextAnchor` (`prefix / exact / suffix`) already is.
   - Nothing stored changes. Pure mappers convert, and must round-trip every row of
     `packages/shared/src/reader/__fixtures__/anchors/{web,mobile,mcp}.json` byte-identically.
   - Server contracts that stay: `TextPosition` v1 keys (`ChapterReconciler` rewrites
     `chapterSlug`), `TextAnchor` keys, `PdfAnchor` (`kind:'pdf'`), the `page:<N>` and
     `chapter:<slug>` locators, MCP's `source:'mcp'` anchor.
6. **The engine never fetches.** The host loads a chapter (IndexedDB / SQLite first, then network)
   and hands the engine HTML or PDF bytes. The reading path waits for neither a token nor the network.
7. **ADR-019's rules move into the engine, unchanged.** They stay pure functions with one home and one
   pinning test each; the hosts keep timing (debounce, flush on hide), I/O, the `?highlight=` hold and
   the newer-position toast. This replaces ADR-019's "hosts keep capture": capture is now the engine's.
8. **Built test-first.** Behaviour → red test against the engine API → code. Old tests are reviewed,
   not copied: keep / rewrite / drop, listed in each PR; every R1–R4 bug keeps one test. Exceptions:
   the spike, pixel geometry (Playwright on the playground), the playground UI.

### API (revised after the API consilium, 2026-10-08)

```ts
/** Plain rect: DOMRect serialises to {} across the WebView bridge. Viewport coordinates. */
export interface Rect { x: number; y: number; width: number; height: number }

/** Readium Locator + extension fields. */
export interface Locator {
  href?: string                                  // chapter SLUG (ADR-015); absent for a chapterless PDF
  type: 'text/html' | 'application/pdf'
  locations: {
    progression?: number                         // fraction of the chapter, 0..1
    totalProgression?: number                    // fraction of the book: `percent:<n>`, start/end sentinels
    position?: number                            // PDF page, 1-based
    charOffset?: number                          // hint, verified, never trusted
    legacyScrollY?: number                       // read/write `scroll:<slug>:<px>` until Phase 6
  }
  text?: { before?: string; highlight?: string; after?: string }   // W3C TextQuoteSelector
  ext?: { stored?: { kind: 'anchor' | 'position' | 'pdf' | 'progress'; value: string; href?: string }; rects?: PdfRect[] }
}

export interface ChapterDoc {                    // one chapter; the host loaded it
  href?: string
  layout: 'reflow' | 'fixed'
  html?: string                                  // reflow: sanitised server HTML
  pdf?: { data: ArrayBuffer } | { length: number; read(begin: number, end: number): Promise<Uint8Array> }
  lang?: string
  dir?: 'ltr' | 'rtl'
}

export type GoToResult = 'exact' | 'fuzzy' | 'fraction' | 'legacyOffset' | 'start' | 'superseded'
export type Reason = 'open' | 'goTo' | 'style' | 'reflow' | 'scroll'   // only 'scroll' is reading

export interface EngineEvents {
  ready: { opId: string; href?: string; pageCount?: number }
  relocated: { locator: Locator; reason: Reason; opId?: string }
  selection: { locator: Locator; text: string; sentence: string; source: 'hold' | 'drag'; tooLong: boolean; rect: Rect } | null
  hold: { x: number; y: number }                 // fires before the word resolves (haptic)
  decorationTap: { group: 'highlight' | 'search'; id: string; rect: Rect }
  imageTap: { src: string; alt?: string; rect: Rect }
  tap: { x: number; y: number }
  scrollDir: 'up' | 'down'
  chapterEnd: { visible: true }                  // the footer came into view, once per open
  linkClick: { href: string; internal: boolean }
  error: { code: 'pdf-auth' | 'pdf-load' | 'render' | 'anchor-miss'; detail?: string }
}

export interface Style {
  fontSize?: number; lineHeight?: number; family?: string; fontFaceCss?: string
  align?: 'start' | 'justify'
  theme?: { bg: string; fg: string; link?: string }
  insets?: { top: number; bottom: number }
  zoom?: number | 'fit'                          // fixed layout only
}

export interface ReaderEngine {
  open(doc: ChapterDoc, at?: Locator, opId?: string): Promise<GoToResult>
  goTo(at: Locator, opts?: { align?: 'reading-line' | 'center'; opId?: string }): Promise<GoToResult>
  setStyle(s: Style, opId?: string): void        // re-anchors; never rebuilds
  setFooter(el: HTMLElement | null): void        // chapter-end block: in the scroll flow, outside the text
  decorate(group: 'highlight' | 'search', items: { id: string; locator: Locator; style?: string }[]): void // replaces the group
  markWords(items: { word: string; style?: string; translation?: string }[], showTranslations: boolean): void
  find(query: string): { locator: Locator; context: string }[]
  clearSelection(): void
  current(): Locator | null                      // web; mobile keeps the last `relocated`
  on<K extends keyof EngineEvents>(e: K, cb: (p: EngineEvents[K]) => void): () => void
  destroy(): void
}

/** Options exist for tests; hosts pass nothing. */
export function createEngine(root: HTMLElement, opts?: {
  scroller?: HTMLElement
  measure?: (el: Element) => { top: number; height: number }
  viewport?: () => { height: number }
  schedule?: (cb: () => void) => void
  observeResize?: (el: Element, cb: () => void) => () => void
  fontsReady?: () => Promise<void>
}): ReaderEngine
```

Rules the types cannot say:

- **Every `open`, `goTo` and `setStyle` emits exactly one `relocated` with its `opId`, even when nothing
  moved, and before its promise resolves.** This replaces the restore ack and `restoreId`
  (ADR-019 rule 3) and `jumpId` on PDF; a newer command makes an older one resolve `'superseded'`, and
  a superseded op never counts as landed.
- **`'scroll'` means user input after the last op settled.** "The reader moved since the restore" is
  then "a `'scroll'` arrived", so `readerMovedSince`'s pixel tolerance goes.
- **Mappers are one pair per stored shape** (`TextPosition`, `TextAnchor`, `PdfAnchor`, `page:<N>`,
  `chapter:<slug>`, `scroll:<slug>:<px>`, `percent:<n>`, the `{"type":"start"|"end"}` sentinels). A locator built from a stored value carries it in
  `ext.stored` with its kind; the same kind's mapper writes it back byte-identically **only while the
  locator still says what the value says** — a moved locator writes a fresh value, and a value is never
  written back as another kind. A fresh write is either a value the readers accept or null (never
  `chapter:` for "unknown", never page 0). A
  highlight anchor has no slug, so the host passes `href` in. Fixtures for every shape (not only
  anchors) exist before the first mapper test.
- **PDF bytes come through `read()`, not a URL.** The host implements it (on mobile, in the bridge
  inside the WebView, with the bearer token); a 401 never reaches the engine as anything but
  `'pdf-auth'`. pdf.js keeps its range streaming (ADR-012's instant first paint).
- **Mobile does not inject chapter HTML through the bridge.** The document embeds the chapter as
  `<script type="application/json">` (like `window.__TS_PDF` today) and the bridge calls `open` inside
  it; `ready` replaces `onLoadEnd` as the restore trigger.
- **No legacy-global shims.** The WebView document and the RN code ship in the same JS bundle, so no
  runtime ever pairs old globals with a new document; the globals go in the release that makes the
  engine the default.
- Cut after review: a `tts` decoration group (TTS marks are drawn over the selection by the host),
  `wordTap` (a hold is a selection with `source:'hold'`).

### Engine vs host

| Engine | Host |
|---|---|
| render, theme through CSS vars, re-anchor on style change and late image loads | load chapters, offline storage, network deadlines |
| capture position, `goTo` resolution ladder, `current()` | save debounce, flush on hide, the PUT |
| ADR-019 pure rules | `?highlight=` hold, newer-position toast |
| paint highlights, search hits, vocab words + inline translations; in-chapter `find` | every popup and toolbar, bars, immersive mode, lightbox, TTS marks |
| selection, word tap, tap, scroll direction, link click (events) | bookmarks, sessions, guest triggers, TTS audio, Sentry, i18n |
| PDF: render, zoom, page window, text layer, PDF highlights | chapter-end block contents and buttons (`setFooter`); PDF `read()` with auth |

Forbidden inside the engine: imports from `apps/`, React, React Native, Expo, `fetch`, any change to
the chapter's text nodes (decorations draw over the text; `WordHint`'s `surroundContents` goes).

### Package rules

- `src/boundary.test.ts` fails the build on a forbidden import — no ESLint needed.
- `packages/reader-engine/CLAUDE.md` holds the rules; `.claude/agents/reader-engine.md` is the agent.
- Mobile gets the engine as one esbuild IIFE (`apps/web/scripts/mobile-bundles.mjs`), drift-checked,
  with a size budget (60 KB unminified; overlay + anchor are 28 KB today).
- A change to `api.ts` amends this ADR.

## Android spike results (Phase 1b, 2026-10-08)

Throwaway es2017 IIFE (one text walker, capture at the 25% line, `goTo` through the shared resolver,
re-anchor on font size) inlined into the reflow document behind a dev flag; Pixel 7 Pro emulator,
debug build, production API as a guest, *1984* Part One (35 k chars, 26.8 k px).

| # | Check | Result |
|---|---|---|
| 1 | No native change | PASS — runtime fingerprint identical before/after; no new navigation rule |
| 2 | Size / speed | PASS — 14.5 KB unminified (budget 60); one walk over 35 k chars 0.2 ms |
| 3 | Positions resolve | PASS — `goTo(capture())` exact, 20/20 exact on a sweep; `mobile.json` 12/12 with the true offset |
| 4 | Long-press selection reaches RN | PASS |
| 5 | Highlights paint | PASS |
| 6 | Font change keeps the reading line | PASS — same sentence before/after, 3–5 ms |
| 7 | Renderer crash → same place | PASS — CDP `Page.crash`; reopened about one line back (save debounce) |
| 8 | Text anchors on the PDF text layer | PASS off-device (37/37 over 40 pages of a real PDF); not run on device (needs a production upload) |

What it changes in this ADR:

- **The engine owns instant scrolling** and flushes style before it scrolls. Today's `scrollToInstant`
  could silently not move or animate; fixed in the old reader in the same PR as this section.
- **The `charOffset` tie-break must only break ties.** With no offset hint, `nearestOccurrence` in
  `resolveTextPosition` overrode a context-unique match (2 of 12 fixture rows). Not a production bug
  today — stored positions always carry their true offset — but a highlight-derived locator has none.
  Fixed test-first in Phase 2.
- **`selection.rect` is new work:** today's selection messages carry no rect.
- **The `fixed` layout normalises text:** the pdf.js text layer joins lines with no separator
  (`theconfidence`); cross-layout anchors over 100 characters would miss, because fuzzy matching stops
  at 100.

## Plan

| # | Phase | Ships to users |
|---|---|---|
| 0 | Pin today's behaviour: smoke tests, QA-007 phone checklist, one mobile fix (#774) | yes (tests, fix) |
| 1 | This ADR + API consilium; package skeleton; mappers test-first | no |
| 1b | Android spike, 8 pass/fail checks — **done 2026-10-08, all pass** (PDF off-device) | no |
| 2 | Engine core, reflow, test-first; `reader-overlay`, the DOM anchor half and the ADR-019 modules move in | no |
| 3 | Mobile adopts (flag), QA-007 rerun | yes, flag |
| 4 | Web adopts (flag), smoke runs flag on and off | yes, flag |
| 5 | PDF as the `fixed` layout | yes, flag |
| 6 | Cleanup: flags, shims, old code; grep for old names = 0 | yes |

## Alternatives rejected

- **A separate repository, migrated when done.** The engine would meet real data on the day of a big
  switch; the old reader keeps getting fixes and the engine drifts behind; two CIs and versioning for
  one consumer. The package can be moved out later in an hour if the boundary holds.
- **foliate-js or Readium ts-toolkit as the base.** Both render each section in an iframe; foliate's
  position is CFI and its API is openly unstable; Readium's WebPub does not re-anchor on resize and
  has no PDF. We keep borrowing ideas (and the overlay already is a foliate port).
- **"Engine-lite"** (only extract the shared DOM anchoring). Cheaper, and the consilium's first advice;
  rejected by the owner because it leaves the reader without one owner and one boundary.
- **Page-turn mode now.** Code, tables and wide figures break across CSS columns; our readers read tech
  books. The layout slot stays open.
- **Renaming stored fields to Readium names.** A backend migration for no user: there is no desktop
  app and no Readium consumer.

## Consequences

- One place to fix the reader; a bug fixed there is fixed on both platforms.
- About 5–6 weeks after launch, in reversible steps. Two code paths exist during the overlap; each
  phase ends with a deletion step.
- `reader-engine-evaluation.md` becomes history. ADR-019 keeps its rules; this ADR moves their home.
- No shim period on mobile: the WebView document and RN ship in one bundle. The only cross-version
  contracts are stored shapes and server data, which the mappers keep byte-identical.

## Owner answers (2026-10-08)

1. **Build-time flags only.** Rollback is a deploy (web) or an OTA (mobile), ~15 min. A remote switch
   would need a cached default (reading never waits on the network) — add it only after an incident
   shows 15 minutes is too slow.
2. **60 KB unminified for the mobile engine bundle, asserted in CI.** Raising it is a deliberate PR.
   The pdf.js bundle is separate and not counted.
3. **Footnote popups after the migration** (after Phase 6), as their own PR. A migration moves
   behaviour; it does not add features. `linkClick` already makes them possible.
4. **The `scroll:<slug>:<px>` locator is written until Phase 6**, then removed in one PR together with
   the server's `LocatorSpace` check. The engine reads it only as the last fallback (`'legacyOffset'`).
