# ADR-032 — One reader engine for V2: a fork of foliate-js, every format

**Status:** Accepted · **Date:** 2026-11-07 · **Plan:** [v2-plan.md](../v2-plan.md) §7 · **Amends:** [ADR-029](ADR-029-foliate-for-v2-epub.md) (fork instead of pin + patches; all formats; scrolled option), [ADR-012](ADR-012-pdf-original-first-lazy-parse.md) (PDF moves to foliate after a gate), [ADR-031](ADR-031-v2-schema.md) (`book_files.format` CHECK) · **Supersedes after R8:** [ADR-025](ADR-025-reader-engine-package.md) · **Keeps:** ADR-019 (position rules, over CFI), ADR-031 locator schemes · **Implementation:** [#1128](https://github.com/mrviduus/textstack/issues/1126)

## Context

ADR-029 put foliate-js behind V2 local EPUBs and left everything else where it was: reader-engine
(ADR-025) for server chapters and PDF, the pdf.js original-first viewer (ADR-012) for PDF. That
leaves V2 with **two renderers until R8**, and ADR-029 lists the cost itself: every selection,
highlight and word-tap bug fixed twice, in whichever path the book uses.

Three facts make one engine the cheaper path:

1. **foliate-js already reads more formats than we do.** Beside EPUB it ships parsers for MOBI and
   KF8 (AZW3), FB2, CBZ and a PDF adapter over pdf.js, all behind the same book interface (sections,
   TOC, CFI-addressable positions) and the same paginator/fixed-layout renderers. The prototype
   stubbed those modules out only to keep the bundle small (ADR-029 Decision 3), not because they
   failed.
2. **V2 does no server-side text extraction.** The client owns the file (v2-plan.md Story A).
   `book_chapters` and `ingestion_jobs` are transitional and are dropped at R8 / M6.4
   ([v2-plan.md](../v2-plan.md) §7, §8). MCP discussion gets its text from client shares
   (`share_chapter`, `shared_chapters`), not from a server parse. So a new format costs a client
   parser, which foliate already has, and no server parser. FB2 was dropped in #381 because the
   legacy *server* pipeline had to extract it; that reason does not exist in V2.
3. **"Pin upstream + `patches/*.patch`" does not scale to the work ahead.** ADR-029 assumed one
   small patch (the paginator render-while-loading fix). Hardening the PDF adapter and enabling four
   more formats means a stream of engine changes; a patch series re-applied on every build is the
   wrong tool for that volume, and it hides the history of each fix.

## Decision

1. **One engine for every V2 format: a fork of foliate-js.** Formats: **EPUB, MOBI, AZW3 (KF8),
   FB2, CBZ, PDF.** Each format module is loaded **lazily**, only when a book of that format opens.
2. **PDF moves to foliate.** It uses foliate's pdf.js adapter, which upstream calls experimental;
   the fork hardens it — **lazy page loading** (no up-front render of every page) and a **text
   layer for selection**, so the word features work on PDF as they do today. **Gate:** the foliate
   PDF path must open, page, select and resume on the **existing real PDF uploads** (the 22+ in
   production, ADR-031). Until it passes, the pdf.js original-first viewer (ADR-012) stays the V2
   PDF reader (plan R7 as written); after it passes, that viewer is deleted.
3. **The fork is a GitHub fork, `mrviduus/foliate-js`, consumed pinned by commit SHA.** This
   replaces ADR-029 Decision 2's "pin upstream SHA + apply `patches/*.patch` on every build". Rules:
   - **The fork carries engine fixes only** (parsing, layout, pagination, the PDF adapter). Each is
     offered upstream; one upstream accepts is dropped from the fork at the next sync.
   - **TextStack features stay in the monorepo**, in the wrapper around the engine: vocabulary,
     word-tap, inline translation, the highlights overlay. The fork never learns what a word card is.
   - **A pin bump is a PR** in this repo that re-runs every ADR-029 Decision 6 check and the PDF gate.
   - **Licence:** foliate-js is MIT © John Factotum; the fork keeps its `LICENSE` and the bundle keeps
     the notices (`legalComments: 'inline'`), plus each bundled dependency's (zip.js BSD-3-Clause;
     pdf.js Apache-2.0 once the PDF module ships).
4. **Paginated by default, scrolled as a per-user option.** Paginated is foliate's default and the
   layout the engine is built around. foliate's paginator switches between paginated and scrolled
   flow on a live view, without reloading the book, so the option is a setting, not a second
   renderer. There are no V2 users yet, so the legacy reader's scroll preference is **not migrated**.
   One cheap client telemetry event — `{mode, format, switchedInFirst5Min}` — records whether readers
   leave the default, so the default can be revisited on evidence.
