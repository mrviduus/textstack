# database/v2/

The V2 database, `textstack_v2` ([ADR-030](../../docs/01-architecture/adr/ADR-030-two-databases-one-cutover.md)):
its schema as plain SQL files, and the runner that applies them. The schema itself is decided in
[ADR-031](../../docs/01-architecture/adr/ADR-031-v2-schema.md); the table map is the V2 section of
[data-model.md](../../docs/01-architecture/data-model.md).

```
database/v2/
  run.sh                        migrator-v2's entrypoint: creates the database if missing, then migrate.sh
  migrate.sh                    the runner: database/migrate.sh without its EF Core bootstrap
  migrations/
    0000_baseline.up.sql        the whole V2 schema; no down, no seed rows
  tests/invariants.sql          ADR-031's schema rules, checked against a migrated database
  tests/roundtrip.sh            CI check of the runner and every V2 migration (runs invariants.sql)
```

Commands, ledger, transactions, checksums, naming and "adding a migration" work exactly as in
[database/README.md](../README.md), with `database/v2/` in place of `database/`. This file lists only
what differs.

## Running it

| | Legacy database | `textstack_v2` |
|---|---|---|
| Compose service | `migrator` | `migrator-v2` (same image, entrypoint `run.sh`) |
| Database | `POSTGRES_DB` | `V2_POSTGRES_DB`, default `textstack_v2` |
| Make | `migrate`, `migrate-down V=`, `migrate-status` | `migrate-v2`, `migrate-v2-down V=`, `migrate-v2-status` |
| Created by | the postgres image, on first start | `run.sh up`/`down`, if missing (`CREATE DATABASE` via `\gexec`); `status` and `verify` never create it |

`api` and `worker` wait for both migrators (ADR-021). Neither connects to `textstack_v2` yet (M1.2).

Without psql installed:

```sh
docker run --rm --network host -v "$PWD/database:/database:ro" \
  -e PGHOST=localhost -e PGUSER=app -e PGPASSWORD=changeme -e PGDATABASE=textstack_v2 \
  pgvector/pgvector:pg16 sh /database/v2/run.sh status
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
