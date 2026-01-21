# OnlineLib Vision

Free book library with Kindle-like reader. Upload EPUB/PDF/FB2 → parse → SEO pages + offline-first reading sync.

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
| Mobile | React Native Expo (later) |

## Features

### Public (no login)
- Browse books by site
- Read chapters (SEO pages)
- Full-text search

### Authenticated (Google Sign-In)
- Reading progress sync
- My Library
- Bookmarks and notes

### Admin
- Upload books (EPUB/PDF/FB2)
- Edition management
- Ingestion monitoring

## Domains

- `textstack.app` — Public book library (all content)
- `textstack.dev` — Admin panel (auth-gated, not indexed)

## Non-Goals (MVP)

- No microservices
- No Elasticsearch (Postgres FTS sufficient)
- No email/password auth
- No advanced sync conflict resolution
- No paywall or monetization

## See Also

- [Roadmap](roadmap.md) — MVP phases and checklist
- [Architecture](../01-architecture/README.md) — System design
- [Database](../02-system/database.md) — Schema reference
