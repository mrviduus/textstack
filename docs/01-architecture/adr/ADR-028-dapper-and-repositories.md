# ADR-028 — Dapper + repositories

**Status:** Accepted · **Date:** 2026-10-26 · **Issue:** [#947](https://github.com/mrviduus/textstack/issues/947)
· **Builds on:** [ADR-026](ADR-026-sql-first-migrations.md) (the schema is plain SQL)

## Context

ADR-026 moved the schema out of the EF Core model into `database/migrations/`. The code still reads
and writes through EF: `AppDbContext` maps 50+ tables, `IAppDbContext` hands every `DbSet` to every
service, and ownership is enforced by query filters that a single `IgnoreQueryFilters()` switches
off. What a request sends to Postgres is decided by LINQ translation, so reading a query means
reading generated SQL in a log. The cleanup (#926) is redesigning modules one by one for V2; each
redesign needs the SQL it runs to be reviewable next to the method that runs it.

Scale today: EF in ~120 files, ~585 queries, ~230 `SaveChangesAsync` calls. A big-bang rewrite is
not on the table.

## Decision

1. **Data access moves to Dapper behind per-aggregate repositories**, module by module. The
   repository interface (a port) lives in `Application`; the Dapper implementation, with its SQL next
   to each method, lives in `Infrastructure/Persistence/Repositories/`. Endpoints never see SQL or a
   repository's internals. Rules: [data-access.md](../data-access.md).
2. **One `NpgsqlDataSource` per process**, a DI singleton built once from the connection string with
   the plugins the schema needs (pgvector). EF Core is configured on that same data source, so EF and
   Dapper share one pool and one type mapping during the transition.
3. **Strangler order.** Pilot: `book_insight` (one table, few consumers, constraints already clean).
   After it, only modules that survive into V2 are ported, each as part of its redesign; tables being
   retired are deleted from EF, never ported. A port moves a table completely — all reads and writes;
   no table is half EF, half Dapper.
4. **Mixed transactions while both exist.** When a use case writes EF tables and a ported table
   atomically, the caller opens the transaction on EF (`IAppDbContext.BeginTransactionAsync`) and
   passes the `IDbContextTransaction` to the repository method, which runs its command on that
   transaction's connection. Explicit, not ambient: the Worker builds contexts from
   `IDbContextFactory`, so a DI scope cannot tell a repository which context's transaction is the
   live one. When EF is gone, the same parameter becomes a unit of work over the data source.
5. **Ownership is in the SQL.** Every user-owned query takes `userId` and filters by it; each
   repository has an isolation test against real Postgres (`tests/TextStack.Persistence.Tests`,
   Testcontainers, schema built by `database/migrate.sh`). A system operation that spans users (e.g.
   re-ingestion moving every reader's insights) is a separately named method.
6. **EF Core is removed** when the last surviving module is ported; `SchemaDriftTests` then gives way
   to the repository tests.

## Consequences

- Each query is reviewable as SQL in the PR that changes it; Postgres idioms (`ON CONFLICT`,
  `RETURNING`, `= ANY(@ids)`) are used directly instead of read-then-write round trips.
- Two data-access styles coexist for a long time. The rule that a table belongs to exactly one of
  them keeps that cost bounded: no table has two sources of truth for its mapping.
- EF navigations into a ported table disappear. A query that joined through one becomes a second
  query through the repository (the first case: `review_question` → `book_insight`).
- The `site_id` query filter does not carry over. Repositories write `site_id` while the column
  exists and do not filter on it — single-site is permanent (ADR-007) and #946 removes the column.
- Repository tests need Docker locally and in CI.

## Alternatives considered

- **Stay on EF Core, raw SQL where it hurts.** Keeps two dialects in every module and the
  global-filter ownership model; the reviewability problem stays.
- **Generic `IRepository<T>`.** Becomes a thin, leaky copy of `DbSet<T>`; the point is explicit
  methods whose SQL can be read.
- **Ambient transaction (scoped connection or `TransactionScope`).** Breaks with factory-built
  contexts in the Worker; `TransactionScope` over two connections escalates to a distributed
  transaction Npgsql does not support.
