# ADR-016 — A chapter review lives inside the chapter's `BookInsight`

**Status:** Proposed · **Date:** 2026-09-28 · **Feature:** [chapter-review.md](../../05-features/chapter-review.md) ·
**Builds on** the insight decisions of 2026-09-10 ([assistant-handoff.md](../../05-features/assistant-handoff.md#insight-categories--what-the-consilium-settled-and-what-it-did-not))

## Context

Stage 2 of TextStack × ChatGPT/Claude: the reader presses **Review chapter**, their own assistant
runs a structured review over MCP (3–6 blocks: example → root cause → rule → linked highlights →
self-check question, plus applications and open threads), and the result comes home **as
structure**, so the reader can see badges on highlights, a per-chapter summary, and questions in SRS.

We already have exactly one place where an assistant's conclusion about a chapter lands:
`BookInsight` (`backend/src/Domain/Entities/BookInsight.cs`). Its shape was argued over and settled
three weeks ago:

- **One row per `(user, book, chapterSlug)`**, a save replaces (`BookInsight.cs:23-27`), enforced by
  two filtered unique indexes with `NULLS NOT DISTINCT` (`AppDbContext.Insights.cs:42-49`).
- **No category in the key.** The consilium of 2026-09-10 and the owner's answer the same day: a
  category column, if ever added, stays out of the unique index — in the key, the write ceiling goes
  from `1 × chapters` to `4 × chapters`, and the "saving again REPLACES" promise in the tool
  description becomes false (commits `3877ba50`, `1649d63c`; PRs #602, #603).
- The return path is **per book, in reading order**, and it already ships on four screens
  (`BookInsightsSection`, web + mobile).

A structured review is, by the owner's own framing, *the* conclusion about a chapter — the same
thing `save_insight` stores, with a shape. The question is where the shape goes.

## Decision

1. **The review is stored in the chapter's existing `BookInsight` row**, in a new nullable `jsonb`
   column `review_json` (`BookInsight.ReviewJson`, `string?` — same convention as
   `Highlight.AnchorJson` and `ReadingProgress.PositionJson`, keeping Domain framework-free).
2. **`Text` keeps a server-rendered Markdown fallback** of the review. Every existing reader of
   insights — `get_my_insights`, both `BookInsightsSection`s, any future export — keeps working with
   zero changes, and a reader of `Text` never sees an empty row.
3. **The unique key does not move.** A review of chapter 7 and a plain `save_insight` about chapter 7
   are the same slot. `save_chapter_review` upserts it; `save_insight` on a row that has a review is
   refused with 409 ("this chapter has a structured review; replace it with save_chapter_review"),
   because silently dropping `review_json` would also orphan the chapter's SRS questions.
4. **Only the SRS state gets its own table** (`review_question`), FK to `book_insight` with
   `ON DELETE CASCADE`. Scheduling state is per question, mutated on every answer, and queried
   across all books by `next_review_at` — none of which fits inside a replaced-as-a-whole jsonb blob.
5. **Open threads are not a table.** They are a field of each review; "open" is computed at read
   time as *threads opened in earlier chapters' reviews minus thread ids closed in earlier chapters'
   reviews*. Thread ids are deterministic (`t_` + 8 hex of `sha256(chapterSlug|normalizedText)`), so
   an identical re-save keeps them stable.

## Alternatives rejected

**A. A separate `chapter_review` table, one row per review.** Two conclusions per chapter — the
insight and the review — with two replace semantics, two DELETE affordances and two lists to render
in reading order. It re-opens the exact question settled on 2026-09-10 (one conclusion per chapter)
by the side door, and every screen that renders the конспект grows a join. Rejected.

**B. `BookInsight` rows with a `kind` column (`note` | `review`) in the unique key.** This *is* the
category-in-the-key design the consilium rejected, with a different enum. Rejected for the reasons
recorded there: doubled write ceiling, a false replace promise, and a later key→facet migration
that has to choose which row per chapter survives.

**C. One row per block (3–6 rows per chapter).** Destroys "a save replaces" (a re-run with 4 blocks
over one with 6 leaves 2 stale), multiplies the ceiling by 6, and turns validation of "the review is
complete" into a multi-row transaction. Rejected.

**D. Structure only in `Text` (Markdown with conventions), parsed on read.** Cannot validate a
reference to a highlight id, cannot drive SRS, and a parser over model-written Markdown is a
permanent source of silent drift. The owner's requirement is "stored as structure, not text".
Rejected.

**E. SRS state inside `review_json`.** A re-save replaces the blob and would reset every question's
interval; the due-queue query would have to unnest jsonb across every review of every book. Rejected
in favour of decision 4.

**F. An `open_thread` table.** Buys a join and a lifecycle to maintain for data that is small (≤10
per chapter), always read per book, and fully derivable. Revisit only if threads ever need editing
from the app independently of a review.

## Consequences

- **Migration is additive**: one nullable column + one new table. Down-migration drops both;
  existing rows are untouched. No backfill.
- `BookInsightDto` gains a nullable `Review` (typed, `ChapterReviewDto`). The web/mobile insight
  section links a reviewed row to its summary page; the reader derives its "reviewed" badges from
  the same list — no new read endpoint for badges.
- `save_insight`'s behaviour changes in one case (409 over a reviewed row); its description and the
  mirrored `McpManifest.cs` text change with it.
- **Re-review replaces.** No review versions — the owner listed them as "later, not now". When they
  come, history belongs in an append-only side table, not in the key.
- Questions survive a re-save when their prompt is unchanged (matched by `prompt_hash`), so running
  a review again does not wipe SRS progress for the parts that did not change.
- Cascade: deleting the insight (reader-only DELETE) deletes its questions. The Edition FK cascade
  already noted in assistant-handoff.md now also takes reviews with it — same risk, larger blast.
- The ceiling the entity exists to hold stays `chapters + 1` rows per book.
