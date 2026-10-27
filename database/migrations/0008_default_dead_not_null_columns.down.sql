-- Undoes 0008_default_dead_not_null_columns: drops the five defaults. No data changes. Roll the code
-- back first: the code of this release relies on the defaults to insert rows.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.ssg_rebuild_jobs
    ALTER COLUMN mode DROP DEFAULT,
    ALTER COLUMN timeout_ms DROP DEFAULT;

ALTER TABLE public.seo_backfill_settings
    ALTER COLUMN language_filter DROP DEFAULT,
    ALTER COLUMN entity_type_filter DROP DEFAULT,
    ALTER COLUMN ssg_rebuild_batch_minutes DROP DEFAULT;
