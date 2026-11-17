# CI/CD, deployment, MCP server, telemetry, SSG checks

Moved verbatim from `CLAUDE.md` (2026-10-12) to keep the always-loaded context small. Read when the task touches this area.

## CI/CD

**GitHub Actions workflows** (`.github/workflows/`):
- **ci.yml** — runs on PR + push to main. Jobs: backend (build, lint, migrations, search tests), frontend (web + admin build), docker (integration tests), e2e (Playwright)
- **deploy.yml** — skips docs, `apps/mobile/**`, `extension/**` pushes (never `packages/**`/lockfile). In parallel: `ci` (merged-tree) and `images` (GitHub-hosted `images.yml`: build → `scripts/scan-image-secrets.sh` gate → push `ghcr.io/mrviduus/textstack-<svc>:<sha>`, outputs digests; job `web` builds the web bundle with canary env, scans `dist`, pushes `textstack-web` as a `FROM scratch` image). Then self-hosted `deploy`: checkout → SSG wait → pre-deploy dump (failure ships nothing) → pull `textstack-web@digest` → scan it with the server's real values (a hit stops with nothing live changed) → `scripts/swap-web-dist.sh` (file by file, `index.html` last, `dist/ssg*` untouched; server vite build only as fallback) → pull `name@digest` (no digest/pull fails → server build) → health → SSG check. Rollback (`rollback_commit`) must be hex and on `origin/main` (`guard` job). Full SSG rebuild only with `rebuild_ssg`, the admin button or `make rebuild-ssg`; no nightly since #992. Pipeline, deps, controls: `docs/architecture/delivery.md`, ADR-020
- **Pins**: every action by commit SHA (`# vX.Y`), every pulled image `tag@sha256:…`; Dependabot moves them. Every workflow has a read-only/none top-level `permissions:`; widen per job only
- **backup.yml** — daily at 3 AM UTC. `textstack_v2` dump (fatal if absent or incomplete; legacy is archived, no longer dumped) + storage tar.gz, keeps 2 newest of each; R2 off-site (`/db_v2.sql`, `/backup` = `data/storage` + `data/library` + `.env`). The deploy's pre-deploy dump is V2 too, and fatal. `make backup` dumps V2; `make restore FILE=` = V2 into an absent database. `restore-drill.yml` (monthly) restores V2 from R2, row-counts its migrated tables (`users`, `books`, `book_files`, `annotations` non-empty) and checks book files exist in the restored library. Details: `internal/ops/backup.md`, `database/v2/README.md`
- **health-check.yml** — every 5 min. Checks API + both frontends; `/health/ready`'s `v2` component must be `ok` unless it says `off` (flag off)
- **V2 rollback**: `make migrate-v2-drop CONFIRM=textstack_v2` drops the database (the baseline has no down file)

## Deployment

```
Internet → Cloudflare (DNS+SSL) → Cloudflare Tunnel → nginx (port 80)
  ├─ textstack.app → SSG static files + /api/ proxy to :8080 + /mcp proxy to :8090
  └─ textstack.dev → admin panel (:81)
```

Docker services: `db` (pgvector pg16, digest-pinned), `migrator`, `api`, `worker`, `admin`, `ssg-worker`, `aspire-dashboard` (profile-gated), `ollama`, `mcp-server` (profile-gated, `--profile mcp`). All localhost-only, no public ports except 80 via tunnel.

Images: built + secret-scanned on GitHub, pulled by digest from GHCR; secrets only in the server's `.env` at runtime. Never deploy by SSH — break-glass is `gh workflow run deploy.yml`.

**Nginx bot detection**: Regex map identifies crawlers (Google, Bing, Yandex, social bots) → routes to prerendered SSG HTML. Rate limiting zones: API (10r/s), uploads (1r/s), translation (5r/m), MCP (10r/s).

**Systemd services** (`infra/systemd/`, user units, restarted on every deploy): `seo-publish-poller` (auto-publish with SEO generation), `seo-backfill-poller` (SEO backfill jobs via the Claude CLI), `quality-poller` (book quality jobs).

**Notable env vars** (beyond `.env.example` basics): `INDEXNOW_KEY`, `INDEXNOW_ENABLED`.

## MCP Server (`backend/src/Ai/TextStack.Ai.Mcp/`)

Thin, stateless MCP↔HTTP bridge (Phase 8) — every tool call becomes an HTTP request to the V2 sync API (`/me/v2/*`; no DB/EF/OpenAI), answered in the shapes the tool catalog maps (`Http/TextStackApiClient.V2*.cs`). 25 tools, every one Bearer-scoped and keyed by the book's `bookId`. The reader's books: `search_my_library` (title/author + tags; V2 has no full-text search), `get_my_book`, `get_my_chapter` (the transitional `book_chapters`, kept by M6 D8), `save_my_highlight`, `list_my_book_highlights` — a chapter's `chapterId` is minted by the bridge from (file, chapter key), so listing and saving agree. Write-back: `save_insight`, `get_my_insights` (one per user, book, chapter; a save replaces). Vocabulary: `list_my_vocabulary` (the V2 change feed, filtered and paged in the bridge), `add_vocabulary_words` (≤20 per call, a required host `operationId` — one id per word derived from it and the word, the same on a retry in any order; translation or definition required, one result line per word; a 429 stops the batch), `update_vocabulary_word` (patches on the revision just read), `delete_vocabulary_word`. Reading state: `get_my_reading` — the shelf, **no arguments**, the only way in when the model holds no id; `get_book_progress`; `set_book_progress` — records a chapter finished ANYWHERE (audiobook, paper) and resumes the reader at the next one. Discussion (#1316): `share_chapter`, `save_checkpoint`, `list_checkpoints`, `get_shared_chapter` (reads one of the caller's own shares in parts of 40,000 characters; the id the V2 reader's Discuss hands over as `(TextStack: book <bookId>, share <shareId>)`, named in `McpBridgeCore.Instructions`). **Retired** (listed, answer "this feature is retired in this version" without a call): `search_books`, `get_book`, `get_chapter`, `list_my_highlights`, `save_highlight`, `get_chapter_review`, `save_chapter_review`, and an `editionId`/catalog `slug` argument on the others; deleting them (25 → 18, new NuGet) is open owner decision M6 D6. The tool count is asserted in four places (`McpManifestDriftTests`, `McpStdioSmokeTests`, `McpOverTheWireTests`, `McpManifestEndpointTests` — 25), the manifest's names equal the bridge's registered names and the descriptions live once, in `Contracts/Mcp/McpManifest.cs`, which the runtime catalog reads.

