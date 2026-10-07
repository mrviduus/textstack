# Architecture review — October 2026

**Date:** 2026-10-04 · **Code:** `main` @ b7eb09c0 · **Method:** five reviewers checked the code in parallel
(map, backend, security, ops, clients). Each claim has `file:line` evidence in its section file. The
lead reviewer re-checked the top items by hand (marked ✔).

| File | What |
|---|---|
| [01-map.md](01-map.md) | Diagrams: context, containers, API components, project graph, deployment, 4 flows, data stores |
| [02-backend-structure.md](02-backend-structure.md) | Layers, queues (full table), book models, background work, dead code |
| 03-security | **Not in the repo on purpose** — the repo is public. The critical and high findings are fixed (#690, #693, #704); the rest are summarised below without exploit detail. |
| [04-ops-reliability.md](04-ops-reliability.md) | Backups, DR, deploy, alerting, capacity, ADR numbering |
| [05-clients.md](05-clients.md) | Web/mobile reader components, duplication, offline sync, API contract |

## Status — 2026-10-05

All P0 and P1 items are fixed and live; the P2/P3 list is planned work.

| # | Item | Fixed in |
|---|---|---|
| 1 | Stored files: sandbox CSP + nosniff on `/storage` (nginx + API) | #690 |
| 2 | `/internal/*` refused at nginx; one tested network check | #690 |
| 3 | Copyrighted PDFs removed from the tree (history kept, owner's call) | #690 |
| 4 | Off-site backup: nightly restic → Cloudflare R2, 9 GB guard, dedup dump | #696, #700 |
| 5 | Connect keys get the same account-route restrictions as OAuth tokens | #693 |
| 6 | Host Claude CLI calls: temp working dir, no tools | #691 |
| 7 | Rate limits keyed on the real client (nginx) and per IPv6 /64 (API) | #693 |
| 8 | Health check hits `/api/health` and checks the body | #691 |
| 9 | Monthly restore drill on a clean runner; DR runbook rewritten — first run DB 206 s, files 37 s | #703 |
| 10 | Deploy/backup: pipefail + dump trailer check, disk alarm, deploy gate | #691, #698 |
| 11 | Web offline highlights replayed; session queue race | #694 |
| 12 | Progress clock comparison; mobile session retry queue | #695 |
| 13 | Refresh tokens hashed (in place, no sign-out); admin/user audiences; HS256 pinned | #704 |
| 14 | Upload size checked before reading; storage path guard; EPUB entry/size limits | #704 |
| — | Clients gap 2: JSON-LD escaped | this PR |
| 17 | Migrator is the only migrator (Api: Development + launchSettings flag only); schema behind the build → Critical log + `/health/ready` 503; rollback via `docker compose run --rm -e MIGRATE_TARGET` (the documented form never reached the container) — [ADR-021](../adr/ADR-021-migrations-owned-by-the-migrator.md) | #706, 2026-10-07 |
| 15 | Queues: **ADR accepted** — [ADR-022](../adr/ADR-022-one-consumer-per-queue.md) (Accepted 2026-10-07): one consumer per queue, startup recovery, shutdown gives the claim back; first fix = a deploy marks in-flight uploads "corrupted" | ADR only |
| 16 | Background work: **ADR accepted** — [ADR-023](../adr/ADR-023-single-instance-no-fire-and-forget.md) (Accepted 2026-10-07): single-instance rule; await the 8 SSG enqueues; delete 3 dead workers | ADR only |
| 18 | Auth by default: **ADR accepted** — [ADR-024](../adr/ADR-024-auth-fails-closed-by-path.md) (Accepted 2026-10-07): `/me` + `/internal` path gates, public-routes snapshot; `/storage` uploads move behind `/me/books/{id}/file` | ADR only |
| 22 | OTLP export off in prod (it was exporting to a container that never runs); Sentry on mcp-server and ssg-worker, same scrubbing; one `service` tag across all four (2026-10-07) | this PR |
| — | Also shipped: podcast deleted (#692), SSG full rebuild nightly not per deploy (#697), deploy waits for a running SSG rebuild (#698), deploy-failing test flake (#699) | |

Open, not in the tables below: web tap-on-text doesn't reveal reader bars (since #157); removing a highlight
note never syncs; expired user refresh-token rows are never deleted.

## The short version

The product code is in better shape than the platform around it. Layering is impure but harmless;
the real risk sits in **nginx, backups and the host**: what the server exposes, what it would lose,
and what nobody would notice.

## Ranked gaps

Severity: **P0** fix now · **P1** this week / before Play production (~2026-10-16) · **P2** plan it,
ADR if structural · **P3** note or accept.

### P0 — fix now

| # | Gap | Where | Fix size |
|---|---|---|---|
| 1 | ✔ User-uploaded content is served from the main domains with no content-security headers → stored XSS risk on textstack.app and textstack.dev | security C1, nginx `/storage/` | nginx-only first step, S |
| 2 | ✔ `/internal/*` is not reliably limited to the Docker network | security C2, `InternalEndpoints.IsLocalRequest` | nginx deny + one shared check, S |
| 3 | ✔ Two copyrighted books are committed as PDF test fixtures in the public repo | backend N1, `tests/TextStack.Extraction.Tests/Fixtures/` | `git rm` + synthetic fixture; history rewrite = owner's call |
| 4 | ✔ No off-site backup. DB dumps, uploads and `.env` live on the same box as the data | ops 1, `backup.yml` | restic → R2/B2, S |

### P1 — this week

| # | Gap | Where |
|---|---|---|
| 5 | Connect keys (`tsk_`) can do account-level actions that OAuth tokens are blocked from | security H1 — one-line fix |
| 6 | ✔ Host pollers run `claude -p` with tools on, from the repo dir, over user-book text | ops 3 / security H2 |
| 7 | Rate limits are weaker than they look (IPv6 per-address keys; nginx zone keyed on the tunnel) | security H3, H4 |
| 8 | ✔ The 5-minute health check's "API" step hits the SPA (`/health` → 200 `text/html`), not the API | map; `health-check.yml:24,27` → use `/api/health` |
| 9 | Restore never rehearsed; the DR runbook fails as written; storage tarball never verified | ops 2 |
| 10 | Deploy: `pnpm install` runs on the prod host; `pg_dump \| gzip` without `pipefail`; no disk alarm, no log rotation | ops 4, 5, 6 |
| 11 | Web highlights saved while offline are silently lost (marked `pending`, never replayed) | clients 1 |
| 12 | Progress last-write-wins compares a client clock to the server clock; mobile drops failed reading sessions | clients 3, 4 |
| 13 | Refresh tokens (user + admin) stored in plain text; one JWT secret/audience for user and admin | security M1, M7 |
| 14 | Upload is buffered fully in memory before the quota check; no zip-bomb limit on EPUB | security M5 |

### P2 — plan it

| # | Gap | Where | Recommendation |
|---|---|---|---|
| 15 | Queues: 11 polled tables, 4 claim styles. Catalog ingestion has no retry cap (poison job loops forever); shell pollers never recover stuck rows; no tests on any claim | backend 2, 3, 10 | One claim rule (status flip + attempts + stale sweep), one test each — ADR |
| 16 | 8 background services run inside the API; vocab enrichment is `Task.Run` fire-and-forget, lost on every deploy | backend 7, map | Rule: Api and Worker are single-instance; move jobs to Worker before any 2nd Api |
| 17 | Migrations run twice (migrator + API start); API start undoes a `MIGRATE_TARGET` rollback | backend 9 | **Done** 2026-10-07 — migrator only, behind schema → `/health/ready` 503 ([ADR-021](../adr/ADR-021-migrations-owned-by-the-migrator.md)) |
| 18 | Auth is opt-in per endpoint (no gap found today, but fail-open by design) | security M3 | Group-level `RequireUser()` filter |
| 19 | Admin: roles never checked, no audit log, no MFA, admin API also reachable on the public host | security M2 | Cloudflare Access on textstack.dev + deny `/api/admin` on .app + audit row |
| 20 | Two book models with 4 different "which book" patterns; `book_collections` orphaned on delete (counts wrong, no ownership check) | backend 4, 5 | Keep storage split; one `BookRef` rule for new code — ADR; fix the orphan bug now |
| 21 | Prod LLM jobs depend on the owner's personal Claude login; poller units not deployed, one never restarted, no alarm when one dies | ops 8, 9 | Anthropic API key; deploy + check all pollers |
| 22 | No metrics in prod (OTLP points at a container that isn't started); no Sentry on ssg-worker / mcp-server | ops 10 | Unset OTLP or free hosted tier; Sentry on both — **done**, see Status; a hosted metrics tier is the owner's call ([delivery.md § Observability](../delivery.md#observability)) |
| 23 | Server can't tell which mobile app version is calling | clients 7 | `X-App-Version` + `minSupportedVersion` |
| 24 | Web keeps its own ~1.8k-line `api/` beside the shared client; vocab highlight engine exists twice (mobile copy is untyped ES5 in a string) | clients 5, 6 | Move module by module |
| 25 | Two SEO engines (shell + CLI in prod, in-process crews still reachable) | backend 6 | Keep one |
| 26 | GDPR delete leaves LLM trace text, caches, backups | security M8 | Redact traces; document retention |

### P3 — note or accept

| # | Item | Verdict |
|---|---|---|
| 27 | Domain uses Npgsql; Application wires concrete AI clients | Fix the **docs** ("pragmatic layering"), not the code |
| 28 | Multisite leftovers | Keep (ADR-007); cost is one cache hit per request |
| 29 | pgvector after RAG: vocab embeddings feed one Stats widget; `drift_centroids` dead | Delete Drift; owner decides on the concept widget |
| 30 | One home server | Accept until revenue, **given** #4 and #9 |
| 31 | ADR numbering (three schemes, two 001s, three 007s) | Rename map ready in ops §7 |
| 32 | Bundle 212 KB gzip entry; dead code folders; small duplicates | Housekeeping PR |

## The 11 items raised before the review — verdicts

| Raised | Verdict | Row |
|---|---|---|
| 1. Domain not pure | True, low impact — fix docs | 27 |
| 2. Refresh tokens in plain text | True, also admin tokens | 13 |
| 3. API background workers | True; 8 + fire-and-forget enrichment | 16 |
| 4. Queues claim differently | True and worse: no retry cap, no stale recovery | 15 |
| 5. Auth per endpoint | True; no hole found, fail-open by design | 18 |
| 6. Admin roles / audit | True, plus admin API on the public host | 19 |
| 7. Multisite leftovers | True, cheap — keep | 28 |
| 8. Two book models | True; plus a real orphan bug | 20 |
| 9. pgvector | Live but thin; Drift is dead | 29 |
| 10. One home server | True; the real gap is **no off-site backup** | 4, 9, 30 |
| 11. ADR numbering | True; rename map ready | 31 |

## Suggested order

1. **Today (nginx + git, no app code):** #1, #2 nginx parts, #3, #8.
2. **This week:** #4 + #9 (back up off-site, then rehearse one restore), #5, #6, #7, #10.
3. **Before Play production:** #11–#14.
4. **Then one ADR each** for #15, #16, #20, and close the P2 list in small PRs.

## Open questions for the owner

- Rewrite git history for the PDFs?
- Off-site target: Cloudflare R2 or Backblaze B2?
- Is offline highlighting on web a product goal (#11)?
- Keep the vocab concept widget (and pgvector)?
- SEO: shell + Claude CLI, or in-process crews?
- Accept "Api and Worker are single-instance" as a rule?
- Podcast feature: live but undocumented — keep or delete?
