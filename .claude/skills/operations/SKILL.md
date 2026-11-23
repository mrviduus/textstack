---
name: operations
description: TextStack CI/CD, deploy pipeline, backups, nginx/Cloudflare topology, the MCP server (tools, transports, deploy) and telemetry (Sentry, OpenTelemetry). Use when a task touches .github/workflows, deploy.yml, backups, infra/, docker-compose, the MCP bridge or error/trace reporting.
---

# CI/CD, deployment, MCP server, telemetry

Updated for M6 (2026-11-17): one database, no SSG, no systemd pollers.

## CI/CD

**GitHub Actions workflows** (`.github/workflows/`):
- **ci.yml** — runs on PR + push to main. Jobs: `changes`, `docs-links` (`tools/checks/check-doc-links.mjs`), `docs-site`, `extension`, `advisories`, `backend` (build, format, vulnerable packages, migrations round trip, persistence/MCP/unit/AI eval tests, pack the MCP tool), `frontend` (web build + unit tests, shared tests + typecheck, drift-check the reader page, admin build, repo script tests), `reader` (sandbox, formats, prod CSP), `mobile` (typecheck, unit tests, Expo alignment, Metro bundle; **not a required check**), `mobile-runtime`, `docker` (migrator through compose, integration tests, isolated rate-limit test), `e2e` (Playwright)
- **deploy.yml** — skips docs, `apps/mobile/**`, `apps/browser-extension/**` pushes (never `packages/**`/lockfile). In parallel: `ci` (merged-tree) and `images` (`images.yml`: build → `infra/scripts/scan-image-secrets.sh` gate → push `ghcr.io/mrviduus/textstack-<svc>:<sha>`, outputs digests; job `web` pushes `textstack-web` as a `FROM scratch` image). Then self-hosted `deploy`: checkout → fatal pre-deploy dump of `textstack_v2` → fetch and scan the web bundle with the server's real values → `infra/scripts/swap-web-dist.sh` (`index.html` last) → pull `name@digest` (the migrator runs first; api/worker wait for it) → sync nginx → health checks (API, frontend, MCP) → CSP live check. Rollback (`rollback_commit`) must be hex and on `origin/main` (`guard` job). Pipeline, deps, controls: `docs/architecture/delivery.md`, ADR-020
- **Pins**: every action by commit SHA (`# vX.Y`), every pulled image `tag@sha256:…`; Dependabot moves them. Every workflow has a read-only/none top-level `permissions:`; widen per job only
- **backup.yml** — daily at 3 AM UTC. `textstack_v2` dump (fatal if absent or incomplete; legacy is archived, no longer dumped) + storage tar.gz, keeps 2 newest of each; R2 off-site (`/db_v2.sql`, `/backup` = `data/storage` + `data/library` + `.env`). The deploy's pre-deploy dump is V2 too, and fatal. `make backup` dumps V2; `make restore FILE=` = V2 into an absent database. `restore-drill.yml` (monthly) restores V2 from R2, row-counts its migrated tables (`users`, `books`, `book_files`, `annotations` non-empty) and checks book files exist in the restored library. Details: `docs/internal/ops/backup.md`, `database/README.md`
- **health-check.yml** — every 5 min. Checks API + both frontends; `/health/ready`'s `v2` component must be `ok`
- **Schema rollback**: `make migrate-down V=<n>`; `make migrate-drop CONFIRM=textstack_v2` drops the database (the baseline has no down file). Before 2026-11-17 the recovery is the legacy archive + tag `pre-v2-cutover` (`docs/internal/ops/backup.md` "The legacy archive")

## Deployment

```
Internet → Cloudflare (DNS+SSL) → Cloudflare Tunnel → nginx (port 80)
  ├─ textstack.app → SPA (dist/) + /reader/ + /api/ proxy to :8080 + /mcp proxy to :8090; catalog URLs 410
  └─ textstack.dev → admin shell (:81)
```

