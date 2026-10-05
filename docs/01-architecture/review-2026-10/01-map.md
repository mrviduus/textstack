# 01 — System map (as built, 2026-10-04)

Everything below was read from code and config, not from docs. Main sources:
`textstack.sln`, `backend/src/**/*.csproj`, `backend/src/Api/Program.cs`,
`backend/src/Api/Extensions/ServiceCollectionExtensions.*.cs`, `backend/src/Worker/Program.cs`,
`docker-compose.yml`, `docker-compose.gpu.yml`, `infra/nginx/textstack.conf`,
`.github/workflows/*.yml`, `infra/systemd/*.service`, `infra/scripts/*.sh`, `apps/*`, `packages/*`.

## 1. C4 L1 — System context

```mermaid
flowchart LR
    reader["Reader<br/>web SPA + Android/iOS app"]
    admin["Owner / admin<br/>textstack.dev"]
    assistant["AI assistant<br/>Claude / ChatGPT via MCP"]
    crawler["Search crawlers<br/>Google, Bing, Yandex"]

    TS(["TextStack<br/>library + reader + vocab SRS + MCP bridge"])

    openai["OpenAI<br/>gpt-4.1-nano/mini, embeddings"]
    edge["Edge TTS<br/>speech.platform.bing.com"]
    resend["Resend<br/>email"]
    idp["Google / Apple<br/>sign-in"]
    olib["OpenLibrary<br/>metadata tool"]
    se["GitHub API<br/>Standard Ebooks repos"]
    sentry["Sentry"]
    cf["Cloudflare<br/>DNS + TLS + tunnel"]
    indexnow["IndexNow<br/>api.indexnow.org, yandex"]
    claude["Claude CLI<br/>on host, owner Max plan"]
    gh["GitHub Actions"]
    eas["Expo EAS<br/>build, update, Play submit"]

    reader -->|HTTPS| cf
    admin -->|HTTPS| cf
    assistant -->|"HTTPS /mcp, OAuth or tsk_ key"| cf
    crawler -->|HTTPS| cf
    cf -->|tunnel| TS

    TS -->|HTTPS| openai
    TS -->|WSS| edge
    TS -->|HTTPS| resend
    TS -->|"token verify"| idp
    TS -->|HTTPS| olib
    TS -->|HTTPS| se
    TS -->|HTTPS| sentry
    TS -->|"HTTPS ping"| indexnow
    TS -->|"exec, SEO + quality text"| claude
    gh -->|"self-hosted runner deploy, backup"| TS
    eas -->|"AAB + OTA bundles"| reader
```

Ollama is in-house (a container), so it is in L2, not here.
Outbound hosts in backend code: `grep -rhoE "https://..." backend/src` —
`openlibrary.org`, `api.resend.com`, `speech.platform.bing.com`, `appleid.apple.com`,
`api.github.com` (`Application/TextStack/StandardEbooksSyncService.cs:32`).
IndexNow: `apps/web/scripts/ssg-worker.mjs:289`.

## 2. C4 L2 — Containers

