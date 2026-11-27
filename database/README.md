# database/

The database, `textstack_v2` ([ADR-030](../docs/architecture/adr/ADR-030-two-databases-one-cutover.md)):
its schema as plain SQL files, and the scripts that apply them ([ADR-026](../docs/architecture/adr/ADR-026-sql-first-migrations.md)).
The schema itself is decided in [ADR-031](../docs/architecture/adr/ADR-031-v2-schema.md); the table map is the
V2 section of [data-model.md](../docs/architecture/data-model.md). The legacy database's ledger (`0000`–`0016`,
EF Core bootstrap included) was deleted at M6; git history keeps it.

```
database/
  run.sh                        the migrator's entrypoint: creates the database if missing, then migrate.sh;
                                also `create` (database only) and `drop <name>` (the baseline's rollback)
  migrate.sh                    the runner (POSIX sh + psql)
  migrations/
    0000_baseline.up.sql        the whole schema; no down, no seed rows
    0001_sync_protocol_deltas   the sync PDD's and the owner's schema deltas (ADR-031 "Amended 2026-11-01")
    0002_identity_and_indexes   the reset stamp, session kind + family, and #1047's indexes (ADR-031 "Amended 2026-11-02")
    0003_migration_runs         the etl-v2 run ledger (v2-plan §5.2)
    0004_migration_runs_fixes   its review fixes: interrupted outcome, typed jsonb, SHA-256 source_dump_sha
    0005_book_formats           book_files.format + fb2, mobi, azw3, cbz (ADR-031 "Amended 2026-11-07")
    0006_page_name_scheme       is_locator() takes page-name, a page-based position (ADR-031 "Amended 2026-11-13")
    0007_drop_migration_runs    the ETL ledger goes with the ETL (ADR-031: "dropped at M6.5")
    0008_transitional_table_comments  book_chapters / ingestion_jobs comments: kept at M6 (D8)
    0009_bare_cfi_position      a reading position may be a bare epub-cfi (mark-read's book start, ADR-033 P4)
    0010_drop_book_chapters_and_ingestion_jobs  both transitional tables dropped; book_files.toc commented (ADR-033 P5)
    0011_book_cover_updated_at  books.cover_updated_at: a cover's own cache version, apart from updated_at (#1584)
    0012_drop_review_question               dropped: chapter reviews are retired (#1624)
    0013_drop_agent_run                     dropped: the agent stack is retired (#1625)
  tests/invariants.sql          ADR-031's schema rules, checked against a migrated database
  tests/roundtrip.sh            CI check of the runner and every migration
```

## Running it

| | |
|---|---|
| Compose service | `migrator` (entrypoint `run.sh`); `api` and `worker` wait for it to exit 0 (ADR-021) |
| Database | `TEXTSTACK_DB`, default `textstack_v2` — not `POSTGRES_DB`, which is only the postgres image's init database |
| Make | `migrate`, `migrate-down V=`, `migrate-status`, `migrate-drop CONFIRM=` |
| Created by | `run.sh up`/`down`, if missing (`CREATE DATABASE` via `\gexec`); `status` and `verify` never create it |
| Text ordering | **ICU**, locale `und` — see below |

The wait is deliberate: since the cutover this is the only database, so a schema the migrator could
not apply is a reason not to start the code that needs it. Before the cutover it was the other way
round ([postmortem](../docs/internal/incidents/2026-10-30-migrator-v2-took-down-the-api.md)).

