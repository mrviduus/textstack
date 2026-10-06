# TextStack Documentation

Free book library with Kindle-like reader. EPUB/PDF upload, parsing, SEO pages, and offline reading.

**Live**: [textstack.app](https://textstack.app/) (public) · [textstack.dev](https://textstack.dev/) (admin)

## Quick Links

| Document | Description |
|----------|-------------|
| [CLAUDE.md](../CLAUDE.md) | AI assistant context (commands, key files, concepts) |
| [STATUS.md](STATUS.md) | **Where the project is right now** — in flight, known-broken, won't-do |
| [CHANGELOG.md](../CHANGELOG.md) | Release index — one line per change, by deploy date |
| [Incidents](incidents/README.md) | Postmortems: what broke, why it was invisible, what it taught |
| [Changelog archive](changelog-archive/) | The full write-up behind every changelog line |
| [Vision](00-vision/README.md) | Goals, principles, stack |
| [Architecture](01-architecture/README.md) | System design: services, projects, pipeline, external deps |
| [Delivery](01-architecture/delivery.md) | PR → images → deploy flow, external dependencies, secret controls |
| [Data model](01-architecture/data-model.md) | All entities by area + PII map |
| [Database](02-system/database.md) | Detailed schema of the core tables (partial) |
| API Docs | http://localhost:8080/scalar/v1 (live) |
| [Local Dev](03-ops/local-dev.md) | Docker, migrations |
| [Environment Variables](03-ops/environment-variables.md) | Complete env var reference |
| [Production Deployment](03-ops/deployment.md) | Cloudflare tunnel, nginx, Docker |
| [Backup & Restore](03-ops/backup.md) | `make backup`, GHA daily dump, restore drill |
| [Uptime Monitoring](03-ops/uptime-monitoring.md) | External probes + alert runbook |
| [Incident Runbook](03-ops/incident-runbook.md) | First-response for DB/worker/SSG/site outages |
| [infra/scripts/README](../infra/scripts/README.md) | Pollers (SEO publish, SEO backfill, quality) — what, install, logs |
| [infra/systemd/README](../infra/systemd/README.md) | User-level systemd units |
| [E2E Testing Guide](04-dev/e2e-guide.md) | Playwright setup, UI mode, troubleshooting |
| [LLM Provider Swap](04-dev/llm-provider-swap.md) | Swap the Ollama calls (distractors, metadata) for a hosted API |

## Core Features

| Feature | Description | Docs |
|---------|-------------|------|
| Reader | Kindle-like reading (settings, navigation, mobile) | [reader.md](05-features/reader.md) |
| Offline | IndexedDB caching, download manager | [offline-reading.md](05-features/offline-reading.md) |
| Auth | Google, Apple, email/password, guest sessions, JWT | [user-auth.md](05-features/user-auth.md), [ADR-014](01-architecture/adr/ADR-014-guest-sessions.md) |
| Search | PostgreSQL FTS (trigger-maintained `search_vector`) | [feat-0006](05-features/feat-0006-search-library.md) |
| Vocabulary | SRS vocab builder + Ollama LLM | [vocabulary-srs.md](05-features/vocabulary-srs.md) |
| Ingestion | EPUB/PDF extraction, admin + user uploads | [ingestion.md](02-system/ingestion.md) |
| MCP server | Connect TextStack to Claude Desktop / Cursor / ChatGPT | [mcp.md](05-features/mcp.md) |
| Chapter review | Assistant reviews a chapter over MCP | [chapter-review.md](05-features/chapter-review.md) |
| SSG | Prerendered HTML for crawlers | [ssg-prerender.md](02-system/ssg-prerender.md) |

## Structure

```
docs/
├── 00-vision/          # Why: goals, roadmap
├── 01-architecture/    # How: design, ADRs
├── 02-system/          # What: schemas, APIs
├── 03-ops/             # Run: setup, deploy
├── 04-dev/             # Build: test, security
└── 05-features/        # Feature PDDs
```

## Features

### Implemented
| Feature | Docs |
|---------|------|
| Kindle-like Reader | [reader.md](05-features/reader.md) |
| Offline Reading | [offline-reading.md](05-features/offline-reading.md) |
| User Auth & Library | [user-auth.md](05-features/user-auth.md) |
| Full-text Search | [feat-0006](05-features/feat-0006-search-library.md) |
| Text Extraction | [feat-0003](05-features/feat-0003-text-extraction-core.md) |
| Observability | [feat-0005](05-features/feat-0005-observability-opentelemetry.md) |
| i18n | `/:lang/` routes; English only since 2026-04-21 (Ukrainian removed) |
| E2E Testing | Playwright e2e tests with CI pipeline |
| Text Selection | Highlights, translate, Explain, TTS in reader (free dictionary removed 2026-10-03) |
| Vocabulary SRS | Spaced repetition vocab builder with Ollama LLM distractors |
| Reading Stats | Heatmap, streaks, goals, achievements |

## Reading Order

1. **New to project**: [Vision](00-vision/README.md) → [Architecture](01-architecture/README.md) → [Local Dev](03-ops/local-dev.md)
2. **Backend work**: [Database](02-system/database.md) → [Ingestion](02-system/ingestion.md) → API Docs (Scalar)
3. **Frontend work**: [Reader](05-features/reader.md) → [Offline](05-features/offline-reading.md) → [Auth](05-features/user-auth.md)
4. **Ops**: [Local Dev](03-ops/local-dev.md) → [Production Deployment](03-ops/deployment.md) → [Backup](03-ops/backup.md)

## ADRs (Architectural Decisions)

All in `01-architecture/adr/`. Numbering is messy (three 007s, `0001` vs `001`); read the status
line at the top of each file.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](01-architecture/adr/0001-audience-based-multisite.md) | Audience-based multisite | Superseded by 007 |
| [001](01-architecture/adr/001-storage-bind-mounts.md) | Storage via bind mounts | In force |
| [002](01-architecture/adr/002-google-auth-only.md) | Google OAuth only | Obsolete |
| [003](01-architecture/adr/003-work-edition-model.md) | Work/Edition data model | In force |
| [004](01-architecture/adr/004-postgres-fts.md) | PostgreSQL FTS | In force |
| [005](01-architecture/adr/005-multisite-resolution.md) | Multisite via Host | Superseded by 007 |
| [006](01-architecture/adr/006-modular-monolith.md) | Modular monolith | In force |
| [007](01-architecture/adr/007-single-domain-consolidation.md) | Single domain consolidation (+ [deploy runbook](01-architecture/adr/007-single-domain-consolidation-deploy.md)) | Implemented |
| [ADR-007](01-architecture/adr/ADR-007-reader-autosave.md) | Reader auto-save (number clash) | In force |
| [ADR-010](01-architecture/adr/ADR-010-seo-backfill-automation.md) | SEO backfill automation | Implemented |
| [ADR-011](01-architecture/adr/ADR-011-mobile-reader-progress-architecture.md) | Mobile reader progress | Partly superseded |
| [ADR-012](01-architecture/adr/ADR-012-pdf-original-first-lazy-parse.md) | PDF original-first | Display in force; RAG parts obsolete |
| [ADR-013](01-architecture/adr/ADR-013-reader-position-model.md) | Reader position model | In force |
| [ADR-014](01-architecture/adr/ADR-014-guest-sessions.md) | Guest sessions | In force (amended) |
| [ADR-015](01-architecture/adr/ADR-015-reader-position-is-logical.md) | Position is a place in the text | In force |
| [ADR-016](01-architecture/adr/ADR-016-chapter-review-lives-in-book-insight.md) | Chapter review in `BookInsight` | Implemented |
| [ADR-017](01-architecture/adr/ADR-017-mcp-oauth-authorization-server.md) | OAuth AS for MCP | In force |
| [ADR-018](01-architecture/adr/ADR-018-reingest-updates-chapters-in-place.md) | Re-ingest updates chapters in place; reader data never cascades | In force |
| [ADR-019](01-architecture/adr/ADR-019-reader-position-rules.md) | Reader position: shared rules, not a shared state machine | Accepted |
| [ADR-020](01-architecture/adr/ADR-020-build-once-deploy-by-digest.md) | Build once on GitHub, deploy by digest (+ [delivery pipeline](01-architecture/delivery.md)) | Accepted |

## Governance

### When to Update Docs

| Event | Update |
|-------|--------|
| Entity added | 01-architecture/data-model.md (and database.md if core) |
| Endpoint added | (auto in Scalar) |
| Architecture decision | New ADR |
| Migration created | Mention if significant |
| New page type (indexable/not) | seo-implementation.md |

### When ADR Required

- Choosing between 2+ valid approaches
- Decision affects multiple modules
- Hard to reverse
- Security implications