```mermaid
flowchart TB
    subgraph clients["Clients"]
        web["Web SPA<br/>React + Vite<br/>apps/web"]
        mob["Mobile app<br/>Expo 57, SQLite offline<br/>apps/mobile"]
        adm_ui["Admin SPA<br/>apps/admin"]
        mcpc["MCP client<br/>Claude / ChatGPT"]
        bot["Crawler"]
    end

    subgraph host["Home server"]
        nginx["nginx :80<br/>infra/nginx/textstack.conf"]
        subgraph docker["docker compose"]
            api["api :8080<br/>ASP.NET Core<br/>+ 9 hosted services"]
            worker["worker<br/>.NET generic host<br/>ingestion, enrichment, podcasts"]
            mcp["mcp-server :8090<br/>profile mcp<br/>stateless MCP to HTTP bridge"]
            ssg["ssg-worker<br/>Node + Puppeteer<br/>polls ssg_rebuild_jobs 5s"]
            admc["admin :81<br/>static admin build"]
            mig["migrator<br/>EF migrations, one-shot"]
            ollama["ollama :11434<br/>gemma4:e2b, GPU overlay"]
            db[("db<br/>pgvector/pgvector:pg16")]
            aspire["aspire-dashboard<br/>profile observability"]
        end
        subgraph sysd["systemd --user"]
            pub["seo-publish-poller"]
            bf["seo-backfill-poller"]
            qp["quality-poller"]
        end
        subgraph disk["./data on host"]
            st[("storage/<br/>books, covers, podcasts")]
            caches[("tts-cache, explain-cache,<br/>translate-cache")]
            dist[("apps/web/dist<br/>SPA + ssg/")]
        end
    end

    web -->|"HTTPS /api"| nginx
    mob -->|"HTTPS /api, Bearer JWT"| nginx
    adm_ui -->|"HTTPS textstack.dev/api"| nginx
    mcpc -->|"HTTPS /mcp SSE, Bearer"| nginx
    bot -->|HTTPS| nginx

    nginx -->|"HTTP /api/ to /"| api
    nginx -->|"HTTP /mcp, /.well-known/oauth-protected-resource"| mcp
    nginx -->|"HTTP textstack.dev /"| admc
    nginx -->|"file: SSG html for bots, SPA for humans"| dist

    mcp -->|"HTTP api:8080, relays Bearer"| api
    api -->|"TCP 5432 EF Core + Dapper FTS"| db
    worker -->|"TCP 5432 EF Core"| db
    ssg -->|"TCP 5432 job table"| db
    ssg -->|"HTTP /ssg/routes + page data"| api
    ssg -->|"writes ssg/ atomic swap"| dist
    mig -->|"TCP 5432 DDL"| db
    api -->|"HTTP distractors, hint"| ollama
    worker -->|"HTTP metadata fallback"| ollama
    api -->|"file IO"| st
    api -->|"file IO"| caches
    worker -->|"file IO"| st
    api -.->|OTLP| aspire
    worker -.->|OTLP| aspire

    pub -->|"psql via docker exec + HTTP /internal"| api
    bf -->|"HTTP /internal/seo/*"| api
    qp -->|"psql + HTTP localhost:8080"| api
```

Notes:
- Ports bind `127.0.0.1` only (`docker-compose.yml`); nginx is the only public listener, reached via Cloudflare tunnel.
- `mcp-server` has no DB/OpenAI access; it only calls the API (`backend/src/Ai/TextStack.Ai.Mcp/TextStack.Ai.Mcp.csproj` references only `Contracts`).
- Pollers shell out to the `claude` CLI on the host (`infra/scripts/seo-generate.sh`, `seo-backfill-generate.sh`, `quality-poll.sh`).

## 3. C4 L3 — API components

```mermaid
flowchart TB
    subgraph pipeline["Middleware, Program.cs:142-316"]
        p1["ForwardedHeaders"] --> p2["Cors"] --> p3["ExceptionMiddleware"] --> p4["StaticFiles /storage"] --> p5["/health, /health/ready"] --> p6["SiteContext"] --> p7["LanguageContext"] --> p8["Routing"] --> p9["McpKeyAuth tsk_/tso_"] --> p10["RateLimiter"] --> p11["GuestActivity"] --> p12["AdminAuth on /admin/*"]
    end

    subgraph eps["Endpoint groups, Api/Endpoints"]
        e_pub["Public catalog<br/>Books, Authors, Genres, Search,<br/>Site, Seo, Ssg, Podcast public"]
        e_auth["Identity<br/>Auth, DeviceAuth, OAuth,<br/>McpKeys, McpManifest, Account, Profile"]
        e_me["Reader data<br/>UserData, Highlights, Insights,<br/>ChapterReview, UserBooks, LibraryShelves,<br/>Collections, ReadingTracking"]
        e_lang["Language<br/>Translation, Explain, Tts,<br/>Vocabulary + Lookups/Pending/Clusters, Tutor"]
        e_adm["Admin<br/>Admin, Authors, Genres, SsgRebuild,<br/>AutoPublish, SeoBackfill, Lint, Settings,<br/>Diagnostics, BookQuality, AiQuality"]
        e_int["Internal, docker net only<br/>Internal, InternalSeo"]
    end

    subgraph app["Application, backend/src/Application"]
        a_auth["Auth, AdminAuth, Entitlements"]
        a_books["Books, UserBooks, Library,<br/>Collections, ChapterReview"]
        a_vocab["Vocabulary, ReadingTracking"]
        a_seo["Seo, SsgRebuild, TextStack import,<br/>Reprocessing, Admin"]
        a_ai["LLM, Ai, Agents, Tools"]
    end

    subgraph libs["Libraries"]
        l_srch["TextStack.Search<br/>Postgres FTS, Dapper"]
        l_voc["TextStack.Vocabulary<br/>SrsEngine, DistractorGenerator"]
        l_tts["TextStack.Tts<br/>EdgeTtsService"]
        l_llm["TextStack.Ai.Llm<br/>ModelGateway, TracingDecorator,<br/>OpenAi/Ollama clients"]
        l_inf["Infrastructure<br/>AppDbContext, LocalFileStorage,<br/>ResendEmailService"]
    end

    pipeline --> eps
    e_pub --> a_books
    e_pub --> l_srch
    e_auth --> a_auth
    e_me --> a_books
    e_me --> a_vocab
    e_lang --> a_vocab
    e_lang --> l_voc
    e_lang --> l_tts
    e_lang --> l_llm
    e_adm --> a_seo
    e_adm --> a_ai
    e_int --> a_seo
    app --> l_inf
    a_ai --> l_llm
```

