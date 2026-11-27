---
name: operations
description: TextStack CI/CD, deploy pipeline, backups, nginx/Cloudflare topology, the MCP server (tools, transports, deploy) and telemetry (Sentry, OpenTelemetry). Use when a task touches .github/workflows, deploy.yml, backups, infra/, docker-compose, the MCP bridge or error/trace reporting.
---

# CI/CD, deployment, MCP server, telemetry

This skill was updated for M6 (2026-11-17): one database, no SSG, no systemd pollers.

## CI/CD

**GitHub Actions workflows** (`.github/workflows/`):
- **ci.yml** runs on a PR and on a push to main. Jobs:
  - `changes`, `docs-links` (`tools/checks/check-doc-links.mjs`), `docs-site`, `extension`, `advisories`
  - `backend`: build, format, vulnerable packages, migrations round trip, persistence/MCP/unit/AI eval tests, pack the MCP tool
  - `frontend`: web build + unit tests, shared tests + typecheck, drift-check the reader page, admin build, repo script tests
  - `reader`: sandbox, formats, prod CSP
  - `mobile`: typecheck, unit tests, Expo alignment, Metro bundle; **not a required check**
  - `mobile-runtime`
  - `docker`: migrator through compose, integration tests, isolated rate-limit test
  - `e2e` (Playwright)
- **deploy.yml** skips pushes of docs, `apps/mobile/**` and `apps/browser-extension/**` (never `packages/**`/lockfile).
  - In parallel: `ci` (merged-tree) and `images` (`images.yml`: build → `infra/scripts/scan-image-secrets.sh` gate → push `ghcr.io/mrviduus/textstack-<svc>:<sha>`, outputs digests). The `web` job pushes `textstack-web` as a `FROM scratch` image.
  - Then the self-hosted `deploy` job: checkout → fatal pre-deploy dump of `textstack_v2` → fetch and scan the web bundle with the server's real values → `infra/scripts/swap-web-dist.sh` (`index.html` last) → pull `name@digest` (the migrator runs first; api/worker wait for it) → sync nginx → health checks (API, frontend, MCP) → CSP live check.
  - A rollback (`rollback_commit`) must be hex and on `origin/main` (`guard` job).
  - Pipeline, deps, controls: `docs/architecture/delivery.md`, ADR-020.
- **Pins**: every action is pinned by commit SHA (`# vX.Y`), and every pulled image by `tag@sha256:…`. Dependabot moves them. Every workflow has a read-only/none top-level `permissions:`. Widen it per job only.
- **backup.yml** runs daily at 3 AM UTC.
  - It makes a `textstack_v2` dump (fatal if absent or incomplete; legacy is archived and no longer dumped) and a storage tar.gz. It keeps the 2 newest of each.
  - R2 off-site: `/db_v2.sql`, and `/backup` = `data/storage` + `data/library` + `.env`.
  - The deploy's pre-deploy dump is V2 too, and fatal. `make backup` dumps V2. `make restore FILE=` restores V2 into an absent database.
  - `restore-drill.yml` (monthly) restores V2 from R2 and row-counts its migrated tables (`users`, `books`, `book_files`, `annotations` non-empty). Then it checks that book files exist in the restored library.
  - Details: `docs/internal/ops/backup.md`, `database/README.md`.
- **health-check.yml** runs every 5 min. It checks the API + both frontends. The `v2` component of `/health/ready` must be `ok`.
- **Schema rollback**: `make migrate-down V=<n>`. `make migrate-drop CONFIRM=textstack_v2` drops the database (the baseline has no down file). Before 2026-11-17, the recovery is the legacy archive + tag `pre-v2-cutover` (`docs/internal/ops/backup.md` "The legacy archive").

## Deployment

```
Internet → Cloudflare (DNS+SSL) → Cloudflare Tunnel → nginx (port 80)
  ├─ textstack.app → SPA (dist/) + /reader/ + /api/ proxy to :8080 + /mcp proxy to :8090; catalog URLs 410
  └─ textstack.dev → admin shell (:81)
```

