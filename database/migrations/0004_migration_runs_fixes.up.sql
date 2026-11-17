-- 0004_migration_runs_fixes — the etl-v2 ledger, after /code-review of 0003 (#1131) and of this file (#1133)
--
-- What:  migration_runs gains an 'interrupted' outcome and a typed validation_failures count; a
--          succeeded run must have validated with 0 failures; counts and validation must be JSON
--          objects; source_dump_sha must be a lowercase SHA-256 hex digest; the COMMENT names its
--          module (Ops) and its drop (M6.5, with the legacy database).
-- Why:   a dead run's row could only stay unfinished forever: the next run, once it holds the ETL
--          advisory lock, closes every other unfinished row as 'interrupted' (finished_at = when
--          closed), never deletes it. A gate must not read "no failures" out of a NULL or an empty
--          jsonb (README rule 8: nothing queried lives in JSON), so the result is a column the
--          database checks. source_dump_sha ties a rehearsal row to the backup it ran on (owner
--          2026-11-07). started_at now defaults to the server's clock_timestamp() (wall clock, not
--          the transaction's start), and every finish or close stamps
--          finished_at = GREATEST(clock_timestamp(), started_at), so ck_migration_runs_order stays and
--          neither a client clock nor a clock step can fail a finish. validation_failures and the
--          validation report come together, on a finished run only.
--        Existing rows that break the new CHECKs make this migration fail, on purpose: there is
--          no truthful backfill for a run's validation (only throwaway test databases have rows;
--          on one that refuses, `DELETE FROM migration_runs` and run again — it is run history only).
-- Issue: https://github.com/mrviduus/textstack/issues/1026
-- Compatibility: textstack_v2 has no ledger rows anywhere real (prod is at 0002; the etl-v2 CLI is
--                unreleased). Like every V2 migration, the Api counts this file for readiness: with
--                Features:V2Api on, V2 is "behind" until `make migrate-v2` applies 0003 and 0004.
--                (0003's header said nothing deployed reads the table; true of the table, not of
--                the migration file.)
-- Down:  0004_migration_runs_fixes.down.sql: 'interrupted' rows go back to unfinished (0003's
--        meaning of a dead run), then 0003's constraints and comment return and validation_failures
--        is dropped — with what it holds.

ALTER TABLE public.migration_runs
    ADD COLUMN validation_failures integer,
    ALTER COLUMN started_at SET DEFAULT clock_timestamp(),
    DROP CONSTRAINT ck_migration_runs_outcome,
    ADD CONSTRAINT ck_migration_runs_outcome CHECK (outcome IN ('succeeded', 'failed', 'interrupted')),
    ADD CONSTRAINT ck_migration_runs_validation_failures CHECK (validation_failures >= 0),
    ADD CONSTRAINT ck_migration_runs_succeeded_validated CHECK (outcome IS DISTINCT FROM 'succeeded' OR (validation_failures = 0) IS TRUE),
    ADD CONSTRAINT ck_migration_runs_validated_together CHECK ((validation_failures IS NULL) = (validation IS NULL)),
    ADD CONSTRAINT ck_migration_runs_validated_finished CHECK (finished_at IS NOT NULL OR validation_failures IS NULL),
    ADD CONSTRAINT ck_migration_runs_counts CHECK (jsonb_typeof(counts) = 'object'),
    ADD CONSTRAINT ck_migration_runs_validation CHECK (jsonb_typeof(validation) = 'object'),
    ADD CONSTRAINT ck_migration_runs_source_dump_sha CHECK (source_dump_sha ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN public.migration_runs.validation_failures IS
    'Validation failures of a finished run; NULL = not validated. A succeeded run has 0.';
COMMENT ON COLUMN public.migration_runs.source_dump_sha IS
    'SHA-256 of the backup the source was restored from (etl-v2 --source-dump-sha); NULL = a source not restored from a backup.';
COMMENT ON TABLE public.migration_runs IS
    'Transitional. Dropped at M6.5 by a V2 migration, with the legacy database; see ADR-031. Ops module: one etl-v2 run (dry runs write none).';