Endpoint registration: `backend/src/Api/Program.cs:318-359` (42 `Map*Endpoints` calls).
CLI verbs also live in `Program.cs:362-640`: `import-textstack`, `optimize-images`, `create-admin`,
`backfill-vocabulary-embeddings`, `cluster-vocabulary`.

### Hosted services: which process runs what

| Process | Hosted service | File | Notes |
|---|---|---|---|
| api | `EdgeTtsService` (startup cache cleanup) | `backend/src/Tts/TextStack.Tts/EdgeTtsService.cs`, reg. `Api/Extensions/ServiceCollectionExtensions.Content.cs:75` | |
| api | `SsgPeriodicRebuildWorker` | `backend/src/Api/Services/SsgPeriodicRebuildWorker.cs` | enqueues SSG jobs |
| api | `AutoRetireSweeperWorker` | `backend/src/Api/Services/AutoRetireSweeperWorker.cs` | vocab F4 |
| api | `DailyCapReconcilerWorker` | `backend/src/Api/Services/DailyCapReconcilerWorker.cs` | pending → SRS |
| api | `WordFrequencyLoaderWorker` | `backend/src/Api/Services/WordFrequencyLoaderWorker.cs` | one-shot seed |
| api | `ClusterCandidateBuilderWorker` | `backend/src/Api/Services/ClusterCandidateBuilderWorker.cs` | 24 h |
| api | `ConceptClusteringWorker` | `backend/src/Api/Services/ConceptClusteringWorker.cs` | weekly |
| api | `ContinuousEvalWorker` | `backend/src/Api/Services/ContinuousEvalWorker.cs` | off by default |
| api | `DriftDetectionWorker` | `backend/src/Api/Services/DriftDetectionWorker.cs` | off by default |
| worker | `AiProviderReadinessCheck` | `backend/src/Worker/Services/AiProviderReadinessCheck.cs` | must be first |
| worker | `IngestionWorker` | `backend/src/Worker/Services/IngestionWorker.cs` | polls 5 s, admin + user uploads |
| worker | `MetadataEnrichmentWorker` | `backend/src/Worker/Services/MetadataEnrichmentWorker.cs` | sweep Pending/stale |
| worker | `PodcastWorker` | `backend/src/Worker/Services/PodcastWorker.cs` | LLM + TTS + ffmpeg |
| worker | `GuestCleanupWorker` | `backend/src/Worker/Services/GuestCleanupWorker.cs` | 2 h / 30 d |
| worker | `AdminRefreshTokenCleanupWorker` | `backend/src/Worker/Services/AdminRefreshTokenCleanupWorker.cs` | daily |
| worker | `HeartbeatWorker` | `backend/src/Worker/Services/HeartbeatWorker.cs` | docker healthcheck file |
| worker | `MetadataBackfillWorker` | `backend/src/Worker/Services/MetadataBackfillWorker.cs` | one-shot heal |
| worker | `TextStackWatcher` | `backend/src/Worker/Services/TextStackWatcher.cs` | only if `TextStack:EnableWatcher` |

