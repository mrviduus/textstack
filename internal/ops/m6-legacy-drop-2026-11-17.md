# Legacy database dropped, production, 2026-11-17 (M6, #1032)

Plan: [m6-deletion-plan.md](../../docs/internal/v2/m6-deletion-plan.md) §1 F. Cutover before it:
[v2-cutover-2026-11-17.md](v2-cutover-2026-11-17.md). Tag: `pre-v2-cutover`.

**Result: dropped.** `DROP DATABASE textstack_prod` at 18:24 UTC. Production has one database, `textstack_v2`.
`/health/ready` stayed `ready` throughout.

## Restore gate (F step 1), before the drop

| Check | Result |
|---|---|
| Archive checksum | sha256 `1e872b9e0f7cf1fa9cbee4201e584b167a97707a499a8d6dd2c571c115540208`, equal to the cutover dump's |
| Restore into a scratch container | 59 tables restored |
| Row counts, restore vs live legacy | equal on every table (legacy was read-only since the cutover, so they must be) |
| Connections to the legacy database | 0 (`pg_stat_activity`) |
| Off-box copy | on the owner's Mac (checked at the cutover) |

## Order

The ledger move (#1413: `database/v2/*` → `database/`, one `migrator` on `textstack_v2`) merged and deployed
**before** the drop. Until then `api` and `worker` waited on the legacy migrator, which ran against the legacy
database; dropping it first would have kept the stack from starting. The plan listed the drop first; corrected
in the plan.

## Config

Production `.env`: `POSTGRES_DB=textstack_v2` (so `psql -U "$POSTGRES_USER" "$POSTGRES_DB"` lands in the data);
`DATABASE_MODE` and `FEATURES_V2API` removed (the code no longer reads them, #1412).

## Rollback

There is no flip any more. Recovery = restore the archive into a database, check out and deploy tag
`pre-v2-cutover` (`gh workflow run deploy.yml -f rollback_commit=<sha of the tag>`). Everything written to V2
since the freeze at 10:49 UTC is lost on that path: it is the data-loss boundary of ADR-030's rollback table.