**There is no question-answering tool.** `ask_book` and the retrieval spine behind it were deleted 2026-09-10: 7 books of 1498 were ever indexed, and the vision PDF transcription that fed the index was 94% of the project's lifetime LLM spend. An assistant reads `get_my_chapter` as plain text and reasons over it better, on the reader's own subscription.

**Assistant writes**: an MCP highlight is a V2 annotation whose `textstack-anchor-v1` locator carries `source: "mcp"`; there is no per-book ceiling on V2 (the assistant writes are rate limited per user, `assistant-write`).

**On a PDF upload an MCP highlight is saved and listed but not painted.** The reader renders PDFs as the original document (ADR-012) and `PdfHighlightLayer` only draws `kind:"pdf"` anchors, which are page geometry the bridge cannot produce. `get_my_book` reports `rendersAsOriginalPdf` so the model can say so. Roughly half the uploaded library is PDF.

The write-back exists because the reasoning happens in Claude/ChatGPT — where the reader already has a profile and a year of history — and only the **result** comes home. See `docs/reference/mcp.md`.

**Dual transport** (env `MCP_TRANSPORT`: `stdio` default | `http`; `--http` flag also selects http). Shared wiring (tool catalog handlers, typed `TextStackApiClient`) in `McpBridgeCore`; the two host builders in `McpHosts`.
- **stdio** (local, single identity): `Host.CreateApplicationBuilder`, **logs→stderr** (stdout is JSON-RPC only — never `Console.Write*`), singleton DI, token from `TEXTSTACK_MCP_TOKEN` (static) or the device flow (`DeviceFlowTokenProvider`, AI-050). Byte-identical to the pre-049 server.
- **http** (AI-049, remote, **multi-user**): `WebApplication`, `.WithHttpTransport(o => o.Stateless = true)`, `app.MapMcp("/mcp")` + `GET /health`. **Bearer required on all of `/mcp`** — none → `401` + `WWW-Authenticate: Bearer resource_metadata=…` (ADR-017); the host also serves the protected-resource metadata. Each connection authenticates with its OWN `Authorization: Bearer <token>` — an OAuth access token (`tso_…`, `OAuthGrant`; AS in the API, `OAuthEndpoints.cs`: authorize → web consent `/en/oauth/consent` → token, CIMD+DCR, refresh rotation, account required), a connect key (`tsk_…`, `McpAccessKey`) or the AI-050 device-flow JWT (both assistant credentials are refused on account management, 403 `insufficient_scope` from `RejectOAuthTokens`: a leaked one cannot mint another key or approve a device login) — read per-request by `HttpContextTokenProvider` (SCOPED; `McpToolCatalog` + provider scoped so no identity leaks across connections). NEVER touches the device-flow cache. Package: `ModelContextProtocol.AspNetCore` 1.4.0 (matches the pinned `ModelContextProtocol`).

**Deploy** (http mode): Docker `mcp-server` (`backend/Docker/Mcp.Dockerfile`, profile `mcp`) binds `http://+:8090`, mapped `127.0.0.1:8090`; talks to the API over the **internal** docker network (`TEXTSTACK_API_URL=http://api:8080`). nginx `location /mcp` (upstream `textstack_mcp`, zone `mcp_limit`) proxies with SSE settings (`proxy_buffering off`, `Connection ""`, relays `Authorization`, 3600s timeouts). Behind Cloudflare tunnel — no new cloud. Bring up: `docker compose --profile mcp up -d mcp-server`. nginx config (incl. `/mcp` and the OAuth well-known/`/oauth/` blocks) is synced by `deploy.yml` ("Sync nginx config").

## Telemetry

**Errors:** Sentry on api, worker, mcp-server (http mode only) and ssg-worker, one project, `service` tag; the web SPA reports to its own browser project when `VITE_SENTRY_DSN` is in `apps/web/production.env` (`apps/web/src/lib/sentry.ts`, lazy, `service: web`); one shared scrubber (`backend/src/Observability/TextStack.Observability/SentryScrubber.cs`, Node twin `apps/web/scripts/ssgSentry.mjs`) strips tokens (`ts[kocr]_`, Bearer, JWT), `/mcp/k/<key>`, query strings and SQL. No DSN = off.

**Traces/metrics:** OpenTelemetry is registered only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set — locally Aspire Dashboard (`--profile observability`, UI `localhost:18888`, OTLP `:18889`); unset in production (nothing receives it). Details: `docs/architecture/delivery.md` § Observability.

## Verifying SSG

After content changes, verify SSG is serving correctly:
```bash
# Check header indicates SSG (not SPA fallback)
curl -I https://textstack.app/en/books/dracula/ | grep X-SEO-Render
# Expected: X-SEO-Render: ssg

# Check SPA routes still work
curl -I https://textstack.app/en/search | grep X-SEO-Render
# Expected: X-SEO-Render: spa
```