Not a hosted service but background work in the API: vocabulary enrichment is a
`Task.Run` fire-and-forget inside the request handler (`Api/Endpoints/VocabularyEndpoints.cs:292`).

## 4. Backend project dependency graph

```mermaid
flowchart BT
    Domain["Domain<br/>pkg: Npgsql"]
    Contracts["Contracts"]
    Extraction["TextStack.Extraction<br/>VersOne.Epub, PdfPig, PDFtoImage, ImageSharp"]
    Search["TextStack.Search<br/>Dapper, Npgsql"]
    Tts["TextStack.Tts"]
    Vocab["TextStack.Vocabulary<br/>HdbscanSharp"]
    AiCore["Ai.Core<br/>Sentry"]
    AiLlm["Ai.Llm<br/>OpenAI, M.E.AI, Sentry"]
    AiTools["Ai.Tools<br/>JsonSchema.Net"]
    AiAgents["Ai.Agents"]
    AiEvals["Ai.Evals<br/>M.E.AI.Evaluation"]
    AiEvalSuite["Ai.EvalSuite"]
    AiMcp["Ai.Mcp<br/>ModelContextProtocol"]
    App["Application<br/>EF Core, Npgsql.EFCore, BCrypt,<br/>Google.Apis.Auth, JWT"]
    Infra["Infrastructure<br/>EF Core, Pgvector, OTel incl. AspNetCore,<br/>ImageSharp, Sentry"]
    Api["Api<br/>OpenApi, Scalar, OTel, Sentry.AspNetCore"]
    Worker["Worker<br/>Hosting, OTel, Sentry"]

    Vocab --> Domain
    App --> Domain
    App --> Contracts
    App --> Extraction
    App --> Vocab
    App --> AiCore
    App --> AiLlm
    App --> AiAgents
    AiLlm --> AiCore
    AiTools --> AiCore
    AiAgents --> AiCore
    AiAgents --> AiTools
    AiEvals --> AiCore
    AiEvalSuite --> AiEvals
    AiEvalSuite --> AiLlm
    AiEvalSuite --> AiTools
    AiEvalSuite --> App
    AiMcp --> Contracts
    Infra --> Domain
    Infra --> App
    Api --> App
    Api --> Infra
    Api --> Contracts
    Api --> Domain
    Api --> Search
    Api --> Tts
    Api --> Vocab
    Api --> AiEvalSuite
    Api --> AiTools
    Api --> AiAgents
    Worker --> App
    Worker --> Infra
    Worker --> Contracts
    Worker --> Domain
    Worker --> Extraction
    Worker --> Tts
```

Layering findings (all from csproj or code):

| # | Finding | Evidence |
|---|---|---|
| L1 | Domain is not framework-free: depends on `Npgsql` for `NpgsqlTsVector` | `backend/src/Domain/Domain.csproj`, `backend/src/Domain/Entities/Chapter.cs:1,31` |
| L2 | Application references the EF Npgsql provider and a concrete LLM implementation (`Ai.Llm`), and wires `OpenAiLlmClient`/`OllamaLlmClient` itself — composition-root work in the Application layer | `backend/src/Application/Application.csproj`, `backend/src/Application/DependencyInjection.cs:158-176` |
| L3 | AI library `Ai.EvalSuite` depends upward on `Application`; `Api` depends on `Ai.EvalSuite` — an eval harness ships in the production API | `backend/src/Ai/TextStack.Ai.EvalSuite/TextStack.Ai.EvalSuite.csproj`, `backend/src/Api/Api.csproj` |
| L4 | Infrastructure carries ASP.NET Core instrumentation (`OpenTelemetry.Instrumentation.AspNetCore`) though Worker is not a web host | `backend/src/Infrastructure/Infrastructure.csproj` |
| L5 | Worker builds its own DbContext wiring (not the shared `AddTextStackPersistence`) with a hard-coded fallback connection string incl. password `changeme` | `backend/src/Worker/Program.cs:25-35` |

Not violations: `Ai.Mcp → Contracts` only (clean bridge); `Search` is standalone (raw SQL).

## 5. Deployment

