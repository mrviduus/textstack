# Reader engine — Phase 4 slice plan (web adopts) — DRAFT

Phase 4 of [ADR-025](adr/ADR-025-reader-engine-package.md): the web reader (`apps/web`) reads reflow
chapters through `packages/reader-engine`, behind `VITE_READER_ENGINE`. PDF stays on today's viewer
(Phase 5). Old code is deleted in Phase 6.

Status: **draft, 2026-10-12, not decided.** Written from a read-only survey of `apps/web` at the end of
Phase 3. The next session starts with the owner's answers to the questions at the bottom.
Phase 3 (mobile) is done: [plan](reader-engine-phase3-plan.md), flag on for everyone since 2026-10-12.

## What web has today (survey)

- **One chapter per route**, the window scrolls (the engine's default scroller). No paging, no infinite
  scroll. `ReaderPage.tsx` → `ReaderReflowChapter` → `ReaderSection` (sanitises, renders the article,
  mounts `ReaderOverlay`), then `ReaderChapterDiscuss` + `ReaderNav` (Prev / Next / Finish).
- **Position:** `useReaderPositionSync` → `useReaderScrollSync` (534 lines): restore, caret reading line
  at 0.25, 1.5 s save debounce, `captureBeforeReflow`, flush on hide, `?highlight=` hold, `?direct=1`,
  ADR-019 gate. I/O in `useReaderProgress` / `useNewerPositionCheck`.
- **Selection:** native only (`useTextSelection`: mouseup / touchend / selectionchange → `{text, range, rect}`).
  One word → `WordPopup` (`useWordBubble`), more → `SelectionToolbar`. No custom hold.
- **Decorations:** all on `@textstack/reader-overlay` (`Overlayer`): highlights (`user-hl` + `reviewed-mark`
  with a dot), vocab underline + inline translations, search (active hit = outline + scroll).
  TTS is a floating bar, not marks: stays as it is (ADR-025 cut the `tts` group).
- **Images:** `ReaderHighlights` img click → `ImageLightbox`. **Links:** no handling, they navigate.
- **Settings:** inline styles on the article + `data-theme` on `<html>`. Bars: `useImmersiveMode`
  (6 px up / 48 px down, the same thresholds as the engine's `scrollDir`).
- **SSG / bots:** chapter pages are `noindex` and not prerendered; bots get the SPA. **The engine does
  not change any indexed output.**
- **Flags:** none on web today. `VITE_*` in `apps/web/production.env`, read by `images.yml` / `deploy.yml`.
  Web has no `@textstack/reader-engine` alias yet (`vite.config.ts`, `tsconfig.json`).
- **Existing bug:** a tap on the chapter does nothing (#818). The engine's `tap` fixes it.

Size: ~2,450 lines the engine replaces (scroll sync, overlay layers, `textAnchor`, selection hook);
host UI kept (popups, toolbar, lightbox, TTS, settings, drawers).

## Gaps between the engine API and web

1. **Reviewed-highlight dot.** `decorate` takes one colour per item; no custom draw or third group.
2. **Search active hit.** Today an outline + scroll; the engine has a colour per item and
   `goTo(…, { align: 'center' })` for the scroll.
3. **Range vs locator.** `WordPopup`, `TranslationPopup`, `useWordBubble` take a DOM Range + DOMRect; the
   engine gives `{locator, text, sentence, rect}`. Adapt the host (anchors via `locatorToAnchor`).
4. **Links.** The engine blocks navigation and sends `linkClick`; web needs footnote `#id` jumps,
   other-chapter links and external links (same gap as mobile #814).
5. **Desktop word lookup.** `hold` ignores the mouse, so a double-click word arrives as a one-word
   `drag` selection. Check `sentence` / `tooLong` on desktop.
6. **Theme.** Keep `data-theme` CSS on `<html>`, or move colours to `setStyle({ theme })`.
7. **Sanitising** stays in the host: `open` sets `innerHTML`.
8. **Two listener sets.** With the flag on, the old listeners (`useTextSelection`, the img click,
   `WordHint`) must not run, or popups open twice.
9. **ADR-019 gate.** Mobile fed engine events into its existing RN gate. Web can do the same (map
   `relocated` scroll events into `useReaderScrollSync`'s save path) or let the engine's op/reason model
   replace most of the hook.

## Slices (draft)

Same rules as Phase 3: red test first; old tests sorted keep / rewrite / drop in the PR; `pnpm -C apps/web
test`, `build`, Playwright green; the flag off changes nothing.

1. **Engine in the page, position only.** Alias + `VITE_READER_ENGINE`; with it on, `ReaderSection`
   mounts the engine (`open` with the saved locator), `relocated` feeds the save path, restore /
   reload / Next→Prev keep the place, typography via `setStyle`, `tap` → bars (#818).
2. **Chapter end and chrome.** `setFooter` carries `ReaderNav` + `ReaderChapterDiscuss` (React portal into
   the footer element); `chapterEnd`; `scrollDir` or keep `useImmersiveMode`.
3. **Selection and words.** `selection` / `hold` → `WordPopup`, `SelectionToolbar`, Translate / Explain;
   old listeners off when the flag is on; `imageTap` → `ImageLightbox`; `linkClick`.
4. **Decorations.** Highlights (+ the reviewed dot, gap 1), `?highlight=` jump, vocab + inline
   translations via `markWords`, search via `find` + `decorate('search')` + `goTo`.
5. **Smoke on and off, then the flag.** Playwright `reader-smoke`, `reader-progress`, `vocabulary`,
   `search`, `bookmarks` with the flag on (a second build in CI); manual pass on desktop + a phone
   browser; then `VITE_READER_ENGINE=true` in `production.env`.

Two PRs, like Phase 3: A = slices 1–2, B = slices 3–4, then slice 5.

## Questions for the owner (answer before slice 1)

1. **Flag rollout:** on for everyone after slice 5 (as mobile), or first only for you (e.g. a
   `?engine=1` / localStorage override on prod)?
2. **Reviewed-highlight dot (gap 1):** extend the engine API (a `style` that names a draw: `'dot'`),
   or drop the dot on web?
3. **Search active hit (gap 2):** accept a colour fill instead of the outline?
4. **ADR-019 gate (gap 9):** keep `useReaderScrollSync` and feed it engine events (smaller, like mobile),
   or replace it with the engine's model (deletes ~500 lines now, riskier)?
5. **Links (gap 4):** in Phase 4, footnote `#id` + external links only (other-chapter links later, #814)?
6. **Theme (gap 6):** keep `data-theme` CSS?

Open items that touch this phase: #814 (links to another file), #818 (web tap), #813 (one redraw per highlight).
