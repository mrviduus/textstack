# database/v2/

The V2 database, `textstack_v2` ([ADR-030](../../docs/01-architecture/adr/ADR-030-two-databases-one-cutover.md)):
its schema as plain SQL files, and the runner that applies them. The schema itself is decided in
[ADR-031](../../docs/01-architecture/adr/ADR-031-v2-schema.md); the table map is the V2 section of
[data-model.md](../../docs/01-architecture/data-model.md).

```
database/v2/
  run.sh                        migrator-v2's entrypoint: creates the database if missing, then migrate.sh
  migrate.sh                    -> ../migrate.sh (the runner resolves migrations/ next to the path it is called by)
  migrations/
    0000_baseline.up.sql        the whole V2 schema; no down, no seed rows
  tests/invariants.sql          ADR-031's schema rules, checked against a migrated database
  tests/roundtrip.sh            -> ../../tests/roundtrip.sh (its steps 1, 2, 4 plus invariants, the fixture and run.sh)
  tests/fixtures/               a throwaway migration, so the round trip can exercise down
```

The two symlinks keep one copy of each script: the EF Core bootstrap inside `migrate.sh` can only
fire on a database EF Core built, which `textstack_v2` never is, and each round-trip step skips
itself where the folder has no files for it.

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
| Text ordering | glibc, via the server's `en_US.utf8` | **ICU**, locale `und` — see below |
| Run by `docker compose up` | yes | **no** — profile `v2`; run it with `make migrate-v2` |

`api` and `worker` wait for `migrator` (ADR-021) and **not** for `migrator-v2`: nothing connects to
`textstack_v2` yet (M1.2), so a V2 migrator that cannot reach or create its database must not keep
the site down. It did, once, on the day it shipped —
[postmortem](../../docs/incidents/2026-10-30-migrator-v2-took-down-the-api.md). The wait comes back,
over V2 endpoints only, when V2 holds real data (#1053).

`run.sh` needs a role that may `CREATE DATABASE` and a reachable `postgres` maintenance database. It
creates from `template0`, so it does not need a `template1` whose collation version still matches —
which the production cluster did not have, and which is why `migrator-v2` could not run there at all
until 2026-10-30 (#1056). `make migrate-v2` is how you find a problem like that out — not a deploy.

### Why ICU, and not the server's locale

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

**There is no rollback of the baseline.** `make migrate-v2-down V=0` prints `Nothing above version 0.`
and exits 0 — correct (nothing is applied above the baseline) but not a rollback: the baseline has
no down file. Undoing it is `DROP DATABASE textstack_v2`, by hand; the next `migrator-v2` run
builds it again.

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
