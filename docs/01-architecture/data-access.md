# Data access — Dapper + repositories

How code talks to Postgres once a module is ported off EF Core. Decision and migration path:
[ADR-028](adr/ADR-028-dapper-and-repositories.md). Schema: `database/` ([ADR-026](adr/ADR-026-sql-first-migrations.md)).

## Layers

```
Domain/                         entities, value objects — no Dapper, no SQL
Application/                    use-case services; repository interfaces (ports), e.g. IInsightRepository
Infrastructure/Persistence/
  DataSource.cs                 the one NpgsqlDataSource (+ Dapper global setup)
  Repositories/                 one per aggregate; SQL next to the method that runs it
Api/Endpoints/                  map HTTP → service or repository port; no SQL
database/                       schema (up/down SQL)
tests/TextStack.Persistence.Tests   repositories against real Postgres (Testcontainers + migrate.sh)
```

Dependency rule unchanged: Api → Application → Domain ← Infrastructure.

## Rules

1. **One repository per aggregate, explicit methods.** No generic `IRepository<T>`. A method's name
   says what it does (`DeleteAsync(userId, id)`, not `Remove(entity)`).
2. **Explicit column lists.** Never `SELECT *` — a new column must not silently change what a query
   returns or what a DTO maps.
3. **Parameters only.** Never build SQL from input. Where a fragment must vary (a sort column, an
   `ON CONFLICT` target), pick it from a closed `switch` over constants.
4. **Async with cancellation.** Every call is `await conn.XxxAsync(new CommandDefinition(sql, args,
   transaction, cancellationToken: ct))`.
5. **One `NpgsqlDataSource`, a singleton**, shared with EF Core. Per operation:
   `await using var conn = await dataSource.OpenConnectionAsync(ct)`; it returns to the pool on
   dispose. Never hold a connection across awaits you don't own.
6. **Transactions.** A use case that writes EF tables and a ported table together opens the
   transaction on EF and passes the `IDbContextTransaction` to the repository; the repository runs on
   that transaction's connection (`GetDbTransaction()`), never its own. A method that can join one
   takes `IDbContextTransaction? tx = null`.
7. **Ownership in SQL.** Every user-owned method takes `userId` and puts it in the `WHERE` (and in the
   `ON CONFLICT` key / `INSERT`). Cross-user system operations are separate, clearly named methods.
   Each repository has an isolation test: user B never reads, changes or deletes user A's rows.
8. **Not found = `null`** (or `false` for a delete). Exceptions are for broken invariants, not for
   "no such row".
9. **Postgres idioms over round trips.** `INSERT … ON CONFLICT … DO UPDATE … RETURNING` for upserts,
   `= ANY(@ids)` for sets, `RETURNING` instead of re-reading.
10. **Naming.** Columns are snake_case, properties PascalCase; `DefaultTypeMap.MatchNamesWithUnderscores`
    maps between them, so no `AS` aliases for plain renames.
11. **Types.** `jsonb` parameters are cast in SQL (`CAST(@x AS jsonb)`) and read back as `string`;
    `timestamptz` maps to `DateTimeOffset` (UTC). Add a type handler only when a mapping actually
    fails — none are registered today.
12. **No EF navigation into a ported table.** A join through one becomes a second query through the
    repository.
