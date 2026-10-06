# How a book moves through TextStack

The runtime view. [README.md](README.md) lists the parts; this file shows how requests move
between them, one diagram per scenario (C4 "dynamic" view). Verified against code on 2026-10-06.

## The map

One API, one worker, one Postgres, three clients and an MCP bridge. Queues are Postgres tables
that a worker polls; there is no broker. Everything runs on one home server behind a Cloudflare
tunnel, and all ports bind to `127.0.0.1` — nginx is the only way in.

```mermaid
flowchart LR
    subgraph internet["Public internet"]
        web["Web SPA<br/>React 19 · IndexedDB"]
        mob["Mobile<br/>Expo · SQLite"]
        ext["Chrome extension<br/>clip · device flow"]
        mcpc["MCP clients<br/>claude.ai · ChatGPT"]
        bot["Search crawlers"]
    end

    cf["Cloudflare<br/>DNS · TLS · tunnel"]

    subgraph home["Home server · ports on 127.0.0.1"]
        nginx["nginx :80 · only ingress<br/>bots → dist/ssg, humans → SPA"]
        api["api :8080<br/>ASP.NET Core · .NET 10<br/>REST · OAuth 2.1 · hosted jobs"]
        mcp["mcp-server :8090<br/>21 tools · HTTP bridge"]
        worker["worker<br/>ingestion · enrichment · cleanup"]
        ssg["ssg-worker<br/>Node · Puppeteer"]
        pollers["host pollers<br/>systemd · SEO, quality"]
        db[("Postgres 16<br/>FTS · pgvector<br/>queues = tables")]
        fs[("data/storage<br/>uploads · covers<br/>+ tts/explain caches")]
        ollama["Ollama<br/>gemma · local LLM"]
    end

    subgraph third["Third parties"]
        openai["OpenAI<br/>gpt-4.1 · embeddings"]
        tts["Edge TTS<br/>WebSocket"]
        mail["Resend · Google · Apple"]
        claude["Claude CLI<br/>Max plan"]
    end

    web & mob & ext & mcpc & bot -->|HTTPS| cf
    cf -->|tunnel| nginx
    nginx -->|"/api, /oauth"| api
    nginx -->|/mcp| mcp
    mcp -->|"HTTP, forwards bearer"| api
    api -->|EF Core| db
    worker -->|polls ingestion jobs| db
    ssg -->|polls ssg_rebuild_jobs| db
    ssg -->|renders SPA pages| api
    pollers -->|"/internal, loopback"| api
    api & worker --> fs
    api & worker -->|HTTP| ollama
    api & worker -->|HTTPS| openai
    api -->|WSS| tts
    api -->|HTTPS| mail
    pollers -->|exec| claude
```

Not drawn: admin SPA (`textstack.dev`), migrator, Sentry, IndexNow, Aspire dashboard.

## 1. Upload a book

```mermaid
sequenceDiagram
    autonumber
    actor U as Reader
    participant api
    participant fs as data/storage
    participant db as Postgres
    participant wk as worker
    participant ai as OpenAI / Ollama

    U->>api: POST /api/me/books/upload
    api->>api: check quota (entitlements tier)
    api->>fs: save original file
    api->>db: insert UserBook + UserIngestionJob (queued)
    api-->>U: 202, book is processing
    loop every 5 s
        wk->>db: take next queued job
    end
    wk->>fs: read file
    wk->>wk: extract chapters (EPUB / PDF / HTML)
    wk->>db: insert chapters (trigger fills search_vector)
    wk->>ai: EnrichmentAgent: genre, year, description
    Note over wk,ai: OpenAI first, falls back to Ollama on error or budget
```

- The upload request does no parsing. It saves bytes and a row, then returns — slow work is in the worker.
- The queue is a table (`user_ingestion_jobs`; the admin catalog uses `ingestion_jobs`). Same worker, `IngestionWorker`.
- Search needs no indexer: a DB trigger keeps `search_vector` current.

## 2. Read a chapter