`run.sh` needs a role that may `CREATE DATABASE` and a reachable `postgres` maintenance database. It
creates from `template0`, so it does not need a `template1` whose collation version still matches —
which the production cluster did not have (#1056). On a new install keep `POSTGRES_DB` off the V2
name: the postgres image would create that database on first start, with the server's glibc locale,
and `run.sh` would then find it and migrate it as it is.

## Commands

`migrate.sh` (and `run.sh`, which passes its arguments on) reads the connection from the libpq
variables `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` — environment, never argv.

| Command | What it does |
|---|---|
| `up` | Applies every pending `.up.sql`, oldest first |
| `down <version>` | Reverts every applied version above `<version>`, newest first, with its `.down.sql` |
| `status` | Applied versions (with time and duration), pending ones, and applied ones this copy has no file for |
| `verify` | Fails if an applied file changed since it was applied |

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
- **The Api never migrates.** It embeds the up files it was built with and answers `/health/ready`
  (and `/me/v2/*`) 503 while one is pending.

## Adding a migration

1. Next free number (gaps are fine; never reuse one), both files: `0008_add_x.up.sql` and
   `0008_add_x.down.sql` — four digits, `_`, lowercase snake_case (anything else is refused).
2. Start the up file with this header:

   ```sql
   -- 0008_add_x — <what, one line>
   --
   -- What:  <the change>
   -- Why:   <the reason>
   -- Issue: https://github.com/mrviduus/textstack/issues/<n>
   -- Compatibility: <does the code deployed now still work after this runs? It must.>
   -- Down:  <what 0008_add_x.down.sql does; if it destroys data, say so — data comes from backup>
   ```

3. No `BEGIN`/`COMMIT` in the file: the runner wraps it. That also rules out statements that cannot
   run in a transaction (`CREATE INDEX CONCURRENTLY`).
4. Follow the schema rules below; update `tests/invariants.sql` when a rule's subject changes (a table
   added or dropped) and `docs/architecture/data-model.md`, in the same PR.
5. Run `tests/roundtrip.sh` (CI runs it too).

Never edit a file that has been applied anywhere; add a new one.

## Release rules

- **Expand, then contract.** A migration must leave the code deployed now working. Add first (new
  column, new table); remove in a later release, once no deployed code uses the old shape.
- **Back up before a contract step** (a drop or a rewrite); `deploy.yml` dumps the database before
  every deploy's migrator runs.
- **Rollback order:** schema first, with the copy deployed now (`down <last version of the target
  release>`), then the code. The other way round, the old copy has no down file for the newer
  versions.

## Checks

- `tests/roundtrip.sh`, on throwaway databases: up, a no-op second up, `verify`, `invariants.sql`; for
  each version, newest first, down to the one below it — `pg_dump --schema-only` must equal a fresh
  database built only that far, column order ignored (a re-added column lands last) — and up again,
  back to the full schema; an edited file failing `verify` and `up`; `down` refusing an unknown
  version; `run.sh` creating its database, and `status` never creating one. Each refusal is checked by
  its message. Without psql installed, run it in the postgres image:

  ```sh
  docker run --rm --network host -v "$PWD/database:/database:ro" \
    -e PGHOST=localhost -e PGUSER=app -e PGPASSWORD=changeme -e PGDATABASE=postgres \
    pgvector/pgvector:pg16 sh /database/tests/roundtrip.sh
  ```

- `tests/TextStack.Persistence.Tests`: every repository against a database `run.sh up` built.

## Why ICU, and not the server's locale

The default would tie this database's text ordering to the host's glibc. Bump the base image and
every text index is sorted by rules nothing uses any more, with no error: a btree lookup walks past
rows that are present, a UNIQUE index stops seeing a duplicate. The legacy cluster has been in that
state since its own initdb — Postgres said so once, as a log WARNING, in January.

