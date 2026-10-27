# CI/CD, deployment, MCP server, telemetry, SSG checks

Moved verbatim from `CLAUDE.md` (2026-10-12) to keep the always-loaded context small. Read when the task touches this area.

## CI/CD

**GitHub Actions workflows** (`.github/workflows/`):
- **ci.yml** — runs on PR + push to main. Jobs: backend (build, lint, migrations, search tests), frontend (web + admin build), docker (integration tests), e2e (Playwright)
- **deploy.yml** — skips docs, `apps/mobile/**`, `extension/**` pushes (never `packages/**`/lockfile). In parallel: `ci` (merged-tree) and `images` (GitHub-hosted `images.yml`: build → `scripts/scan-image-secrets.sh` gate → push `ghcr.io/mrviduus/textstack-<svc>:<sha>`, outputs digests; job `web` builds the web bundle with canary env, scans `dist`, pushes `textstack-web` as a `FROM scratch` image). Then self-hosted `deploy`: checkout → SSG wait → pre-deploy dump (failure ships nothing) → pull `textstack-web@digest` → scan it with the server's real values (a hit stops with nothing live changed) → `scripts/swap-web-dist.sh` (file by file, `index.html` last, `dist/ssg*` untouched; server vite build only as fallback) → pull `name@digest` (no digest/pull fails → server build) → health → SSG check. Rollback (`rollback_commit`) must be hex and on `origin/main` (`guard` job). Full SSG rebuild only with `rebuild_ssg`, the admin button or `make rebuild-ssg`; no nightly since #992. Pipeline, deps, controls: `docs/01-architecture/delivery.md`, ADR-020
- **Pins**: every action by commit SHA (`# vX.Y`), every pulled image `tag@sha256:…`; Dependabot moves them. Every workflow has a read-only/none top-level `permissions:`; widen per job only
- **backup.yml** — daily at 3 AM UTC. DB dump + storage tar.gz, keeps 5 newest of each
- **health-check.yml** — every 5 min. Checks API + both frontends

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

Thin, stateless MCP↔HTTP bridge (Phase 8) — every tool call becomes an HTTP request to the public TextStack API (no DB/EF/OpenAI). 21 tools. Public catalog: `search_books`, `get_book`, `get_chapter`. The user's own uploads (Bearer): `search_my_library`, `get_my_book`, `get_my_chapter`, `save_my_highlight`, `list_my_book_highlights` — keyed by `bookId` (`UserBook.Id`), which is NOT an `editionId` and does not work in the edition-scoped tools. Write-back, either book type (Bearer): `save_insight`, `get_my_insights` — conclusions from an outside assistant, keyed by chapter **slug** (`BookInsight`, table `book_insight`), one per (user, book, chapter) so a re-run replaces rather than accumulates. Everything else (Bearer): `list_my_highlights`, `list_my_vocabulary` (returns word ids), `save_highlight`. Vocabulary writes (Bearer): `add_vocabulary_words` (≤20 per call, translation or definition required, one result line per word; a 429 or a missing native language stops the batch), `update_vocabulary_word`, `delete_vocabulary_word` — thin over `POST/PATCH/DELETE /me/vocabulary/words`; a save with no `nativeLanguage` falls back to the profile's, and a connect-key/OAuth save is tagged `source = "mcp"` server-side. Wipe-all `DELETE /me/vocabulary/words` refuses OAuth tokens and connect keys. Reading state (Bearer): `get_my_reading` — the shelf, **no arguments**, the only way in when the model holds no id; `get_book_progress`; `set_book_progress` — records a chapter finished ANYWHERE (audiobook, paper) and resumes the reader at the next one. Chapter review (Bearer, either book type): `get_chapter_review`, `save_chapter_review` — the reader's assistant reviews one chapter by the method in `Application/ChapterReview/ReviewMethod.md`; stored in the chapter's `BookInsight.ReviewJson` (ADR-016), questions in `review_question` with their own SRS queue (`/me/review-questions/*`); refused beyond the reader's progress. See `docs/05-features/chapter-review.md`. The tool count is asserted in four places (`McpManifestDriftTests`, `McpStdioSmokeTests`, `McpOverTheWireTests`, `McpManifestEndpointTests`) and the descriptions are mirrored verbatim into `Contracts/Mcp/McpManifest.cs`, which the drift test compares character for character.

**There is no question-answering tool.** `ask_book` and the retrieval spine behind it were deleted 2026-09-10: 7 books of 1498 were ever indexed, and the vision PDF transcription that fed the index was 94% of the project's lifetime LLM spend. An assistant reads `get_chapter` as plain text and reasons over it better, on the reader's own subscription.

