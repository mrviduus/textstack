# Site Architecture

One public site. The multisite tables and `site_id` columns remain, but there is exactly one site
and the code treats it as permanent ([ADR-007](adr/007-single-domain-consolidation.md); earlier
[ADR-0001](adr/0001-audience-based-multisite.md) and [ADR-005](adr/005-multisite-resolution.md)
are superseded).

## Domains

| Domain | Purpose |
|--------|---------|
| textstack.app | Public library, API (`/api`), MCP (`/mcp`) |
| textstack.dev | Admin panel (login required, `X-Robots-Tag: noindex, nofollow`) |

## Site resolution

```
Request → Host → SiteResolver → SiteContext (HttpContext) ; EF filters use ICurrentSite.Id
```

1. `SiteContextMiddleware` reads `Host`.
2. `SiteResolver` looks it up in `site_domains`, then `sites.primary_domain`.
3. No match → falls back to the single site (`ICurrentSite.Id`, config `Site:Id`, default
   `SiteConstants.DefaultSiteId`) and logs a warning. Added after the ssg-worker's `Host` header
   was dropped by undici and SSG silently failed for five weeks (see the comment in `SiteResolver`).
   It returns 404 only if that site row is missing. `AllowedHosts` limits which hosts get this far.
4. The dev `?site=` override was removed (R1b).

### Key files

- `backend/src/Api/Sites/SiteResolver.cs`, `SiteContextMiddleware.cs`, `HttpContextExtensions.cs`
- `backend/src/Infrastructure/Persistence/CurrentSite.cs`, `SiteScopedStamp.cs`
- `backend/src/Domain/Entities/ISiteScoped.cs`
- `apps/web/src/context/SiteContext.tsx` (fetches `/api/site/context`)

## Data scoping

Entities that implement `ISiteScoped` get an EF global query filter
`SiteId == ICurrentSite.Id` (`AppDbContext.*.cs`) and have `SiteId` stamped on insert. Code does not
filter by site by hand. Scoped today: Work, Edition, Author, Genre, ReadingProgress, Bookmark, Note,
Highlight, ReadingSession, ReadingGoal, UserAchievement, VocabularyWord, VocabularyReview,
PendingVocabularyWord, WordLookup, WordCluster, UserVocabularySettings, BookInsight, ReviewQuestion,
McpAccessKey, TutorSession, AutoPublishJob, SsgRebuildJob, TextStackImport. Not scoped: User,
UserBook (and its children), auth/OAuth/AI-ops tables.

## SEO surface

- `GET /robots.txt` — per host.
- Sitemaps: `/sitemap.xml` (index), `/sitemaps/books.xml`, `/sitemaps/authors.xml`,
  `/sitemaps/genres.xml`, `/sitemaps/pages.xml`. No chapter sitemaps (chapters are noindex).
- JSON-LD and breadcrumbs: `apps/web/src/components/JsonLd.tsx`, `Breadcrumbs.tsx`.

## Public routes (web)

```
/                              → 301 /en/
/{lang}/                       Home            (lang is always "en"; /uk/* → 301 /en/*)
/{lang}/books, /books/:slug    Catalog, book detail
/{lang}/books/:slug/:chapter   Reader (noindex)
/{lang}/authors[/:slug], /{lang}/genres[/:slug]
/{lang}/search?q=
/{lang}/library/...            User library + uploads (private)
```

## `sites` table

`code`, `primary_domain`, `default_language`, `theme`, `ads_enabled`, `indexing_enabled`,
`sitemap_enabled`, `features_json`. Most of these are vestigial with one site.

## See also

- [Database: Site/SiteDomain](../02-system/database.md)
