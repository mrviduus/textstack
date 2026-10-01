# System Architecture

Modular monolith: single API + Worker, layered architecture, PostgreSQL.

## High-Level View

```
┌─────────────────────────────────────────────────────────┐
│                    Reverse Proxy                        │
│              (nginx/caddy, TLS termination)             │
└─────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│     Web       │   │     API       │   │    Admin      │
│  (React/Vite) │   │ (ASP.NET Core)│   │  (React/Vite) │
│  port 5173    │   │  port 8080    │   │  port 81    │
└───────────────┘   └───────────────┘   └───────────────┘
                            │
                    ┌───────┴───────┐
                    ▼               ▼
            ┌───────────────┐ ┌───────────────┐
            │    Worker     │ │   PostgreSQL  │
            │ (ingestion)   │ │ port 5432, FTS│
            └───────────────┘ └───────────────┘
                    │               │
                    ▼               │
            ┌───────────────┐       │     ┌───────────────┐
            │   Storage     │◄──────┘     │    Ollama     │
            │ (bind mount)  │             │  gemma4:e2b   │
            └───────────────┘             └───────────────┘
                                          ┌───────────────┐
                                          │LibreTranslate │
                                          └───────────────┘
                                          ┌───────────────┐
                                          │  Edge TTS     │
                                          │ (WebSocket)   │
                                          └───────────────┘
```

## Backend Layers

```
backend/src/
├── Api/              # HTTP endpoints, middleware
│   ├── Endpoints/    # Minimal API route groups
│   ├── Sites/        # SiteResolver, SiteContext
│   └── Middleware/   # Exception handling
├── Application/      # Business logic
│   ├── Books/        # BookService
│   ├── Admin/        # AdminService
│   ├── Ingestion/    # IngestionService
│   ├── Search/       # SearchService
│   └── Sites/        # SiteService
├── Domain/           # Entities, enums (no dependencies)
│   ├── Entities/     # Work, Edition, Chapter, etc.
│   └── Enums/        # EditionStatus, JobStatus
├── Infrastructure/   # EF Core, storage
│   ├── Data/         # AppDbContext, Configurations
│   ├── Migrations/   # EF migrations
│   └── Storage/      # LocalFileStorageService
├── Tts/              # Text-to-Speech
│   └── TextStack.Tts/ # EdgeTtsClient (WebSocket), EdgeTtsService (cache)
├── Worker/           # Background jobs
│   ├── Services/     # IngestionWorker
│   └── Parsers/      # EpubParser
└── Contracts/        # DTOs
```

## Dependency Rules

```
API ──► Application ──► Domain ◄── Infrastructure
                           ▲
                           │
                        Worker
```

- **Domain**: Pure C#, no framework dependencies
- **Application**: Business logic, depends on Domain + interfaces
- **Infrastructure**: Implements interfaces (IAppDbContext, IFileStorageService)
- **API/Worker**: Orchestration, DI configuration

## Key Patterns

### Minimal API
Endpoints grouped by domain:
- `MapBooksEndpoints()` — public book/chapter routes
- `MapAdminEndpoints()` — admin CRUD
- `MapSearchEndpoints()` — FTS search
- `MapVocabularyEndpoints()` — vocabulary SRS + review
- `MapReadingTrackingEndpoints()` — sessions, goals, achievements
- `MapTtsEndpoints()` — text-to-speech synthesis + voice listing

### Background Jobs
Worker polls database for queued jobs:
```
IngestionJob.Status == Queued
  → Processing → Succeeded/Failed
```

### Site Context
Every request:
1. SiteContextMiddleware resolves Host → SiteContext
2. SiteContext.SiteId used in all queries
3. Unknown host → 404

## Frontend Structure

```
apps/
├── web/              # Public reader
│   ├── src/
│   │   ├── pages/
│   │   ├── components/
│   │   └── context/  # SiteContext.tsx
│   └── Dockerfile
├── admin/            # Admin panel
└── mobile/           # React Native (later)

packages/             # Shared TS code
├── api-client/       # Generated from OpenAPI
├── sync/             # Offline queue
└── reader/           # Locator format
```

## TTS (Text-to-Speech)

```
┌──────────┐    ┌──────────────┐    ┌─────────────────┐    ┌──────────────────┐
│ Frontend │───►│ GET /api/tts │───►│ EdgeTtsService  │───►│  EdgeTtsClient   │
│ useTts() │    │ TtsEndpoints │    │ (disk cache)    │    │ (WebSocket)      │
└──────────┘    └──────────────┘    └─────────────────┘    └──────────────────┘
     │                                     │                        │
     ▼                                     ▼                        ▼
┌──────────┐                      ┌─────────────────┐    ┌──────────────────┐
│IndexedDB │                      │ data/tts-cache/  │    │ speech.platform  │
│(browser) │                      │ {sha256}.mp3     │    │ .bing.com (wss)  │
└──────────┘                      └─────────────────┘    └──────────────────┘
```

**Flow**: `useTts.speak(text, lang)` → check IndexedDB → miss → `GET /api/tts` → `EdgeTtsService` checks disk cache → miss → `EdgeTtsClient` opens WebSocket → receives MP3 chunks → saves to disk → returns bytes → frontend saves to IndexedDB → plays `<audio>`.

