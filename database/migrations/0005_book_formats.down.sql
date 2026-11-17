-- Undoes 0005_book_formats: the baseline's format lists come back. Fails closed: a book_files row in
-- fb2/mobi/azw3/cbz, or an ingestion_jobs row in mobi/azw3/cbz, raises below, with the counts, before
-- anything changes (the re-added CHECKs would refuse too, naming only the constraint). Nothing is
-- deleted or rewritten here: those rows are real books, and which of them may go is a human's call.

DO $$
DECLARE
    files bigint := (SELECT count(*) FROM public.book_files WHERE format IN ('fb2', 'mobi', 'azw3', 'cbz'));
    jobs bigint := (SELECT count(*) FROM public.ingestion_jobs WHERE source_format IN ('mobi', 'azw3', 'cbz'));
BEGIN
    IF files > 0 OR jobs > 0 THEN
        RAISE EXCEPTION '0005 down refused: % book_files row(s) in fb2/mobi/azw3/cbz, % ingestion_jobs row(s) in mobi/azw3/cbz; remove those books first', files, jobs;
    END IF;
END $$;

ALTER TABLE public.book_files
    DROP CONSTRAINT ck_book_files_format,
    -- html = a clipped web page.
    ADD CONSTRAINT ck_book_files_format CHECK (format IN ('epub', 'pdf', 'html'));

ALTER TABLE public.ingestion_jobs
    DROP CONSTRAINT ck_ingestion_jobs_source_format,
    ADD CONSTRAINT ck_ingestion_jobs_source_format
        CHECK (source_format IN ('epub', 'pdf', 'html', 'fb2', 'unknown'));