```mermaid
sequenceDiagram
    autonumber
    actor U as Reader
    participant c as Web / Mobile
    participant api
    participant db as Postgres
    participant cache as disk cache
    participant ext as Edge TTS / OpenAI

    U->>c: open chapter
    alt mobile, chapter on the phone
        c->>c: read SQLite first, render
    end
    c->>api: GET /api/books/{slug}/chapters/{chapterSlug}
    api->>db: read chapter html
    api-->>c: chapter (mobile refreshes its SQLite row in place)
    c->>api: PUT progress
    U->>c: listen / translate / explain
    c->>api: /api/tts, /api/translate, /api/explain
    api->>cache: SHA256 key hit?
    alt miss
        api->>ext: generate
        api->>cache: store (30 d)
    end
    api-->>c: audio / text
```

- Mobile is offline-first: it renders from SQLite and never waits for the network.
- Web keeps chapters in IndexedDB only for books you downloaded.
- Every paid or slow call (TTS, translate, explain) is behind a disk cache, so a repeat costs nothing.

## 3. Claude via MCP

```mermaid
sequenceDiagram
    autonumber
    participant cl as claude.ai
    participant mcp as mcp-server
    participant api
    participant db as Postgres
    actor U as Reader

    cl->>mcp: POST /mcp (no token)
    mcp-->>cl: 401 + WWW-Authenticate (resource metadata)
    cl->>api: OAuth 2.1: register, /oauth/authorize (PKCE)
    api->>U: consent page /en/oauth/consent
    U-->>api: approve
    cl->>api: POST /oauth/token
    api-->>cl: tso_ access + tsr_ refresh (stored hashed)
    cl->>mcp: tool call save_my_highlight + Bearer tso_
    mcp->>api: POST /api/me/... with the same bearer
    api->>db: resolve token by hash, write highlight (max 200 per book)
    api-->>mcp: 200
    mcp-->>cl: tool result
```

- The bridge holds no state and no secrets. It only forwards the bearer; the API checks it.
- Tokens are stored as hashes, so a DB leak does not leak working tokens.
- Assistant writes have their own ceiling (200 highlights per book) and a per-user rate limit.

## 4. Bots and SEO

```mermaid
sequenceDiagram
    autonumber
    participant src as admin / periodic job / nightly backup
    participant db as Postgres
    participant ssg as ssg-worker
    participant api
    participant ng as nginx
    actor bot as Crawler

    src->>db: insert ssg_rebuild_jobs row
    loop every 5 s
        ssg->>db: take next job
    end
    ssg->>api: GET /ssg/routes
    ssg->>ssg: Puppeteer renders each SPA page (SPA calls api) into dist/ssg-new
    ssg->>ssg: swap ssg-new → ssg, ping IndexNow
    bot->>ng: GET /en/books/dracula/
    ng-->>bot: prerendered HTML (X-SEO-Render: ssg)
```

- Bots get static HTML, humans get the SPA. So a browser check cannot see what Google sees — use `curl -I`.
- The swap is atomic: the site never serves a half-built folder.

## 5. Background AI

```mermaid
sequenceDiagram
    autonumber
    participant p as systemd pollers (host)
    participant api
    participant db as Postgres
    participant cli as Claude CLI

    p->>api: POST /internal/seo/jobs/claim (loopback)
    api->>db: claim jobs (FOR UPDATE SKIP LOCKED)
    api-->>p: jobs + context
    p->>cli: write SEO text / clean PDF chapter
    cli-->>p: output
    p->>p: validate (JSON schema, word-diff gate)
    p->>api: POST /internal/.../apply
    api->>db: save result
```

- The pollers run on the host, not in Docker, because the Claude CLI uses the owner's Max plan.
- `/internal` is reachable only on loopback; nginx blocks `/api/internal` from the internet.
- Other background work runs as hosted services in api and worker: metadata backfill, guest
  cleanup, vocabulary cap promotion, drift detection, continuous evals. See [README.md](README.md#background-work).

## Trust boundaries

| Who | How they prove identity | Where it is checked |
|-----|-------------------------|---------------------|
| Web / mobile users | JWT access (60 min) + rotating refresh. Google, Apple, email or guest | Endpoints call `GetUserId` |
| Claude, ChatGPT | OAuth 2.1 + PKCE, hashed `tso_`/`tsr_` tokens, scope `library` | API (`McpKeyAuth`); the bridge only forwards |
| Extension, stdio MCP | Device-flow JWT or `tsk_` connect key | API (`McpKeyAuth`) |
| Admin | Separate `admin_access_token` cookie | `AdminAuthMiddleware` on `/admin/*` |
| Host pollers | Loopback only | nginx blocks `/api/internal` |
