-- 0006_drop_ssg_rebuild_results — drop the never-written per-route SSG results
--
-- What:  DROP TABLE ssg_rebuild_results (its 2 indexes and its FK to ssg_rebuild_jobs go with it).
-- Why:   nothing has written it since 2026-01-23 (ssg-worker records progress on ssg_rebuild_jobs
--        only); its 349 rows are all from that day. The previous release removed the entity, the
--        admin /stats and /results endpoints and the job page sections that read it (#970).
-- Issue: https://github.com/mrviduus/textstack/issues/933
-- Compatibility: the deployed code no longer maps the table. Locks it first, then refuses to run
--        if it holds a row newer than 2026-01-23, so nothing a live writer added is dropped.
--        Dropping the FK briefly locks ssg_rebuild_jobs too; past the 5 s timeout it aborts with
--        nothing changed, and is rerun.
-- Down:  0006_drop_ssg_rebuild_results.down.sql recreates the table, indexes and FK exactly as
--        0000_baseline has them, empty. The 349 stale rows are not restored; if wanted: the
--        pre-deploy dump (~/backups/textstack/pre-deploy-*) or a nightly backup.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.ssg_rebuild_results IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.ssg_rebuild_results WHERE rendered_at >= '2026-01-24') THEN
        RAISE EXCEPTION 'ssg_rebuild_results has rows after 2026-01-23; something writes it (#933)';
    END IF;
END $$;

DROP TABLE public.ssg_rebuild_results;
