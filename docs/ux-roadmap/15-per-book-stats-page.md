# Slice 15 — Per-book stats page

**Phase:** 3 (Power features) · **Estimated:** 1 day · **Risk:** low · **Flag:** `myBooksV2.bookStats`

## Goal

When a user opens a book's detail page, show their personal investment in it: hours read, words encountered, vocab saved from it, highlights count, sessions, current pace. This is what differentiates TextStack from Kindle — your own data, surfaced.

## Acceptance criteria

1. `UserBookDetailPage` (and equivalent for saved books, if exists) shows a "Your stats" section between the cover/metadata block and the chapter list:
   - Reading time (total hours/minutes)
   - Sessions (count)
   - Pages read (or chapters read)
   - Words encountered (sum across sessions)
   - Vocab words saved from this book (count, link to filtered Vocab page)
   - Highlights count (link to filtered Highlights page)
   - Current reading pace (words/min based on this book's sessions)
   - Estimated time remaining ("~3h 20m at your pace")
2. If user has 0 sessions on this book → section shows "Start reading to see stats" + open-book CTA.
3. Backend endpoint `GET /me/books/{id}/stats` returns all numbers in one call.
4. Stats refresh when page reopens (no live updates needed).
5. Mobile: same layout, vertical stack instead of horizontal.
6. Behind feature flag `myBooksV2.bookStats`.

## Files to touch

| File | Change |
|---|---|
| `apps/web/src/pages/UserBookDetailPage.tsx` | Mount `<BookStatsSection />`. |
| `apps/web/src/components/library/BookStatsSection.tsx` | **New.** Stat tiles + estimate. |
| `apps/web/src/hooks/useBookStats.ts` | Verify exists; if exists for general stats, may need a per-book variant `useBookStats(bookId)`. |
| `apps/mobile/app/library/my/[id]/index.tsx` | Mount mobile stats section. |
| Backend: `backend/src/Api/Endpoints/UserBooksEndpoints.cs` | Add `GET /me/books/{id}/stats` endpoint. |
| Backend: `backend/src/Application/UserBooks/BookStatsService.cs` | **New.** Aggregates from `ReadingSession`, `VocabularyWord`, `Highlight` filtered by bookId. |
| `apps/web/src/locales/en.json` + mobile | All stat labels, time formatters. |

## Implementation notes

- **Stats DTO:**
  ```csharp
  public record BookStatsDto(
    Guid BookId,
    int SessionsCount,
    long TotalReadMinutes,
    int WordsRead,
    int ChaptersRead,
    int VocabSavedCount,
    int HighlightsCount,
    decimal AverageWordsPerMinute,
    int? EstimatedMinutesRemaining   // null if no sessions yet
  );
  ```
- **Pace calculation:** `AverageWordsPerMinute = totalWords / totalMinutes`. Filter sessions of this book only. If < 3 sessions, fall back to user's overall pace.
- **Estimated remaining:** `(book.totalWordCount * (1 - progress)) / pace`. Only show if pace ≥ 50 wpm (sane lower bound) — otherwise hide.
- **Superseded 2026-10-01:** pace is no longer per-book. Book stats, shelves, `/me/reading/stats` and `/me/reading/pace` all use one rule (`Application/ReadingTracking/ReadingPace.cs`): the reader's overall wpm once they have ≥3 sessions (clamped 50–800), else 200; minutes left round to nearest.
- **Caching:** cache response 60s server-side keyed `book-stats:{userId}:{bookId}`. Reading sessions don't change that fast.
- **Vocab/highlights links:** deep-link to existing pages with `?bookId={id}` filter. If those pages don't support this filter, add it (small change to those pages, in scope).

## Out of scope

- Book-level reading goals ("Finish by Friday") — separate concept, Phase 4.
- Comparison to other readers ("You read 2× faster than average") — out of scope, social aspect.
- Chart visualizations (heatmap per chapter, etc.) — Phase 4 polish.

## Tests

**Unit:**
- `BookStatsService.test.cs`: aggregates correctly from fixtures, handles 0 sessions, pace fallback to overall.
- `BookStatsSection.test.tsx`: renders all tiles, hides estimate when pace too low.

**Integration:**
- `dotnet test tests/TextStack.IntegrationTests --filter BookStats`: endpoint returns expected shape; permissions enforced (other user's bookId returns 403/404).

**E2E:**
- Navigate to book detail page with sessions → assert stats visible with non-zero numbers.
- Click "Vocab saved" link → lands on Vocab page filtered to this book.
- Book with 0 sessions → empty state CTA visible.

## Done criterion

```bash
pnpm -C apps/web test --filter "BookStatsSection"
pnpm -C apps/web test:e2e --grep "book-stats"
pnpm -C apps/web build
dotnet test tests/TextStack.IntegrationTests --filter BookStats
cd apps/mobile && npx tsc --noEmit
```

## Rollback plan

Toggle `myBooksV2.bookStats` to `false`. Section unmounts. Backend endpoint stays (additive).

## Follow-ups

- Heatmap visualization per chapter — Phase 4.
- Per-book reading goals — Phase 4.
- "Books I read most this month" — Phase 4 dashboard.