**Cache keys**: Server: `SHA256(text+voice+rate)[:16].mp3`. Client: `{lang}:{SHA256(text)[:16]}`.

## PDF Content Quality Pipeline

Self-improving cleanup for PDF-extracted books. Heuristics (PdfPig + the
post-processing chain) hit ~70-75%; the gap to ~90% is semantic — running
headers in body, fragmented paragraphs, unmerged line-wrap hyphens, inlined
footnotes. The pipeline closes it with a gated Claude pass, and logs every fix
so the deterministic processors can ratchet up over time and the Claude
dependency shrinks. Full design: [`docs/05-features/feat-0007-pdf-content-quality.md`](../05-features/feat-0007-pdf-content-quality.md).

### Synchronous path — ingest

```
┌──────────┐    ┌──────────────────┐    ┌──────────────────────────────────────┐
│  Upload  │───►│ POST /me/books/  │───►│ Worker — UserIngestionService         │
│   PDF    │    │     upload       │    │   PdfPig extract                      │
└──────────┘    └──────────────────┘    │   Spelling→Hyphenation→Typography→    │
                                        │   Semantic→Linter   ◄── ratchet lands │
                                        │   ChapterContentQualityAnalyzer       │
                                        │   → ContentQualityScore (0-100) per ch│
                                        │   TryQueueQualityJobAsync             │
                                        └──────────────────────────────────────┘
                                                       │
                       ┌───────────────────────────────┴─────────────────┐
                       ▼                                                 ▼
              ┌────────────────┐                               ┌──────────────────┐
              │   user_books   │                               │ book_quality_jobs│
              │  status=Ready  │   (reader can open it now)   │  status=Queued   │
              └────────────────┘                               └──────────────────┘
```

Book is readable immediately at heuristic quality (~70-75%). Phase 3 cleanup
runs asynchronously and refines flagged chapters in place.

### Asynchronous path — cleanup

```
┌──────────────────────────────────┐
│ quality-poller.service (systemd) │     polls every 30s
│ infra/scripts/quality-poll.sh    │     claude CLI on host (Max sub)
└──────────────────────────────────┘
                │
                ▼  claim Queued BookQualityJob
┌───────────────────────────────────────────────────────────────────────────┐
│ Phase 1 — validate chapter STRUCTURE                                       │
│   claude -p → ISSUES_JSON  (empty / fragment / giant / placeholder title) │
├───────────────────────────────────────────────────────────────────────────┤
│ Phase 2 — apply structure fixes via internal API                           │
│   DELETE / PUT(rename) / POST(merge)   /internal/.../chapters/{n}         │
├───────────────────────────────────────────────────────────────────────────┤
│ Phase 3 — content cleanup (gated by per-chapter ContentQualityScore)       │
│                                                                            │
│   for each chapter where score < CONTENT_QUALITY_THRESHOLD:                │
│       GET  /internal/.../chapters/{n}/content   ── messy HTML              │
│       claude -p (preserve verbatim, fix structure only)                    │
│       pdf-cleanup-gate.py: word-multiset diff                              │
│           ACCEPT → PUT cleaned + write (messy→clean) pair to dataset       │
│           REJECT → keep original, write rejected pair                      │
└───────────────────────────────────────────────────────────────────────────┘
                │
                ▼
        data/pdf-cleanup-dataset/   ──►  manual study (Slice 5)
                                        ──►  new processors land in the
                                             Semantic / Linter chain above
                                             — Claude usage trends down.
```

### Components

| Piece | Where | Role |
|-------|-------|------|
| `ChapterContentQualityAnalyzer` | `backend/src/Extraction/.../Quality/` | Deterministic 0-100 score + issue codes — the gate that decides which chapters reach the LLM |
| `BookQualityJob` | DB entity | Tracks Phase 1-2 (`IssuesFound/Fixed`) and Phase 3 (`ContentChaptersCleaned/Rejected/Skipped`) |
| `quality-poll.sh` | host systemd | Three-phase orchestrator, calls `claude` CLI |
| `pdf-cleanup-gate.py` | host | Preservation gate — strips whitespace + hyphens, rejects hallucination (>3% novel tokens) or over-deletion (<70% retention) |
| Internal chapter endpoints | API | `GET .../chapters/{n}/content` + `PUT .../chapters/{n}` with `{html}` — single source of truth for chapter HTML |
| `data/pdf-cleanup-dataset/` | host | Append-only pair log — fuel for the heuristic ratchet |

### Configuration

| Knob | Default | Effect |
|---|---|---|
| `CONTENT_CLEANUP_ENABLED` (`.env`) | `false` | Master switch — Phase 3 no-op when off |
| `CONTENT_QUALITY_THRESHOLD` (`.env`) | `60` | Chapters scoring below this go through Claude. 60 ≈ obviously broken only |
| `CLEANUP_TIMEOUT` (`.env`) | `1500` (s) | Per-chapter Claude budget; 20k-word chapters hit ~15-20 min |
| `quality.autoQueueForUserBooks` (`admin_settings`) | `false` | Auto-enqueue a `BookQualityJob` after every user-book ingest |

Setup: `make quality-poll-setup` (one-time host systemd install).

## See Also

- [Multisite](multisite.md) — Host resolution and data isolation
- [ADR-006: Modular Monolith](adr/006-modular-monolith.md)
- [Frontend](frontend.md) — Monorepo structure