```mermaid
flowchart LR
    dev["git push main"] --> ghci["GitHub-hosted CI<br/>ci.yml: build, lint, migrations,<br/>integration, e2e"]
    dev --> ghdep["deploy.yml<br/>self-hosted runner on server"]
    dev -->|"paths apps/mobile, packages, lockfile"| ota["mobile-ota.yml<br/>eas update, Android"]
    manual["workflow_dispatch"] --> rel["mobile-release.yml<br/>eas build / submit / update"]
    rel --> play["Google Play<br/>internal, closed, production 10%"]
    ota --> easu["EAS Update CDN"]
    easu --> phone["Installed app"]
    play --> phone

    subgraph server["Home server, Linux, x86_64, NVIDIA GPU"]
        cfd["cloudflared tunnel"]
        ngx["nginx :80"]
        dc["docker compose<br/>-f docker-compose.yml -f docker-compose.gpu.yml<br/>--profile mcp"]
        sd["systemd --user<br/>seo-publish, seo-backfill, quality pollers"]
        bk[("~/backups/textstack<br/>same disk")]
    end

    ghdep -->|"1 pg_dump pre-deploy<br/>2 git pull<br/>3 snapshot ssg, vite build, restore<br/>4 compose up --build<br/>5 sync nginx conf<br/>6 /internal/ssg/rebuild-all<br/>7 wait + validate SSG<br/>8 restart 2 pollers"| dc
    ghdep --> bk
    cron["backup.yml 03:00 UTC<br/>self-hosted"] -->|"pg_dump + tar storage, keep 5, restore-verify"| bk
    hc["health-check.yml every 5 min<br/>GitHub-hosted"] -->|HTTPS| cf["Cloudflare"]
    cf --> cfd --> ngx --> dc
    eval_cf["Users"] --> cf
```

Evidence: `.github/workflows/deploy.yml:42-456`, `.github/workflows/backup.yml:5,16,27-49`,
`.github/workflows/mobile-ota.yml:47-60`, `.github/workflows/mobile-release.yml:23-130`,
`.github/workflows/health-check.yml:19-44`, `infra/systemd/*.service`.
cloudflared is not in the repo (only described in `docs/03-ops/deployment.md`).

## 6. Key runtime flows

### 6a. Upload → ingestion → read

```mermaid
sequenceDiagram
    autonumber
    participant C as Web/Mobile
    participant A as api
    participant S as storage disk
    participant D as db
    participant W as worker
    participant L as OpenAI / Ollama
    C->>A: POST /me/books/upload multipart
    A->>A: entitlement check, quota
    A->>S: write original
    A->>D: UserBook, UserBookFile, UserIngestionJob queued
    A-->>C: 200 bookId
    loop every 5 s
        W->>D: claim queued job
    end
    W->>S: read original
    W->>W: Extraction EPUB/PDF, pipeline rules
    W->>D: UserChapters, search_vector by trigger
    W->>L: EnrichmentAgent, fallback Ollama metadata
    W->>D: genre, year, description
    C->>A: GET /me/books/id/chapters/slug or /file for PDF
    A-->>C: html or original bytes, Range
```

`Worker/Services/IngestionWorker.cs:12`, `Worker/Services/UserIngestionService.cs`,
`Worker/Services/EnrichmentAgentMetadataGenerator.cs`, `Api/Endpoints/UserBooksEndpoints.cs`.

### 6b. Word tap → explain/translate → save → enrichment → review

```mermaid
sequenceDiagram
    autonumber
    participant C as Reader
    participant A as api
    participant F as file cache
    participant O as OpenAI
    participant OL as Ollama
    participant D as db
    C->>A: POST /explain or /translate
    A->>F: SHA256 key lookup
    alt miss
        A->>O: ILlmService gateway, traced to llm_trace
        A->>F: store 30 d
    end
    A-->>C: text
    C->>A: POST /me/vocabulary/words
    A->>D: caps check, insert VocabularyWord or Pending or Lookup
    A-->>C: 200
    Note over A: Task.Run fire-and-forget, own DI scope
    A->>O: embedding of word + sentence
    A->>OL: distractors, hint, explanation
    A->>D: update word
    C->>A: GET /me/vocabulary/review
    A->>D: due cards
    A-->>C: multiple_choice cards
    C->>A: POST /me/vocabulary/review
    A->>D: SrsEngine stage update, VocabularyReview
```