Docker services: `db` (pgvector pg16, digest-pinned; the app's database is `textstack_v2`), `migrator`, `api`, `worker`, `admin`, `aspire-dashboard` (`--profile observability`), `mcp-server` (`--profile mcp`). All services are localhost-only. No ports are public except 80 through the tunnel.

Images: GitHub builds and secret-scans them, and the server pulls them by digest from GHCR. Secrets live only in the server's `.env` at runtime. Never deploy by SSH. The break-glass path is `gh workflow run deploy.yml`.

Rate limiting zones in nginx: API, uploads, translation, MCP (`infra/nginx/textstack.conf`).

## MCP Server (`backend/src/Ai/TextStack.Ai.Mcp/`)

The server is a thin, stateless MCP↔HTTP bridge (Phase 8). Every tool call becomes an HTTP request to the V2 sync API (`/me/v2/*`; no DB/EF/OpenAI). The bridge answers in the shapes that the tool catalog maps (`Http/TextStackApiClient.V2*.cs`). There are 18 tools. Every tool is Bearer-scoped and keyed by the book's `bookId`.

- **The reader's books**:
  - `search_my_library`: title/author + tags; V2 has no full-text search.
  - `get_my_book`: chapters from the reader's synced TOC; no text (ADR-033).
  - `save_my_highlight`, `list_my_book_highlights`. The bridge mints a chapter's `chapterId` from (file, chapter key), so listing and saving agree.
- **Write-back**: `save_insight`, `get_my_insights`. There is one insight per reader, book and chapter; a save replaces it.
- **Vocabulary**:
  - `list_my_vocabulary`: the V2 change feed, filtered and paged in the bridge.
  - `add_vocabulary_words`: ≤20 per call, with a required host `operationId`. The bridge derives one id per word from the `operationId` and the word, the same on a retry in any order. A translation or definition is required. The tool returns one result line per word, and a 429 stops the batch.
  - `update_vocabulary_word` (patches on the revision just read), `delete_vocabulary_word`.
- **Reading state**:
  - `get_my_reading`: the shelf, with **no arguments**. It is the only way in when the model holds no id.
  - `get_book_progress`.
  - `set_book_progress`: records a chapter finished ANYWHERE (audiobook, paper), and the reading screen resumes at the next chapter.
- **Discussion** (#1316): `share_chapter`, `save_checkpoint`, `list_checkpoints`, `delete_checkpoint`, `get_shared_chapter`. `get_shared_chapter` reads one of the caller's own shares in parts of 40,000 characters. It takes the id that Discuss on the V2 reading screen hands over as `(TextStack: book <bookId>, share <shareId>)`, named in `McpBridgeCore.Instructions`.
- **Deleted**: `get_my_chapter` went with server-side extraction (ADR-033 P4). The catalog, edition-highlight and chapter-review tools (`search_books`, `get_book`, `get_chapter`, `list_my_highlights`, `save_highlight`, `get_chapter_review`, `save_chapter_review`) were deleted at M6 (D6, NuGet 2.0.0).
- **Tool count**: four tests assert it (`McpManifestDriftTests`, `McpStdioSmokeTests`, `McpOverTheWireTests`, `McpManifestEndpointTests` — 18). The manifest's names equal the bridge's registered names. The descriptions live once, in `Contracts/Mcp/McpManifest.cs`, which the runtime catalog reads.

**There is no question-answering tool.** `ask_book` and the retrieval spine behind it were deleted 2026-09-10. Only 7 books of 1498 were ever indexed. The vision PDF transcription that fed the index was 94% of the project's lifetime LLM spend. Now an assistant reads a chapter that the reader shares from the reading screen (`get_shared_chapter`). The assistant reasons over it on the reader's own subscription.

**Assistant writes**: an MCP highlight is a V2 highlight (an `annotations` row). Its `locator` (scheme `textstack-anchor-v1`) carries `source: "mcp"`. V2 has no per-book ceiling. The assistant writes are rate limited per reader (`assistant-write`).

**On a PDF upload, the server saves and lists an MCP highlight, but the reading screen does not paint it.** The reading screen renders PDFs as the pages of the book file. A PDF highlight is placed by page geometry, and the bridge cannot produce page geometry. `get_my_book` reports `rendersAsOriginalPdf`, so the model can say so. Roughly half the uploaded library is PDF.

The write-back exists because the reasoning happens in Claude/ChatGPT. There, the reader already has a profile and a year of history, and only the **result** comes home. See `docs/reference/mcp.md`.

**Dual transport** (env `MCP_TRANSPORT`: `stdio` default | `http`; the `--http` flag also selects http). `McpBridgeCore` holds the shared wiring (tool catalog handlers, typed `TextStackApiClient`). `McpHosts` holds the two host builders.
- **stdio** (local, single identity):
  - `Host.CreateApplicationBuilder`, singleton DI, **logs→stderr**. Stdout is JSON-RPC only: never `Console.Write*`.
  - The token comes from `TEXTSTACK_MCP_TOKEN` (static) or the device flow (`DeviceFlowTokenProvider`, AI-050).
  - Byte-identical to the pre-049 server.
- **http** (AI-049, remote, **multi-user**):
  - `WebApplication`, `.WithHttpTransport(o => o.Stateless = true)`, `app.MapMcp("/mcp")` + `GET /health`.
  - **Bearer required on all of `/mcp`.** With none, the host answers `401` + `WWW-Authenticate: Bearer resource_metadata=…` (ADR-017). The host also serves the protected-resource metadata.
  - Each connection authenticates with its OWN `Authorization: Bearer <token>`. The token is one of these:
    - an OAuth access token (`tso_…`, `OAuthGrant`). The AS is in the API (`OAuthEndpoints.cs`): authorize → web consent `/en/oauth/consent` → token, CIMD+DCR, refresh rotation, account required;
    - a connect key (`tsk_…`, `McpAccessKey`);
    - the AI-050 device-flow JWT.
  - `RejectOAuthTokens` refuses both assistant credentials on account management (403 `insufficient_scope`). So a leaked one cannot mint another key or approve a device login.
  - `HttpContextTokenProvider` reads the token per request (SCOPED). `McpToolCatalog` + the provider are scoped, so no identity leaks across connections. The http mode NEVER touches the device-flow cache.
  - Package: `ModelContextProtocol.AspNetCore` 1.4.0 (matches the pinned `ModelContextProtocol`).

**Deploy** (http mode):
- Docker `mcp-server` (`backend/Docker/Mcp.Dockerfile`, profile `mcp`) binds `http://+:8090`, mapped `127.0.0.1:8090`. It talks to the API over the **internal** docker network (`TEXTSTACK_API_URL=http://api:8080`).
- nginx `location /mcp` (upstream `textstack_mcp`, zone `mcp_limit`) proxies with SSE settings: `proxy_buffering off`, `Connection ""`, relays `Authorization`, 3600s timeouts.
- It runs behind the Cloudflare tunnel, with no new cloud. Start it: `docker compose --profile mcp up -d mcp-server`.
- `deploy.yml` ("Sync nginx config") syncs the nginx config, including `/mcp` and the OAuth well-known/`/oauth/` blocks.

## Telemetry

**Errors:**
- Sentry runs on api, worker and mcp-server (http mode only): one project, a `service` tag.
- The web SPA reports to its own browser project when `VITE_SENTRY_DSN` is in `apps/web/production.env` (`apps/web/src/lib/sentry.ts`, lazy, `service: web`).
- One shared scrubber (`backend/src/Observability/TextStack.Observability/SentryScrubber.cs`) strips tokens (`ts[kocr]_`, Bearer, JWT), `/mcp/k/<key>`, query strings and SQL.
- No DSN = off.

**Traces/metrics:** the app registers OpenTelemetry only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Locally, that is the Aspire Dashboard (`--profile observability`, UI `localhost:18888`, OTLP `:18889`). It is unset in production, because nothing receives it. Details: `docs/architecture/delivery.md` § Observability.
