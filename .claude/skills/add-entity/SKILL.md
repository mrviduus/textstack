---
name: add-entity
description: Add a new table to TextStack — plain SQL migration, Dapper repository with inline SQL, Persistence.Tests story test, DI wiring. Use when persisting a new kind of record.
---

# Add a table + Dapper repository

One database (`textstack_v2`), Dapper over one `AppDataSource` (ADR-028), plain SQL migrations (ADR-026).
No EF Core, no stored procedures, no `.sql` files for queries. SQL is inline, next to the method that
runs it (`docs/architecture/data-access.md` rule 13). Copy the smallest example that exists:
`AdminSettingsRepository` + `AdminSettingsRepositoryTests`.

## Steps

1. **Migration** — take the next free number in `database/migrations/` ([`database/README.md`](../../../database/README.md)).
   - Write `NNNN_<name>.up.sql` (header: what / why / issue / compatibility / down) with `CREATE TABLE`,
     keys, FKs and indexes (`pk_<table>`, `ix_<table>_<cols>`, `fk_<table>_<target>_<col>`, `ck_<table>_<rule>`).
   - Write `NNNN_<name>.down.sql` that drops the table. Use snake_case names.
   - Add a line to the tree in `database/README.md`, and add the table to `docs/architecture/data-model.md`.

2. **Domain type** (if the record has behaviour or is shared) — `backend/src/Domain/<Area>/<Name>.cs`,
   plain C#, no framework. If one query reads a row, the row can be a `record` next to the repository.

3. **Interface** — `backend/src/Application/<Area>/I<Name>Repository.cs`. Application owns it; callers
   depend on it, not on Dapper.

4. **Repository** — `backend/src/Infrastructure/Persistence/Repositories/<Name>Repository.cs`:
   `public sealed class <Name>Repository(AppDataSource dataSource) : I<Name>Repository`.
   - Each method opens a connection (`await using var conn = await dataSource.OpenConnectionAsync(ct)`).
   - It runs a `private const string` SQL through `new CommandDefinition(sql, params, cancellationToken: ct)`.
   - If a write must land together with the write of another repository, the method takes
     `NpgsqlTransaction? tx`. The use case opens the transaction with `IUnitOfWork` (see `ClipService`; data-access.md rule 6).
   - For user-owned rows, every query filters by `user_id`.

5. **Wire** — add `.AddSingleton<I<Name>Repository, <Name>Repository>()` to `AddTextStackDataAccess`
   in `backend/src/Infrastructure/Persistence/DataSource.cs`, and the interface to the list in
   `tests/TextStack.UnitTests/DataAccessRegistrationTests.cs`.

6. **Test** — `tests/TextStack.Persistence.Tests/<Area>/<Name>RepositoryTests.cs` on real Postgres
   (`PostgresFixture`, Testcontainers, built by `database/migrate.sh`). Write a few story tests that
   read like the feature (`{Method}_{Scenario}_{Expected}`). Do not write one per edge case.

7. **Verify** — run `make migrate`, then `\d <table>`. Run `dotnet test tests/TextStack.Persistence.Tests`
   (needs Docker). CI runs `database/tests/roundtrip.sh` (up, down, up, plus `invariants.sql`).

## Gotchas
- Never edit an applied migration: the runner checks its checksum. Add the next number.
- `make migrate` uses this checkout's `database/`. A plain `docker compose up` uses the image's copy.
  So rebuild the image (`docker compose build migrator`) before you rely on a plain `docker compose up`.
- Only the migrator migrates (ADR-021); the Api never does.
- Do not add `<Version>` to a csproj. The versions are central, in `Directory.Packages.props`.
