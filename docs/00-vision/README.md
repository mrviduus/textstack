# TextStack Vision

Free book library with Kindle-like reader. Upload EPUB/PDF → parse → SEO pages + offline-first reading sync.

## Core Principles

1. **SEO-first**: Real HTML pages, indexable by search engines
2. **Content-first**: Reading and discovery take priority
3. **Self-hosted**: No mandatory cloud providers
4. **Simple MVP**: Avoid premature complexity
5. **Data durability**: Containers ephemeral, data permanent

## Stack

| Layer | Technology |
|-------|------------|
| API | ASP.NET Core (Minimal API) |
| Worker | ASP.NET Core Worker |
| Database | PostgreSQL + EF Core |
| Search | PostgreSQL FTS (tsvector + GIN) |
| Frontend | React (Vite) |
| Mobile | React Native (Expo) — `apps/mobile` |

## Features

### Public (no login)
- Browse books
- Read chapters (SEO pages)
- Full-text search

### Signed in (Google, Apple, email/password; or an anonymous guest session — ADR-014)
- Reading progress sync
- My Library
- Bookmarks and notes

### Admin
- Upload books (EPUB/PDF)
- Edition management
- Ingestion monitoring

## Domains

- `textstack.app` — Public book library (all content)
- `textstack.dev` — Admin panel (auth-gated, not indexed)

## Non-Goals (MVP)

- No microservices
- No Elasticsearch (Postgres FTS sufficient)
- ~~No email/password auth~~ — shipped (password reset via Resend)
- No advanced sync conflict resolution
- No paywall or monetization (entitlement tiers exist in `Entitlements:Tiers`, no billing)

## See Also

- [Roadmap](roadmap.md) — **historical** (frozen Jan 2025). Live status lives in [STATUS.md](../STATUS.md).
- [Architecture](../01-architecture/README.md) — System design
- [Database](../02-system/database.md) — Schema reference
