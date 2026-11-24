-- Undoes 0011_book_cover_updated_at: covers version by books.updated_at again.

ALTER TABLE public.books DROP COLUMN cover_updated_at;
