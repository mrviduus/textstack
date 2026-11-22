# How a book moves through TextStack

The runtime view. [README.md](index.md) lists the parts; this file shows how requests move
between them, one diagram per scenario (C4 "dynamic" view). Updated for V2-only on 2026-11-17.

## The map

One API, one worker, one Postgres, three clients and an MCP bridge. Queues are Postgres tables
that a worker polls; there is no broker. Everything runs on one home server behind a Cloudflare
tunnel, and all ports bind to `127.0.0.1` — nginx is the only way in.

```mermaid
flowchart LR
    subgraph internet["Public internet"]
        web["Web SPA<br/>React 19 · IndexedDB"]
        mob["Mobile<br/>Expo · book files on the device"]
        ext["Chrome extension<br/>clip · device flow"]
        mcpc["MCP clients<br/>claude.ai · ChatGPT"]
    end

    cf["Cloudflare<br/>DNS · TLS · tunnel"]

    subgraph home["Home server · ports on 127.0.0.1"]
        nginx["nginx :80 · only ingress<br/>SPA + reader frame"]
        api["api :8080<br/>ASP.NET Core · .NET 11<br/>REST · OAuth 2.1 · hosted jobs"]
        mcp["mcp-server :8090<br/>18 tools · HTTP bridge"]
        worker["worker<br/>chapter extraction · cleanup"]
        db[("Postgres 16 · textstack_v2<br/>queues = tables")]
        fs[("data/library · data/storage<br/>book files · covers<br/>+ tts/translate/explain caches")]
        ollama["Ollama<br/>gemma · local LLM"]
    end

    subgraph third["Third parties"]
        openai["OpenAI<br/>gpt-4.1"]
        tts["Edge TTS<br/>WebSocket"]
        mail["Resend · Google · Apple"]
    end

    web & mob & ext & mcpc -->|HTTPS| cf
    cf -->|tunnel| nginx
    nginx -->|"/api, /oauth"| api
    nginx -->|/mcp| mcp
    mcp -->|"HTTP, forwards bearer"| api
    api -->|Dapper| db
    worker -->|polls ingestion_jobs| db
    api & worker --> fs
    api & worker -->|HTTP| ollama
    api & worker -->|HTTPS| openai
    api -->|WSS| tts
    api -->|HTTPS| mail
```

Not drawn: admin shell (`textstack.dev`), migrator, Sentry, Aspire dashboard.

## 1. Upload a book

```mermaid
sequenceDiagram
    autonumber
    actor U as Reader
    participant c as Web / Mobile
    participant api
    participant fs as data/library
    participant db as Postgres
    participant wk as worker

    U->>c: pick a file
    c->>api: PUT /api/me/v2/books/{id} (metadata, sha256)
    api->>db: insert book + book_files row
    c->>api: PUT …/files/{fileId}/parts/{n} (one per part)
    c->>api: POST …/files/{fileId}/content (complete)
    api->>api: check parts against the file, check quota (entitlements tier)
    api->>fs: attach the bytes
    api->>db: enqueue ingestion_jobs (EPUB / PDF / HTML)
    loop every 5 s
        wk->>db: take next queued job
    end
    wk->>fs: read file
    wk->>db: extract chapters into book_chapters
```

- The reader never waits for the worker: it opens the file itself. `book_chapters` is transitional and
  feeds the MCP chapter tools and clips.
- The queue is a table (`ingestion_jobs`), one consumer, `IngestionWorker`.
- Sync protocol (revisions, `operation_id`, parts): [v2-sync-protocol.md](../internal/v2/v2-sync-protocol.md).

## 2. Read a book

Detailed behavior: [open a book and resume](../internal/v2/reader-open-resume.md).

```mermaid
sequenceDiagram
    autonumber
    actor U as Reader
    participant c as Web / Mobile
    participant api
    participant db as Postgres
    participant cache as disk cache
    participant ext as Edge TTS / OpenAI

    U->>c: open book
    alt mobile, file on the phone
        c->>c: open the retained file, render in the reader page
    else web
        c->>api: GET /api/me/v2/books/{id}/files/{fileId}/content
    end
    c->>api: PUT /api/me/v2/books/{id}/reading-state
    api->>db: write reading_state (revision)
    U->>c: listen / translate / explain
    c->>api: /api/tts, /api/translate, /api/explain
    api->>cache: SHA256 key hit?
    alt miss
        api->>ext: generate
        api->>cache: store
    end
    api-->>c: audio / text
```

- Mobile reads offline: the file and the local library live on the device; sync runs beside it.
- The reader is our foliate-js fork in a sandboxed page ([ADR-029](adr/ADR-029-foliate-for-v2-epub.md), [ADR-032](adr/ADR-032-one-engine-foliate-fork.md)).
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
    mcp->>api: PUT /api/me/v2/annotations/{id} with the same bearer
    api->>db: resolve token by hash, write highlight
    api-->>mcp: 200
    mcp-->>cl: tool result
```

- The bridge holds no state and no secrets. It only forwards the bearer; the API checks it.
- Tokens are stored as hashes, so a DB leak does not leak working tokens.
- Assistant writes have a per-user rate limit.

## 4. Background work

Hosted services in api and worker: chapter extraction, retention cleanup, the TTS cache sweep.
See [index.md](index.md#background-work).

## Trust boundaries

| Who | How they prove identity | Where it is checked |
|-----|-------------------------|---------------------|
| Web / mobile users | JWT access (60 min) + rotating refresh. Google, Apple, email or guest | Endpoints call `GetUserId` |
| Claude, ChatGPT | OAuth 2.1 + PKCE, hashed `tso_`/`tsr_` tokens, scope `library` | API (`McpKeyAuth`); the bridge only forwards |
| Extension, stdio MCP | Device-flow JWT or `tsk_` connect key | API (`McpKeyAuth`) |
| Admin | Separate `admin_access_token` cookie | `AdminAuthMiddleware` on `/admin/*` |
