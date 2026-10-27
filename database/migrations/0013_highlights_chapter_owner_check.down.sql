-- Undoes 0013_highlights_chapter_owner_check: drops the CHECK. No data changes.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.highlights DROP CONSTRAINT ck_highlights_chapter_owner;
