-- 0003_migration_runs — the ETL's run ledger (M3.1)
--
-- What:  one new table, migration_runs: one row per non-dry-run `etl-v2` run — when it started,
--          whether and how it finished, the per-aggregate counts and the validation result.
-- Why:   v2-plan §5.2 / ADR-031 "Decision — tables": the ETL records every run in V2, so a rehearsal
--          (M3.5) and the cutover (M5) can read what each run moved and whether it validated.
--          A row with finished_at NULL is a run that is still going or was interrupted; the next
--          run reports it, it never deletes it.
-- Issue: https://github.com/mrviduus/textstack/issues/1026
-- Compatibility: additive. No existing table, column or constraint changes; nothing deployed reads
--                or writes it (the `etl-v2` CLI is the only writer). Concurrent runs are serialised
--                by an advisory lock in the CLI, not by this table.
-- Down:  0003_migration_runs.down.sql drops the table — with the run history it holds.

CREATE TABLE public.migration_runs (
    id              uuid        NOT NULL,
    started_at      timestamptz NOT NULL,
    finished_at     timestamptz,
    -- NULL while running or after an interruption; set once, with finished_at.
    outcome         text,
    -- The backup the source was restored from, when there is one (rehearsals); NULL on a live source.
    source_dump_sha text,
    counts          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    validation      jsonb,
    CONSTRAINT pk_migration_runs PRIMARY KEY (id),
    CONSTRAINT ck_migration_runs_outcome CHECK (outcome IN ('succeeded', 'failed')),
    CONSTRAINT ck_migration_runs_finished CHECK ((finished_at IS NULL) = (outcome IS NULL)),
    CONSTRAINT ck_migration_runs_order CHECK (finished_at IS NULL OR finished_at >= started_at)
);

COMMENT ON TABLE public.migration_runs IS
    'Transitional. Dropped at M6 with the legacy database; see ADR-031. ETL module: one etl-v2 run (dry runs write none).';
