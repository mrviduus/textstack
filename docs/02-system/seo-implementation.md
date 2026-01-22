# SEO Technical Implementation

Technical implementation spec for TextStack SEO module.

**Related docs:**
- [SEO Policy](seo-policy.md) — what to index (strategy)
- [SSG Prerender](ssg-prerender.md) — static HTML generation for SEO pages

**Status:** Slice 1 complete (Dec 2025), SSG implemented (Jan 2026)

---

## 1. Purpose
The goal of this module is to make TextStack **indexable, controllable, and safe for SEO at launch**.
This MVP focuses on technical SEO foundations, not growth hacks or content scaling.

Success means:
- Search engines can discover and index core pages
- Duplicate and low-value pages are controlled
- SEO behavior is configurable without code changes later

---

## 2. Non-Goals (Explicitly Out of Scope)
- No keyword research or content strategy
- No link-building or off-page SEO
- No A/B testing or SEO experiments
- No complex faceted navigation (marketplace-level SEO)
- No paid SEO tools integration

---

## 3. Public Pages to Index
Minimum set of indexable pages:

- **Book page**: `/book/{slug}`
- **Author page**: `/author/{slug}`
- **Genre / Category page**: `/genre/{slug}`
- **Language landing (optional)**: `/lang/{code}` or language prefix

All other pages must be either `noindex` or blocked via robots.txt.

---

## 4. Technical SEO Requirements (MVP)

### 4.1 robots.txt
Endpoint: `GET /robots.txt`

Rules:
- `Disallow: /admin/`
- `Disallow: /api/`
- Reference sitemap:
  ```
  Sitemap: https://{HOST}/sitemap.xml
  ```

---

### 4.2 XML Sitemaps
Endpoints:
- `GET /sitemap.xml` (sitemap index)
- `GET /sitemap-books.xml`
- `GET /sitemap-authors.xml`
- `GET /sitemap-genres.xml`

Rules:
- Only include entities where:
  - `Published = true`
  - `Indexable = true`
- URLs must be **absolute**
- Stable ordering (no random ordering per request)

---

### 4.3 Canonical URLs
All public entity pages must render:

```html
<link rel="canonical" href="https://{HOST}/{clean-path}" />
```

Rules:
- No query parameters in canonical
- Canonical must point to the primary slug URL
- Canonical override must be supported (future admin use)

---

### 4.4 Meta Robots
Default behavior:
- `index,follow`

If entity is:
- `Published = false` OR `Indexable = false`
  - Render: `noindex,follow`

---

### 4.5 Meta Title & Description

#### Global Templates (Config-based)
- Book title:
  ```
  {Title} — read online | OnlineLib
  ```
- Author title:
  ```
  {Name} — books by author | OnlineLib
  ```
- Genre title:
  ```
  {Genre} — books online | OnlineLib
  ```

#### Description Rules
- Use entity description if available
- Trim to SEO-safe length
- Fallback template if empty

---

### 4.6 Structured Data (Optional but Recommended)
JSON-LD for Book pages:
- `@type: Book`
- `name`
- `author`
- `inLanguage`
- `datePublished` (if available)

---

## 5. SEO Fields in Domain Models
(Required now, UI can come later)

For **Book / Author / Genre**:
- `Slug` (string, unique per entity type)
- `Published` (boolean)
- `Indexable` (boolean)
- `SeoTitle` (nullable string)
- `SeoDescription` (nullable string)
- `CanonicalOverride` (nullable string)

---

## 6. Search Engine Integrations

### 6.1 Site Verification Meta Tags
Config-driven meta tags rendered in `<head>`:
- Google: `google-site-verification`
- Bing: `msvalidate.01`
- Yandex (optional): `yandex-verification`

No hardcoding — config only.

---

### 6.2 Analytics (Minimal)
- Support GA4 via config:
  - `GA_MEASUREMENT_ID`
- Basic pageview tracking
- Optional custom events:
  - `read_click`
  - `scroll`

---

## 7. Duplicate Control Rules
- Any URL with query parameters:
  - Must NOT be indexed
  - Either:
    - `noindex`
    - OR canonical to base page
- MVP decision: **noindex all parameterized URLs**

---

## 8. Work Slices

### Slice 1 — SEO Skeleton ✅ COMPLETE
Includes:
- robots.txt
- sitemap index + entity sitemaps
- canonical tags
- meta title & description templates
- verification meta tags
- noindex for chapters/reader pages

No admin UI, no redirects.

---

### Slice 2 — Admin SEO Control
Includes:
- Editable slug / published / indexable
- SEO title & description overrides
- Preview rendered meta

---

### Slice 3 — Slug Change Redirects
Includes:
- Redirect table
- Auto-301 on slug change
- Middleware resolution

---

### Slice 4 — Structured Data
Includes:
- Book JSON-LD schema
- Validation against schema.org

---

### Slice 5 — SSG Prerender ✅ COMPLETE (Jan 2026)
Pre-render SEO pages to static HTML at build time.

Includes:
- Puppeteer-based prerender script (`apps/web/scripts/prerender.mjs`)
- SSG API endpoints (`/ssg/routes`, `/ssg/books`, `/ssg/authors`, `/ssg/genres`)
- nginx routing: SSG first, SPA fallback
- ~2000 pages rendered (books, authors, genres, homepage)

See [SSG Prerender](ssg-prerender.md) for architecture details.

---

## 9. Test Plan (TDD)

### Unit Tests
- SEO title & description template rendering
- Canonical URL generation (query stripping)
- Sitemap filtering logic (Published / Indexable)

### Integration Tests
- `GET /robots.txt`
- `GET /sitemap.xml`
- `GET /sitemap-books.xml`
- `GET /book/{slug}`

---

## 10. Acceptance Criteria
SEO Module MVP is complete when:
- Google Search Console accepts sitemap without errors
- Public pages render valid canonical + meta tags
- No private/admin URLs are indexable
- Verification tags are configurable without code changes
