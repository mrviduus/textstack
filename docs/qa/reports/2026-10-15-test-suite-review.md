# Test suite review — 2026-10-15 (issue #846, step 1)

Scope: web unit, web e2e, mobile unit + e2e, `packages/reader-engine`, `packages/shared`.
Backend .NET is out of scope. Base: `main` @ `edadd0fb` (after Phase 6 PR C).
This is a report only. No test was changed.

All four Vitest suites were run for this report: **all green** (web 946 passed + 2 skipped,
engine 352, shared 646, mobile 831). The 2 skipped tests are `apps/web/scripts/ssgJob.test.mjs`
(they need `SSG_TEST_DATABASE_URL`), which is out of scope. No `.only` anywhere.

## Counts

| Suite | Files | Tests | Run time (sum of files) | Findings |
|---|---|---|---|---|
| web unit (`apps/web/src`) | 129 | 880 | 38 s (PdfEngineView alone: 21.6 s) | 8 |
| web e2e (`apps/web/e2e`) | 11 | ~48 | — | 7 |
| mobile unit (`apps/mobile/src`) | 91 | 831 | 26.6 s | 7 |
| mobile e2e (`apps/mobile/e2e`) | 6 | 17 | — | 1 |
| reader-engine (unit + `playground/*.e2e.ts`) | 12 + 2 | 352 + 20 | 11.8 s (fixed.test: 9.1 s) | 4 |
| shared | 48 | 646 | 1.1 s | 3 |

The short version: shared and the engine are mostly clean. Most of the mess is in four places:
web e2e (tests that assert nothing), mobile (about 130 source-text guards), real sleeps in three
big unit files (about 35 s of the 78 s total), and shared logic tested from the app folders.

Decisions: **keep** / **rewrite** / **merge** / **drop**.
"R-pin" means the test is the pin for an R1–R4 bug and must keep at least one test.

---

## Web e2e (`apps/web/e2e`)

