# ADR-018 — Re-ingestion updates chapters in place; reader data never cascades with chapters

**Status:** Accepted · **Date:** 2026-10-05 · **PRs:** #715, #718 ·
**Write-up:** [changelog archive](../../changelog-archive/2026-H2.md#2026-10-05-reader-bug-hunt-r1-r2)

## Context

A chapter row is where reader data hangs: `reading_progresses`, `bookmarks` and `notes` point at
`chapters.id`, highlights at `chapters.id` or `user_chapters.id`. Positions also name a chapter by
**slug** in strings and JSON (progress locator `scroll:<slug>:<px>`, the ADR-015 position JSON
`chapterSlug`, bookmark `chapter:<slug>`, `BookInsight.ChapterSlug`).

Re-ingestion (`/admin/reprocess`, reprocess-all, TextStack reimport, a retry after a quality fix)
deleted all of an edition's chapters and inserted new ones with new Ids. The FKs to `chapters` were
`ON DELETE CASCADE` (progress, bookmarks, notes) and `SET NULL` (highlights). So one admin click
silently deleted every reader's progress and bookmarks for that book, and their highlights lost their
chapter and never painted again. Upload **Retry** on a Ready book did the same to a user's own book.
Found by the 2026-10 reader bug hunt (data C1, H1); a scratch harness on real Postgres failed 10/10
checks on `origin/main`.

## Decision

1. **Chapters are updated in place, Ids kept.** `ChapterReconciler`
   (`backend/src/Application/Ingestion/ChapterReconciler.cs`) plans a match between existing and
   incoming chapters in three greedy passes, existing chapters in number order:
   **slug** (same position and title) → **title**, case-insensitive (a chapter was added or removed in
   front, so every slug shifted) → **chapter number** (the extractor retitled a chapter in place).
   A matched row keeps its `Id` and gets the new number, slug, title, html, text and counts;
   unmatched incoming chapters are inserted. All of it runs in one transaction. Existing rows are
   first parked on negative numbers (and, for uploads, `~<id>` slugs) so the unique keys allow any
   final order.
2. **A removed chapter hands its readers to a neighbour first.** The nearest surviving chapter
   **before** it, else the nearest after it (`RemoveEditionChapterAsync` / `RemoveUserChapterAsync`).
   Previous, not next: a reader must never skip text they have not read, and a merged chapter's text
   now lives in the previous one. Progress, bookmarks, notes and highlights are re-pointed with
   `ExecuteUpdate`, then the chapter is deleted. Only when an edition has no chapter left are
   progress, bookmarks and notes deleted.
3. **Slug-bearing positions are rewritten (#718).** `SlugMoves` maps each old slug to where it went.
   A **matched** chapter keeps the in-chapter part (offset, text anchor) — same text. A **re-pointed**
   one is reset to the chapter start (`scroll:<slug>:0`, position JSON → null), because the anchor
   quotes text that chapter does not have. Applied to catalog progress and bookmarks, upload progress
   fields and bookmarks, and insights. Insights are one per (user, book, chapter): a move onto a slug
   the user already holds is skipped and logged, and a removed chapter's insight that cannot move is
   parked on `~orphan:<old slug>` — kept, not deleted.
4. **An empty re-extraction fails** instead of wiping the book ("keeping the existing ones and their
   readers").
5. **FKs `reading_progresses` / `bookmarks` / `notes` → `chapters` are `NO ACTION`** (migration
   `ChapterDependentsNoActionOnDelete`; `AppDbContext.Reading.cs`). Any code path that deletes a
   chapter without going through the reconciler now fails loudly with 23503 instead of silently
   deleting reader data. Highlights stay `SET NULL` (a highlight also belongs to the edition and is
   still listed).

Callers: `IngestionService`, `TextStackImportService`, admin chapter delete
(`AdminService.Chapters.cs`), quality-pipeline delete/merge (`InternalEndpoints.cs`),
`UserIngestionService` (old assets deleted only after the new chapters commit).

## Alternatives

- **Keep delete-and-recreate, remap afterwards by number.** Rejected: the delete already cascaded; the
  remap would have nothing to move.
- **`SET NULL` on progress/bookmarks/notes.** Rejected: it trades deletion for orphan rows — a progress
  row with no chapter restores nowhere, and the failure is just as silent.
- **`RESTRICT` instead of `NO ACTION`.** Rejected. In Postgres, `RESTRICT` is checked immediately,
  inside the statement; `NO ACTION` is checked at the end of the statement. Deleting an **edition**
  cascades to its chapters *and* (via `EditionId`) to their progress, bookmarks and notes in one
  statement. With `NO ACTION` that statement ends consistent and succeeds; with `RESTRICT` the chapter
  delete would be refused before the dependents are gone. Both refuse a bare chapter delete, which is
  the guard we want.

## Consequences

- Re-processing a book is safe for its readers: progress, bookmarks, notes and highlights survive,
  and in the common case (same chapters) the reader resumes at the same spot.
- Every chapter delete must go through `ChapterReconciler.Remove*ChapterAsync` inside a transaction.
  A new delete path that forgets it gets a 23503 in tests, not data loss in production.
- Tests: `tests/TextStack.UnitTests/ChapterReconcilerTests.cs`,
  `tests/TextStack.UnitTests/ChapterPositionRemapTests.cs`,
  `tests/TextStack.IntegrationTests/ReingestKeepsReaderDataTests.cs`.

## Known limits

- **`MaxChapterNumber` is not remapped.** `ReadingProgress.MaxChapterNumber` is a raw chapter number
  (read by `ChapterFrontier` for the chapter-review spoiler gate). If re-ingestion renumbers
  chapters, the frontier can move by the shift.
- **Standalone admin delete/merge paths do not rewrite locators.** Admin chapter delete and the
  quality-pipeline delete/merge re-point Ids (decision 2) but do not run `SlugMoves`, so a locator or
  insight naming the deleted slug is left as is; the reader opens that book at the chapter top.
  Admin delete also renumbers later chapters (see the first limit).
- **Duplicate titles pair greedily.** Two chapters with the same title (e.g. "Notes", "Chapter") are
  matched in number order by the title pass, which can pair the wrong two when chapters were added in
  front. Readers then land in a sibling chapter with the offset kept.
- Rewriting slug positions loads every progress/bookmark row of the edition into memory — fine at
  today's sizes; per-row SQL if an edition ever has thousands of readers.
