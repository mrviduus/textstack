-- Undoes 0004_drop_book_files_sha256: re-adds the column, nullable and empty. Old values come from
-- a backup (see the up header). The column lands last, not between format and uploaded_at as on a
-- fresh build; nothing reads columns by position.

ALTER TABLE public.book_files ADD COLUMN sha256 text;
