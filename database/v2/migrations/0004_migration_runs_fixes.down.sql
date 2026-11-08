-- Undoes 0004_migration_runs_fixes: 'interrupted' rows go back to unfinished (0003 records a dead
-- run as finished_at/outcome NULL), 0003's constraints and comment return, and validation_failures
-- is dropped — with what it holds. The close time of an interrupted row is lost: 0003 cannot hold it.

UPDATE public.migration_runs SET finished_at = NULL, outcome = NULL WHERE outcome = 'interrupted';

ALTER TABLE public.migration_runs
    DROP CONSTRAINT ck_migration_runs_source_dump_sha,
    DROP CONSTRAINT ck_migration_runs_validation,
    DROP CONSTRAINT ck_migration_runs_counts,
    DROP CONSTRAINT ck_migration_runs_validated_finished,
    DROP CONSTRAINT ck_migration_runs_validated_together,
    DROP CONSTRAINT ck_migration_runs_succeeded_validated,
    DROP CONSTRAINT ck_migration_runs_validation_failures,
    DROP CONSTRAINT ck_migration_runs_outcome,
    ADD CONSTRAINT ck_migration_runs_outcome CHECK (outcome IN ('succeeded', 'failed')),
    ALTER COLUMN started_at DROP DEFAULT,
    DROP COLUMN validation_failures;

COMMENT ON COLUMN public.migration_runs.source_dump_sha IS NULL;
COMMENT ON TABLE public.migration_runs IS
    'Transitional. Dropped at M6 with the legacy database; see ADR-031. ETL module: one etl-v2 run (dry runs write none).';