**Assistant write ceiling**: `HighlightsEndpoints.MaxAssistantHighlightsPerBook` (200) caps how many highlights one book may receive over MCP, counted by `anchor_json->>'source' = 'mcp'` — the field `SynthesizeAnchor` writes. A person highlighting in the reader is never counted and never capped. `POST /me/highlights` and the vocabulary word writes (POST/PATCH/DELETE `/me/vocabulary/words`) are additionally rate-limited by the `highlight-write` policy (120/min, one budget per user across those routes), which — like `insights` — is **partitioned by user id rather than IP**: the MCP bridge reaches the API from one container address, so an IP key would let one looping client throttle every other MCP user.

**On a PDF upload an MCP highlight is saved and listed but not painted.** The reader renders PDFs as the original document (ADR-012) and `PdfHighlightLayer` only draws `kind:"pdf"` anchors, which are page geometry the bridge cannot produce. `get_my_book` reports `rendersAsOriginalPdf` so the model can say so. Roughly half the uploaded library is PDF.

The write-back exists because the reasoning happens in Claude/ChatGPT — where the reader already has a profile and a year of history — and only the **result** comes home. See `docs/05-features/mcp.md`.

**Dual transport** (env `MCP_TRANSPORT`: `stdio` default | `http`; `--http` flag also selects http). Shared wiring (tool catalog handlers, typed `TextStackApiClient`) in `McpBridgeCore`; the two host builders in `McpHosts`.
- **stdio** (local, single identity): `Host.CreateApplicationBuilder`, **logs→stderr** (stdout is JSON-RPC only — never `Console.Write*`), singleton DI, token from `TEXTSTACK_MCP_TOKEN` (static) or the device flow (`DeviceFlowTokenProvider`, AI-050). Byte-identical to the pre-049 server.
- **http** (AI-049, remote, **multi-user**): `WebApplication`, `.WithHttpTransport(o => o.Stateless = true)`, `app.MapMcp("/mcp")` + `GET /health`. **Bearer required on all of `/mcp`** — none → `401` + `WWW-Authenticate: Bearer resource_metadata=…` (ADR-017); the host also serves the protected-resource metadata. Each connection authenticates with its OWN `Authorization: Bearer <token>` — an OAuth access token (`tso_…`, `OAuthGrant`; AS in the API, `OAuthEndpoints.cs`: authorize → web consent `/en/oauth/consent` → token, CIMD+DCR, refresh rotation, account required), a connect key (`tsk_…`, `McpAccessKey`) or the AI-050 device-flow JWT — read per-request by `HttpContextTokenProvider` (SCOPED; `McpToolCatalog` + provider scoped so no identity leaks across connections). NEVER touches the device-flow cache. Package: `ModelContextProtocol.AspNetCore` 1.4.0 (matches the pinned `ModelContextProtocol`).

**Deploy** (http mode): Docker `mcp-server` (`backend/Docker/Mcp.Dockerfile`, profile `mcp`) binds `http://+:8090`, mapped `127.0.0.1:8090`; talks to the API over the **internal** docker network (`TEXTSTACK_API_URL=http://api:8080`). nginx `location /mcp` (upstream `textstack_mcp`, zone `mcp_limit`) proxies with SSE settings (`proxy_buffering off`, `Connection ""`, relays `Authorization`, 3600s timeouts). Behind Cloudflare tunnel — no new cloud. Bring up: `docker compose --profile mcp up -d mcp-server`. nginx config (incl. `/mcp` and the OAuth well-known/`/oauth/` blocks) is synced by `deploy.yml` ("Sync nginx config").

## Telemetry

**Errors:** Sentry on api, worker, mcp-server (http mode only) and ssg-worker, one project, `service` tag; the web SPA reports to its own browser project when `VITE_SENTRY_DSN` is in `apps/web/production.env` (`apps/web/src/lib/sentry.ts`, lazy, `service: web`); one shared scrubber (`backend/src/Observability/TextStack.Observability/SentryScrubber.cs`, Node twin `apps/web/scripts/ssgSentry.mjs`) strips tokens (`ts[kocr]_`, Bearer, JWT), `/mcp/k/<key>`, query strings and SQL. No DSN = off.

**Traces/metrics:** OpenTelemetry is registered only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set — locally Aspire Dashboard (`--profile observability`, UI `localhost:18888`, OTLP `:18889`); unset in production (nothing receives it). Details: `docs/01-architecture/delivery.md` § Observability.

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
