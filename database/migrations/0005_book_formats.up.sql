-- 0005_book_formats — book_files.format gains fb2, mobi, azw3, cbz (ADR-031 "Amended 2026-11-07", ADR-032)
--
-- What:  ck_book_files_format takes 'fb2', 'mobi', 'azw3', 'cbz' beside 'epub', 'pdf', 'html';
--          ck_ingestion_jobs_source_format takes 'mobi', 'azw3', 'cbz' beside the five it had, so it
--          stays "book_files.format plus 'unknown'".
-- Why:   owner 2026-11-07: V2 reads EPUB, MOBI, AZW3, FB2, CBZ and PDF, on the device, through the
--          foliate-js fork (ADR-032). The ETL carries legacy's fb2 uploads (prod: 1) as fb2 files.
--          Nothing enqueues an ingestion job for the new formats (ADR-032 decided 5); source_format
--          widens only so the two lists cannot drift apart.
-- Issue: https://github.com/mrviduus/textstack/issues/1128
--        https://github.com/mrviduus/textstack/issues/1013
-- Compatibility: both CHECKs only widen: every row valid before stays valid, no backfill. The
--                application still accepts only epub/pdf from sync (SyncValidation) until the
--                reader work lands; the ETL writes fb2.
-- Down:  0005_book_formats.down.sql puts the old lists back. It fails, on purpose, while any row
--        holds a format only this migration allows: nothing truthful to rewrite it to, and the bytes
--        it names are a real book. Remove or keep those books first; the down never deletes them.

ALTER TABLE public.book_files
    DROP CONSTRAINT ck_book_files_format,
    -- html = a clipped web page.
    ADD CONSTRAINT ck_book_files_format CHECK (format IN ('epub', 'pdf', 'html', 'fb2', 'mobi', 'azw3', 'cbz'));

ALTER TABLE public.ingestion_jobs
    DROP CONSTRAINT ck_ingestion_jobs_source_format,
    ADD CONSTRAINT ck_ingestion_jobs_source_format
        CHECK (source_format IN ('epub', 'pdf', 'html', 'fb2', 'mobi', 'azw3', 'cbz', 'unknown'));
