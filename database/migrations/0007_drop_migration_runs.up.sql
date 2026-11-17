-- 0007_drop_migration_runs — the etl-v2 run ledger goes (ADR-031: "dropped at M6.5")
--
-- What:  DROP TABLE public.migration_runs, with its rows.
-- Why:   the ETL ran for the last time at the cutover (2026-11-17), its CLI was deleted at M6 B3 and
--          the legacy database it read is about to be dropped. The rows are run history only; the
--          cutover record lives in internal/ops/, and the table's last state in the V2 backups.
-- Issue: https://github.com/mrviduus/textstack/issues/1013
-- Compatibility: nothing deployed reads or writes the table (the etl-v2 CLI and validate-etl.sql were
--                its only users, both deleted). The Api counts this file for readiness, so /me/v2
--                answers 503 until it is applied; compose runs the migrator before api and worker.
-- Down:  0007_drop_migration_runs.down.sql recreates the table as 0003 + 0004 left it, empty: the run
--        history is lost (a V2 backup taken before this ran still has it).

DROP TABLE public.migration_runs;
