# UX Redesign — Mobile (Slices 1-10)

> **Historical — a record of the 2026-H1 redesign, not current UI.** Since then: translation moved
> from LibreTranslate to OpenAI (2026-04-22); the dictionary (`DictionarySheet`) was removed
> 2026-10-03; Home was deleted and Library became the front door; the reader shows one chapter at a
> time (#683). `WordCard.tsx`, `OnboardingOverlay.tsx`, `ContinueReadingCard.tsx`, `lib/notifications.ts`,
> `app/vocabulary/index.tsx` and `app/blog/index.tsx` no longer exist (checked 2026-10-04).
> Current mobile reader: [reader.md](reader.md#mobile-experience).

**Goal:** Transform from "reader with translation" → "learning system through reading"
**Priority:** Mobile (Play Store release)
**Branch:** `ux-redesign-slice-1-5` (merged to main)
**Commit:** `1d9d3a7`

## Slice 1 — Reader Onboarding

3-step overlay on first reader open. Teaches: tap word → translation → save to vocab.

**File:** `apps/mobile/src/components/OnboardingOverlay.tsx`

- Step 1: "Learn by reading" + animated tap icon
- Step 2: Mock word card (amorphous → аморфний) + Save button
- Step 3: "You're ready!" + checkmark
- Persisted via `AsyncStorage` key `onboarding_reader_done`
- Shown once per device, skippable

**Integration:** `apps/mobile/app/reader/[bookSlug]/[chapterSlug].tsx` checks flag on mount.

## Slice 2 — WordCard (Progressive Disclosure)

Replaces flat `SelectionActionBar` for single-word selections.

**File:** `apps/mobile/src/components/WordCard.tsx`

**Level 1 (default):** Compact card
- Word + auto-translation (via LibreTranslate API)
- TTS button
- Save button (green, prominent)

**Level 2 (tap to expand):**
- Highlight color buttons (yellow, green, pink, blue)
- Dictionary button → opens existing `DictionarySheet`
- Dismiss button

**Level 3:** Existing `DictionarySheet` (unchanged)

Multi-word selections still use `SelectionActionBar`.

**autoLookup change:** No longer auto-saves words or opens DictionarySheet. WordCard shows instead — user explicitly taps Save.

## Slice 3 — Tap & Save Animations

**CSS tap-pulse** (`apps/mobile/src/lib/readerHtml.ts`):
- `@keyframes tap-pulse` — warm highlight flash on single-word selection
- `applyTapPulse()` JS function wraps selection in temp `<span>`, removes after 650ms

**Save animation** (WordCard):
- Scale bounce (1 → 1.2 → 1) on save button via `Animated.spring`
- "Saved!" / "X words saved this session" text fades out over 1.3s

## Slice 4 — Progress Feedback

**Session word counter** in reader:
- `sessionWordCount` state, increments on each save
- Green badge in top bar: school icon + count
- Exit summary overlay: "X words saved" shown for 1.8s before navigating back

**Home screen:**
- `wordsReviewedToday` stat from vocabulary API in quick stats bar

## Slice 5 — Continue Reading & Start CTA

**File:** `apps/mobile/src/components/ContinueReadingCard.tsx`

Authenticated users with reading progress:
- Shows last-read unfinished book (cover, title, progress bar, play button)
- Data: `libraryApi.getLibrary()` + `readingProgressApi.getAllProgress()`
- Finds most recent book with `percent < 1`

Unauthenticated users:
- "Start Reading" CTA button → navigates to book catalog

**Home layout (authenticated):** Hero → ContinueReadingCard → Stats Bar → Quick Stats → Vocab Review → Recent Books → Authors

## Bug Fix — Translation API

**Problem:** `packages/shared/src/api/translation.ts` sent `{ q, source, target }` but backend expects `{ text, sourceLang, targetLang }`.

**Fix:**
- Shared client: field names corrected
- Backend: added `/translate` compat route (nginx strips `/api/` prefix for this endpoint)

## Files Changed

| File | Change |
|------|--------|
| `apps/mobile/src/components/OnboardingOverlay.tsx` | New — 3-step onboarding |
| `apps/mobile/src/components/WordCard.tsx` | New — progressive disclosure word card |
| `apps/mobile/src/components/ContinueReadingCard.tsx` | New — continue reading + progress |
| `apps/mobile/app/reader/[bookSlug]/[chapterSlug].tsx` | WordCard integration, counters, onboarding, exit summary |
| `apps/mobile/app/(tabs)/index.tsx` | ContinueReadingCard, Start CTA, reviewed-today stat |
| `apps/mobile/src/lib/readerHtml.ts` | CSS tap-pulse + JS pulse applicator |
| `backend/src/Api/Endpoints/TranslationEndpoints.cs` | Compat route |
| `packages/shared/src/api/translation.ts` | Field name fix |

## Slice 6 — Language Selection in Onboarding

**Files:** `packages/shared/src/i18n/{en,uk}.json`, `OnboardingOverlay.tsx`, `(tabs)/_layout.tsx`

- Step 0 (new): Language picker — 🇬🇧 English / 🇺🇦 Українська card buttons
- Calls `switchLanguage()`, auto-advances to step 1
- Steps 1-3: existing steps with `t()` instead of hardcoded English
- Tab labels use `t('nav.read')`, `t('nav.discover')`, etc.
- i18n keys added: `onboarding.*`, `nav.*`

## Slice 7 — Navigation Restructure

**Files:** `(tabs)/index.tsx`, `(tabs)/search.tsx`, `(tabs)/profile.tsx`, `(tabs)/_layout.tsx`

- **Home → Read tab**: icon `book`, stripped catalog (Hero, StatsBar, RecentBooks, Authors). Keeps: ContinueReadingCard, QuickStats, VocabReview, StartCTA
- **Search → Discover tab**: icon `compass`, catalog below search bar when no query (StatsBar, RecentBooks grid with stagger animation, Authors scroll)
- **Profile simplified**: removed Browse section (All Books, Authors, Genres) — now in Discover

## Slice 8 — Empty States

**Files:** `library.tsx`, `search.tsx`, `vocabulary/index.tsx`, `stats/index.tsx`, `highlights/index.tsx`, `blog/index.tsx`

- All hardcoded empty state markup replaced with `<EmptyState>` component + `t()` calls
- Library: not authed, no saved books, no uploads, no reviews
- Search: no results
- Vocab/Stats/Highlights/Blog: styled EmptyState with i18n

## Slice 9 — Micro-animations

**Files:** `(tabs)/_layout.tsx`, `BookCard.tsx`, `PressableScale.tsx` (new), `ContinueReadingCard.tsx`, `_layout.tsx`

- **Tab icon bounce**: `AnimatedTabIcon` — scale 1→1.15→1 via spring on focus
- **Book card stagger**: fade-in + slide-up with `animationDelay` prop (400ms timing, 80ms stagger)
- **PressableScale**: reusable press feedback (scale 0.96 on press, spring back)
- **Reader entry**: `slide_from_bottom` animation on Stack.Screen

## Slice 10 — Full Learning Loop

**Files:** `reader/[bookSlug]/[chapterSlug].tsx`, `notifications.ts`, `_layout.tsx`, `vocabulary/review.tsx`

- **Post-reading review prompt**: "Review Now" / "Later" buttons in exit summary when `sessionWordCount > 0`. Auto-dismiss 5s
- **Smart notifications**: `scheduleSmartReminder()` checks `vocabularyApi.getVocabularyStats()` for `dueNow`, shows personalized count
- **Review celebration**: motivational message based on accuracy (≥90% Excellent, 70-89% Great, <70% Keep practicing) + streak badge
- **Skipped**: 10C (vocab badge on library cards — no per-book endpoint), 10E (streak widget — already in QuickStats)

## Files Changed (Slices 6-10)

| File | Change |
|------|--------|
| `packages/shared/src/i18n/{en,uk}.json` | i18n keys for onboarding, nav, empty states, review |
| `apps/mobile/src/components/OnboardingOverlay.tsx` | 4-step onboarding with language selection |
| `apps/mobile/app/(tabs)/_layout.tsx` | Tab icons, labels, AnimatedTabIcon |
| `apps/mobile/app/(tabs)/index.tsx` | Rewritten as Read tab (~150 lines) |
| `apps/mobile/app/(tabs)/search.tsx` | Discover tab with catalog + stagger |
| `apps/mobile/app/(tabs)/profile.tsx` | Removed Browse section |
| `apps/mobile/app/(tabs)/library.tsx` | EmptyState + i18n |
| `apps/mobile/app/vocabulary/index.tsx` | EmptyState + i18n |
| `apps/mobile/app/stats/index.tsx` | EmptyState + i18n |
| `apps/mobile/app/highlights/index.tsx` | EmptyState + i18n |
| `apps/mobile/app/blog/index.tsx` | EmptyState + i18n |
| `apps/mobile/src/components/ui/BookCard.tsx` | animationDelay + badge props |
| `apps/mobile/src/components/ui/PressableScale.tsx` | New — press feedback component |
| `apps/mobile/src/components/ContinueReadingCard.tsx` | PressableScale adoption |
| `apps/mobile/app/_layout.tsx` | slide_from_bottom, smart notifications |
| `apps/mobile/app/reader/[bookSlug]/[chapterSlug].tsx` | Review prompt on exit |
| `apps/mobile/src/lib/notifications.ts` | scheduleSmartReminder() |
| `apps/mobile/app/vocabulary/review.tsx` | Celebration + streak in summary |

## Future

- Web parity (after mobile validation)
- 10C: per-book vocab badge (needs backend endpoint)
- 10E: dedicated streak widget (if QuickStats proves insufficient)
