-- 0008_default_dead_not_null_columns — defaults for five NOT NULL columns the code stops writing
--
-- What:  SET DEFAULT on ssg_rebuild_jobs.mode ('Full'), ssg_rebuild_jobs.timeout_ms (30000),
--        seo_backfill_settings.language_filter ('{}'), .entity_type_filter ('{}'),
--        .ssg_rebuild_batch_minutes (5) — the values the code wrote until now.
-- Why:   nothing reads these columns (#937). This release stops writing them; an INSERT that omits
--        a NOT NULL column without a default would fail. The next release drops them.
-- Issue: https://github.com/mrviduus/textstack/issues/937
-- Compatibility: the deployed code still writes all five; a default changes nothing for it.
-- Down:  0008_default_dead_not_null_columns.down.sql drops the five defaults. No data changes.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.ssg_rebuild_jobs
    ALTER COLUMN mode SET DEFAULT 'Full',
    ALTER COLUMN timeout_ms SET DEFAULT 30000;

ALTER TABLE public.seo_backfill_settings
    ALTER COLUMN language_filter SET DEFAULT '{}',
    ALTER COLUMN entity_type_filter SET DEFAULT '{}',
    ALTER COLUMN ssg_rebuild_batch_minutes SET DEFAULT 5;
