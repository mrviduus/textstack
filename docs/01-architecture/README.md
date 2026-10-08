# System Architecture

Modular monolith ([ADR-006](adr/006-modular-monolith.md)): one ASP.NET Core API, one background
Worker, one PostgreSQL, three clients. Single public site ([ADR-007](adr/007-single-domain-consolidation.md)).
Verified against code on 2026-10-04.

## High-Level View

How requests move between these parts: the interactive [map](https://mrviduus.github.io/textstack/architecture/) (source [textstack-map.html](textstack-map.html)), or the same as Mermaid in [flows.md](flows.md).

```
Internet ─► Cloudflare (DNS + TLS) ─► Cloudflare Tunnel ─► nginx on host (:80)
   textstack.app ─┬─ bots → prerendered SSG HTML, humans → SPA (apps/web/dist)
                  ├─ /api/*  → api        :8080
                  └─ /mcp    → mcp-server :8090
   textstack.dev  ── admin SPA            :81   (noindex, JWT login)

Docker services (docker-compose.yml, all bound to 127.0.0.1):
  db          pgvector/pgvector:pg16 — Postgres 16 + FTS + pgvector
  migrator    one-shot EF migrations; api waits for it
  api         HTTP API + some hosted services (see below)
  worker      ingestion + enrichment + cleanup jobs (polls DB)
  ssg-worker  Node + Puppeteer; polls DB for SSG rebuild jobs, writes apps/web/dist/ssg
  admin       nginx serving the admin SPA
  ollama      local LLM (gemma4:e2b) for vocabulary distractors / metadata
  mcp-server  MCP↔HTTP bridge (profile `mcp`; prod deploy enables it)
  aspire-dashboard  OpenTelemetry UI (profile `observability`)

Host (systemd user units, outside Docker): seo-publish-poller, seo-backfill-poller,
quality-poller — shell scripts in infra/scripts/ that call the Claude CLI.
```

## Backend projects

`backend/src/` — all in `textstack.sln`, target `net10.0`.

| Project | Role |
|---------|------|
| `Domain` | Entities, enums, value objects. Only package: `Npgsql` (for `NpgsqlTsVector` on `Chapter`) |
| `Contracts` | Request/response DTOs, MCP manifest. No references |
| `Application` | Services + `IAppDbContext`, `IFileStorageService`. References Domain, Contracts, Extraction, Vocabulary, Ai.Core, Ai.Llm, Ai.Agents; packages incl. EF Core |
| `Infrastructure` | `AppDbContext` (split into partials per area), migrations, `LocalFileStorageService`, `ResendEmailService`, `ImageOptimizer` |
| `Api` | Minimal API endpoints (`Api/Endpoints/`), middleware, site resolution, SEO/SSG endpoints |
| `Worker` | Background host: ingestion, enrichment, guest cleanup |
| `Extraction/TextStack.Extraction` | EPUB (VersOne.Epub) / PDF (PdfPig) / HTML extractors, text pipeline, quality scorer |
| `Search/TextStack.Search` | Postgres FTS via Dapper (`PostgresSearchProvider`) |
| `Tts/TextStack.Tts` | Edge TTS WebSocket client + disk cache |
| `Vocabulary/TextStack.Vocabulary` | SRS engine, review cards, distractor generator |
| `Ai/TextStack.Ai.Core` | AI abstractions (`ILlmService` etc.) |
| `Ai/TextStack.Ai.Llm` | `ModelGateway`: OpenAI + Ollama clients, routing, shadow runs, tracing, budgets |
| `Ai/TextStack.Ai.Tools`, `Ai/TextStack.Ai.Agents` | Tool calling + agent loop (`TutorAgent`, `EnrichmentAgent` in `Application/Agents/`) |
| `Ai/TextStack.Ai.Evals`, `Ai/TextStack.Ai.EvalSuite` | Eval framework + runners (admin AI-quality page, continuous evals) |
| `Ai/TextStack.Ai.Mcp` | MCP server; references only `Contracts`, talks to the API over HTTP |

Deleted and gone from the solution: `TextStack.Epub` (2026-09-28), `TextStack.Search.Meilisearch`
and `search_documents` (2026-10-01), `TextStack.Ai.Rag` and all chat/RAG features (2026-09-10).
Empty `bin/obj` folders of those may still exist in local checkouts.

## Dependency rules

```
Api ──► Application ──► Domain ◄── Infrastructure
 │           │             ▲
 │           └─► Ai.*, Extraction, Vocabulary
 └─► Search, Tts           │
                        Worker
```

- Domain: no framework dependencies (except Npgsql types — see smell list in the review notes).
- Infrastructure implements Application interfaces.
- Api/Worker compose everything via DI.

## Request pipeline (`Api/Program.cs`, order matters)

`ForwardedHeaders` → `Cors` → `ExceptionMiddleware` → `StaticFiles(/storage)` → `/health`,
`/health/ready` → `SiteContext` → `LanguageContext` → `Routing` → `McpKeyAuth` → `RateLimiter`
→ `GuestActivity` (10-min debounce) → `AdminAuth` (only `/admin/*` except `/admin/auth/*`) → endpoints.

The rate limiter must sit after `UseRouting`; before it, every per-endpoint policy was inert
(comment in `Program.cs`). There is no ASP.NET authentication middleware — endpoints read the
bearer token themselves (`GetUserId`).

## Site context

Single site forever (ADR-007). `SiteContextMiddleware` resolves `Host` via `site_domains`; an
unknown host falls back to the one site (`ICurrentSite.Id`, config `Site:Id`) — 404 only if that
row is missing. EF global query filters on `ISiteScoped` entities key on `ICurrentSite.Id`, so
code does not pass `SiteId` by hand. The `site_id` columns stay. See [multisite.md](multisite.md).

## Background work

| Host | Hosted services |
|------|-----------------|
| Worker | `IngestionWorker` (admin + user uploads, polls every 5 s), `MetadataEnrichmentWorker`, `GuestCleanupWorker` (2 h / 30 d), `AdminRefreshTokenCleanupWorker`, `HeartbeatWorker`, `AiProviderReadinessCheck`, `TextStackWatcher` (optional) |
| Api | `AutoRetireSweeperWorker`, `DailyCapReconcilerWorker`, `WordFrequencyLoaderWorker`, `ClusterCandidateBuilderWorker`, `ConceptClusteringWorker`, `ContinuousEvalWorker`, `EdgeTtsService` (cache cleanup) |
| ssg-worker | Polls `ssg_rebuild_jobs` every 5 s, runs `prerender.mjs`, swaps `dist/ssg` atomically, pings IndexNow |
| Host systemd | `seo-publish-poll.sh`, `seo-backfill-poll.sh`, `quality-poll.sh` (Claude CLI) |

All queues are Postgres tables polled by the consumer; there is no message broker.

## Data stores

| Store | What |
|-------|------|
| PostgreSQL 16 | ~63 tables ([data-model.md](data-model.md)). FTS: `chapters.search_vector` (trigger). pgvector: `vocabulary_words.embedding` (1536-d) |
| `./data/storage` (bind mount, [ADR-001](adr/001-storage-bind-mounts.md)) | Original uploads + covers, served at `/storage` |
| `./data/tts-cache`, `./data/explain-cache` | SHA256-keyed disk caches, 30-day TTL |
| `./data/ollama` | Ollama models |
| Web IndexedDB | Offline chapters, TTS audio |
| Mobile SQLite (`offlineDb.ts`) + files | Offline chapters and original PDFs |

## Clients and shared code

| Path | What |
|------|------|
| `apps/web` | Public React 19 + Vite SPA; also the SSG source |
| `apps/admin` | Admin React SPA on `textstack.dev` |
| `apps/mobile` | Expo 57 / React Native 0.86 (Android first) |
| `packages/shared` | `@textstack/shared` — API client, types, i18n, reader progress logic (source alias, not published) |
| `packages/reader-overlay` | `@textstack/reader-overlay` — DOM overlay engine for highlights/vocab/search |

Details: [frontend.md](frontend.md).

## External dependencies

| Service | Used for | Failure mode |
|---------|----------|--------------|
| OpenAI | Translate (`gpt-4.1-nano`), Explain (`gpt-4.1-mini`), Tutor, embeddings (`text-embedding-3-small`) | Feature returns error; reading unaffected |
| Ollama (self-hosted) | Vocabulary distractors/hint/explanation, book metadata | Fallback distractors; fields stay null |
| Edge TTS (`speech.platform.bing.com`, no key) | Text-to-speech | No audio |
| Resend | Password reset, admin alert emails | No email |
| Google / Apple sign-in | OAuth login | Email/password and guest still work |
| Sentry | Errors from api + worker (no-op without DSN) | — |
| Cloudflare | DNS, TLS, tunnel to the home server | Site down |
| IndexNow (Bing/Yandex) | Push changed URLs after SSG rebuild | — |
| Claude CLI (host, Max subscription) | SEO generation, PDF cleanup pollers | Jobs stay queued |
| GitHub Actions (self-hosted runner) | CI + deploy on push to `main` | No deploys |
| EAS / Google Play | Mobile builds, OTA updates | — |

## Feature notes

**TTS**: `useTts()` → IndexedDB → `GET /api/tts` → `EdgeTtsService` disk cache → `EdgeTtsClient`
WebSocket. Server key `SHA256(text+voice+rate)`.

**PDF content quality**: after ingestion, `ChapterContentQualityAnalyzer` scores each chapter
0–100; if `quality.autoQueueAfterIngestion` / `quality.autoQueueForUserBooks` (admin settings) is on,
a `BookQualityJob` is queued. `quality-poll.sh` on the host runs a Claude pass on low-score
chapters behind a word-diff gate (`pdf-cleanup-gate.py`). Off by default
(`CONTENT_CLEANUP_ENABLED=false`). Full design:
[feat-0007](../05-features/feat-0007-pdf-content-quality.md).

## ADRs

All in [adr/](adr/). Numbering is inconsistent (three files numbered 007, `0001` beside `001`,
mixed `NNN-` / `ADR-NNN-` prefixes, no 008/009). Status notes at the top of each file say which
are superseded or obsolete.

## See also

- [flows.md](flows.md) — runtime view: upload, read, MCP, SSG, background AI
- [data-model.md](data-model.md) — entity map + PII
- [multisite.md](multisite.md) — host → site resolution
- [frontend.md](frontend.md) — apps and packages
- [../02-system/](../02-system/) — database, ingestion, SSG, SEO, admin
