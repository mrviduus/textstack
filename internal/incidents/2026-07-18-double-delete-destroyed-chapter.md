# A shifted double-delete destroyed a real chapter

**Date:** 2026-07-18
**Status:** Resolved

## Impact

"The Death of Ivan Ilyich" («Смерть Ивана Ильича») lost chapter I (2 510 words). Any book with two quality issues on one chapter was at risk.

## Root cause

The quality-validation apply loop did not dedup delete targets, and the internal delete endpoint renumbers remaining chapters — so the second delete removed a different, real chapter.

## Fix

Dedup delete targets, forbid `delete` as the PLACEHOLDER_TITLE fix, and refuse to delete any chapter over 300 words via the quality path. PR #444.

## Lesson

An idempotent-looking operation stops being idempotent when the target list is computed before the
first mutation renumbers it. Deleting is not a fix — cap the blast radius of any automated repair.

## Detection

By reading the output. A book in the catalog was missing its first chapter; the loss was silent
because the quality pipeline reported a successful repair.

---

## Full write-up

*Preserved verbatim from the CHANGELOG entry of 2026-07-18. This is the long-form record — the source
material for articles and the detail a future reader needs.*

User report: "The Death of Ivan Ilyich" («Смерть Ивана Ильича», EPUB) was missing its first chapter. Diagnosed end-to-end: the extractor was **innocent** (local + prod both produced all 14 units — job `units_count=14` proved it), and the Worker saves every unit. The killer was the **quality-validation pipeline**: Claude flagged the 7-word title-page unit with TWO issues — `FRAGMENT_CHAPTER` (fix: delete, correct) and `PLACEHOLDER_TITLE` (fix: **delete**, wrong — it even carried a `suggestedTitle`) — both pointing at `chapterNumber: 1`. The apply loop sorted delete targets descending but did **not dedup**, and the internal delete endpoint renumbers remaining chapters down — so the first delete removed the title page, chapter "I" (2 510 words) slid into slot 1, and the second delete destroyed it. Three fixes: (1) the apply loop dedups delete targets (`set()`) so N issues on one chapter = one delete; (2) the validation prompt now forbids `delete` as the PLACEHOLDER_TITLE fix (a bad title is not a reason to remove content — rename with the suggested title); (3) a **server-side safety rail** in both internal delete endpoints: a chapter above **300 words** is not deletable via the quality path at all (409) — the pipeline exists to drop title pages and blank stubs, never real content. The damaged book is repaired by a re-ingestion retry after deploy. Also noted for the "skip the parser like PDF" question: the EPUB parser ran perfectly in 2 s — an epub.js original-view would not have prevented this; the failure was post-processing without a seat belt, which now has one.
