-- Undoes 0004_drop_book_files_sha256: re-adds the column, nullable and empty. Old values come from
-- a backup.

ALTER TABLE public.book_files ADD COLUMN sha256 text;