`Api/Endpoints/ExplainEndpoints.cs:33,63`, `Api/Endpoints/TranslationEndpoints.cs:15,33`,
`Api/Endpoints/VocabularyEndpoints.cs:255-320`, `Vocabulary/TextStack.Vocabulary/DistractorGenerator.cs`.

### 6c. MCP request

```mermaid
sequenceDiagram
    autonumber
    participant M as Claude / ChatGPT
    participant N as nginx
    participant B as mcp-server
    participant A as api
    participant D as db
    M->>N: POST /mcp no token
    N->>B: proxy
    B-->>M: 401 WWW-Authenticate resource_metadata
    M->>N: GET /.well-known/oauth-authorization-server
    N->>A: proxy
    M->>A: /oauth/authorize, web consent, /oauth/token
    A->>D: OAuthGrant
    A-->>M: tso_ access + refresh
    M->>N: POST /mcp Bearer tso_ or tsk_
    N->>B: proxy SSE, relays Authorization
    B->>A: HTTP api:8080 /me/... same Bearer
    A->>A: McpKeyAuthMiddleware resolves user, then RateLimiter
    A->>D: query
    A-->>B: JSON
    B-->>M: tool result
```

`backend/src/Ai/TextStack.Ai.Mcp/McpHosts.cs:173-179`, `Api/Middleware/McpKeyAuthMiddleware.cs:35-53`,
`Api/Endpoints/OAuthEndpoints.cs`, `infra/nginx/textstack.conf:232-320`.

### 6d. SSG rebuild → crawler

```mermaid
sequenceDiagram
    autonumber
    participant T as Trigger
    participant A as api
    participant D as db
    participant S as ssg-worker
    participant P as Puppeteer
    participant FS as apps/web/dist
    participant N as nginx
    participant K as Crawler
    T->>A: admin, deploy rebuild-all, publish, periodic worker
    A->>D: insert ssg_rebuild_jobs
    loop every 5 s
        S->>D: poll queued job
    end
    S->>A: GET /ssg/routes
    S->>P: spawn prerender.mjs, local static server + API proxy
    P->>FS: write ssg-new
    S->>FS: rename ssg to ssg-old, ssg-new to ssg
    S->>D: job status
    S->>S: IndexNow ping if enabled
    K->>N: GET /en/books/slug
    N->>FS: is_bot then ssg file
    N-->>K: html, X-SEO-Render ssg
```

`apps/web/scripts/ssg-worker.mjs:62,99-133,289,370-375`, `apps/web/scripts/prerender.mjs:16,61-160`,
`infra/nginx/textstack.conf:343-385`.

## 7. Data stores

| Store | Location | Contents | Backed up? | Evidence |
|---|---|---|---|---|
| PostgreSQL 16 + pgvector | `./data/postgres-prod` (container `db`) | all entities (64 DbSets), FTS vectors, embeddings, llm_trace, job queues | **Yes**, daily + pre-deploy, keep 5, restore-verified, **same host** | `backup.yml:29,49`, `deploy.yml:46` |
| Book storage | `./data/storage` → `/storage` (api, worker) | originals, covers, podcast mp3 | **Yes**, daily tar, keep 5, same host | `backup.yml:34` |
| TTS cache | `./data/tts-cache` | mp3 by SHA256, 30 d, 1 GB | No (regenerable) | `docker-compose.yml` api volumes |
| Explain cache | `./data/explain-cache` | JSON by SHA256, 30 d | No (regenerable, costs OpenAI) | `ExplainEndpoints.cs:63` |
| Translate cache | `./data/translate-cache` | JSON by key | No (regenerable, costs OpenAI) | `TranslationEndpoints.cs:33` |
| TextStack import source | `./data/textstack` → api | source books for `import-textstack` | No | `docker-compose.yml` api volumes |
| Ollama models | `./data/ollama` | gemma4:e2b weights | No (re-pull) | `docker-compose.yml` ollama |
| SSG output | `apps/web/dist/ssg` | prerendered HTML | No (rebuilt; deploy snapshots it) | `deploy.yml:83-238` |
| PDF cleanup dataset | `data/pdf-cleanup-dataset` | quality-poller training pairs | No | `infra/scripts/quality-poll.sh:23` |
| Secrets | `.env` on server | DB, JWT, OpenAI, Resend, Sentry keys | No | not referenced in `backup.yml` |
| Mobile local | SQLite + `Paths.document/originals` + SecureStore | offline chapters, PDF originals (2 GB LRU), tokens | n/a (device) | `apps/mobile/src/lib/offlineDb.ts`, `originalFileCache.ts` |
| Web local | IndexedDB, localStorage | offline chapters, TTS audio, session queue | n/a | `apps/web/src/context/DownloadContext.tsx` |

