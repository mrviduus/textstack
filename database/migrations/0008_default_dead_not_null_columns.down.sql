-- Undoes 0008_default_dead_not_null_columns: drops the five defaults. No data changes. This release's
-- code inserts without these columns, so between this down and the code rollback a new SSG job (or a
-- first SEO-settings save) fails with a NOT NULL error; roll the code back right after.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.ssg_rebuild_jobs
    ALTER COLUMN mode DROP DEFAULT,
    ALTER COLUMN timeout_ms DROP DEFAULT;

ALTER TABLE public.seo_backfill_settings
    ALTER COLUMN language_filter DROP DEFAULT,
    ALTER COLUMN entity_type_filter DROP DEFAULT,
    ALTER COLUMN ssg_rebuild_batch_minutes DROP DEFAULT;