**WE1. `reader-progress.spec.ts` (#845): tests that can pass with no assertion. Drop most of it.**
- `:77` `if (await bookLink.isVisible())` wraps the only expect (#845). Also in `bookmarks.spec.ts:181`.
- `:49` `if (chapterCount <= 1) return` and `:94` `if (enBook.chapterCount > 1)`. The CI fixture
  is a one-paragraph book, so these branches may never assert.
- `:30` `initialProgress >= 0` and `:36` `newProgress >= initialProgress` are true for a dead bar.
- 6 fixed sleeps (`:34 :67 :70 :106 :128 :131`, 500–5000 ms). All tests share one `authedPage` user.
- The behaviour (save, reload, resume) is now pinned properly by the blocking
  `reader-smoke.spec.ts` (`:191` reload, `:213` Next/Prev), which uses its own user and polls.
- Decision: **drop** the spec. Move "auto-add to library after >1%" (`:115`) and "TOC click closes
  the drawer" (`:39`) into `reader-smoke.spec.ts`, **rewritten** with polls.

**WE2. `bookmarks.spec.ts`: 4 of 7 tests assert nothing real. Rewrite as 2 tests.**
- `:28` "remove bookmark": no expect at all. `:120` "sendBeacon on unload": `beacon` is never read
  ("Just verify no crash"). `:140` "server sync": `progressRequests` is collected, never asserted.
- `:7` "add bookmark persists to IndexedDB": never reads IndexedDB; the only expect is that the TOC
  drawer opened. `:22` and `:83` put the click/asserts behind `if (isVisible())`.
- `:59` skips itself when its own button-index guess is wrong.
- 13 `waitForTimeout` calls (`:14 … :170`).
- Positional selector: `clickTopBarBtn(page, 1)` (`helpers/reader.ts:60`). The search button is
  conditional (`ReaderTopBar.tsx:81` `showSearch &&`), so index 1 is the TOC button when search is
  hidden. The buttons have titles: `getByTitle('Add bookmark')` does not drift.
- The Autosave block (`:94–186`) duplicates `reader-smoke.spec.ts`.
- Decision: **rewrite** into "add → POST seen → reload → item in the drawer" and "remove → DELETE
  seen → gone". **Drop** the Autosave block.

**WE3. `guest-landing.spec.ts`: 2 of 3 URLs no longer exist. Rewrite.**
`/en/learn-english-brazil` and `/en/learn-english-spain` were removed in #217 (`9b29317c`). The test
loads the 404 page, sees no `POST /auth/guest`, and passes. Only `/en` still tests something.
Decision: **rewrite** with today's landing pages (`/en`, `/mcp`, a book page). Keep the rule.

**WE4. Dead helpers.** `helpers/reader.ts`: `navigateToChapter` (`:42`), `goToNextPage` (`:69`,
with its own `if (isVisible())`) and `getBookmarksFromIndexedDB` (`:21`) have 0 callers.
Decision: **drop**.

**WE5. `reader-mobile.spec.ts`: only checks that classes of the deleted reader are absent**
(`:16–17`). The only spec in the `mobile` project. Decision: **drop**, or turn it into one real
mobile-viewport smoke (owner question 4).

**WE6. Weak smoke asserts** (`smoke.spec.ts` is a PR gate).
- `:17` "/en/books lists books" checks only that `main, #root` is visible.
- `:27` `/search|results|test/i` matches the header and the URL text, so a broken page passes.
- Decision: **rewrite** both to check a real element (a book card, `.search-page__input`).

**WE7. `search.spec.ts:13` waits 500 ms for a debounce before Enter.** Enter does not need the
debounce. Decision: **rewrite** (remove the sleep; the `toHaveURL` below is already a poll).

**Keep:** `reader-smoke`, `reader-pdf`, `auth`, `delete-account`, `vocabulary` (real polls, all assert).

---

## Web unit (`apps/web/src`)

**WU1. Real sleeps in `PdfEngineView.test.tsx`: 21.6 s, more than half of web unit time.**
`:64` `wait(ms)` is a real `setTimeout`: `wait(2300)` ×8 (`:286 :292 :310 …`), `wait(2500)` ×1,
`wait(50)` ×7. These wait out a debounce. Decision: **rewrite** with `vi.useFakeTimers()` +
`advanceTimersByTimeAsync`. Keep every test (it carries R4 / #853 pins).
Smaller cases, same fix: `ReaderSection.engine.test.tsx:23` (`50 ms` ×14),
`ReaderHighlights.engine.test.tsx:88` (`250 ms` ×4), `useHighlights.test.ts:307` (30 ms),
`lib/progressSync.test.ts:162` (5 ms in a loop). `setTimeout(r, 0)` microtask flushes are fine.

**WU2. One hook, three files, three naming styles: `useReaderScrollSync`** (970 lines).
`useReaderScrollSync.test.ts` (R1/R2 pins), `.r4.test.ts` (R4 pins), `.engine.test.ts`
(Phase 4 slice 1). The restore cases overlap: `engine.test.ts:48–67` (`restore_SavedTextPosition`,
`restore_NothingSaved…`) and `test.ts:45–77` ("goes to the top", "goes to the saved offset").
Decision: **merge** into one file grouped by ADR-019 rule. Keep every R1/R2/R4 pin; drop the
~5 overlapping restore cases.

**WU3. Tests of code with no live caller.**
- `lib/sentences.test.ts` (81 lines): `splitSentences` / `tokenizeWords` in `packages/shared`
  have no production caller. Sentence logic now lives in the engine (fixture `sentences.json`).
- `lib/analytics.test.ts:184–232`: `trackTranslationUsed`, `trackTtsPlayed`,
  `trackSearchPerformed`, `trackLandingCtaClick` have no caller.
- Decision: **drop** with the code (owner question 3).

**WU4. Shared code tested from the web folder.** `api/__tests__/tutor.test.ts` and
`insights.test.ts` test `@textstack/shared` API functions; the "tutor pure logic" block in
`hooks/useTutorSession.test.ts:29–85` tests `buildPlanCard` / `buildQueue` / `isSessionComplete`
(`packages/shared/src/api/tutor.ts`), which `apps/mobile/src/lib/agents.test.ts:29–84` tests again.
Decision: **merge** into `packages/shared` once; keep the hook-flow tests in web.

**WU5. Source-text guards.**
- `pages/__tests__/readerProgressSingleGet.test.ts` — R-pin (R4-5). **Keep** (only test of R4-5).
- `pages/__tests__/readerDoesNotMintOnMount.test.ts` — guest rule (ADR-014). **Keep.**
- `__tests__/sharedApiCookieMode.test.ts` — architecture guard (one api client). **Keep.**
- `hooks/__tests__/translationSentenceContext.test.tsx:53,113,119` — greps `ReaderHighlights.tsx`
  while the same file already renders the hook. **Rewrite** as behaviour, or drop the 3 guards.

**WU6. Test mirrors the parent.** `components/library/__tests__/BookInsightsSection.test.tsx:16`
`Host` re-implements the page's list/remove logic ("Mirrors the page"). The test checks the mirror,
not the page. Low. Decision: **keep**, but note it is not proof the page works.

**WU7. Long files, rule unclear from the name:** `useReaderVocabulary.test.tsx` (461),
`ReaderHighlights.engine.test.tsx` (444). Low. **Keep**; group by rule when touched.
**WU8.** `locales/__tests__/*` are lint-style key scans on web's own catalog. **Keep.**

---

## Mobile unit (`apps/mobile/src`)

**MU1. ~130 source-text guards in 29 files — the biggest mess.** Four kinds:
1. *Lint-style repo scans* (one rule, whole tree): `i18nKeys`, `i18nGolden`, `capabilityLiterals`,
   `routeLiterals`, `guestMergeWarningLiterals`, `screenFetchCount`. **Keep.**
2. *Code-shape guards that a renderHook test now covers.* `hooks/useReaderPersistence.test.ts`
   drives the real hook for C1 (`:213`), C2 (`:463`), H3 / R4 bug 3 (`:485`), rule 8 (`:306`),
   chapter change (`:516`). So these guards are now duplicates:
   - `lib/readerResumeWiring.test.ts` (all 4) → **drop**.
   - `lib/readerR4Wiring.test.ts:36–53` (bug 3) → **drop**; keep `:54–74` (bug 4 / review #2, #3)
     until a behaviour test exists.
   - `lib/readerR2Wiring.test.ts:39–64` (H3) → **drop**.
   - `lib/readerWriteTarget.test.ts:70–87` (restore follows the document) → **drop**.
   - `lib/progressRestoreOrder.test.ts` → **merge** into `useReaderPersistence.test.ts`
     ("open makes no progress request" is easy to assert on the mocked api).
3. *Absence guards* ("this old code never comes back"). They pass forever after a rename, so they
   prove little: `readerWriteTarget.test.ts:32–33,47`, `readerR4Wiring.test.ts:75`,
   `sessionMath.test.ts:109`, `rebuildRestore.test.ts:178`, `qa007.test.ts:328,329,395`,
   `appVersion.test.ts:59`, `readerSessionGate.test.ts:148`, `readerResumeWiring.test.ts:23`,
   `readerR2Wiring.test.ts:83,84,89,127,140`, `useReaderVocabActions.test.ts:154`.
   **Drop** — unless it is the last test of an R bug, then **rewrite** (owner question 5).
4. *The only test of an R2/R3 bug* (WebView / native view, no behaviour test):
   `readerR2Wiring.test.ts` H1, H2/M9/M2, M1; `readerR3Wiring.test.ts` M3, M7, L4. R-pins:
   **keep** now; rewrite as behaviour later where a hook can be rendered (owner question 1).

**MU2. `lib/qa007.test.ts`: a grab-bag named after a QA run** (405 lines, 29 tests, 14 of them
guards, slowest mobile file at 7.8 s). Its tests are about the library, downloads, PDF pages and
the hero, all in one file. Decision: **rewrite** — move each test next to the code it tests, keep
the QA-007 id in the test name, drop the absence guards (MU1.3).

**MU3. Real sleeps on the jsdom engine page.** `lib/readerEnginePage.test.ts:91,105,111,122,146,149`
(260–500 ms), `lib/readerSentence.test.ts:35` (`HELD_MS`), `lib/readerEnginePdfBundle.test.ts:59`
(a 20 ms ×100 poll — fine). The page runs in its own jsdom window, so `vi.useFakeTimers()` may not
reach it. Decision: **rewrite** to wait for the expected bridge message (poll), not a fixed time.

**MU4. `lib/crossAppAnchors.test.ts` re-tests engine code** (197 lines, 6.9 s). Since Phase 6 the
mobile page makes and resolves anchors with the engine's `rangeToLocator` / `resolveLocator`,
which `packages/reader-engine/src/text.test.ts` T2/T3 already run on the same fixtures.
Decision: **merge** — keep a few cases that prove the page's `selection` / `renderHighlight`
bridge works and the `mobile.json` regeneration; drop the per-producer loop.

**MU5. Tutor logic tested twice** — `lib/agents.test.ts:29–84` = web WU4. **Merge** into shared;
keep `exerciseBadgeColor` (mobile-only).

**MU6. Possibly dead code that only tests call:** `readerTypographyCss` (`lib/readerChrome.ts:83`,
tested in `readerChrome.test.ts:99`), `getPendingSessions` (`lib/pendingSessions.ts`).
Decision: check, then **drop** with the code if dead.

**MU7. Fake-timer leak risk.** `qa007.test.ts:358` calls `vi.useRealTimers()` in the middle of the
test, not in `afterEach`. If an expect fails before it, the next tests run on fake timers.
Low. **Rewrite** with `afterEach(() => vi.useRealTimers())`.

## Mobile e2e (`apps/mobile/e2e`)

Already cleaned earlier: no sleeps, one honest skip (`reader-smoke.spec.ts:30`). **Keep.**
**ME1. Broad text alternations** can match the tab bar on a blank screen:
`highlights.spec.ts` `/Highlights|Sign in/i`, `navigation.spec.ts:41` `/Sign in|Appearance|Language/i`,
`books.spec.ts:23` `/All|No books/`. Low. **Rewrite** to a role/testID inside the screen.

---

## Reader engine (`packages/reader-engine`)

**EN1. Real sleeps in `src/fixed.test.ts`: 9.1 s, 77 % of engine time.** `:369 :385`
(`setTimeout 200`), `:399` (5 ms), and `wait()` (`:421`) used 17 times. `:407` was already moved to
fake timers because "real timers raced the 150 ms idle window on a loaded CI runner" — the others
have the same race. Decision: **rewrite** all to fake timers (TDD, engine rules apply).

**EN2. Not every test is named by an E rule.** E-named: `engine`, `events`, `decorations`
(25/26), `fixed`, `positionRules` (rule 1–8). Not E-named: `mappers.test.ts` (28),
`text.test.ts` (T1–T4), `resolve.test.ts` (L1–L6), `overlay.test.ts` (2), `boundary.test.ts` (4).
Decision: **keep** the tests; give them rule IDs on the rules page, or record T/L as id families
(owner question 2).

**EN3.** E27, E29, E43 have no Vitest test; they live in `playground/geometry.e2e.ts:73,94,147`,
which gates the PR (`ci.yml:812`). Correct (geometry needs real layout). **Keep.**

**EN4.** `positionRules.test.ts` rule 5 overlaps `packages/shared/src/reader/newerPosition.test.ts`.
Fine: one case per rule through the engine API. **Keep both**; no more detail on the engine side.

---

## Shared (`packages/shared`)

**SH1. `reader/continueReading.test.ts` (517 lines, 34 tests) tests a test-only wrapper.**
`pickContinueReadingBook` has no production caller; it is `rankContinueReading(input)[0]`
(`continueReading.ts:81`). `rankContinueReading.test.ts` copies the fixtures "on purpose".
Decision: **merge** into one file on `rankContinueReading` (assert `[0]` where the old test did),
then drop the wrapper. Same for `continueReading.pbt.test.ts`.

**SH2. Receiving home for WU3/WU4/MU5.** `api/tutor.ts` has no shared test today; tutor,
insights and tutor-api tests move here.

**SH3. `splitSentences` / `tokenizeWords` (`text/sentences.ts`) look dead** — see WU3.

The rest of shared is clean: small pure tests, two property-based tests, no sleeps.

---

## R1–R4 pins — none of these is dropped

| Bug | Pin that stays |
|---|---|
| R1 | `apps/web/src/hooks/__tests__/useReaderScrollSync.test.ts` (#193, M4, C1/C2) |
| R2 | `useReaderScrollSync.test.ts`, `apps/web/src/hooks/useHighlights.test.ts` (M1), mobile `readerR2Wiring.test.ts` (H1, H2, M1) |
| R3 | mobile `readerR3Wiring.test.ts` (M3, M7, L4) — only pins, kept |
| R4 | `useReaderScrollSync.r4.test.ts`, `useReaderProgress.newer.test.ts`, `useUserBookProgress.test.ts`, `readerProgressSingleGet.test.ts`, `PdfEngineView.test.tsx`, mobile `useReaderPersistence.test.ts`, `readerR4Wiring.test.ts` (bug 4), `sessionMath`, `pdfInitialJump`, `readerEnginePage` |

Every guard proposed for a drop in MU1.2 has a renderHook test for the same bug in
`useReaderPersistence.test.ts`.

---

## Proposed PRs (bundled, biggest win first)

1. **PR 1 — web e2e that can fail** (WE1–WE7). Fixes #845. Drop `reader-progress.spec.ts` and
   `reader-mobile.spec.ts`, rewrite `bookmarks.spec.ts` (2 tests), fix `guest-landing` URLs, drop
   dead helpers, tighten 2 smoke asserts, use `getByTitle` not button index.
   Est. **−320 lines**. Biggest win: these are the tests that are green while broken.
2. **PR 2 — no real sleeps in unit tests** (WU1, EN1, MU3, MU7). Fake timers / polls.
   Est. **−10 lines net**, **~35 s less** test time (web 21.6 s → ~1 s, engine 9 s → ~1 s,
   mobile ~4 s), and removes the CI-race class EN1 already hit once. Engine part follows
   `packages/reader-engine/CLAUDE.md`.
3. **PR 3 — mobile source guards** (MU1.2, MU1.3, MU2, MU4). Drop duplicates and absence guards,
   split `qa007.test.ts` by feature, shrink `crossAppAnchors`. Est. **−350 lines**.
4. **PR 4 — one home per behaviour** (WU2, WU3, WU4, MU5, MU6, SH1–SH3). Merge the 3
   `useReaderScrollSync` files, move tutor/insights/sentences tests to shared, merge the two
   continue-reading files, drop dead code + its tests. Est. **−450 lines** (tests + dead code).

Total est. about −1,100 lines, no R-pin lost.

## Owner questions

1. R2/R3 mobile guards with no behaviour test: keep as guards, or rewrite as renderHook tests now?
2. Engine tests without E ids (T1–T4, L1–L6, mappers): add E ids, or keep T/L families?
3. Dead code (`splitSentences`, 4 analytics `track*`, `pickContinueReadingBook`,
   `readerTypographyCss`): delete code and tests together in PR 4?
4. `reader-mobile.spec.ts`: drop, or one real mobile-viewport smoke?
5. Absence guards ("old code never returns"): drop all, or keep those tied to an incident?
6. `guest-landing`: which URLs are the landing pages today — `/en`, `/mcp`, a book page?