ICU's version travels with the image, which is pinned by digest and which Dependabot no longer
bumps (#1056), so it cannot move on its own. `und`, the root locale, orders text exactly as the
`en_US.utf8` it replaces:

```
Älvsborg < apple < zebra < Zoo < ёлка < Ель < Чехов < Ящик
```

Identical under glibc `en_US.utf8` and ICU `und`; `C` would give `Zoo < apple`, which is why the
tempting "just use C and never think about collations again" is wrong for a library of books in
several languages. `LC_COLLATE`/`LC_CTYPE` are still required by `CREATE DATABASE ... TEMPLATE
template0`; with an ICU provider they are not what sorts, so `C` there is correct, not a compromise.

`/health/ready` reports this database's collation version either way (#1059).

## The baseline's rollback

**`make migrate-drop CONFIRM=textstack_v2`.** `make migrate-down V=0`
prints `Nothing above version 0.` and exits 0 — correct (nothing is applied above the baseline) but
not a rollback: the baseline has no down file. `migrate-drop` runs `run.sh drop <name>` in the
migrator image: `DROP DATABASE ... WITH (FORCE)`, all its data gone, refused unless `CONFIRM` names
the database `PGDATABASE` points at. The next `make migrate` builds it again. Dump it first
(`make backup`) if it holds anything.

## Backups (#1043)

`textstack_v2` holds all live data since the cutover (2026-11-17); the legacy database is read-only and
archived, and no backup dumps it any more. Every dump goes through `infra/scripts/pg-dump-checked.sh`: a
database that is absent, a query that cannot tell, or a dump without pg_dump's trailer is a failure, and the
file gets its real name only once complete.

| Where | File | Database absent or dump fails |
|---|---|---|
| `backup.yml` (nightly) | `textstack_v2-db-<date>.sql.gz`, R2 `/db_v2.sql` | job red |
| `deploy.yml` pre-deploy | `textstack_v2-pre-deploy-<date-time>.sql.gz` | deploy stops before anything live changes |
| `make backup` | `textstack_v2-db_<date_time>.sql.gz` | exit 1 |
| `restore-drill.yml` | restores `/db_v2.sql`, counts every table its ledger's migrations create; `users`, `books`, `book_files`, `annotations` non-empty; current book files exist in the restored library | red |

Restore: `make restore FILE=<a V2 dump>` loads it into a V2 database that does not exist yet,
created by `run.sh create` (ICU, `template0`, no migrations: the dump carries schema and ledger). It
refuses when the database exists — `make migrate-drop` first — and checks `FILE` before creating
anything.

Without psql installed:

```sh
docker run --rm --network host -v "$PWD/database:/database:ro" \
  -e PGHOST=localhost -e PGUSER=app -e PGPASSWORD=changeme -e PGDATABASE=textstack_v2 \
  pgvector/pgvector:pg16 sh /database/run.sh status
```

## Schema rules (ADR-031)

1. **One table, one owner module, one lifecycle**; the table's `COMMENT` names both.
2. **Ownership in the key.** Every user-owned table has `user_id`; references are composite
   `(user_id, …)` FKs, so a row cannot point at another user's row. Queries still filter `user_id`.
3. **Client-generated UUIDs**; the server never renumbers.
4. **Soft removal only where the product needs it**: `books.removed_at`, `annotations.deleted_at`,
   `vocabulary_words.deleted_at`. Everything else hard-deletes.
5. **Idempotency on every replayable write**: `operation_id` unique per user; `revision` guards
   last-writer-wins (stale → 409).
6. **Locators are envelopes** `{"version":1,"scheme":…,"value":…}`, checked by `is_locator()`;
   `epub-cfi` adds `quote` (required in `reading_state.current_locator`). SQL checks the shape, the
   application the content.
7. **Enums are `text` + CHECK; times are `timestamptz`.** `created_at`/`updated_at` are set by the
   repository; no triggers.
8. **No JSON for anything queried by.** JSON only for opaque client payloads.
9. **Account deletion = `DELETE FROM users`, cascading.** Provenance FKs are
   `DEFERRABLE INITIALLY DEFERRED`; tests end with `SET CONSTRAINTS ALL IMMEDIATE`.
10. **The baseline reads top to bottom**, grouped by module, each table preceded by a short comment.
    No `site_id` anywhere (ADR-007).

Names: `pk_<table>`, `fk_<table>_<reftable>_<cols>`, `ak_<table>_<cols>` (unique constraint),
`ck_<table>_<what>`, `ix_<table>_<cols>` (unique or not). Identifiers stop at 63 characters.

## Not carried from legacy

Columns of the tables the baseline carries from legacy that it leaves out (whole tables: ADR-031
"disposition"):

| Column | Why |
|---|---|
| `site_id` (`mcp_access_keys`, `book_insight`, `review_question`, `reading_sessions`) | ADR-007: one site; rule 10 |
| `book_insight.edition_id`, `user_book_id` and `ck_book_insight_target` | one `book_id` (ADR-031) |
| `reading_sessions.edition_id`, `user_book_id` | one nullable `book_id` |
| `agent_run.edition_id` | ADR-031: the catalog is retired |
| `user_chapters.search_vector` (generated) and its GIN index | ADR-031 disposition #34 |
| `user_chapters.content_quality_score` | not in ADR-031's `book_chapters` column list; PDF quality cleanup is not a V2 feature (#16) |
| `user_chapters.slug` | becomes `chapter_key` (`'ch-' \|\| chapter_number` when null) |

Defaults dropped: `users.email` and `users.google_subject` lose legacy's `DEFAULT ''` (the code
always writes them; with their unique indexes, an insert that omitted one would collide on `''`).
`ix_users_email` is unique on `lower(email)`: ADR-031 decided item 7 matches accounts by email
case-insensitively. `reading_sessions`' percents are `numeric`, like every other fraction.

`oauth_clients` has no seed: legacy seeds none, so its rows come only from the ETL (M3).
