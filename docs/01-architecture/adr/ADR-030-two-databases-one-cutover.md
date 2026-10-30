# ADR-030 — Two databases, one cutover

**Status:** Proposed · **Date:** 2026-10-30 · **Plan:** [v2-plan.md](../v2-plan.md) §5 · **Builds on:** ADR-026, ADR-028 · **Supersedes:** the in-place/interim migration of ADR-027 (which stays Proposed-deferred as research input) · **Keeps:** ADR-021 (only the migrator migrates)

## Context

V2 is a personal, local-first reader on ~24 tables ([v2-plan.md](../v2-plan.md) §1.2, §4.2). The
legacy database has 58, two parallel reading models (catalog `editions`, uploads `user_books`), and
is read and written through EF Core: 56 `DbSet`s in ~115 files. ADR-028 started the port to Dapper
table by table; one table (`book_insight`) has moved.

Three V2 tables collide by name with live legacy tables of a different shape: `book_files`
(legacy = catalog files, V2 = an upload's file versions), `vocabulary_words` and
`vocabulary_reviews` (V2 drops embeddings, clusters and tutor fields, keys a card by
`(user_id, language, word_key)`). Building V2 inside the legacy `public` schema means renaming one
side or altering live tables in place.

A table-by-table strangler in one database is slow here for a structural reason: almost every V2
table is a *reshape* of legacy rows (two reading models fold into `books`, `admin_users` into
`users.role`, `edition_id`/`user_book_id` into one `book_id`), not a port of a table that keeps its
shape. Each step would need an interim schema, dual-path code and a migration that is later
undone, and EF would live until the last of ~58 tables is resolved. The data is small (largest
preserved set: `user_chapters`, 131 MB), so moving it in one event costs minutes.

## Decision

1. **A separate database `textstack_v2`, in the same Postgres container.** One volume, one RAM pool
   on the home server (plan, open question 1). It is created and migrated by a `migrator-v2`
   compose service running `database/v2/migrate.sh` with `PGDATABASE=textstack_v2`
   ([migrate.sh](../../../database/migrate.sh) selects its database only through the libpq `PG*`
   variables). Own ledger (`schema_migrations` inside `textstack_v2`), own `0000_baseline` that *is*
   the V2 schema — no `legacy_*` names, no interim history. Proposed shape: the existing migrator
   image also carries `database/v2/`, and `migrator-v2` overrides entrypoint and env, so `images.yml`
   and the digest-pull list in `deploy.yml` (`migrator api worker admin ssg-worker mcp-server`) do not
   grow a seventh image. ADR-021 holds for both databases: only a migrator migrates.
   **Amended 2026-10-30:** `api` and `worker` wait on the legacy migrator only. Waiting on
   `migrator-v2` too took the site down on the day it shipped, for a database nothing read
   ([postmortem](../../incidents/2026-10-30-migrator-v2-took-down-the-api.md)); `migrator-v2` is
   behind compose profile `v2`. V2 readiness returns as a gate over V2 endpoints when V2 holds real
   data (#1053) — two databases exist so that V2 can be broken while V1 serves, and a hard
   dependency from V1's containers undoes exactly that.
2. **V2 code is Dapper-only, against a second `NpgsqlDataSource` (`V2DataSource`).** Legacy code stays
   on EF Core and its data source until it is deleted; nothing new is added to EF. No table is ever
   half in one database and half in the other, or half EF and half Dapper (ADR-028 §3 holds
   trivially). Repository rules: [data-access.md](../data-access.md); a V2 unit of work passes an
   explicit `NpgsqlTransaction` (plan §6). This amends ADR-028 §2 ("one data source per process") to
   one per database.
3. **Users exist in V2 before any real V2 write.** Cross-database foreign keys are impossible, and
   every V2 user-owned table keys on `users`. So auth over V2 (plan M2.5: `AuthService`, guest merge,
   account delete) ships first, and during M2–M4 V2 is test-only behind `Features:V2Api`: no real
   user's data is written to `textstack_v2` before the cutover's ETL.
4. **Preserved data moves by an ETL CLI, `migrate-v2`** (plan §5.2). Reads legacy over a read-only
   connection; writes through the same V2 repositories the API uses (bulk `book_chapters` by `COPY`).
   Deterministic ids: uploads keep their ids (`books.id = user_books.id`); catalog pairs get
   `uuid_v5('textstack-v2', user ‖ edition)`; operation ids are `uuid_v5` of the legacy row id. Re-runs
   are no-ops (`ON CONFLICT DO NOTHING` + a count report). Ledger `migration_runs` in V2 (dropped at
   M6). Gate: `database/v2/scripts/validate-etl.sql` must report 0 failures. Rehearsed on restored
   backups via `restore-drill.yml` until it reports 0 failures three times in a row.
5. **Cutover is one event** (plan §5.3): write freeze ≤10 min (`Maintenance:WriteFreeze`); `pg_dump`
   of legacy to an archive outside restic retention + git tag `pre-v2-cutover`; `migrate-v2`;
   validation 0 failures; flip `Database:Mode=v2` (force-recreate api/worker); legacy database
   `default_transaction_read_only = on`. **Rollback = flip back** and turn read-only off: V2 code
   never writes legacy, so legacy is exactly as it was at the freeze.
6. **Old clients get a compatibility shim** (plan §5.4; write matrix adapted from
   [catalog-retirement-plan.md](../catalog-retirement-plan.md) §7). It translates edition-keyed and
   `user_books`-keyed routes to V2 (upload ids are unchanged, so most map 1:1; edition writes → the
   pair's V2 book or 410; catalog reads → 410). Every hit is logged with `X-App-Version`, route and
   outcome. Window: 60 days, closed only after the log has been silent for the last 14. iOS is
   treated as in production until the owner says otherwise — it cannot be forced by
   `MOBILE_MIN_SUPPORTED_BUILD`, so the log, not the calendar, ends the shim.
7. **Retirement is by whole units** (plan §5.5, M6). The legacy database is dropped whole, only after
   a restore of the cutover archive is proven. EF Core, `AppDbContext`, `SchemaDriftTests`, and the
   catalog/SEO/SSG code are deleted as units, one PR each — never ported. `database/v2/` then becomes
   `database/`; legacy migrations stay in git history.

## Consequences

**Positive**
- The schema the owner reads for years is the final one: `database/v2/migrations/0000_baseline.up.sql`
  top to bottom, no rename noise, no interim history.
- Legacy code is not touched until it is deleted; no dual-path code inside a module.
- EF leaves with its database, not table by table; the end state is checkable
  (`git grep -l "DbContext\|EntityFrameworkCore" backend/` is empty; plan §10).
- Rollback during the window is a configuration flip with nothing to reconcile in legacy.

**Costs**
- Two connection strings, two data sources, two migrators and two ledgers for months (M1–M6).
  `/health/ready` and `health-check.yml` must report both schemas; `backup.yml`, the pre-deploy dump
  in `deploy.yml`, `make backup` and `restore-drill.yml` dump only the legacy database today and must
  cover `textstack_v2` before it holds anything worth keeping.
- `migrate.sh` connects to `PGDATABASE`; it does not create it. `migrator-v2` needs a `CREATE
  DATABASE` step against the maintenance database (idempotent), decided in M1.1. On the production
  cluster that step cannot succeed at all until `template1`'s collation version is repaired
  (#1056) — a condition that predates V2 and that nothing had hit, because nothing had created a
  database since initdb.

**Two things the retirement step gets for free** (M6, after legacy is deleted)
- The `vector` extension goes. V2 has no vector column and ADR-031 D6 retires the embedding,
  cluster and tutor data; it is only the legacy `vocabulary_words.embedding` (`public.vector(1536)`)
  that keeps the cluster on `pgvector/pgvector` — a vanilla `postgres:16` cannot even restore that
  dump (`infra/scripts/backup-verify.sh`).
- Collation is normalised. Leaving pgvector means a dump and restore into a fresh cluster, and a
  restore rebuilds every index under the current OS sort rules. So the repair in #1056 and dropping
  pgvector are one action, and the cutover plan should schedule them together rather than reindexing
  a cluster twice.
- The cutover is a single event. Rehearsal bounds the risk: same CLI, same validation, on real
  backups, three clean runs before production; small data keeps the freeze short.
- Flip-back discards whatever was written to V2 after the flip — legacy never sees it. The smoke
  (plan §5.3 step 7) therefore runs immediately after the flip, and a rollback decision is made
  inside the window, not days later.
- The guest → account merge is rewritten per aggregate over V2 (plan §6.1); today's merge, which
  drops `book_insight`/`review_question`, is not carried over.
- A transitional `book_chapters` (+ `ingestion_jobs`) lives in V2 until the V2 reader serves EPUB and
  PDF on all clients (plan open question 2); its sunset is written into ADR-031, the table comment,
  and the M6.4 gate on R8.
- The shim is server code kept alive for at least 60 days after cutover.

## Alternatives considered

- **Rename legacy tables to `legacy_*` in one database.** Solves the collision but puts rename noise
  and a long interim history into the schema meant to be read for years; legacy code must change
  every query to follow the rename.
- **Postgres schemas as module boundaries (`v2.*` beside `public.*`).** Complicates `migrate.sh`,
  `SchemaDriftTests`, `roundtrip.sh` and backups (search paths, per-schema ledgers), and the legacy
  half still cannot be dropped as one unit.
- **In-place `ALTER`s toward V2 (ADR-027's interim path).** Every reshape becomes an interim schema
  plus a migration later undone; EF and dual-path code survive until the last table; two transitions
  for the same data.
- **Fresh database + big-bang without rehearsal.** Same shape as this ADR minus the evidence: the
  first time the ETL meets production data would be the cutover.
- **Dual-write (legacy and V2 kept in sync until switch).** Doubles every write path, needs
  reconciliation for partial failures across two databases with no distributed transaction, and the
  data is small enough that a ≤10-minute freeze is cheaper.

## Rollback

| Phase | Rollback | Data |
|---|---|---|
| Before cutover (M1–M4) | nothing to roll back: V2 holds only test data; drop or re-create `textstack_v2`; revert code | no loss |
| Cutover window (M5, until smoke passes) | flip `Database:Mode=legacy`, legacy read-only off | legacy untouched; V2 writes after the flip are discarded |
| After the flip, during the shim window | still a flip, but every real V2 write since cutover is lost unless replayed | **loss grows with time** — decide in the window |
| After the shim window / legacy dropped (M6) | restore the cutover archive (`pg_dump`, tag `pre-v2-cutover`) | **data-loss boundary**: everything written after the freeze is gone |

Related: [ADR-021](ADR-021-migrations-owned-by-the-migrator.md) ·
[ADR-026](ADR-026-sql-first-migrations.md) · [ADR-027](ADR-027-retire-public-catalog.md) ·
[ADR-028](ADR-028-dapper-and-repositories.md) · [catalog-retirement-plan.md](../catalog-retirement-plan.md) ·
[v2-plan.md](../v2-plan.md).
