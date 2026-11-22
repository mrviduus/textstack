# Architecture

<img src="../assets/pixel-icons/architecture.svg" width="48" height="48" alt="">

TextStack is one API, one background worker and one PostgreSQL, with three clients: a web app, an
Android app and an MCP server for AI assistants. It is a modular monolith
([ADR-006](adr/006-modular-monolith.md)): one deployable backend, split into projects with strict
dependency rules.

Production runs V2 only since 2026-11-17: one database (`textstack_v2`), one reader (our foliate-js
fork). The plan that got here, kept as history: [v2.md](v2.md),
[ADR-030](adr/ADR-030-two-databases-one-cutover.md). Current state: [STATUS.md](../STATUS.md).

New here? Read [a book's journey](story.md) first: the same system as a short story with pictures.

## Read in this order

1. This page: the parts and what each one does.
2. [flows.md](flows.md): how a request moves between the parts, one diagram per scenario.
3. [data-model.md](data-model.md) and [data-access.md](data-access.md): the tables and the rules for reading and writing them.
4. [frontend.md](frontend.md): the apps and the shared packages.
5. [delivery.md](delivery.md): how a commit reaches production.
6. [adr/](adr/): why each load-bearing choice was made.

## The parts

Why one worker runs every queue, and what a second would take: [ADR-022](adr/ADR-022-one-consumer-per-queue.md), [ADR-023](adr/ADR-023-single-instance-no-fire-and-forget.md). How requests move between these parts: [flows.md](flows.md).

```
Internet ─► Cloudflare (DNS + TLS) ─► Cloudflare Tunnel ─► nginx on host (:80)
   textstack.app ─┬─ SPA (apps/web/dist) + reader frame (dist/reader-v2/)
                  ├─ /api/*  → api        :8080
                  └─ /mcp    → mcp-server :8090
   textstack.dev  ── admin SPA            :81   (noindex, JWT login)

Docker services (docker-compose.yml, all bound to 127.0.0.1):
  db          pgvector/pgvector:pg16 — Postgres 16, database textstack_v2
  migrator    one-shot: applies the plain-SQL migrations in database/ (ADR-026); api waits for it
  api         HTTP API + the TTS cache sweep
  worker      chapter extraction + retention cleanup (polls DB)
  admin       nginx serving the admin SPA
  ollama      local LLM (gemma4:e2b) for local tasks
  mcp-server  MCP↔HTTP bridge (profile `mcp`; prod deploy enables it)
  aspire-dashboard  OpenTelemetry UI (profile `observability`)
```

## Backend projects

`backend/src/` — all in `textstack.sln`, target `net11.0`.

| Project | Role |
|---------|------|
| `Domain` | Entities, enums, value objects |
| `Contracts` | Request/response DTOs, MCP manifest. No references |
| `Application` | Services + repository interfaces, `IFileStorageService`. References Domain, Contracts, Extraction, Vocabulary, Ai.Core, Ai.Llm, Ai.Agents |
| `Infrastructure` | Dapper repositories over one `AppDataSource` (`Persistence/`, [ADR-028](adr/ADR-028-dapper-and-repositories.md)), `LibraryFileStore`, `LocalFileStorageService`, `ResendEmailService`, `ImageOptimizer` |
| `Api` | Minimal API endpoints (`Api/Endpoints/`), middleware |
| `Worker` | Background host: chapter extraction, retention cleanup |
| `Extraction/TextStack.Extraction` | EPUB (VersOne.Epub) / PDF (PdfPig) / HTML extractors, text pipeline, quality scorer |
| `Tts/TextStack.Tts` | Edge TTS WebSocket client + disk cache |
| `Vocabulary/TextStack.Vocabulary` | SRS engine, review cards, distractor generator |
| `Ai/TextStack.Ai.Core` | AI abstractions (`ILlmService` etc.) |
| `Ai/TextStack.Ai.Llm` | `ModelGateway`: OpenAI + Ollama clients, routing, tracing, budgets |
| `Ai/TextStack.Ai.Tools`, `Ai/TextStack.Ai.Agents` | Tool calling + agent loop (`EnrichmentAgent` in `Application/Agents/`) |
| `Ai/TextStack.Ai.Evals`, `Ai/TextStack.Ai.EvalSuite` | Eval framework + runners |
| `Ai/TextStack.Ai.Mcp` | MCP server; references only `Contracts`, talks to the API over HTTP |

Deleted and gone from the solution: `TextStack.Epub` (2026-09-28), `TextStack.Search.Meilisearch`
and `search_documents` (2026-10-01), `TextStack.Ai.Rag` and all chat/RAG features (2026-09-10),
`TextStack.Search` and EF Core (M6, 2026-11-17).
Empty `bin/obj` folders of those may still exist in local checkouts.

## Dependency rules

```
Api ──► Application ──► Domain ◄── Infrastructure
 │           │             ▲
 │           └─► Ai.*, Extraction, Vocabulary
 └─► Tts                   │
                        Worker
```

- Domain: no framework dependencies (except Npgsql types — see smell list in the review notes).
- Infrastructure implements Application interfaces.
- Api/Worker compose everything via DI.

## Request pipeline (`Api/Program.cs`, order matters)

`ForwardedHeaders` → `Cors` → `AppVersion` → `ExceptionMiddleware` → `UserStoragePolicy` →
`StaticFiles(/storage)` → `/health`, `/health/ready` → `Routing` → `WriteFreeze` (off unless configured) →
`McpKeyAuth` → `RateLimiter` → `AccountGuard` → `GuestActivity` (10-min debounce) → `AdminAuth` (only `/admin/*`) → `PathGates`
(`/me/*` needs a user, `/internal/*` only from the Docker network; [ADR-024](adr/ADR-024-auth-fails-closed-by-path.md)) → endpoints.

The rate limiter must sit after `UseRouting`; before it, every per-endpoint policy was inert
(comment in `Program.cs`). There is no ASP.NET authentication middleware — endpoints read the
bearer token themselves (`GetUserId`).

## Background work

| Host | Hosted services |
|------|-----------------|
| Worker | `SingleInstanceLock`, `IngestionWorker` (uploaded files → `book_chapters`), `RetentionCleanupWorker` (daily: expired tokens, AI traces > 30 d), `HeartbeatWorker`, `AiProviderReadinessCheck` |
| Api | `EdgeTtsService` (cache cleanup) |

All queues are Postgres tables polled by the consumer; there is no message broker.

## Data stores

| Store | What |
|-------|------|
| PostgreSQL 16 | `textstack_v2`, ~27 tables ([data-model.md](data-model.md)) |
| `./data/storage` (bind mount, [ADR-001](adr/001-storage-bind-mounts.md)) | Avatars + upload covers, served at `/storage` |
| `./data/library` | Book files, outside the public root (`LibraryFileStore`) |
| `./data/tts-cache`, `./data/explain-cache`, `./data/translate-cache` | SHA256-keyed disk caches |
| `./data/ollama` | Ollama models |
| Web IndexedDB (`offlineDb.ts`) | Highlights, translations, explains, TTS audio, pending vocabulary |
| Mobile files + local library (`v2reader/hostStorage.ts`, `localLibrary.ts`) | Book files and their rows, read offline |

## Clients and shared code

| Path | What |
|------|------|
| `apps/web` | React 19 + Vite SPA; hosts the reader page (`V2ReaderHost`) |
| `apps/admin` | Admin shell on `textstack.dev`: login and an empty home |
| `apps/mobile` | Expo 57 / React Native 0.86 (Android first); hosts the shared reader (`packages/reader/`, [ADR-032](adr/ADR-032-one-engine-foliate-fork.md)) |
| `packages/reader` | Shared renderer, protocol, generated page and reader tests |
| `packages/shared` | `@textstack/shared` — API client, types, i18n, reader progress logic (source alias, not published) |

Details: [frontend.md](frontend.md).

## External dependencies

| Service | Used for | Failure mode |
|---------|----------|--------------|
| OpenAI | Translate (`gpt-4.1-mini`), Explain (`gpt-4.1-mini`) | Feature returns error; reading unaffected |
| Ollama (self-hosted) | Local LLM tasks (routes in `AiRouteMap`) | Soft in `/health/ready` |
| Edge TTS (`speech.platform.bing.com`, no key) | Text-to-speech | No audio |
| Resend | Password reset, admin alert emails | No email |
| Google / Apple sign-in | OAuth login | Email/password and guest still work |
| Sentry | Errors from api, worker, MCP server, web, mobile (no-op without DSN) | — |
| Cloudflare | DNS, TLS, tunnel to the home server | Site down |
| GitHub Actions | CI, image builds and deploy on merge to `main` ([delivery.md](delivery.md)) | No deploys |
| EAS / Google Play | Mobile builds, OTA updates | — |

## Feature notes

**TTS**: `useTts()` → IndexedDB → `GET /api/tts` → `EdgeTtsService` disk cache → `EdgeTtsClient`
WebSocket. Server key `SHA256(text+voice+rate)`.

## ADRs

All in [adr/](adr/). Numbering is inconsistent (three files numbered 007, `0001` beside `001`,
mixed `NNN-` / `ADR-NNN-` prefixes, no 008/009). Status notes at the top of each file say which
are superseded or obsolete.

## See also

- [flows.md](flows.md) — runtime view: upload, read, MCP, background AI
- [data-model.md](data-model.md) — entity map + PII
- [frontend.md](frontend.md) — apps and packages
- [admin](auth.md#admin)
