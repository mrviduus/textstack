# Site Architecture

Single public domain with admin panel on separate domain.

## Domains

| Domain | Purpose |
|--------|---------|
| textstack.app | Public book library (all content) |
| textstack.dev | Admin panel (auth-gated) |

## Site Resolution

### Flow

```
Request → Host header → SiteResolver → SiteContext → All queries
```

1. Middleware extracts `Host` header
2. `SiteResolver` queries `site_domains` or `sites.primary_domain`
3. Returns `SiteContext` with site_id, code, theme, features
4. Unknown hosts → 404

### Dev Override

```
http://localhost:5173/?site=general
```

### Key Files

- `backend/src/Api/Sites/SiteResolver.cs`
- `backend/src/Api/Sites/SiteContextMiddleware.cs`
- `apps/web/src/context/SiteContext.tsx`

## Data Model

| Entity | Scoping |
|--------|---------|
| Site | Root entity |
| SiteDomain | FK to Site |
| Work | FK to Site |
| Edition | FK to Site |
| Chapter | Via Edition |
| ReadingProgress, Bookmark, Note | FK to Site |
| User | Global (cross-site) |

## SEO

### robots.txt
- Served dynamically per Host
- Includes sitemap URL

### Sitemaps
- `/sitemap.xml` — index
- `/sitemaps/books.xml` — all books
- `/sitemaps/chapters-*.xml` — chunked

### Structured Data
- Organization schema
- Book schema on book pages
- BreadcrumbList on all pages

## Frontend Routing

### Public Routes
```
/                           — Home
/{lang}/books               — Book list
/{lang}/books/:slug         — Book detail
/{lang}/books/:slug/:chapter — Chapter reader
/{lang}/search?q=           — Search
/{lang}/authors             — Author list
/{lang}/genres              — Genre list
```

## API Filtering

Frontend never passes site_id for public reads.
Backend infers site from Host and applies filter.

```csharp
// All public endpoints
var siteId = httpContext.GetSiteId();
var books = await _db.Editions
    .Where(e => e.SiteId == siteId)
    .Where(e => e.Status == EditionStatus.Published)
    .ToListAsync();
```

## Site Configuration

Stored in `sites` table:

| Column | Type | Description |
|--------|------|-------------|
| code | varchar(50) | Stable identifier |
| primary_domain | varchar(255) | Main domain |
| default_language | varchar(10) | en, uk |
| theme | varchar(50) | Theme token |
| ads_enabled | bool | Show ads |
| indexing_enabled | bool | Allow robots |
| sitemap_enabled | bool | Generate sitemap |
| features_json | jsonb | Feature flags |

## See Also

- [ADR-007: Single Domain Consolidation](adr/007-single-domain-consolidation.md)
- [Database: Site/SiteDomain entities](../02-system/database.md)
