# ADR-026 — SQL-first migrations

**Status:** Accepted · **Date:** 2026-10-26 · **Issue:** [#931](https://github.com/mrviduus/textstack/issues/931)
· **Supersedes:** the mechanics of [ADR-021](ADR-021-migrations-owned-by-the-migrator.md) (who migrates
and the rollback order stay)

## Context

The schema was built by 147 EF Core migrations (148 files, one never applied: #948) and a 5,626-line
model snapshot. Reading what a migration does meant reading generated C#; what EF could not model —
`pg_trgm`, `vector`, the full-text function and trigger, a generated column, trigram indexes — lived
in raw `migrationBuilder.Sql(...)` strings scattered across years of files. The database cleanup
(#926) is a long series of schema steps, each of which must be reviewable and reversible by reading
it, and data access is moving off EF Core module by module, so the schema cannot stay owned by the
EF model.

## Decision

1. **The schema is plain SQL in `database/migrations/`**: `NNNN_<name>.up.sql` + `NNNN_<name>.down.sql`,
   each up file opening with a header (what, why, issue, compatibility, what down does).
   `0000_baseline.up.sql` is production's schema on 2026-10-26 (`pg_dump --schema-only` of a restored
   backup, grouped by domain, + seed rows); it has no down.
2. **`database/migrate.sh` (POSIX sh + psql) applies them**: `up`, `down <version>`, `status`, `verify`.
   Ledger `schema_migrations(version, name, checksum, applied_at, execution_ms)`. Each file runs with
   its ledger row in one transaction (`--single-transaction`, `ON_ERROR_STOP`); each transaction takes
   `pg_advisory_xact_lock` and re-reads the ledger, so concurrent runners serialize. Applied files are
   never edited: a changed checksum stops `up` and `down`.
3. **Production bootstrap**: no ledger + `__EFMigrationsHistory` ending at the last EF migration →
   create the ledger, record `0000` as applied, run nothing. Any other EF history is refused. The EF
   history table stays until a later contract step, so a code rollback to an EF-migrator image finds a
   complete history and does nothing.
4. **ADR-021 holds**: only the `migrator` compose service migrates (now a ~22 MB alpine image with
   psql and `database/`); the Api never does — not even for `dotnet run`, which used to migrate behind
   a launchSettings flag. The Api embeds the up files at build time; at start and on every
   `/health/ready` it compares them with the ledger. Same contract: `components.schema =
   { status: "behind", pending: ["0007_x", …] }` and 503 until the migrator catches up.
5. **Rollback is an argument, not an environment variable**: `docker compose run --rm migrator down
   <version>` (`make migrate-down V=<version>`). `MIGRATE_TARGET` and its `.env` hazard are gone.
6. **`down` refuses versions this copy has no file for** — ADR-021 step 5, unchanged in meaning: an
   older image cannot undo a newer migration, so it must not report success.
7. **The EF model is checked against the schema** while it exists: `SchemaDriftTests` (CI, on the
   database `migrate.sh` built) fails if a mapped column is missing or differs in type or nullability,
   or a NOT NULL column without a default on a mapped table is not in the model.

## Rolling back a release with a migration — order unchanged from ADR-021

1. **Schema first, with the image deployed now** (it has the down files):
   `docker compose run --rm migrator down <last version of the target release>`.
2. **Verify:** `/api/health/ready` shows `schema: behind` with exactly the reverted versions in
   `pending`.
3. **Then the code:** deploy `rollback_commit`. Its migrator has no file for the reverted versions and
   nothing pending: `up` is a no-op; the old Api reports `schema: ok`.

The reverse order cannot work: after step 3 the migrator on the box has no down files for the newer
versions, and `down` exits 1 saying so.

## Release rules

- **Expand, then contract.** Every migration leaves the code deployed now working: add first; remove
  in a later release, once nothing deployed uses the old shape. That is what makes step 3 above safe.
- **Back up before a contract step.** A data-destroying down file recreates structure only; its
  header says the data comes from backup.
- One transaction per file rules out `CREATE INDEX CONCURRENTLY`; the tables are small enough for a
  plain `CREATE INDEX`. A non-transactional mode is added when one isn't.

## Alternatives

| option | verdict | why |
|---|---|---|
| Keep EF migrations, squash to one baseline | rejected | still generated C# to review, still a snapshot to keep in step, and the Dapper move would leave the schema owned by a model that no longer describes it |
| A migration tool (Flyway, Liquibase, DbUp, sqitch) | rejected | the needs fit ~200 lines of sh: a ledger, checksums, transactions, a lock, one refusal rule. A tool brings a runtime (JVM / .NET) back into the migrator and its own file conventions, and hides the mechanics this repo wants readable |
| One transaction for the whole `up` batch | rejected | a late failure would also undo earlier, valid migrations, and the ledger could no longer say how far a run got |
| Session `pg_advisory_lock` held across the run | rejected | psql opens one session per file; holding a lock across them needs a second long-lived connection. A transaction lock + ledger re-read gives the same guarantee per file |

## Consequences

- New schema change = a numbered up/down pair + a `data-model.md` row change, in one PR with an
  issue. `database/tests/roundtrip.sh` (CI) proves each down undoes its up: after each down the schema
  must equal a fresh database built only that far, and up again must restore the full schema.
- `dotnet ef migrations add` no longer exists here (`Microsoft.EntityFrameworkCore.Design`, the
  migrations folder and `AppDbContextFactory` are deleted). Entity changes are written twice — the
  mapping and the SQL — and the drift test keeps them together until EF is gone.
- Local development migrates with `make migrate` (the migrator image), including for `dotnet run`.
- `__EFMigrationsHistory` stays in production, unused, until it is dropped in a later migration.
