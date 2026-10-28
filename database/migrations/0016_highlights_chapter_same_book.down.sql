-- Undoes 0016_highlights_chapter_same_book: drops the composite FKs, then the unique constraints
-- they reference. No data changes.

SET LOCAL lock_timeout = '5s';

-- Chapters before highlights, as a chapter delete's SET NULL takes them: no deadlock.
LOCK TABLE public.chapters, public.user_chapters IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.highlights IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.highlights
    DROP CONSTRAINT fk_highlights_chapters_chapter_id_edition_id,
    DROP CONSTRAINT fk_highlights_user_chapters_user_chapter_id_user_book_id;
ALTER TABLE public.chapters DROP CONSTRAINT ak_chapters_id_edition_id;
ALTER TABLE public.user_chapters DROP CONSTRAINT ak_user_chapters_id_user_book_id;
