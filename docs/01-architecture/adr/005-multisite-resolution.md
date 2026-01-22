# ADR-005: Multisite via Host Resolution

**Status**: Accepted
**Date**: 2024-12

## Context

Need to run multiple branded sites (general, programming) from single backend.

Options:
1. Separate deployments per site
2. Path-based routing (/general/...)
3. Host-based resolution

## Decision

Use **Host header resolution** → SiteContext per request.

```
general.example.com → site_id=general
programming.example.com → site_id=programming
```

## Implementation

### Backend (Request Pipeline)

```
Request → SiteContextMiddleware → SiteResolver → SiteContext
                                       ↓
                               DB lookup (cached)
```

- `ISiteResolver` / `SiteResolver`: Handles host → site lookup with 10min cache
- `SiteContextMiddleware`: Integrates SiteResolver into request pipeline, stores in HttpContext.Items
- `HttpContextExtensions.GetSiteId()`: Helper to retrieve site from context

### Frontend (React)

- `SiteContext.tsx`: Fetches site config from `/api/site/context` endpoint
- `useSite()` hook: Provides site config to components

Dev override: `?site=general` query param (backend converts to `{site}.localhost`).

## Data Isolation

| Entity | Scoping |
|--------|---------|
| Work | site_id (primary) |
| Edition | site_id (denormalized) |
| ReadingProgress, Bookmark, Note | site_id |
| User | Global (cross-site account) |

## Consequences

### Pros
- Single deployment
- Shared codebase and infrastructure
- Per-site theming/SEO
- Clean domain separation

### Cons
- Must enforce site_id filter everywhere
- Risk of data leakage if filter missed
- Site cache invalidation needed

## Notes

- Sites table stores: code, primary_domain, theme, ads_enabled, indexing_enabled
- SiteDomains table for domain aliases
