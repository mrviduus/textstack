# Reader engine — open-source evaluation (2026-10-05)

**Status: superseded by [ADR-025](adr/ADR-025-reader-engine-package.md) (2026-10-08).** Kept as history; several facts here are stale (font-change re-anchor was already fixed in R2, ADR-019 replaced the state machine).

~~**Status: investigation, no decision.**~~ Companion to [`reader-engine-brainstorm.md`](reader-engine-brainstorm.md).
It answers one question: if we build `packages/reader-engine` (TypeScript, web + Expo WebView), how much
can we take from open-source engines instead of writing it? Options and evidence only. The owner decides.

Sources were cloned and read, not only the READMEs. Pinned commits:

| Repo | Commit | Date |
|---|---|---|
| [foliate-js](https://github.com/johnfactotum/foliate-js) | `78914ae` | 2026-05-01 |
| [readium/ts-toolkit](https://github.com/readium/ts-toolkit) | `ca428e3` | 2026-10-02 |
| [edrlab/thorium-reader](https://github.com/edrlab/thorium-reader) | `e0dacd5` | 2026-10-05 |
| [futurepress/epub.js](https://github.com/futurepress/epub.js) | `eee359d` | 2026-03-23 |

## 1. What we have today (the baseline)

Both readers are **scroll mode, one chapter per document** (ADR-015 addendum 2026-10-03; mobile stopped
appending chapters). The chapter is server-made HTML; no client ever sees an EPUB.

| Piece | Where | Size | Notes |
|---|---|---|---|
| Text anchor resolver (`{prefix, exact, suffix}` + offset hint, Dice fuzzy match) | `packages/shared/src/reader/textAnchor.ts` | 166 | shared, DOM-free, tested |
| Reading position (`TextPosition` v1) | `packages/shared/src/reader/textPosition.ts` | 218 | ADR-015 |
| SVG overlay + text walker | `packages/reader-overlay/src/` | ~560 | **already ports of foliate-js** `overlayer.js` / `text-walker.js` (`readerOverlay.ts:2`, `textWalker.ts:2`) |
| PDF page window / resume / persist gate | `packages/shared/src/reader/pdf*.ts` | ~420 | ADR-012, ours |
| Mobile reflow document (scroll, restore, highlights, vocab, lightbox) | `apps/mobile/src/lib/readerHtml.ts` | 1566 | untyped JS in a string (highlights `:761–934`, vocab `:992–1304`) |
| Mobile DOM↔RN bridge | `apps/mobile/src/lib/readerBridge.ts` | 625 | JS in a string, shared by reflow + PDF |
| Web reader shell + restore/save | `ReaderPage.tsx` 884, `useReaderScrollSync.ts` 416, `useRestoreProgress.ts` 132, `useReadingProgress.ts` 189, `useUserBookProgress.ts` 269 | ~1900 | React DOM, no iframe |
| Mobile restore/save | `apps/mobile/src/hooks/useReaderPersistence.ts` | 483 | plus ~15 small `reader*.ts` policy modules |

We also already have the build path an engine needs on mobile: esbuild IIFE bundles injected into the
WebView (`apps/web/scripts/build-mobile-overlay.mjs`, `build-mobile-pdf.mjs`, target es2017).

## 2. Comparison

| | **foliate-js** | **Readium ts-toolkit** | **Thorium** (r2-navigator-js) | **epub.js** |
|---|---|---|---|---|
| Licence | MIT | BSD-3 (Hypothesis anchoring inside: BSD-2) | BSD-3 | BSD-2 |
| Activity, last 12 months | 15 commits, last 2026-05-01; author + ~8 contributors | 75 commits, last 2026-10-02; **66 of 75 by one person** | very active (app) | 5 commits in 2 years; last npm release 0.3.93, **2023-09** |
| Releases | **none**; README: "not stable… API may change at any time", use as git submodule (README:22–24) | npm, semver, changelog (`@readium/navigator` 2.11.1, 2026-09-30) | app releases only | stale |
| Language | plain JS, ES modules, no build | TypeScript | TypeScript | JS |
| Size | 7.1k lines total; paginator 1130, overlayer 175, search 130, tts 278 | navigator 1.3 MB unpacked npm, shared 0.97 MB, injectables 0.52 MB; ~33k lines in the 4 core pkgs | large | 6.4 MB unpacked |
| Modules separable? | **Yes.** `paginator.js`, `overlayer.js`, `search.js`, `tts.js`, `text-walker.js`, `progress.js` have **zero imports** | Partly. `@readium/shared` (models) and `@readium/decorator` (42 KB) stand alone; navigator needs all four | No — Electron `<webview>` + IPC (`r2-navigator-js/electron/renderer/dom.ts:307`) | No — one rendition/manager graph |
| Can it render **our server chapter HTML**? | Yes. Any object with `sections[i].load() → URL` is a "book" (README:88–117; `view.js:233–236`). We'd make a blob URL per chapter | Yes, best fit on paper: `WebPubNavigator` reads a Readium Web Publication (manifest + HTML resources) via a pluggable `Fetcher` (`shared/src/fetcher/Fetcher.ts:5`) | n/a | Needs an EPUB/OPF structure |
| Scroll mode | Yes, `flow="scrolled"`, one section at a time (README:173: no continuous scroll) | Yes; WebPub is scroll-only | — | Yes (continuous manager) |
| Paginated (Kindle-style pages) | Yes, CSS columns, switch without reload (README:171–178) | EPUB navigator yes; **WebPub no** | — | Yes |
| Position model | **EPUB CFI** (`view.js:431–435`, fake CFI per section index when no OPF). No text-quote | **Locator** `{href, locations{progression, totalProgression, position, fragments}, text{before, highlight, after}}` (`shared/src/publication/Locator.ts:12–144`) | r2 Locator (same family) | CFI |
| Text-quote anchoring | none (we have our own) | Yes: vendored Hypothesis `TextQuoteAnchor` + approx-string-match (`navigator-html-injectables/src/helpers/locator.ts:105–110`) | yes | none |
| Keeps place across font/resize | **Yes, structurally**: paginator holds `#anchor` = visible `Range` and re-scrolls to it on every expand (`paginator.js:441, 673, 953–958`) | Not in WebPub: on resize `WebPubSnapper` only re-reports a fraction (`WebPubSnapper.ts:166–177`) — to verify on device | — | weak (known complaints) |
| Decorations | `overlayer.js` (we already ported it) | `@readium/decorator`, groups, CSS Highlight API, hover/activate | yes | marks-pane |
| Search / TTS | `search.js` (Intl.Collator/Segmenter), `tts.js` (SSML with word marks) | content iterators, guided navigation | yes | basic |
| PDF | Experimental adapter on pdf.js, **paged fixed layout**, no scroll (`pdf.js:56–100`, `fixed-layout.js`) | **No PDF navigator** (EPUB, WebPub, Divina, Audio only) | pdf.js in Electron | no |
| Needs iframe per section | Yes (`paginator.js:213`, sandbox `allow-same-origin allow-scripts` `:244`) | Yes (`epub/frame/FrameManager.ts:34`, blob URLs `webpub/WebPubFramePoolManager.ts:163–176`) | `<webview>` | Yes |
| Inside an RN WebView | Plausible: custom elements + iframe + blob URL, all in-page; esbuild can lower `#private` to es2017. Unverified on Android | Plausible, heavier; iframe↔host comms are `postMessage` with origin checks (`comms/comms.ts:58–83`) — origin `null` in a WebView loaded from an HTML string is a risk | No | Possible, not worth it |

## 3. Verdict per candidate (reuse level)

### foliate-js — **borrow modules** (we already started)

Evidence for: MIT; modules with no imports; a "book" interface that accepts our chapters without any
EPUB; and `paginator.js` solves the exact bug class of R2 H2 ("font change lost the place") by design —
the view is anchored to a `Range`, not a pixel or a fraction. It also gives a paginated mode for free if
the product ever wants page turns.

Evidence against using it as the **base**: no releases and an openly unstable API (README:22); the
position currency is CFI, which we chose not to use (ADR-015 picked text anchors because the HTML is
re-generated on re-ingest and sanitised differently per client — CFI is a DOM path and breaks the same
way `paragraph_index` does); one main author; PDF is paged, not our continuous original-first viewer.

Concrete candidates to copy (with attribution, pinned SHA, like `reader-overlay`):
- `paginator.js` scrolled-mode core: section load into an iframe, visible-range bisect, `#anchor`
  re-apply on resize/font load. Highest value.
- `search.js` (diacritics/case via `Intl.Collator`) — only if in-book search moves client-side.
- `tts.js` word-mark SSML — only if TTS moves to word sync on the reader text.
- Skip: `view.js` (CFI glue), `epub.js`/`mobi.js`/`fb2.js` (formats live on the server), `pdf.js`.

### Readium ts-toolkit — **contract + ideas; "base" is a real option B**

Evidence for: its `Locator` is almost our `TextPosition` already (before/highlight/after,
progression); it is typed, released on npm, very active; `WebPubNavigator` is designed for "a manifest
plus HTML resources over HTTP", which is what our API serves. Using its JSON shape would make our
positions readable by any Readium app (Thorium, Readium mobile toolkits) for free.

Evidence against basing on it now: WebPub is scroll-only and, as read, does not re-anchor to text on
resize (`WebPubSnapper.ts:166–177`); a selection becomes a locator with **only** `highlight`, no
before/after (`WebPubNavigator.ts:309`) — weaker than our anchors; no PDF; ~2.8 MB unpacked across the
packages, which matters inside a WebView string; one maintainer writes ~90% of commits; iframe comms
rely on window origin, untested in RN WebView.

Concrete candidates:
- **Copy the Locator JSON field names** (no code dependency). Cheap, high value.
- `@readium/decorator` (standalone since 2026-07, 42 KB) is a possible replacement for our overlay — but
  we already own a working one, so only if ours keeps breaking.
- Compare our Dice resolver with Hypothesis `TextQuoteAnchor` on the R1/R2 fixtures; adopt whichever wins.

### Thorium — **ideas only**

Desktop Electron app; the navigator lives in `src/r2-xxx-js/r2-navigator-js/electron/` and uses
`<webview>` + IPC. Nothing transfers to a browser or RN WebView. Useful only as a reference if a desktop
app happens later — and even then the Readium ts-toolkit is the newer path.

### epub.js — **no**

Last npm release 2023-09, 5 commits in two years, EPUB-shaped input, CFI positions. foliate-js was
written as its simpler successor (README:171).

## 4. What an engine would and would not have removed (R1/R2)

Honest split of the 2026-10-05 hunt. An engine owns DOM, layout and the locator; the host keeps sync.

| Finding | Removed by an engine? |
|---|---|
| Web R2: chapter DOM rebuilt each render, killed every `Range` | **Yes** — engine owns the DOM, React never touches it |
| Web H2: font/line-height change lost the place | **Yes** with a foliate-style Range anchor; **No** with Readium WebPub as read |
| Web C2: restore ran on the old chapter's skeleton | **Yes** — `goTo` resolves only after its section loaded |
| Web H1: ghost highlights / three anchor shapes | **Yes** — one Locator type, decorations scoped per section |
| Web M1: `?highlight=` jump vs restore race | Partly — `goTo(locator)` is one path; the host still orders it |
| Mobile C1: restore never ran on slow network | Partly — engine readiness is one event; the book-id race is host |
| Web C1 (no trailing save), M4 (PUT per render), Mobile C2 (handoff), H3 (cached chapter id), mobile H1/H2 (layout choice, offline chapters), sync clock/merge | **No** — host/sync logic. Needs the separate "one restore/save state machine" |
| PDF C3 / H4 (page drift, zoom) | **No** — PDF stays our viewer |

So roughly a third of the reader findings are engine-shaped. The other two thirds need the host state
machine whatever we pick.

## 5. Minimal contract sketch

Readium-compatible field names, our semantics. Not a decision; a shape to argue about.

```ts
// Locator — a place in the text. Readium JSON shape + our extension fields.
interface Locator {
  v: 1
  href: string                  // chapter SLUG (identity; never chapterId — ADR-015 §1)
  type: 'text/html' | 'application/pdf'
  title?: string
  locations: {
    progression?: number        // fraction of the chapter  (= TextPosition.chapterFraction)
    totalProgression?: number   // fraction of the book     (computeBookProgress)
    position?: number           // PDF page, 1-based        (= today's page:<N>)
    charOffset?: number         // hint, verified, never trusted (Readium "otherLocations")
  }
  text?: { before?: string; highlight?: string; after?: string }  // = prefix / exact / suffix
}

// Publication — what the host hands the engine. No EPUB, no URLs required.
interface Publication {
  id: string                    // editionId or userBookId
  layout: 'reflow' | 'original-pdf'
  language: string; dir?: 'ltr' | 'rtl'
  readingOrder: { href: string /* slug */; title: string; words?: number }[]
}

// Engine API — no DB, no fetch; the host loads chapter HTML (SQLite first on mobile).
interface ReaderEngine {
  open(pub: Publication, load: (href: string) => Promise<string /* html */>): Promise<void>
  goTo(target: Locator | { href: string }): Promise<'exact' | 'fuzzy' | 'fraction' | 'start'>
  setStyle(p: { fontSize; lineHeight; family; align; theme }): void   // re-anchors, never rebuilds
  decorate(group: 'highlight' | 'vocab' | 'search' | 'tts', items: { id; locator: Locator; style }[]): void
  on(e: 'relocated', cb: (l: Locator, reason: 'scroll' | 'goTo' | 'style') => void): void
  on(e: 'selection' | 'wordTap' | 'decorationTap', cb: (...) => void): void
  destroy(): void
}
```

Mapping to today, no migration in phase 1: `TextPosition` ↔ `Locator` and `TextAnchor` ↔ `Locator.text`
are pure functions in both directions, so `position_json` and highlight `anchor_json` stay as stored.
The `goTo` return value is the resolution ladder `resolveTextPosition` already has, made visible to the
host (so it can tell "found the text" from "fell back to the fraction").

## 6. Risks

1. **Iframe on web.** Both serious candidates render each section in an iframe. Our web overlays and
   popups (`SelectionToolbar`, `WordPopup`, the overlay layers — 17 files in `components/reader/` measure
   rects) live in the parent DOM; each needs coordinate mapping and event forwarding. This is the
   biggest web cost. Alternative: write our scroll engine without an iframe (our HTML is already
   sanitised server-side, so isolation is less needed) and borrow only the anchor idea from foliate.
   Chapter pages are not in the SSG route set, so an iframe has no SEO cost (to confirm).
2. **Iframe inside RN WebView.** Blob-URL iframes in a document loaded from an HTML string (origin
   `null`/`about:blank`) — must be proven on Android and iOS before anything else.
3. **foliate API instability.** No releases; we would vendor a copy at a SHA and own it (as with
   `reader-overlay`). Upstream fixes then arrive by hand.
4. **Bus factor.** foliate: one author. Readium ts-toolkit: one person writes ~90% of commits.
5. **Scope trap.** An engine fixes the DOM/position class, not the sync class (§4). If the restore/save
   state machine is not done too, most of R1/R2 can come back.
6. **WebView bundle size.** Readium's packages are large for an injected string; the PDF bundle already
   inlines pdf.js. Measure before choosing.
7. **Two engines during migration.** The overlay-v2 review already warned: without a cleanup slice we
   get a second system next to the old one. Same applies here.
8. **Paginated mode is tempting and separate.** CSS-column pagination has known layout bugs
   (foliate README:171). Treat it as a product decision, not part of the engine move.

## 7. Phased plan (rough sizes; only if approved)

| # | Step | Size | Ends with |
|---|---|---|---|
| 0 | **Spike, throwaway**: foliate `paginator.js` (scrolled) fed our chapter HTML via blob URL, in the Expo WebView (Android + iOS) and on web. Check font-change re-anchor, selection forwarding, bundle size. Half a day for the same with Readium `WebPubNavigator` | 3–4 days | data for an ADR |
| 1 | ADR + `packages/reader-engine` with the Locator/Publication types and pure mappers to `TextPosition`/`TextAnchor`, tests | 2–3 days | no runtime change |
| 2 | Engine core in TS: load one section, scroll, `relocated` → Locator via `textAnchor.ts`, `goTo`, Range anchor across style change (foliate idea or code), decorations via `reader-overlay` | ~1 week | engine tested in jsdom + one Playwright page |
| 3 | Mobile adopts: replace the reflow half of `readerHtml.ts` (progress, restore, highlights, vocab) with the engine bundle via the existing esbuild IIFE path; OTA-safe if no native change | ~1 week | delete ~1000 lines of string JS |
| 4 | Web adopts: `ReaderSection` hosts the engine; overlays/popups move to engine events | 1–1.5 weeks | riskiest step |
| 5 | One restore/save state machine (host side, `packages/shared`), used by both apps | 3–5 days | removes the sync-shaped bugs |
| 6 | Cleanup slice: grep for old names returns 0 | 1–2 days | one system, not two |
| — | PDF: out of scope; only `Locator.position` = page | — | — |

Total about **4–5 weeks**, more than the brainstorm's 2–3, mainly because of step 4 and step 5.
Reuse estimate from the code read: **closer to 30% than 80%** — foliate's paginator core + what we
already took (overlay, walker) + Readium's Locator shape. The rest (anchor resolver, PDF, host sync) is
ours already or has to be.

## 8. Open questions for the owner

1. Iframe on web: accept it (foliate/Readium way) or no-iframe engine of our own?
2. Spike first (step 0) before any ADR — ok?
3. Readium Locator JSON names on the wire — want Readium compatibility, or keep our names?
4. Paginated (page-turn) mode: ever wanted? Changes how much of `paginator.js` is worth taking.
5. Vendor foliate code at a SHA (like `reader-overlay`) vs depend on npm (only Readium has releases)?
6. Restore/save state machine (step 5): do it first, without the engine? It covers more R1/R2 findings.
7. Client-side in-book search and word-synced TTS: on the roadmap? Decides `search.js` / `tts.js`.
8. Desktop app: real plan? Only then does Readium's ecosystem fit pay off.
