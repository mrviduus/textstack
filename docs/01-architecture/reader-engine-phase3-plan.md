# Reader engine — Phase 3 slice plan (mobile adopts)

Phase 3 of [ADR-025](adr/ADR-025-reader-engine-package.md): the mobile app reads reflow chapters
through `packages/reader-engine`, behind `EXPO_PUBLIC_READER_ENGINE`. **First phase that can ship to
users.** PDF stays on today's viewer (Phase 5). Web is Phase 4. Old code is deleted in Phase 6.

Status: **draft for the owner** (2026-10-12). Nothing here is decided until the questions at the end
are answered. Phase 2 is done ([plan](reader-engine-phase2-plan.md)); its gate issues are closed
except [#798](https://github.com/mrviduus/textstack/issues/798), which slice 1 closes.

## What changes, what stays

- **Changes (WebView side).** With the flag on, `buildReaderHtml` inlines `READER_ENGINE_SCRIPT`
  (`window.__TSEngine`, 51 KB) instead of the overlay, the anchor resolver, the selection bridge and
  the page's own position / highlight / vocab scripts. A small bootstrap creates the engine on the
  chapter container and turns engine events into `postMessage`s.
- **Stays (RN side).** `useReaderPersistence` and its ADR-019 gate (`restoreReadiness`,
  `readerWriteGate`, `applyNewer`, `rebuildRestore`) keep working unchanged: the bootstrap emits the
  messages they already read (`progress`, `restored` with its `restoreId`). The host keeps timing,
  I/O, popups, bars, WordCard, TTS, the chapter-end block (ADR-025 "Engine vs host").
- **Reading path.** Unchanged: SQLite first, then the server; nothing waits for a token or a network.
- **Release.** JS only: an OTA is enough (fingerprint unchanged unless a native dependency is added).
  Rollback = flip the env value back and publish an OTA (~15 min, ADR-025 owner answer 1).

## How the flag reaches people (the decision to make)

`EXPO_PUBLIC_*` values are baked into the JS bundle at build/OTA time. Today every tester build
(internal and closed testing) and the future public app use the same EAS `production` channel. So:

| Option | Who reads with the engine | Cost |
|---|---|---|
| **A. Off for everyone** until QA-007 passes, then on for everyone | nobody, then all | the code ships dormant; the owner tests on a dev / `preview` build |
| **B. On for everyone now** | all testers (and the public, once the app is live) | testers find bugs; a bad slice hits them all, rollback by OTA |
| **C. Testers only** | builds from the `preview` profile/channel | needs a workflow that publishes OTAs to `preview`, and testers on a second build |

STATUS also says *"production engine code only after Play launch"* (production access is expected
around 2026-10-16). Option A fits that: dormant code is not engine code in use.

## Slices

Each slice: red test first (jsdom boots the real WebView document, like
`apps/mobile/src/lib/capturePosition.test.ts`), then code; old mobile tests sorted keep / rewrite /
drop in the PR; `npx tsc --noEmit`, mobile tests, the bundle drift check green. Device check on the
emulator with real taps (adb) and Playwright over CDP, as in slice 6.

1. **Engine in the WebView, position only.** Flag branch in `buildReaderHtml`; bootstrap: `open` with
   the saved locator (mapped from `TextPosition` by `src/mappers.ts`), `relocated` → `progress`, the
   open's ack → `restored`. Restore, kill/reopen, Next/Prev keep the place. Closes #798 (taps ride on
   `click`, no Android menu after a hold) on the emulator.
2. **Style and chrome.** `setStyle` replaces `__textstackApplyTypography` (font, line height, theme,
   safe-area insets); `tap` and `scrollDir` drive the bars; `setFooter` carries the chapter-end block,
   `chapterEnd` replaces `__tsSetChapterEnd`'s visibility message.
3. **Selection and words.** `selection` (drag), `hold` (word), `clearSelection` feed the existing
   toolbar and WordCard; `linkClick` (footnotes stay links, ADR-025 answer 3), `imageTap` → lightbox.
4. **Decorations.** Highlights via `decorate('highlight')` + `decorationTap` (replaces
   `renderHighlight` / `highlightTap`); vocab via `markWords` with inline translations (replaces
   `vocabPaintJs` and the `<mark>` path, the STATUS "legacy `<mark>` vocab path" root fix); the
   `__textstackScrollToHighlight` jump becomes `goTo(…, { align: 'center' })`.
5. **QA-007 with the flag on, then the default.** The owner runs the 14 checks
   ([QA-007](../qa/scenarios/QA-007-reader-android-r1-r4.md)) on the engine; failures are fixed
   test-first; then the flag's default flips (per the decision above). The old path stays until Phase 6.

Bundle per PR: slices 1–2 and 3–4 can each be one PR if they stay small (one CI run each).

## Questions for the owner

1. Flag: **A**, **B** or **C**? (Recommended: **A**, flip after QA-007.)
2. Start before Play production access (~2026-10-16), with the flag off? (Recommended: yes; it ships
   dormant code only.)
3. PRs: one per slice, or slices 1–2 and 3–4 bundled? (Recommended: bundled.)
4. QA-007 run: you on your phone, or me on the emulator first and you after?
