# Reader engine — rules

What `packages/reader-engine` promises its hosts (web, mobile), in plain words. Design and API:
[ADR-025](../01-architecture/adr/ADR-025-reader-engine-package.md); position rules:
[ADR-019](../01-architecture/adr/ADR-019-reader-position-rules.md); slices:
[phase 2 plan](../01-architecture/reader-engine-phase2-plan.md).

Each rule has one ID. The test that pins it starts its name with that ID
(`packages/reader-engine/src/engine.test.ts`; decorations, E13–E19, in `decorations.test.ts`). Change a rule here first, then its test, then the code.

ADR-019's eight position rules are pinned once each in `src/positionRules.test.ts` (`rule 1` … `rule 8`),
through the engine and the pure rules it re-exports from shared (`newerPosition`, `progressPrecedence`,
`pdfPersistGate`; the code moves in Phase 6). With the engine, "the reader moved" = a `'scroll'` arrived:
no pixel tolerance, so `readerMovedSince` is not re-exported. Rule 6 in the engine: a webfont that never
loads holds an `open` 4 s at most.

**Words used below.** The *reading line* is a quarter down the screen: the text there is "where the
reader is". An *op* is `open`, `goTo` or `setStyle`. An op's *ack* is the one `relocated` event that
carries its `opId`.

## Rules (owner-decided)

| ID | Rule | Why / source | Since |
|---|---|---|---|
| E1 | `open` shows the chapter, says `ready`, then acks once — before its promise resolves. | ADR-025 API rule; replaces the mobile restore ack (ADR-019 rule 3) | 2026-10-12 |
| E2 | A saved position (open or goTo) puts its sentence on the reading line. A position with only a fraction lands on that fraction. | ADR-015: position = place in the text | 2026-10-12 |
| E3 | A position from another chapter never moves to a look-alike place. `goTo`: no move, `anchor-miss` error naming the chapter, resolves `'superseded'` (not landed). `open`: opens at the top, `'start'`, same error. | Owner decision D1; ADR-015 | 2026-10-12 |
| E4 | A newer `open` / `goTo` supersedes an older one: the older resolves `'superseded'`. Every op is still acked exactly once. | ADR-019 rule 3: a stale restore lands nothing | 2026-10-12 |
| E5 | Only the reader scrolling, after the last op finished, is `'scroll'` (reading). The engine's own scrolls never are; a scroll during an op is ignored. | ADR-019 rule 7; web `wordsRead` ≈ 0, mobile M8 | 2026-10-12 |
| E6 | A style change (font size, …) keeps the same sentence on the reading line and never rebuilds the chapter. Two quick changes keep the first place. | ADR-025; R2 font-change re-anchor | 2026-10-12 |
| E7 | A style change during a restore keeps the restore target. While an op runs, "where the reader is" is its target, never the half-moved view. | ADR-019 rule 8; mobile "rebuild mid-restore saves 0" | 2026-10-12 |
| E8 | When the chapter changes size late (an image or webfont loads), the same sentence stays on the reading line, with one `'reflow'` event. No size change → no event. | ADR-025 "re-anchor on late image loads" | 2026-10-12 |
| E9 | `destroy` stops every event and empties the container, and gives it back as it was; a running op resolves `'superseded'`. | ADR-025 API | 2026-10-12 |
| E10 | Real server HTML (newlines between blocks, blocks inside blocks) behaves the same as clean HTML. | Code review of slice 3 (bug: all positions below paragraph 1 read as one) | 2026-10-12 |
| E11 | An op's ack names the place it was sent to, even when the scroll stops short (chapter top or end). | Code review of slice 3 (bug: position moved backwards on save) | 2026-10-12 |
| E12 | `ready` fires for every chapter shown, even when a `goTo` overtakes the `open`. | Code review of slice 3 (bug: host waits forever) | 2026-10-12 |
| E13 | `decorate` draws each highlight or search hit over its text; the chapter's text nodes never change. A call replaces its own group only. | ADR-025: decorations draw over the text | 2026-10-12 |
| E14 | An item from another chapter, or whose text is gone, is not drawn. Never on a look-alike place. | ADR-015; same ladder as `goTo` (quote, exact or fuzzy) | 2026-10-12 |
| E15 | Decorations follow their text: redrawn after a style change and a late reflow. They belong to their chapter: open another and its own are drawn; come back and these are again. | Web R2 "ghost highlights" / new chapter never painted | 2026-10-12 |
| E16 | A tap on a highlight or search hit emits `decorationTap` with its id and box on screen. A highlight under a search hit wins. A tap on plain text, or the click that ends a selection, emits nothing. | ADR-025 API | 2026-10-12 |
| E17 | `find` returns every match in reading order (any case, a no-break space = a space), each with 40 characters of context and a locator `goTo` and `decorate` land on. | Web in-book search (drawer list = painted hits) | 2026-10-12 |
| E18 | `markWords` underlines each saved word where it stands as a whole word, in any case; a block or a footnote ends a word. A saved phrase is marked whole, never also as its words. A call replaces the set. | Web vocab matcher, now over the chapter text | 2026-10-12 |
| E19 | With translations on, each marked word with a translation shows it above the word, drawn over the text: the chapter text, and so every anchor and position, stays the same. | STATUS "legacy `<mark>` vocab path": the root fix | 2026-10-12 |

## Before users get the engine (Phase 3)

Open items are GitHub issues labelled [`phase-3-gate`](https://github.com/mrviduus/textstack/issues?q=label%3Aphase-3-gate):
[#789](https://github.com/mrviduus/textstack/issues/789) reading line via the caret probe, like the apps;
[#790](https://github.com/mrviduus/textstack/issues/790) scroll cost on a long chapter;
[#794](https://github.com/mrviduus/textstack/issues/794) browser scroll anchoring read as the reader moving.
