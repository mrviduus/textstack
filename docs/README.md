# TextStack Documentation

Free book library with Kindle-like reader. EPUB/PDF/FB2 upload, parsing, SEO pages, and offline reading.

**Live**: [textstack.app](https://textstack.app/) (general) · [textstack.dev](https://textstack.dev/) (programming)

## Quick Links

| Document | Description |
|----------|-------------|
| [CLAUDE.md](../CLAUDE.md) | AI assistant context (commands, key files, concepts) |
| [CHANGELOG.md](../CHANGELOG.md) | Version history and recent changes |
| [Vision](00-vision/README.md) | Goals, principles, stack |
| [Architecture](01-architecture/README.md) | System design |
| [Database](02-system/database.md) | Schema, entities |
| API Docs | http://localhost:8080/scalar/v1 (live) |
| [Local Dev](03-ops/local-dev.md) | Docker, migrations |
| [Production Deployment](03-ops/deployment.md) | Cloudflare tunnel, nginx, Docker |

## Core Features

| Feature | Description | Docs |
|---------|-------------|------|
| Reader | Kindle-like reading (settings, navigation, mobile) | [reader.md](05-features/reader.md) |
| Offline | IndexedDB caching, download manager | [offline-reading.md](05-features/offline-reading.md) |
| Auth | Google OAuth, JWT, user features | [user-auth.md](05-features/user-auth.md) |
| Search | PostgreSQL FTS, fuzzy search | [feat-0006](05-features/feat-0006-search-library.md) |
| Ingestion | EPUB parsing, chapter extraction | [ingestion.md](02-system/ingestion.md) |

## Structure

```
docs/
├── 00-vision/          # Why: goals, roadmap
├── 01-architecture/    # How: design, ADRs
├── 02-system/          # What: schemas, APIs
├── 03-ops/             # Run: setup, deploy
├── 04-dev/             # Build: test, security
├── 05-features/        # Feature PDDs
└── archive/            # Historical docs
```

## Features

### Implemented
| Feature | Docs |
|---------|------|
| Kindle-like Reader | [reader.md](05-features/reader.md) |
| Offline Reading | [offline-reading.md](05-features/offline-reading.md) |
| User Auth & Library | [user-auth.md](05-features/user-auth.md) |
| Full-text Search | [feat-0006](05-features/feat-0006-search-library.md) |
| Multisite | [feat-0002](05-features/feat-0002-multisite-general-programming.md) |
| Text Extraction | [feat-0003](05-features/feat-0003-text-extraction-core.md) |
| Site Resolver | [feat-0004](05-features/feat-0004-site-resolver-host.md) |
| Observability | [feat-0005](05-features/feat-0005-observability-opentelemetry.md) |

### Planned
| Feature | Docs |
|---------|------|
| Next.js SSG Migration | [feat-0007](05-features/feat-0007-nextjs-ssg-migration.md) |

## Reading Order

1. **New to project**: [Vision](00-vision/README.md) → [Architecture](01-architecture/README.md) → [Local Dev](03-ops/local-dev.md)
2. **Backend work**: [Database](02-system/database.md) → [Ingestion](02-system/ingestion.md) → API Docs (Scalar)
3. **Frontend work**: [Reader](05-features/reader.md) → [Offline](05-features/offline-reading.md) → [Auth](05-features/user-auth.md)
4. **Ops**: [Local Dev](03-ops/local-dev.md) → [Production Deployment](03-ops/deployment.md) → [Backup](03-ops/backup.md)

## ADRs (Architectural Decisions)

| ADR | Title |
|-----|-------|
| [001](01-architecture/adr/001-storage-bind-mounts.md) | Storage via bind mounts |
| [002](01-architecture/adr/002-google-auth-only.md) | Google OAuth only |
| [003](01-architecture/adr/003-work-edition-model.md) | Work/Edition data model |
| [004](01-architecture/adr/004-postgres-fts.md) | PostgreSQL FTS |
| [005](01-architecture/adr/005-multisite-resolution.md) | Multisite via Host |
| [006](01-architecture/adr/006-modular-monolith.md) | Modular monolith |

## Governance

### When to Update Docs

| Event | Update |
|-------|--------|
| Entity added | database.md |
| Endpoint added | (auto in Scalar) |
| Architecture decision | New ADR |
| Migration created | Mention if significant |
| New page type (indexable/not) | seo-policy.md |

### When ADR Required

- Choosing between 2+ valid approaches
- Decision affects multiple modules
- Hard to reverse
- Security implications
