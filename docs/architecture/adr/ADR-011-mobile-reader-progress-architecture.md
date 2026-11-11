# ADR-011: Mobile Reader — Progress Tracking Architecture

## Status
Accepted

> **Partly superseded.** §2 (two sibling hooks `useReaderProgress` / `useUserBookProgress`) was reversed on 2026-06-09 (#292): both were deleted and replaced by one `apps/mobile/src/hooks/useReaderPersistence.ts` shared by both readers. The position format is now governed by [ADR-013](ADR-013-reader-position-model.md) and [ADR-015](ADR-015-reader-position-is-logical.md).

## Date
2026-05-23

## Platform priority

**Android first, iOS second.** TextStack is in iOS testing phase as of
2026-05-23; the Play Store launch is the active deadline. Every decision
below was made with Android constraints as the primary forcing function:

- **OS-kill behavior**: Android may evict a backgrounded app silently
  (Doze, low memory, manufacturer OEM aggression). React Native's
  `useEffect` cleanup does NOT run on OS-kill. iOS in contrast keeps
  apps suspended in memory for hours and gives ~5s of UIApplicationState
  background time. Conclusion: `useFlushOnBackground` is non-negotiable
  for Android; on iOS it's a nice-to-have safety net.
- **WebView differences**: Android WebView (Chromium-based) needs
  `androidLayerType="hardware"` for smooth scroll on long-form content;
  iOS WKWebView composites on GPU by default.
- **Selection menu**: Android's long-press shows the system Copy/Share/
  Search callout that competes with our SelectionActionBar. Both
  platforms get `menuItems={[]}` to suppress.

References:
- [Android Doze + App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby)
  — explains the OS-kill behavior that motivates `useFlushOnBackground`.
- [React Native AppState API](https://reactnative.dev/docs/appstate)
  — `'background' | 'inactive' | 'active'` semantics. Both states are
  treated as "about to be evicted" for flush purposes.
- [Expo Router state management](https://docs.expo.dev/router/reference/navigation-state/)
  — explains why nav state can survive a warm start and motivated the
  `ColdResetOnResume` component.

## Context

Mobile has two reader code paths:

1. **Catalog reader** — `apps/mobile/app/reader/[bookSlug]/[chapterSlug].tsx`,
   reads from the public library (Edition + Chapter entities). Server stores
   per-edition progress with chapterId/chapterSlug/percent and supports
   multi-device sync via `readingProgressApi`.

2. **User-book reader** — `apps/mobile/app/my-books/read/[bookId]/[chapterSlug].tsx`,
   reads user-uploaded EPUB/PDF/FB2 (UserBook + UserChapter entities).
   Server stores per-user-book progress (chapterSlug + locator + percent)
   but does NOT store a book-wide percent — there's no canonical
   `totalWordCount` exposed by `GET /me/books/{id}/progress`.

The two paths share UX (WebView reader, selection toolbar, progress
footer) but differ in:

- IDs (editionId+chapterId vs userBookId+userChapterId)
- API surface (`/me/progress/*` vs `/me/books/{id}/progress`)
- Offline support (catalog has full offline cache, user-books don't)

Pre-2026-05-23, the user-book reader had ~80 lines of inline progress-save
logic that duplicated `useReaderProgress` (catalog) in structure, with
ad-hoc differences. Mobile bug sweep surfaced four problems:

1. Footer % showed chapter percent, not book percent (reset to 0% on each
   chapter — felt like no progress through the book).
2. After Save Word, the selection toolbar didn't close — looked broken.
3. App opened on "random screens" after a long background (Expo Router
   preserves nav state, looked like a cold launch mid-book).
4. TOC sheet rendered empty silently when chapters list hadn't loaded.

## Decision

### 1. Book-progress is computed client-side, never stored server-side

Reader UIs derive book-wide percent from `chapters[]` + `chapterSlug` +
`chapterProgress` at render time. The formula
(`computeBookProgress` in `@textstack/shared/reader/bookProgress`) is
unit-tested (30 cases, monotonicity invariant) and shared between both
mobile reader paths and any future web/desktop reader.

**Why client-side**:

- Avoids a backend schema change for `bookPercent` on the catalog `ReadingProgress`
  and `UserBook.progressPercent` entities.
- A single source of truth (chapter list + current slug + chapter %) means
  no risk of catalog/user-book progress drifting from each other server-side.
- Cross-device consistency falls out for free: if web reads the same
  chapters + chapterSlug + chapterProgress, it computes the same book %.

**Storage**: book-percent is also cached locally (AsyncStorage) so the
home `ContinueReadingCard` doesn't need to fetch + compute on every
mount. The cache is a hint, not a source of truth — it can be wiped at
any time and will rebuild from the next reader session.

### 2. Two sibling hooks, not one polymorphic hook

`useReaderProgress` (catalog) and `useUserBookProgress` (user-book) are
maintained as sibling hooks with an identical CONTRACT:

```
{ saveProgress(): void, bumpProgress(): void }
```

…but separate implementations because the differences (API surface,
local offline cache, idempotency) would force a polymorphic hook into
either runtime branching (`if (mode === 'catalog')`) or a config-object
abstraction that hides what's actually happening. Senior call: two
small clear files > one large config-driven file.

Cross-cutting concerns ARE extracted:

- `useFlushOnBackground(flush)` — AppState background → call flush
  (Android OS-kill mitigation). Removes 8 LOC duplication, one place to
  evolve behavior (e.g. add Notification-tap flushing later).
- `buildUserBookProgressPayload()` — pure payload builder for the user-book
  PUT body. Lives in `@textstack/shared/reader/progressPayload`, fully
  unit-tested. Hook becomes orchestration-only (refs → builder → I/O).
- `computeBookProgress()` — pure, in shared, both readers and any future
  reader consume it.

### 3. Cold-reset on long background is route-aware

After 30 min of background, the app resets navigation to home — UNLESS
the user was on a protected reader route (`/reader/*` or `/my-books/read/*`).
Reading sessions are intentional and resumeable (Kindle/Apple Books model);
random nav (library/discover/stats) resets fresh.

The AppState listener is isolated in a `ColdResetOnResume` component
that returns `null` so its `usePathname()` subscription doesn't re-render
the whole Stack tree on every navigation (perf-critical for the WebView
mount cost in the reader).

### 4. Storage key namespaces are explicit, not inherited

`reading.progress.` (catalog) and `reading.progress.userbook.` (user-book)
overlap by string prefix. To prevent a `startsWith('reading.progress.')`
filter from accidentally pulling in user-book rows (different shape,
silent corruption on UUID collision), an `isCatalogKey()` helper
encodes the exclusion. `clearAllLocalProgress` lists both prefixes
explicitly. This is the explicit-coupling-by-name approach (vs. inherited
namespaces) — clearer at call sites and survives prefix renames.

## Consequences

**Positive**:

- Book-% works identically for catalog and user-books with no backend
  changes. Multi-device consistency follows from same-formula clients.
- Reader bug surface is shrunk to ~3 files (the two readers + shared
  utilities); hook contracts let future readers (e.g. web-based PWA
  reader for user-books) reuse the same patterns.
- 65 unit tests guard the pure logic against regression.

**Negative**:

- Two hook files instead of one. Risk of drift if behavior diverges.
  Mitigation: shared utilities for the cross-cutting parts, identical
  return-shape contract enforced by convention.
- Book-% cache is per-device. A user reading on web then opening mobile
  will see a stale book-% until the first scroll triggers a recompute
  + cache write (no visible impact since the chapter slug is shared and
  the formula produces the same value).

## Future work

- When backend ships `totalWordCount` on `GET /me/books/{id}/progress`
  responses, the user-book reader can fetch it instead of computing
  from the chapter list — slightly cheaper on books with hundreds of
  chapters. Not blocking.
- If a third reader emerges (web PWA for user books?), extract a
  `createReaderProgressHook(config)` factory rather than copy-paste.
  Pattern: two sibling hooks is fine, three is a smell.
- E2E tests for save-flow + TOC + selection close exist in
  `apps/mobile/e2e/tests/reader-smoke.spec.ts` — extend with the bug-sweep
  scenarios once we have a stable Playwright reader fixture for the
  WebView's selection events.

## Tested by

Pure logic + wire-format builders/parsers extracted to `@textstack/shared`
are covered by unit + property-based tests (Vitest). As of 2026-05-23:

| Module | Hand-crafted tests | Property-based | Coverage (stmts/branches) |
|---|---|---|---|
| `bookProgress.ts` | 30 | — | 100% / 90% |
| `progressPayload.ts` | 45 | 4 (~1300 cases) | 100% / 97% |
| `continueReading.ts` | 29 | 5 (~1000 cases) | 100% / 100% |
| `lib/pathPrefix.ts` | 16 | — | 100% / 100% |
| **Total** | **120** | **9 properties** | — |

Uncovered branches are defensive dead code (e.g. `parseInt` after a
strict-digits regex check, `?? 0` after a successful `typeof === 'number'`
guard) — the type system guarantees they can't fire at runtime.

Reader integration / WebView interaction (selection, save flow, scroll
restore) is verified manually on Android device. The TOC regression case
is also guarded by `apps/mobile/e2e/tests/reader-smoke.spec.ts` (the
shell test that catches "TOC sheet renders empty silently", which was
the original bug).

Hooks (`useReaderProgress`, `useUserBookProgress`, `useFlushOnBackground`)
intentionally have no unit tests — they're thin orchestrators over the
pure builders + AppState API. Testing them would require a full RN
testing-library setup whose maintenance cost exceeds the regression risk
on ~20-line orchestration code. Decision logged here; revisit when a
third reader (e.g. web PWA for user-books) appears.

## See also

- **ADR-007** (Reader Auto-Save Strategy, 2026-01-19) — describes the
  per-chapter percent persistence layer that this ADR builds on top of.
  Cadence (2s debounce), trigger semantics (stable-position detection),
  and offline-first storage are inherited from ADR-007 and apply here.

## References

- `packages/shared/src/reader/bookProgress.ts` + `.test.ts` (30 tests)
- `packages/shared/src/reader/progressPayload.ts` + `.test.ts` (45 tests
  — payload builder + scroll-locator parser)
- `packages/shared/src/reader/continueReading.ts` + `.test.ts` + `.pbt.test.ts`
  (LWW picker, 26 hand-crafted + 5 property-based tests)
- `apps/mobile/src/hooks/useReaderProgress.ts`
- `apps/mobile/src/hooks/useUserBookProgress.ts`
- `apps/mobile/src/hooks/useFlushOnBackground.ts`
- `apps/mobile/src/lib/progressStorage.ts`
- `apps/mobile/src/lib/analytics.ts` (`trackAppResumedFromBackground` for
  post-launch observability of "random screens" reports)
- `apps/mobile/app/_layout.tsx` (`ColdResetOnResume` component)
- `apps/mobile/e2e/tests/reader-smoke.spec.ts` (TOC regression guard)
