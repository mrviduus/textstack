-- 0011_drop_dead_columns — drop the 13 columns nothing reads or writes
--
-- What:  DROP COLUMN
--          ssg_rebuild_jobs: mode, timeout_ms, book_slugs_json, author_slugs_json, genre_slugs_json
--          ingestion_jobs: work_id, source_edition_id
--          editions: source_edition_id
--          seo_backfill_settings: language_filter, entity_type_filter, ssg_rebuild_batch_minutes
--          user_books: suggested_tags_at
--          user_ingestion_jobs: units_count
--        Their indexes (ix_editions_source_edition_id, ix_ingestion_jobs_source_edition_id,
--        ix_ingestion_jobs_work_id) and FKs (fk_editions_editions_source_edition_id,
--        fk_ingestion_jobs_editions_source_edition_id, fk_ingestion_jobs_works_work_id) go with them.
-- Why:   write-only or never-read columns. The previous release stopped writing them and 0008 gave
--        the NOT NULL ones defaults (#976).
-- Issue: https://github.com/mrviduus/textstack/issues/937
-- Compatibility: the deployed code no longer maps any of them. The guard refuses to drop anything if
--        a nullable one was set on a row created after 13:30 UTC, just after #976 deployed
--        (2026-10-27 13:18): that would mean a live writer. editions is locked briefly; past the
--        5 s timeout the file aborts with nothing changed, and is rerun.
-- Down:  0011_drop_dead_columns.down.sql re-adds the columns, indexes and FKs as 0000_baseline has
--        them, with 0008's defaults. Values are not restored: the NOT NULL ones come back as the
--        defaults (what the code always wrote), the nullable ones as NULL. Old values: the pre-deploy
--        dump (~/backups/textstack/pre-deploy-*) or a nightly backup. Code from before #976 writes
--        these columns: to roll it back, run this down FIRST, then deploy the old commit.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.ssg_rebuild_jobs, public.ingestion_jobs, public.editions,
    public.seo_backfill_settings, public.user_books, public.user_ingestion_jobs
    IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE cutoff CONSTANT timestamptz := '2026-10-27 13:30:00+00';
BEGIN
    IF EXISTS (SELECT 1 FROM public.ssg_rebuild_jobs WHERE created_at >= cutoff
                   AND (book_slugs_json IS NOT NULL OR author_slugs_json IS NOT NULL OR genre_slugs_json IS NOT NULL))
       OR EXISTS (SELECT 1 FROM public.ingestion_jobs WHERE created_at >= cutoff
                   AND (work_id IS NOT NULL OR source_edition_id IS NOT NULL))
       OR EXISTS (SELECT 1 FROM public.editions WHERE created_at >= cutoff AND source_edition_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.user_books WHERE suggested_tags_at >= cutoff)
       OR EXISTS (SELECT 1 FROM public.user_ingestion_jobs WHERE created_at >= cutoff AND units_count IS NOT NULL)
    THEN
        RAISE EXCEPTION 'a column 0011 drops was written after #976 deployed: a writer is still live';
    END IF;
END $$;

ALTER TABLE public.ssg_rebuild_jobs
    DROP COLUMN mode,
    DROP COLUMN timeout_ms,
    DROP COLUMN book_slugs_json,
    DROP COLUMN author_slugs_json,
    DROP COLUMN genre_slugs_json;

ALTER TABLE public.ingestion_jobs
    DROP COLUMN work_id,
    DROP COLUMN source_edition_id;

ALTER TABLE public.editions DROP COLUMN source_edition_id;

ALTER TABLE public.seo_backfill_settings
    DROP COLUMN language_filter,
    DROP COLUMN entity_type_filter,
    DROP COLUMN ssg_rebuild_batch_minutes;

ALTER TABLE public.user_books DROP COLUMN suggested_tags_at;

ALTER TABLE public.user_ingestion_jobs DROP COLUMN units_count;
