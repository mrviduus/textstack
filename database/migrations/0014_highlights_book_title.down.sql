-- Undoes 0014_highlights_book_title: drops the column. The stored titles are lost.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.highlights DROP COLUMN book_title;