Docker services: `db` (pgvector pg16, digest-pinned; the app's database is `textstack_v2`), `migrator`, `api`, `worker`, `admin`, `aspire-dashboard` (`--profile observability`), `ollama`, `mcp-server` (`--profile mcp`). All localhost-only, no public ports except 80 via tunnel.

Images: built + secret-scanned on GitHub, pulled by digest from GHCR; secrets only in the server's `.env` at runtime. Never deploy by SSH — break-glass is `gh workflow run deploy.yml`.

Rate limiting zones in nginx: API, uploads, translation, MCP (`infra/nginx/textstack.conf`).

## MCP Server (`backend/src/Ai/TextStack.Ai.Mcp/`)

Thin, stateless MCP↔HTTP bridge (Phase 8) — every tool call becomes an HTTP request to the V2 sync API (`/me/v2/*`; no DB/EF/OpenAI), answered in the shapes the tool catalog maps (`Http/TextStackApiClient.V2*.cs`). 17 tools, every one Bearer-scoped and keyed by the book's `bookId`. The reader's books: `search_my_library` (title/author + tags; V2 has no full-text search), `get_my_book` (chapters from the reader's synced TOC; no text, ADR-033), `save_my_highlight`, `list_my_book_highlights` — a chapter's `chapterId` is minted by the bridge from (file, chapter key), so listing and saving agree. Write-back: `save_insight`, `get_my_insights` (one per user, book, chapter; a save replaces). Vocabulary: `list_my_vocabulary` (the V2 change feed, filtered and paged in the bridge), `add_vocabulary_words` (≤20 per call, a required host `operationId` — one id per word derived from it and the word, the same on a retry in any order; translation or definition required, one result line per word; a 429 stops the batch), `update_vocabulary_word` (patches on the revision just read), `delete_vocabulary_word`. Reading state: `get_my_reading` — the shelf, **no arguments**, the only way in when the model holds no id; `get_book_progress`; `set_book_progress` — records a chapter finished ANYWHERE (audiobook, paper) and resumes the reader at the next one. Discussion (#1316): `share_chapter`, `save_checkpoint`, `list_checkpoints`, `get_shared_chapter` (reads one of the caller's own shares in parts of 40,000 characters; the id the V2 reader's Discuss hands over as `(TextStack: book <bookId>, share <shareId>)`, named in `McpBridgeCore.Instructions`). `get_my_chapter` was deleted with server-side extraction (ADR-033 P4). The catalog, edition-highlight and chapter-review tools (`search_books`, `get_book`, `get_chapter`, `list_my_highlights`, `save_highlight`, `get_chapter_review`, `save_chapter_review`) were deleted at M6 (D6, NuGet 2.0.0). The tool count is asserted in four places (`McpManifestDriftTests`, `McpStdioSmokeTests`, `McpOverTheWireTests`, `McpManifestEndpointTests` — 17), the manifest's names equal the bridge's registered names and the descriptions live once, in `Contracts/Mcp/McpManifest.cs`, which the runtime catalog reads.

**There is no question-answering tool.** `ask_book` and the retrieval spine behind it were deleted 2026-09-10: 7 books of 1498 were ever indexed, and the vision PDF transcription that fed the index was 94% of the project's lifetime LLM spend. An assistant reads a chapter the user shares from the reader (`get_shared_chapter`) and reasons over it on the reader's own subscription.

**Assistant writes**: an MCP highlight is a V2 annotation whose `textstack-anchor-v1` locator carries `source: "mcp"`; there is no per-book ceiling on V2 (the assistant writes are rate limited per user, `assistant-write`).

**On a PDF upload an MCP highlight is saved and listed but not painted.** The reader renders PDFs as the original pages, and a PDF highlight is placed by page geometry the bridge cannot produce. `get_my_book` reports `rendersAsOriginalPdf` so the model can say so. Roughly half the uploaded library is PDF.

The write-back exists because the reasoning happens in Claude/ChatGPT — where the reader already has a profile and a year of history — and only the **result** comes home. See `docs/reference/mcp.md`.

**Dual transport** (env `MCP_TRANSPORT`: `stdio` default | `http`; `--http` flag also selects http). Shared wiring (tool catalog handlers, typed `TextStackApiClient`) in `McpBridgeCore`; the two host builders in `McpHosts`.
- **stdio** (local, single identity): `Host.CreateApplicationBuilder`, **logs→stderr** (stdout is JSON-RPC only — never `Console.Write*`), singleton DI, token from `TEXTSTACK_MCP_TOKEN` (static) or the device flow (`DeviceFlowTokenProvider`, AI-050). Byte-identical to the pre-049 server.
- **http** (AI-049, remote, **multi-user**): `WebApplication`, `.WithHttpTransport(o => o.Stateless = true)`, `app.MapMcp("/mcp")` + `GET /health`. **Bearer required on all of `/mcp`** — none → `401` + `WWW-Authenticate: Bearer resource_metadata=…` (ADR-017); the host also serves the protected-resource metadata. Each connection authenticates with its OWN `Authorization: Bearer <token>` — an OAuth access token (`tso_…`, `OAuthGrant`; AS in the API, `OAuthEndpoints.cs`: authorize → web consent `/en/oauth/consent` → token, CIMD+DCR, refresh rotation, account required), a connect key (`tsk_…`, `McpAccessKey`) or the AI-050 device-flow JWT (both assistant credentials are refused on account management, 403 `insufficient_scope` from `RejectOAuthTokens`: a leaked one cannot mint another key or approve a device login) — read per-request by `HttpContextTokenProvider` (SCOPED; `McpToolCatalog` + provider scoped so no identity leaks across connections). NEVER touches the device-flow cache. Package: `ModelContextProtocol.AspNetCore` 1.4.0 (matches the pinned `ModelContextProtocol`).

**Deploy** (http mode): Docker `mcp-server` (`backend/Docker/Mcp.Dockerfile`, profile `mcp`) binds `http://+:8090`, mapped `127.0.0.1:8090`; talks to the API over the **internal** docker network (`TEXTSTACK_API_URL=http://api:8080`). nginx `location /mcp` (upstream `textstack_mcp`, zone `mcp_limit`) proxies with SSE settings (`proxy_buffering off`, `Connection ""`, relays `Authorization`, 3600s timeouts). Behind Cloudflare tunnel — no new cloud. Bring up: `docker compose --profile mcp up -d mcp-server`. nginx config (incl. `/mcp` and the OAuth well-known/`/oauth/` blocks) is synced by `deploy.yml` ("Sync nginx config").

## Telemetry

**Errors:** Sentry on api, worker and mcp-server (http mode only), one project, `service` tag; the web SPA reports to its own browser project when `VITE_SENTRY_DSN` is in `apps/web/production.env` (`apps/web/src/lib/sentry.ts`, lazy, `service: web`); one shared scrubber (`backend/src/Observability/TextStack.Observability/SentryScrubber.cs`) strips tokens (`ts[kocr]_`, Bearer, JWT), `/mcp/k/<key>`, query strings and SQL. No DSN = off.

**Traces/metrics:** OpenTelemetry is registered only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set — locally Aspire Dashboard (`--profile observability`, UI `localhost:18888`, OTLP `:18889`); unset in production (nothing receives it). Details: `docs/architecture/delivery.md` § Observability.
