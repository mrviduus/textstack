# database/

The TextStack schema as plain SQL files, and the script that applies them.

`migrate.sh` and `tests/roundtrip.sh` also serve `database/v2/` ([its README](v2/README.md)),
which symlinks both: one runner and one round trip, two databases (ADR-030).

```
database/
  migrate.sh                    the runner (POSIX sh + psql)
  migrations/
    0000_baseline.up.sql        the whole schema as of 2026-10-26 + seed rows; no down
    NNNN_<name>.up.sql          one change
    NNNN_<name>.down.sql        how to undo it
  tests/roundtrip.sh            CI check of the runner and every migration
```

## Commands

`migrate.sh` reads the connection from the libpq variables `PGHOST`, `PGPORT`, `PGDATABASE`,
`PGUSER`, `PGPASSWORD`.

| Command | What it does |
|---|---|
| `migrate.sh up` | Applies every pending `.up.sql`, oldest first |
| `migrate.sh down <version>` | Reverts every applied version above `<version>`, newest first, with its `.down.sql` |
| `migrate.sh status` | Applied versions (with time and duration), pending ones, and applied ones this copy has no file for |
| `migrate.sh verify` | Fails if an applied file changed since it was applied |

Without psql installed, run it in the postgres image, e.g. against the local stack's database:

```sh
docker run --rm --network host -v "$PWD/database:/database:ro" \
  -e PGHOST=localhost -e PGUSER=app -e PGPASSWORD=changeme -e PGDATABASE=books \
  pgvector/pgvector:pg16 sh /database/migrate.sh status
```

## How it works

- **Ledger** `schema_migrations(version, name, checksum, applied_at, execution_ms)`, one row per
  applied file. `migrate.sh` creates it on first use.
- **One transaction per file.** Each file runs with `psql --single-transaction -v ON_ERROR_STOP=1`,
  and its ledger insert (or, for `down`, delete) is in the same transaction. A failing file leaves
  neither its changes nor its ledger row.
- **One runner at a time.** Each transaction first takes `pg_advisory_xact_lock`, then re-reads the
  ledger: a second runner waits, then skips what the first one already did.
- **Checksums.** The ledger keeps the sha256 of each up file as applied. `up` and `down` refuse to run
  when an applied file has changed; fix forward with a new migration instead. Down files are not
  checksummed: until one runs, it may still be fixed.
- **No down for an unknown version.** If the database has versions this copy has no file for (a newer
  release applied them, then the code was rolled back), `down` refuses: this copy does not have their
  `.down.sql`. Roll the schema back with the copy that has them. `up` only notes them and continues.
- **Production bootstrap.** Production was built by 147 EF Core migrations. When the ledger is missing
  and `__EFMigrationsHistory` exists, `up` creates the ledger, records `0000_baseline` as applied
  (`execution_ms` 0) and runs nothing for it. Only if that history ends at the last EF migration the
  baseline stands for (`EF_HEAD` in `migrate.sh`); any other history is a different schema, refused.
  `0001` then drops the EF history table; its down file restores it with its 147 rows.

## Adding a migration

1. Next free number (gaps are fine; never reuse one), both files: `0001_add_x.up.sql` and
   `0001_add_x.down.sql` — four digits, `_`, lowercase snake_case (anything else is refused).
2. Start the up file with this header:

   ```sql
   -- 0001_add_x — <what, one line>
   --
   -- What:  <the change>
   -- Why:   <the reason>
   -- Issue: https://github.com/mrviduus/textstack/issues/<n>
   -- Compatibility: <does the code deployed now still work after this runs? It must.>
   -- Down:  <what 0001_add_x.down.sql does; if it destroys data, say so — data comes from backup>
   ```

3. No `BEGIN`/`COMMIT` in the file: the runner wraps it. That also rules out statements that cannot
   run in a transaction (`CREATE INDEX CONCURRENTLY`); the tables are small enough for a plain
   `CREATE INDEX`.
4. Update `docs/01-architecture/data-model.md` in the same PR.
5. Run `tests/roundtrip.sh` (CI runs it too).

Never edit a file that has been applied anywhere; add a new one.

## Release rules

- **Expand, then contract.** A migration must leave the code deployed now working. Add first (new
  column, new table); remove in a later release, once no deployed code uses the old shape.
- **Back up before a contract step** (a drop or a rewrite).
- **Rollback order:** schema first, with the copy deployed now (`down <last version of the target
  release>`), then the code. The other way round, the old copy has no down file for the newer
  versions.

## Checks

- `tests/roundtrip.sh`, on throwaway databases: up and a no-op second up; for each version, newest
  first, down to the one below it — `pg_dump --schema-only` must equal a fresh database built only
  that far, column order ignored (a re-added column lands last) — and up again, back to the full
  schema; the EF-history bootstrap and its refusal of a history that ends elsewhere; an edited file
  failing `verify` and `up`; `down` refusing an unknown version. Each refusal is checked by its
  message.
- `tests/TextStack.IntegrationTests/SchemaDriftTests.cs`: every column the EF Core model maps exists in
  the migrated database with the same type and nullability, and every NOT NULL column without a
  default on a mapped table is in the model.
