# Reader engine — Phase 3 slice plan (mobile adopts)

Phase 3 of [ADR-025](adr/ADR-025-reader-engine-package.md): the mobile app reads reflow chapters
through `packages/reader-engine`, behind `EXPO_PUBLIC_READER_ENGINE`. **First phase that can ship to
users.** PDF stays on today's viewer (Phase 5). Web is Phase 4. Old code is deleted in Phase 6.

Status: decided 2026-10-12 (owner answers below). Phase 2 is done ([plan](reader-engine-phase2-plan.md)).
**PR A (slices 1–2) done:** the engine page, flag off; checked on the emulator. Next: PR B (slices 3–4).

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

## Decisions (owner, 2026-10-12)

1. **Flag: B, on for everyone**, with no testers-only stage. It is switched on (EAS production env +
   OTA) once the engine page covers today's reader: after PR B and the QA-007 run. Until then it stays
   off, or testers would lose selection, highlights and vocab.
2. **Start now**, before Play production access.
3. **Two PRs:** A = slices 1–2, B = slices 3–4 (then slice 5, the switch).
4. **QA-007 on the emulator** (real taps over adb, the WebView over CDP).

## PR A — what was built and checked (2026-10-12)

- `apps/mobile/src/lib/readerEnginePage.ts`: the engine page script (bundled with the engine and the
  position mappers into `readerEngineScript.generated.ts`, 58 KB of the 60 KB budget). It answers
  `__textstackRestoreAnchor / Scroll / Percent`, `__textstackApplyTypography` and `__tsSetChapterEnd`,
  and posts `progress`, `restored`, `tap`, `chapterEnd`. `buildEngineReaderHtml` shares the old page's
  stylesheet (`readerStyle`) and keeps the old scroll-direction detector for the bars (it reveals on
  any upward move and RN resyncs it; the engine's `scrollDir` does neither yet).
- `EXPO_PUBLIC_READER_ENGINE=true` picks it in `useReaderDocument`; nothing else in RN changed.
- Emulator (dev build, flag on, Moby-Dick as a guest): the chapter shows; the chapter-end block and
  its Next button work; kill and reopen land on the same line (y 9095 → 9091); a font change keeps the
  line (26 px and back); a real tap posts one `tap` and toggles the bars; a quick double tap posts one.
  After the review fixes, again: kill/reopen y 10551 → 10543. A place saved by the engine page reopens
  on the same line in the old page (flag off), so the two can share one book during the switch.
  Found [#811](https://github.com/mrviduus/textstack/issues/811) (old page too): a kill within
  milliseconds of Home loses the last scroll.
- Found for PR B ([#798](https://github.com/mrviduus/textstack/issues/798)): a long press makes the
  WebView's own native selection (with handles) beside the engine's hold. No Android menu shows (the
  host passes no menu items), but slice 3 must stop the native one, as the old bridge does.
