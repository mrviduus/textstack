# OnlineLib Documentation

## Quick Links

| Document | Description |
|----------|-------------|
| [Vision](00-vision/README.md) | Goals, principles, stack |
| [Roadmap](00-vision/roadmap.md) | Current focus, completed, future |
| [Architecture](01-architecture/README.md) | System design |
| [Database](02-system/database.md) | Schema, entities |
| API Docs | http://localhost:8080/scalar/v1 (live) |
| [SEO Policy](02-system/seo-policy.md) | Indexing strategy, prerender rules |
| [SEO Implementation](02-system/seo-implementation.md) | Technical spec (robots.txt, sitemap, etc.) |
| [Local Dev](03-ops/local-dev.md) | Docker, migrations |
| [Production Deployment](03-ops/deployment.md) | Cloudflare tunnel, nginx, Docker |
| [CI/CD Plan](03-ops/cicd-plan.md) | GitHub Actions, automation (TODO) |

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

## Features (PDDs)

| Feature | Title | Status |
|---------|-------|--------|
| [feat-0002](05-features/feat-0002-multisite-general-programming.md) | Multisite (General + Programming) | Implemented |
| [feat-0003](05-features/feat-0003-text-extraction-core.md) | Text Extraction Core | Implemented |
| [feat-0004](05-features/feat-0004-site-resolver-host.md) | Site Resolver (Host-based) | Implemented |
| [feat-0005](05-features/feat-0005-observability-opentelemetry.md) | Observability (OpenTelemetry) | Implemented |
| [feat-0006](05-features/feat-0006-search-library.md) | Search Library | Implemented |
| [feat-0007](05-features/feat-0007-nextjs-ssg-migration.md) | Next.js SSG Migration | Planned |
| [feat-seo-dashboard](05-features/feat-seo-dashboard.md) | SEO Admin Dashboard | Planning |

## Reading Order

1. **New to project**: [Vision](00-vision/README.md) → [Architecture](01-architecture/README.md) → [Local Dev](03-ops/local-dev.md)
2. **Backend work**: [Database](02-system/database.md) → [Ingestion](02-system/ingestion.md) → API Docs (Scalar)
3. **Frontend work**: [Architecture](01-architecture/README.md) → [Multisite](01-architecture/multisite.md) → [Reader](02-system/reader.md)
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
