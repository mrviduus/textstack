-- 0014_highlights_book_title — a highlight keeps its book's title after the book is deleted
--
-- What:  highlights.book_title (text, nullable): the title of the edition or upload at create time,
--          backfilled from the current owner. Readers show it, marked deleted, once the owner is
--          gone (SET NULL); while the owner exists they show its live title.
-- Why:   a deleted book's highlights stayed in All highlights with no title (#982).
-- Issue: https://github.com/mrviduus/textstack/issues/982
-- Compatibility: nullable, so the previous release, which does not write it, keeps working.
--        Highlights already ownerless when this runs (1 on prod, 2026-10-27) keep NULL: their
--        title is gone. Locks: ROW EXCLUSIVE for the backfill (39 rows on prod), ACCESS EXCLUSIVE
--        for the ADD COLUMN, which rewrites nothing; 5 s lock timeout, rerun if it aborts.
-- Down:  0014_highlights_book_title.down.sql drops the column; the titles are lost.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.highlights ADD COLUMN book_title text;

UPDATE public.highlights h
SET book_title = COALESCE(
    (SELECT e.title FROM public.editions e WHERE e.id = h.edition_id),
    (SELECT b.title FROM public.user_books b WHERE b.id = h.user_book_id))
WHERE h.edition_id IS NOT NULL OR h.user_book_id IS NOT NULL;
