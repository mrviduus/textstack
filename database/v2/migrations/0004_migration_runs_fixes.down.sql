-- Undoes 0004_migration_runs_fixes: 0003's constraints and comment back. 'interrupted' rows
-- become 'failed' first (0003 has no other outcome for a finished run); a row whose finished_at
-- precedes started_at (clock step) blocks the down until fixed by hand.

UPDATE public.migration_runs SET outcome = 'failed' WHERE outcome = 'interrupted';

ALTER TABLE public.migration_runs
    DROP CONSTRAINT ck_migration_runs_source_dump_sha,
    DROP CONSTRAINT ck_migration_runs_validation,
    DROP CONSTRAINT ck_migration_runs_counts,
    DROP CONSTRAINT ck_migration_runs_outcome,
    ADD CONSTRAINT ck_migration_runs_outcome CHECK (outcome IN ('succeeded', 'failed')),
    ADD CONSTRAINT ck_migration_runs_order CHECK (finished_at IS NULL OR finished_at >= started_at);

COMMENT ON TABLE public.migration_runs IS
    'Transitional. Dropped at M6 with the legacy database; see ADR-031. ETL module: one etl-v2 run (dry runs write none).';
