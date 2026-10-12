# Reader engine — rules

What `packages/reader-engine` promises its hosts (web, mobile), in plain words. Design and API:
[ADR-025](../01-architecture/adr/ADR-025-reader-engine-package.md); position rules:
[ADR-019](../01-architecture/adr/ADR-019-reader-position-rules.md); slices:
[phase 2 plan](../01-architecture/reader-engine-phase2-plan.md).

Each rule has one ID. The test that pins it starts its name with that ID
(`packages/reader-engine/src/engine.test.ts`; decorations, E13–E19, in `decorations.test.ts`; events, E20–E24 and E28, in `events.test.ts`; geometry on real chapters in Chromium, E25–E27 and E29, in `playground/geometry.e2e.ts`). Change a rule here first, then its test, then the code.

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
| E20 | A drag selection in the chapter, once it stops changing (220 ms), emits `selection` (`source:'drag'`): its text, its sentence, a locator `goTo` and `decorate` land on and its box on screen. Over 500 characters it is still sent, with `tooLong`. A drag running on past the chapter is its part in the chapter; the same text is never sent twice. When it goes away, or another `open` replaces it: `null`. | Mobile bridge: iOS fires `selectionchange` mid-drag; server translate/TTS cap 500 | 2026-10-12 |
| E21 | A finger held still 450 ms on a word emits `hold`, then a `selection` of the whole word (soft hyphens and `’` inside it; `source:'hold'`), marked over the text; the page's own selection is never touched (Android would open its menu). Moving 8 px cancels; a hold on a link does nothing. `clearSelection` removes the mark. | Mobile word hold; SEL-1 (the mark stays while the toolbar is open) | 2026-10-12 |
| E22 | A tap emits one event: a link `linkClick` (relative = `internal`; the page never navigates), an image `imageTap`, a highlight or search hit `decorationTap` (E16), else `tap`. The click that ends a selection or a hold, and a tap on the footer, emit nothing. | ADR-025 events; mobile lightbox skips images inside links | 2026-10-12 |
| E23 | Reader scrolling emits `scrollDir` when the direction changes: `'down'` after 48 px, `'up'` after 6 px (hide the bars late, show them early). The engine's own scrolls never do. | Mobile scroll-direction detector | 2026-10-12 |
| E24 | `setFooter` puts the host's block after the chapter, in the scroll flow but outside its text (positions, `find`, decorations unchanged). `chapterEnd` fires once per open, when the footer comes into view: by scrolling, an op, a style change or a reflow. | ADR-025: chapter-end block contents stay the host's | 2026-10-12 |
| E25 | In a browser the engine reads the reading line with the caret, like the apps: its place is on the line web's caret probe reads. With no caret API it estimates per block (jsdom test). | [#789](https://github.com/mrviduus/textstack/issues/789): the old estimate was off by up to 226 px | 2026-10-12 |
| E26 | `goTo` puts the place's line on the reading line. Until the reader scrolls, `current()` is that place exactly: open and save without a scroll never drifts. | #789; ADR-015 | 2026-10-12 |
| E27 | Reading the place on a reader scroll costs under 4 ms a frame (a quarter of one at 60 fps) on a long chapter (Ulysses XV, 2760 table cells), CPU 4× slower. | [#790](https://github.com/mrviduus/textstack/issues/790): 6.3 ms before, 0.4 ms with the caret, 0.1 ms with element carets found by binary search ([#804](https://github.com/mrviduus/textstack/issues/804)) | 2026-10-12 |
| E28 | A second tap within 300 ms of a `tap` is a double tap and emits nothing: the bars toggle once. The first tap is sent at once, never held. | [#799](https://github.com/mrviduus/textstack/issues/799), owner choice; the old bridge held every tap 300 ms | 2026-10-12 |
| E29 | The chapter growing above the reading line (an image loads) is one `'reflow'`, never `'scroll'`, even with the browser's scroll anchoring on. | [#794](https://github.com/mrviduus/textstack/issues/794): the engine's re-anchor lands on the scrollTop it set, so the anchored scroll is its own | 2026-10-12 |

## Before users get the engine (Phase 3)

Open items are GitHub issues labelled [`phase-3-gate`](https://github.com/mrviduus/textstack/issues?q=label%3Aphase-3-gate):
[#798](https://github.com/mrviduus/textstack/issues/798) taps ride on `click`, and no Android menu after a hold: check in the WebView (needs the engine loaded there: the first step of Phase 3).
