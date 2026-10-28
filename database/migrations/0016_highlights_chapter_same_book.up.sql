-- 0016_highlights_chapter_same_book — a highlight's chapter belongs to the highlight's own book
--
-- What:  highlights: composite FKs (chapter_id, edition_id) → chapters (id, edition_id) and
--          (user_chapter_id, user_book_id) → user_chapters (id, user_book_id), ON DELETE SET NULL of
--          the chapter column only. They need UNIQUE (id, edition_id) on chapters and
--          (id, user_book_id) on user_chapters. MATCH SIMPLE: a row with no book (deleted, SET NULL)
--          is not checked; the single-column chapter FKs stay and still check the chapter exists.
-- Why:   0013 pairs a chapter with the right *kind* of book, not the right book: edition A with a
--          chapter of edition B passed. Only highlight create's lookup refused it.
-- Issue: https://github.com/mrviduus/textstack/issues/998
-- Compatibility: highlight create and upload re-attach (#983) set the chapter from the same book.
--        Prod backup 2026-10-27: see the PR. A guard refuses, by name, any violating row written
--        since. Locks: SHARE on chapters / user_chapters while the unique indexes build (reads go
--        on, writes wait), ACCESS EXCLUSIVE on highlights; all taken up front, 5 s lock timeout,
--        rerun if it aborts.
-- Down:  0016_highlights_chapter_same_book.down.sql drops the FKs and unique constraints. No data
--        changes either way.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.highlights IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.chapters, public.user_chapters IN SHARE MODE;

-- Rows the FKs below would refuse: say which rule, instead of a bare 23503.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.highlights h JOIN public.chapters c ON c.id = h.chapter_id
               WHERE c.edition_id <> h.edition_id)
       OR EXISTS (SELECT 1 FROM public.highlights h JOIN public.user_chapters c ON c.id = h.user_chapter_id
                  WHERE c.user_book_id <> h.user_book_id) THEN
        RAISE EXCEPTION 'a highlight''s chapter belongs to another book; fix it first (#998)';
    END IF;
END $$;

ALTER TABLE public.chapters ADD CONSTRAINT ak_chapters_id_edition_id UNIQUE (id, edition_id);
ALTER TABLE public.user_chapters ADD CONSTRAINT ak_user_chapters_id_user_book_id UNIQUE (id, user_book_id);

ALTER TABLE public.highlights
    ADD CONSTRAINT fk_highlights_chapters_chapter_id_edition_id FOREIGN KEY (chapter_id, edition_id)
        REFERENCES public.chapters (id, edition_id) ON DELETE SET NULL (chapter_id),
    ADD CONSTRAINT fk_highlights_user_chapters_user_chapter_id_user_book_id
        FOREIGN KEY (user_chapter_id, user_book_id)
        REFERENCES public.user_chapters (id, user_book_id) ON DELETE SET NULL (user_chapter_id);
