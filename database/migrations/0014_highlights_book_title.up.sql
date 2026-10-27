-- 0014_highlights_book_title — a highlight keeps its book's title after the book is deleted
--
-- What:  highlights.book_title (text, nullable). Book delete (upload or edition) writes the book's
--          title onto its highlights just before the owner is SET NULL; readers show it, marked
--          deleted, from then on. While the book exists they show its live title, so a rename
--          needs no update here.
-- Why:   a deleted book's highlights stayed in All highlights with no title (#982).
-- Issue: https://github.com/mrviduus/textstack/issues/982
-- Compatibility: nullable, no backfill; the previous release, which does not write it, keeps
--        working. Highlights already ownerless (1 on prod, 2026-10-27) keep NULL: their title is
--        gone. Locks: ACCESS EXCLUSIVE for a metadata-only ADD COLUMN; 5 s lock timeout, rerun if
--        it aborts.
-- Down:  0014_highlights_book_title.down.sql drops the column; the kept titles are lost.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.highlights ADD COLUMN book_title text;
