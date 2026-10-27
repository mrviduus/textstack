-- 0015_deleted_upload_trail — a deleted upload's highlights and sessions remember which file they were
--
-- What:  highlights.deleted_book_sha256, highlights.deleted_chapter_slug,
--          reading_sessions.deleted_book_sha256 (nullable). Upload delete writes the file's sha256 and
--          the highlight's chapter slug just before the owner is SET NULL; when the same user uploads
--          a file with that sha256 again, the worker re-attaches them to the new book once it is Ready
--          (chapter by slug) and clears the columns.
-- Why:   deleting an upload and uploading the same file again started with no highlights (#983).
-- Issue: https://github.com/mrviduus/textstack/issues/983
-- Compatibility: nullable, no backfill; the previous release neither writes nor reads them. Rows
--        already ownerless keep NULL: their file is unknown. Locks: ACCESS EXCLUSIVE for
--        metadata-only ADD COLUMNs; 5 s lock timeout, rerun if it aborts.
-- Down:  0015_deleted_upload_trail.down.sql drops the columns; ownerless rows can no longer be
--        re-attached.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.highlights
    ADD COLUMN deleted_book_sha256 character varying(64),
    ADD COLUMN deleted_chapter_slug text;
ALTER TABLE public.reading_sessions ADD COLUMN deleted_book_sha256 character varying(64);
