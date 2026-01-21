# ADR-007: Single Domain Consolidation

**Status**: Accepted
**Date**: 2025-01

## Context

TextStack operates two public-facing sites:
- `textstack.app` (general)
- `textstack.dev` (programming)

Problems:
- Duplicate domain signals hurt SEO
- SEO instability from competing domains
- Unnecessary architectural complexity
- Admin panel only accessible via SSH tunnel (localhost:5174)

## Decision

1. **ONE public site**: `https://textstack.app` (all books merged)
2. **textstack.dev = admin panel** (auth-gated, not public)
3. **Merge programming books** into general site

### Architecture After

```
textstack.app  → nginx → web dist → API (all books)
textstack.dev  → nginx → admin dist → API /admin/* (auth required)
```

---

## Implementation Slices

### Slice 1 — Block textstack.dev from indexing
- Add `X-Robots-Tag: noindex, nofollow` header in nginx
- Set `IndexingEnabled=false` for programming site in DB

### Slice 2 — Migrate programming books to general site
- SQL: UPDATE editions/works SET site_id = general WHERE site_id = programming

### Slice 3 — Route textstack.dev to admin panel
- Nginx: serve admin dist (not web dist) for textstack.dev
- Remove textstack.dev from public CORS

### Slice 4 — Auth gate for textstack.dev
- Admin app already requires login (ProtectedRoute)
- All pages redirect to /login if not authenticated

### Slice 5 — Cleanup
- Remove programming site from DB (or mark inactive)
- Remove textstack.dev detection from frontend SiteContext
- Update docs

---

## Consequences

### Pros
- Single canonical domain for SEO
- No duplicate content signals
- Admin accessible via proper domain (not SSH tunnel)
- Cleaner architecture

### Cons
- Lose textstack.dev as public programming brand
- Migration effort for existing bookmarks

## Verification

- `curl -I https://textstack.dev` → `X-Robots-Tag: noindex`
- textstack.dev/robots.txt → `Disallow: /`
- textstack.dev shows admin login page
- All books visible on textstack.app
- `site:textstack.dev` → 0 results (after Google crawls)

## Notes

- Existing tests use `general.localhost` — unaffected
- Keep Cloudflare tunnel for both domains
- Updates needed: multisite.md, README.md