5. **No server-side text extraction for new formats.** MOBI, AZW3, FB2 and CBZ files are stored and
   synced as bytes; nothing enqueues an `ingestion_jobs` row for them. EPUB and PDF keep the
   transitional extraction only while `book_chapters` lives (until R8).
6. **`packages/reader-engine` retires after R8.** Its proven parts are ported into the wrapper
   around the fork, not rewritten: `overlay.ts` (itself a port of foliate's overlayer), the
   `rangeToLocator` prefix/suffix builder the prototype already reuses, and ADR-019's position rules
   re-keyed over spine index + CFI (ADR-029 Decision 7). Until R8 it keeps serving the transitional
   server-chapter reader.
7. **Locators** (derived from 1–2, not an owner decision; confirmed or changed in the implementation issue). Reflowable formats (EPUB, MOBI, AZW3, FB2) and CBZ write `epub-cfi`, which foliate
   produces for its book types (section-level for CBZ pages). PDF keeps `pdf-page` (ADR-031), mapped from foliate's
   page-per-section index, so migrated PDF positions and highlights stay readable. The scheme-fits-file
   rule (#1122: `epub-cfi` only on `epub`/`html`) widens to the new formats with the CHECK migration.

## Consequences

**Positive**
- One renderer for V2: a selection, highlight or word-tap fix lands once. ADR-029's "two renderers
  coexist until R8" cost goes away for V2 books.
- Four formats added for the price of enabling client modules — no server parser, no extraction
  pipeline, no `book_chapters` rows.
- The engine's history is a readable git fork instead of a patch series.

**Costs**
- **Fork maintenance.** Upstream moves; syncing the fork is recurring work, and the longer a fix
  waits upstream, the more the fork diverges. Mitigation: engine fixes only, each offered upstream.
- **An experimental PDF adapter.** The fork owns its hardening until upstream catches up, and PDF is
  the format with real users today — hence the gate in Decision 2 and the old viewer kept until it
  passes.
- **Bundle growth.** Each format module (and pdf.js above all) adds weight to a page that is
  ~216 KB with them stubbed out. Formats load lazily (Decision 1); the bundle keeps its own size
  assertion per ADR-029 Decision 3, and the single inlined IIFE build has to split per-format modules
  to make lazy loading real.
- **CBZ has no text.** Selection, word-tap, translation, vocabulary and text highlights do not apply
  to comics; the wrapper hides them for that format.
- **DRM'd AZW3 is unsupported.** Encrypted files are detected and refused with a clear message; no
  DRM removal, ever.
- **Paginated default** means code blocks and wide tables can split across pages (ADR-029); the
  scrolled option is the answer, and the telemetry event says how often readers need it.
- **The format list widens in the schema and in code** (ADR-031 amendment below; `SyncValidation`'s
  format check and scheme-fits-file rule; `ReadingStateRepository`'s write SQL) — tracked in #1128.

## Alternatives considered

- **Keep ADR-029 as written: foliate for EPUB, pdf.js viewer + reader-engine for the rest.**
  Rejected: two renderers for the life of V2, and every word feature written against two
  document models (foliate's per-section iframes vs reader-engine's container).
- **Pin upstream + patches (ADR-029 Decision 2).** Fine for one patch; rejected for a hardened PDF
  adapter and four enabled formats. A fork pinned by SHA gives the same reproducibility with
  reviewable history.
- **Vendor foliate-js into the monorepo.** Rejected: it mixes engine code with TextStack features,
  which is exactly what makes upstreaming fixes hard; the fork boundary keeps them apart.
- **Keep the pdf.js original-first viewer for PDF permanently.** It works and has users. Rejected as
  the end state because it keeps a second renderer and a second overlay model; kept as the fallback
  until the PDF gate passes.
- **Server-side extraction for the new formats.** Rejected: V2 reads on the device and
  drops `book_chapters` at R8 (Context 2).

## Rollback

- **Fork:** pin back to the previous SHA (a one-line PR). Dropping the fork altogether means
  returning to upstream at a SHA plus ADR-029's patch policy for whatever fixes we still need.
- **PDF:** until the gate passes nothing changes — the ADR-012 viewer is still the reader. After the
  viewer is deleted, rollback is a revert of that deletion; PDF positions are `pdf-page` on both
  paths, so no stored data changes.
- **New formats:** turn a format's module off; its books stay in the library as files that do not
  open. The `book_files.format` CHECK can be narrowed only after such rows are removed.
- **Layout default:** a config change; the per-user option is unaffected.
