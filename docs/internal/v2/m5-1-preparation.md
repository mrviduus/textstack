# M5.1 preparation

Status: In progress. Part of [#1031](https://github.com/mrviduus/textstack/issues/1031).
No production switch or ETL is authorized by this document.

## Goal and current evidence

Prepare a bounded, tested switch from legacy to V2. Reuse the existing repositories, ETL and three
accepted backup rehearsals. [V2 plan](v2-plan.md) §5 remains the cutover contract.

Deployment of #1356 succeeded on 2026-11-16. The production readiness endpoint still reports V2 off.
The default remains legacy. Part B now provides the V2 identity selection, but compatibility,
assistant book reads and release-entry/rehearsal gates still prevent a production switch.
The shadow-user bridge runs only in legacy mode; native mode validates the current V2 account.

## Independently reviewable parts

| Part | Minimum scope | Verification |
|---|---|---|
| A: HTTP write barrier (merged #1357) | Default-off `Maintenance:WriteFreeze`; 503 before handlers and auth use stamps; omit API database sweeps and startup model seeding; preserve reads without creating shadow users | Real API pipeline plus middleware, OAuth/MCP stamp, shadow-user and background-registration tests |
| B: database and identity selection (this PR) | Strict startup `Database:Mode`; selected Api auth/admin services and five identity ports in both hosts; native account checks; selected readiness and Worker loops | Real HTTP on PostgreSQL with legacy unreachable: register/login/refresh/reset/device/OAuth/MCP keys/account delete/guest merge/admin; deterministic reset-boundary tests; legacy behavior retained |
| C: compatibility and MCP aliases | Inventory old private reads/writes, map retained operations to V2, explicitly retire catalog operations; log app version, route and outcome; coordinate book-tool parity with #1346 | Old-route write matrix, ownership checks, retry/idempotence, no silently dropped sessions/annotations; MCP scenarios on a V2-only book |
| D: M5.2 rehearsal and release entry points | Runbook, final archive, complete stop/drain/freeze sequence, current-build ETL and validation, both clients, MCP and rollback | One full rehearsal on an isolated restored backup; device evidence; explicit owner approval before production |

Parts A and B are separate PRs; C/D remain pending. None of these rows closes M5 by itself.
No schema change, reader implementation, legacy deletion, production ETL or production flag change
belongs to either preparation PR.

## Part A: HTTP barrier contract

`MAINTENANCE_WRITE_FREEZE=false` is the Compose default. It sets `Maintenance:WriteFreeze` on the
Api only. Changing it requires recreating the Api; live reconfiguration is not supported.

With the barrier enabled:

- All methods except GET, HEAD and OPTIONS return 503 `{"error":"write_frozen"}`, `Retry-After: 60`
  and `Cache-Control: no-store`, before credentials or handlers can write.
- `/me/v2` writes keep the existing `v2_unavailable` error envelope so sync clients retain their
  normal retry behavior; no new sync-protocol error code is introduced.
- GET/HEAD `/oauth/authorize` are also blocked: authorization creates a request and may register a
  client. OPTIONS is left to the normal CORS handling.
- MCP/OAuth credentials still authenticate reads, without last-used updates. Guest activity does not
  write. V2 reads may use an existing shadow user but cannot create one; a missing shadow pauses V2
  with its existing 503 response.
- API database-writing background services and model-registry seeding do not start. Existing database
  readiness checks and reader paths stay in place. This does not change auth, routing or database mode.

This barrier is **not database quiescence**. Before the final snapshot, M5.2 must stop and drain the
Worker, SSG processes, old Api requests, administrative/CLI writers and any other source of writes.
Do not run production ETL merely because this flag is available. In-flight writes are not rolled back
by a flag; database-level enforcement and its rollback must be rehearsed as part of the complete runbook.

Verification and rollback for this part: test both flag values; recreate the Api with the flag false
to resume HTTP writes. No data or schema migration is involved.

## Part B: selected identity, not a release switch

- `DATABASE_MODE=legacy` is the Compose default in both Api and Worker. `v2` requires
  `FEATURES_V2API=true` and `ConnectionStrings:V2`. Unknown/blank mode values fail startup. Recreate
  both processes to change it; there is no per-request database choice or outage fallback.
- Api reader/admin auth selects the existing service contracts. Users, sessions, OAuth, device
  logins and MCP keys select one database together. In native mode the legacy identity mirror is
  inert. Worker selects those ports but does not issue HTTP sessions.
- Native private requests validate the current V2 user, role and credential-reset stamp. The check
  is memoized within a request only. New signed JWTs retain full issue-time precision alongside
  standard `iat`, so an immediate post-reset sign-in works; older tokens fall back to whole-second
  `iat`. Reader/admin audiences remain separate.
- Primary health/schema/collation probes use the selected pool. `/health/ready` reports `db.mode`.
  Native private `/me` routes skip the legacy sites lookup; public catalog reads remain legacy
  until retirement. Migrations and ETL keep their explicit source/target settings.
- Native Worker holds its single-consumer lock on V2 and runs V2 ingestion, selected credential
  retention and heartbeat. Legacy ingestion, enrichment, guest cleanup and watchers do not start.
  Api legacy database sweeps/model seeding also do not run in native mode. Trace writers select V2;
  Ops readers/retention remain tracked in #1090. Native inactive-empty-guest cleanup is #1358.
  Part C must align spend reads with V2 traces before enabling paid AI handlers; do not bypass that
  gap by granting the route marker to a legacy AI handler. The cutover runbook must stop the old
  Worker before starting the native one; the selected-database lock is not a cross-mode rollout lock.
- Until Part C adapts or retires them, unmarked private routes and mutation handlers return retryable
  503 `v2_compatibility_pending` in native mode. `V2SelectedRoute` is granted only to reviewed handlers
  using selected identity/V2 dependencies; marking a legacy handler is not a workaround for the gate.
  This deliberately prevents mixed-database writes, and means **native mode is not ready for end users yet**.

No production setting is changed by this PR. Rolling the mode back after real native writes may lose
those writes; Part D must verify the archive, smoke checks and the rollback boundary before the switch.

## Reader dependency before the switch

Ordinary web `/library/my/:id/read` routes still open `ReaderPage`; `/read-v2` is a separate route.
The Android V2 reader is still behind `__DEV__`. Neither becomes the default from a database flag.
Part D must prove the intended reader path and file/chapter reads for EPUB and PDF after Part B/C.
Do not assume that a retained `book_chapters` table alone keeps the old PDF reader working.
Reader hosting implementation stays outside this PR.

## Later work, not blockers for Part A

MCP book/chapter reads (#1346), the chapter-review/checkpoint decision (#1345), physical Android
evidence, remaining release checks, archive destination and the cutover window must be settled
before the production switch. They do not justify adding features or unrelated refactoring here.
Legacy deletion remains M6; reverting to legacy after real V2 writes can lose those writes unless replayed.

## Unresolved questions

- Chapter reviews: port or defer?
- Permanent archive destination?
- Physical Android and remaining release checks?
- Cutover window, after the full rehearsal?
