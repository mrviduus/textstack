-- 0011_book_cover_updated_at — a cover's own version, apart from books.updated_at
--
-- What:  books.cover_updated_at (timestamptz, null without a cover), set when a cover is stored.
-- Why:   clients cache a cover for a year under ?v=<version>. The version was books.updated_at, which also moves
--          on a TOC PUT, a touch, a metadata edit, a remove and a restore, so the unchanged cover was refetched.
-- Issue: https://github.com/mrviduus/textstack/issues/1584
-- Compatibility: additive. Backfilled from updated_at, so every cover URL a client holds stays the same.
--                Deploy the migration before the code.
-- Down:  0011_book_cover_updated_at.down.sql drops the column; covers then version by updated_at again.

ALTER TABLE public.books ADD COLUMN cover_updated_at timestamptz;
UPDATE public.books SET cover_updated_at = updated_at WHERE cover_key IS NOT NULL;
COMMENT ON COLUMN public.books.cover_updated_at IS 'When the cover was stored: its cache version (?v=). Null without a cover.';
