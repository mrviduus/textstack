-- 0004_migration_runs_fixes — the etl-v2 ledger, after /code-review of 0003 (#1131)
--
-- What:  migration_runs gains an 'interrupted' outcome; the started/finished clock order CHECK goes;
--          counts and validation must be JSON objects; a succeeded run must carry validation;
--          source_dump_sha must be a lowercase SHA-256 hex digest; the COMMENT names its module (Ops).
-- Why:   a dead run's row could only stay "running or interrupted" forever. The next run, once it
--          holds the ETL advisory lock (so the old run is provably not running), closes it as
--          'interrupted', finished_at = when it was closed — never deleted. A wall-clock step back
--          between start and finish made the finish UPDATE fail after the data had moved. Untyped
--          jsonb let a gate query read NULL as "no failures". source_dump_sha ties a rehearsal row
--          to the backup it ran on (owner 2026-11-07); a malformed value would make that unprovable.
-- Issue: https://github.com/mrviduus/textstack/issues/1026
-- Compatibility: textstack_v2 has no ledger rows anywhere real (prod is at 0002; the etl-v2 CLI is
--                unreleased). Like every V2 migration, the Api counts this file for readiness: with
--                Features:V2Api on, V2 is "behind" until `make migrate-v2` applies 0003 and 0004.
--                (0003's header said nothing deployed reads the table; that is true of the table,
--                not of the migration file.)
-- Down:  0004_migration_runs_fixes.down.sql restores 0003's constraints and comment; 'interrupted'
--        rows become 'failed' first, the only outcome 0003 allows for a finished run.

ALTER TABLE public.migration_runs
    DROP CONSTRAINT ck_migration_runs_outcome,
    DROP CONSTRAINT ck_migration_runs_order,
    ADD CONSTRAINT ck_migration_runs_outcome CHECK (outcome IN ('succeeded', 'failed', 'interrupted')),
    ADD CONSTRAINT ck_migration_runs_counts CHECK (jsonb_typeof(counts) = 'object'),
    ADD CONSTRAINT ck_migration_runs_validation CHECK (
        (validation IS NULL OR jsonb_typeof(validation) = 'object')
        AND (outcome IS DISTINCT FROM 'succeeded' OR validation IS NOT NULL)),
    ADD CONSTRAINT ck_migration_runs_source_dump_sha CHECK (source_dump_sha ~ '^[0-9a-f]{64}$');

COMMENT ON TABLE public.migration_runs IS
    'Transitional. Dropped at M6 by a V2 migration, with the legacy database; see ADR-031. Ops module: one etl-v2 run (dry runs write none).';
