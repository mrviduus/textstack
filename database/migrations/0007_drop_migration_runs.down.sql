-- Undoes 0007_drop_migration_runs: the table as 0003 + 0004 left it, empty. The rows it held are not
-- recoverable from here (a V2 backup taken before 0007 ran has them).

CREATE TABLE public.migration_runs (
    id                  uuid        NOT NULL,
    started_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at         timestamptz,
    outcome             text,
    source_dump_sha     text,
    counts              jsonb       NOT NULL DEFAULT '{}'::jsonb,
    validation          jsonb,
    validation_failures integer,
    CONSTRAINT pk_migration_runs PRIMARY KEY (id),
    CONSTRAINT ck_migration_runs_outcome CHECK (outcome IN ('succeeded', 'failed', 'interrupted')),
    CONSTRAINT ck_migration_runs_finished CHECK ((finished_at IS NULL) = (outcome IS NULL)),
    CONSTRAINT ck_migration_runs_order CHECK (finished_at IS NULL OR finished_at >= started_at),
    CONSTRAINT ck_migration_runs_validation_failures CHECK (validation_failures >= 0),
    CONSTRAINT ck_migration_runs_succeeded_validated CHECK (outcome IS DISTINCT FROM 'succeeded' OR (validation_failures = 0) IS TRUE),
    CONSTRAINT ck_migration_runs_validated_together CHECK ((validation_failures IS NULL) = (validation IS NULL)),
    CONSTRAINT ck_migration_runs_validated_finished CHECK (finished_at IS NOT NULL OR validation_failures IS NULL),
    CONSTRAINT ck_migration_runs_counts CHECK (jsonb_typeof(counts) = 'object'),
    CONSTRAINT ck_migration_runs_validation CHECK (jsonb_typeof(validation) = 'object'),
    CONSTRAINT ck_migration_runs_source_dump_sha CHECK (source_dump_sha ~ '^[0-9a-f]{64}$')
);

COMMENT ON COLUMN public.migration_runs.validation_failures IS
    'Validation failures of a finished run; NULL = not validated. A succeeded run has 0.';
COMMENT ON COLUMN public.migration_runs.source_dump_sha IS
    'SHA-256 of the backup the source was restored from (etl-v2 --source-dump-sha); NULL = a source not restored from a backup.';
COMMENT ON TABLE public.migration_runs IS
    'Transitional. Dropped at M6.5 by a V2 migration, with the legacy database; see ADR-031. Ops module: one etl-v2 run (dry runs write none).';
