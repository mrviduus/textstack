# ADR-021 — Migrations are owned by the migrator

**Status:** Accepted · **Date:** 2026-10-07 · **PRs:** #706 (Api stops migrating), this PR (readiness,
rollback path) · **Review:** [2026-10 #17](../review-2026-10/00-summary.md), backend N6

## Context

Two things applied migrations: the one-shot `migrator` compose service (`migrate.sh`, `dotnet ef
database update`) and `db.Database.Migrate()` in `Api/Program.cs`. With the schema at head the second
was a no-op, so nobody noticed. It only mattered on a rollback: `MIGRATE_TARGET=<name>` rolls the
schema back, and the next Api restart migrated it forward again.

Checking that in a scratch stack found a second, older defect: the documented rollback
(`MIGRATE_TARGET=0 docker compose up migrator`) never reached the container. #12 (2026-01-23) dropped
`MIGRATE_TARGET` from the migrator's `environment:`, so compose ignored the shell variable and the
migrator logged `Target: latest`. Rollback had been a no-op for nine months.

## Decision

1. **Only the migrator migrates.** Compose already orders it: `api` and `worker` wait on
   `migrator: service_completed_successfully`, and every deploy (`docker compose up -d`) re-runs it.
   The Worker and mcp-server never migrated.
2. **The Api migrates only for `dotnet run` without Docker:** `ASPNETCORE_ENVIRONMENT=Development`
   **and** `Database:MigrateOnStartup=true`, which only `launchSettings.json` sets
   (`Api/Extensions/MigrationPolicy.cs`). Not `appsettings.Development.json`: CI runs the compose stack
   as Development, and must prove the migrator, not the Api.
3. **A schema behind the build is reported, not fatal.** At start the Api logs **Critical** (reaches
   Sentry) with the pending count and newest name, and `/health/ready` reports
   `components.schema = { status: "behind", pending: [...] }` with **503** until the migrator catches
   up. It re-checks per request, so it recovers without a restart. `/health` (liveness, compose
   healthcheck, deploy gate) stays "DB reachable".
4. **Rollback is a one-off run with `-e`:** `docker compose run --rm -e MIGRATE_TARGET=<name> migrator`.
   Not an `environment:` entry: compose also reads `.env`, and a `MIGRATE_TARGET` left there would
   roll production back on every deploy (`0` drops every table).
5. **The migrator refuses a rollback it cannot do.** EF reverts only migrations its own assembly
   contains, so an older image asked for a target reverted nothing and exited 0. `migrate.sh` now
   reads `__EFMigrationsHistory` (psql) first: with `MIGRATE_TARGET` set and applied migrations this
   image does not contain, it exits 1 naming the newest. Without a target it prints a note and
   continues — that is the normal state after a code rollback. A target name the image does not have
   at all already fails in EF ("migration not found", exit 1).

## Rolling back a release with a migration — order matters

1. **Schema first, with the image deployed now** (it has the `Down()` methods):
   `docker compose run --rm -e MIGRATE_TARGET=<last migration of the target release> migrator`.
2. **Verify:** `/api/health/ready` shows `schema: behind` with exactly the migrations you meant to
   remove in `pending`. The running Api now logs Critical and `health-check.yml` alarms — expected for
   the minutes until step 3.
3. **Then the code:** deploy `rollback_commit`. Its deploy re-tags `textstack-migrator:latest` to the
   old image and runs it with no target: nothing is pending for that image and nothing unknown is
   applied, so it is a no-op; the old Api then reports `schema: ok`.

The reverse order cannot work: after step 3 the only migrator on the box is the old one, which does
not contain the newer migrations. Before step 5 it silently did nothing; now it exits 1.

## Alternatives

| option | verdict | why |
|---|---|---|
| Throw at start on pending migrations | rejected | `restart: always` turns it into a crash-loop through a deliberate rollback — the site goes fully down instead of partly working. Compose ordering already prevents the normal case. |
| Fail `/health` instead of `/health/ready` | rejected | compose marks the Api unhealthy and the deploy gate fails on an operator's intended state; liveness is not schema. |
| Restore `MIGRATE_TARGET: ${MIGRATE_TARGET:-}` in compose | rejected | the `.env` hazard above. |
| Keep the Api migrating, guard rollback some other way | rejected | two owners of one schema is the bug. |

## Consequences

- After a schema rollback, restart the Api with `docker compose restart api` or `up -d --no-deps …`.
  A plain `docker compose up -d` — and any deploy of the current code — re-runs the migrator to head.
  So follow a schema rollback with the code rollback (order above), or the next deploy re-applies it.
- A code rollback over a newer schema (DB ahead of the build) is not flagged: additive migrations make
  that the normal state of a code rollback.
- `health-check.yml` alarms within 5 min if production serves against a schema behind its build: step
  **"Schema matches the build"** fails with `::error::` naming the pending migrations. It reads the one
  `/health/ready` response fetched by "Readiness probe" (no `-f`, so the 503 body is kept), which the SSG
  step reuses; each alarm carries its own label.
- Local `dotnet run` is unchanged. `dotnet run --no-launch-profile` skips the flag: run
  `dotnet ef database update --project backend/src/Infrastructure --startup-project backend/src/Api`.
