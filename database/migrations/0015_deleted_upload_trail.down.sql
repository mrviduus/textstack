-- Undoes 0015_deleted_upload_trail: drops the columns. Ownerless rows can no longer be re-attached.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.reading_sessions DROP COLUMN deleted_book_sha256;
ALTER TABLE public.highlights DROP COLUMN deleted_chapter_slug, DROP COLUMN deleted_book_sha256;
