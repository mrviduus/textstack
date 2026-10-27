-- 0010_drop_lint_results — drop the extraction lint findings nothing displayed
--
-- What:  DROP TABLE lint_results (its index and its FK to editions go with it).
-- Why:   catalog ingestion wrote up to 1000 lint findings per edition (18,380 rows, 30 MB); the only
--        reader was an admin endpoint no UI called. The previous release removed the writer, the
--        endpoints, the entity and the lint rules (#975).
-- Issue: https://github.com/mrviduus/textstack/issues/936
-- Compatibility: the deployed code no longer maps the table. The guard refuses to drop it if any
--        row is newer than 13:00 UTC, just after #975 deployed (2026-10-27 12:56): that would mean a
--        live writer. Code from before #975 writes the table on every catalog ingest: to roll the code back
--        past #975, run this file's down FIRST (`make migrate-down V=9`). Dropping the FK briefly locks editions too; past the 5 s timeout it aborts
--        with nothing changed, and is rerun.
-- Down:  0010_drop_lint_results.down.sql recreates the table, index and FK exactly as 0000_baseline
--        has them, empty. The findings are not restored; they were derived data (re-ingesting with
--        the code before #975 regenerates them). If wanted: the pre-deploy dump
--        (~/backups/textstack/pre-deploy-*) or a nightly backup.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.lint_results IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.lint_results WHERE created_at >= '2026-10-27 13:00:00+00') THEN
        RAISE EXCEPTION 'lint_results has rows written after #975 deployed: a writer is still live';
    END IF;
END $$;

DROP TABLE public.lint_results;
