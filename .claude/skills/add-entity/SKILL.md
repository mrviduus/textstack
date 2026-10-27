---
name: add-entity
description: Add a new EF Core entity + SQL migration to TextStack (with optional writer service). Use when persisting a new kind of record — table, DbSet, mapping, migration, and wiring. Covers the AppDbContext partial pattern and the LlmTrace/AgentRun-style writer.
---

# Add an EF Core entity + SQL migration

Pattern mirrors `LlmTrace` / `EvalRun` / `AgentRun`. Domain stays framework-free; mapping lives in an
`AppDbContext.<Area>.cs` partial; the DbSet is exposed on both `IAppDbContext` and `AppDbContext`.

## Steps

1. **Entity** — `backend/src/Domain/Entities/<Name>.cs`: a plain POCO, `required` on non-null strings,
   `Guid? UserId` + `User? User` for an optional owner FK. XML-doc says which table + where the mapping lives.
   Big JSON blobs go in a single `string` property mapped to `jsonb` (read whole, not queried per field).

2. **Mapping** — new partial `backend/src/Infrastructure/Persistence/AppDbContext.<Area>.cs`:
   `private static void Configure<Area>(ModelBuilder b)` with `ToTable("<snake_case>")`, indexes for the
   hot query (e.g. `HasIndex(x => new { x.UserId, x.CreatedAt }).HasFilter("user_id IS NOT NULL")`),
   `.HasColumnType("jsonb")` / `"numeric(10,6)"` where needed, and the FK with
   `.OnDelete(DeleteBehavior.SetNull)` for an optional owner. **Snake_case is automatic** (global convention).

3. **Wire**: call `Configure<Area>(modelBuilder)` in `AppDbContext.OnModelCreating`; add
   `DbSet<<Name>> <Plural> => Set<<Name>>();` to `AppDbContext.cs` AND `DbSet<<Name>> <Plural> { get; }`
   to `IAppDbContext`.

4. **Migration** — plain SQL, written by hand ([`database/README.md`](../../../database/README.md),
   ADR-026): `database/migrations/NNNN_add_<name>.up.sql` (header: what / why / issue / compatibility /
   down) with the `CREATE TABLE`, keys, FKs and indexes the mapping declares (`pk_<table>`,
   `ix_<table>_<cols>`, `fk_<table>_<target>_<col>` — the names EF would give), and
   `NNNN_add_<name>.down.sql` that drops it. Update `docs/01-architecture/data-model.md` in the same PR.

5. **Writer** (optional, for observability records like agent runs): interface in `Ai.Core`
   (`I<Name>Writer`), `Db<Name>Writer` in `Application/Ai` (scoped, `: global::TextStack.Ai.Core.I<Name>Writer`,
   maps a framework-free record → entity, serializes blobs to jsonb), registered
   `AddScoped<...I<Name>Writer, Db<Name>Writer>()` in `Application/DependencyInjection.cs`.

6. **Verify on real Postgres**: `docker compose build migrator && make migrate`, then `\d <table>` +
   a jsonb insert/read roundtrip. CI's backend job runs `database/tests/roundtrip.sh` (up, down, up)
   and `SchemaDriftTests`, which fails if the mapping and the SQL disagree on a column.

## Gotchas
- Don't add `<Version>` to a csproj — central versions in `Directory.Packages.props`.
- The migrator image copies `database/`; rebuild it (`docker compose build migrator`) before applying
  a fresh migration locally, or it won't include it.
- Never edit an applied migration file (the runner checks its checksum); add the next number.
