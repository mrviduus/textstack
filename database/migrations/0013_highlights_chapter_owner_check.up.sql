-- 0013_highlights_chapter_owner_check — a highlight's chapter belongs to its book's kind
--
-- What:  highlights: CHECK a catalog chapter (chapter_id) never sits on an upload highlight
--          (user_book_id), nor an upload chapter (user_chapter_id) on a catalog one (edition_id).
--          All four NULL is allowed: deleting a book or chapter sets its key NULL (SET NULL).
-- Why:   ck_highlights_owner (0012) limits the owner to one, but nothing paired the chapter with it.
-- Issue: https://github.com/mrviduus/textstack/issues/989
-- Compatibility: highlight create has refused mixed chapter ids since #980.
--        Prod backup 2026-10-27: 0 of 39 highlights pair a chapter with the other kind of book;
--        up, down, up ran clean on it (0008-0013). A guard refuses, by name, any such row
--        written since. Locks: ACCESS EXCLUSIVE on highlights, taken up front; past the 5 s
--        timeout the file aborts with nothing changed, and is rerun.
-- Down:  0013_highlights_chapter_owner_check.down.sql drops the CHECK. No data changes either way.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.highlights IN ACCESS EXCLUSIVE MODE;

-- Rows the constraint below would refuse: say which rule, instead of a bare 23514.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.highlights
               WHERE NOT ((chapter_id IS NULL OR user_book_id IS NULL)
                      AND (user_chapter_id IS NULL OR edition_id IS NULL))) THEN
        RAISE EXCEPTION 'a highlight pairs a chapter with the other kind of book; fix it first (#989)';
    END IF;
END $$;

ALTER TABLE public.highlights
    ADD CONSTRAINT ck_highlights_chapter_owner CHECK (
        (chapter_id IS NULL OR user_book_id IS NULL) AND (user_chapter_id IS NULL OR edition_id IS NULL));