## Gaps noticed while mapping

- **Health check never tests the API.** `health-check.yml:24,27` curls `https://textstack.app/health` and `textstack.dev/health`, but nginx has no `/health` location (`grep health infra/nginx/textstack.conf` is empty); on textstack.app it falls to `location /` → `try_files $uri /index.html` (`textstack.conf:385-389`) = SPA shell 200, on textstack.dev to the admin container. A dead API passes. Should be `/api/health`.
- **Backups live on the same disk as the data.** `backup.yml` and `deploy.yml:44` write only to `~/backups/textstack`; no rclone/S3/scp anywhere (`grep -i "rclone\|s3\|rsync" backup.yml Makefile` empty). Disk or host loss = total loss. `.env` not backed up either.
- **Vocabulary enrichment is fire-and-forget in the API.** `VocabularyEndpoints.cs:292` `Task.Run` — lost on every deploy/restart; no retry. Worker already has a claim/sweep pattern (`MetadataEnrichmentWorker`) that could own this.
- **API runs 9 hosted services** (`ServiceCollectionExtensions.HostedServices.cs:18-37` + `Content.cs:75`) while a dedicated Worker exists. Background CPU (clustering, HDBSCAN, evals) shares the 1 GB request process (`docker-compose.yml` api memory limit 1G).
- **Layering:** Domain → Npgsql (`Domain/Entities/Chapter.cs:31`); Application wires concrete OpenAI/Ollama clients (`Application/DependencyInjection.cs:158-176`); `Ai.EvalSuite → Application` and `Api → Ai.EvalSuite` (csproj).
- **Podcast feature is live but undocumented** in CLAUDE.md: `PodcastWorker` (`Worker/Program.cs:729`), `PodcastEndpoints.cs:20-22`, ffmpeg in `backend/Docker/Worker.Dockerfile:39`. Unclear if it fits the product thesis.
- **OTLP goes to a container deploy doesn't start.** api/worker export to `http://aspire-dashboard:18889` (`docker-compose.yml`), but aspire is `profiles: ["observability"]` and deploy runs only `--profile mcp` (`deploy.yml:278`). Either it was started by hand or exports fail silently.
- **quality-poller not restarted on deploy.** `infra/systemd/quality-poller.service` exists; `deploy.yml:455-456` restarts only seo-publish and seo-backfill pollers — it keeps running old script code after a deploy.
- **Host pollers bypass the API for DB access** (`psql` via `docker exec`, e.g. `quality-poll.sh`, `seo-backfill-poll.sh` uses `FOR UPDATE SKIP LOCKED`) — schema changes can break them with no compile-time or CI signal.
- **Worker fallback connection string with a password** `changeme` (`Worker/Program.cs:25-26`) — a missing env silently connects to localhost instead of failing fast (the API throws, `Api/Program.cs` "ConnectionStrings:Default is required").
- **Stale comments:** `Worker/Program.cs` "purge inactive guests every 6h" vs `GuestCleanupWorker.cs:15` `FromHours(2)`; `deploy.yml:363` says ssg-worker mount is `/app/dist` but compose mounts `/repo/apps/web/dist`; compose worker comment still cites `podcast.script` routing.
- **CLAUDE.md drift:** middleware order there puts RateLimiter before ExceptionMiddleware and omits `McpKeyAuthMiddleware` (real order `Program.cs:142-316`); lists `db` as `postgres:16` (real: `pgvector/pgvector:pg16`); omits `translate-cache` and the `quality-poller` unit.
- **Leftover data dirs** `data/dictionary-cache` (dictionary removed 2026-10-03) and `data/eval-meai`, `data/presale-books` exist locally with no compose mount — check prod for the same cruft.
- **Global `statement_timeout=10000`** on the DB server (`docker-compose.yml` db command) applies to migrator and pollers too (pg_dump resets it itself) — a long migration fails at 10 s unless it overrides it.
