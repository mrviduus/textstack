-- 0001_drop_ef_migrations_history — drop EF Core's migration ledger
--
-- What:  DROP TABLE "__EFMigrationsHistory" (147 rows: the EF migrations 0000_baseline stands for).
-- Why:   since #931 the ledger is schema_migrations (ADR-026). The EF table was kept only so a code
--        rollback to an EF-migrator image would find a complete history; that rollback path ends here.
-- Issue: https://github.com/mrviduus/textstack/issues/961
-- Compatibility: the app never reads it. migrate.sh reads it only to bootstrap a database that has
--        no ledger (a pre-#960 backup restored); that path stays. IF EXISTS: a database built from
--        the baseline never had the table.
-- Down:  0001_drop_ef_migrations_history.down.sql recreates the table with its 147 rows, so an
--        EF-era image works again. Rolling the code back past #960: `migrate.sh down 0` with the image
--        deployed now, then the code (ADR-026).

DROP TABLE IF EXISTS public."__EFMigrationsHistory";
