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
   dispose. Never hold a connection across awaits you don't own. V2 repositories use `V2DataSource`
   instead, the pool to `textstack_v2` (one data source per database, ADR-030 §2), registered
   lazily: it is built on first use, so nothing at startup touches `textstack_v2` and V1 keeps serving
   while V2 is broken or unconfigured (ADR-030 decision 1, amended;
   [postmortem](../incidents/2026-10-30-migrator-v2-took-down-the-api.md)). Without
   `ConnectionStrings:V2`, the first use fails naming that key.
6. **Transactions.** A use case that writes EF tables and a ported table together opens the
   transaction on EF and passes the `IDbContextTransaction` to the repository; the repository runs on
   that transaction's connection (`GetDbTransaction()`), never its own. A method whose write must be
   atomic with EF writes takes a required `IDbContextTransaction tx`; one that may run either way takes
   `IDbContextTransaction? tx = null`. A V2 method that must compose with another repository's write
   will take `NpgsqlTransaction? tx = null` over `V2DataSource` (plan §6); the first such use case is
   M2.2 (#1067).
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
    fails. One is registered (`DataSource.ConfigureDapper`): `DateTimeOffset` parameters are written
    as UTC, because Npgsql throws on a non-zero offset and client times arrive with one. It covers
    scalar parameters, not arrays: convert array elements yourself (as `ReplaceForInsightAsync` does).
12. **No EF navigation into a ported table.** A join through one becomes a second query through the
    repository.
13. **SQL stays inline, next to the method that runs it** (decided 2026-10-30; the owner considered
    stored procedures and `.sql` resource files and rejected both). The golden path is one file read
    top to bottom: method → its SQL → its parameters → its result. Rules that keep that readable:
    - each statement is a `const string` named by what it does (`InsertFile`, `AdvanceGuarded`,
      `UnlinkCheckpoints`), declared at the top of the class or directly above its one method — never
      built inline in a call;
    - raw string literals (`"""…"""`), one statement per concern, a `-- why` line above anything
      non-obvious, no comment that repeats the SQL;
    - a repository stays under about 250 lines. Longer means the aggregate is cut wrong, not that the
      SQL should move to a file. No stored procedures, no functions holding behaviour (schema-level
      functions such as `is_locator` are schema, not behaviour), no `.sql` embedded resources.
