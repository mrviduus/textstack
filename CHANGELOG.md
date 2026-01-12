# Changelog

## [Unreleased]

### SEO - Chapter Splitting
- **Chapter splitter** - long chapters auto-split at word boundaries (HTML block-aware)
- **Site-level config** - `MaxWordsPerPart` per site (general: 1000, programming: 2000)
- **Split-on-publish** - chapters split before publishing, reload after split
- **Reprocessing API** - `POST /admin/reprocess/split-existing` for batch reprocess
- **GeneratedRegex** - compiled regex patterns for performance

### Reader
- **Mobile progress** - footer shows overall book % instead of chapter %
- **Help button** - hidden on mobile (keyboard shortcuts not applicable)
- **Scroll tracking** - mobile progress bar reflects scroll position

### Documentation
- **feat-0007** - Next.js SSG Migration PDD (`docs/05-features/feat-0007-nextjs-ssg-migration.md`)

---

## [0.1.0] - 2025-01-09 - MVP 1

### Reader
- **Full-featured Kindle-like reader**
  - Centered text column, responsive layout
  - Settings drawer: font size, line height, width, theme (light/sepia/dark), font family, text alignment
  - TOC drawer, chapter prev/next navigation
  - Progress % indicator, localStorage persistence
- **Fullscreen mode** - auto-hide top/bottom bars, `F` shortcut
- **Keyboard shortcuts** - arrow keys, `?` for help modal, help button in top bar
- **Mobile support** - swipe navigation, centered nav arrows
- **Visual effects** - aged book edge / burnt paper effect

### UI/UX
- **Header** - collapsing animation on scroll, language switcher (UA/EN)
- **Search** - integrated in header, fuzzy/typo-tolerant, view all results link fix
- **Home hero** - responsive layout, improved alignment
- **Book grid** - responsive layout improvements
- **About page** - creator section with image

### Backend
- **SEO module** - `GET /seo/sitemap.xml`, `SeoService`, `SeoHead` component
- **Full-text search** - PostgreSQL FTS, pg_trgm fuzzy search, GIN indexes
- **Example books seeder** - migration seeds sample data
- **Public API** - `/books`, `/books/{slug}`, `/books/{slug}/chapters/{chapterSlug}`, `/authors`, `/genres`, `/search`
- **Admin API** - file upload, ingestion jobs CRUD
- **EPUB parser** - VersOne.Epub + HtmlAgilityPack, chapter extraction
- **Ingestion worker** - background polling, EPUB → chapters, search_vector indexing
- **Data model** - Work/Edition hierarchy, Admin auth system, UserLibrary
- **Admin app** - separate React app on port 5174

### Changed
- Rebrand to **TextStack**, default language to English
- Book/Translation → Work/Edition data model
- Swashbuckle → Scalar.AspNetCore for OpenAPI
- Docker compose defaults (`.env` optional)

### Technical
- Fresh migration: `Initial_WorkEdition_Admin`
- Removed: Book, BookTranslation, ChapterTranslation entities

---

## Next Up

### Phase B: Google OAuth
- Cookie-based auth with Google sign-in
- Endpoints: `/auth/google`, `/auth/me`, `/auth/logout`

### Phase D: User API
- `/me/library` - saved books
- `/me/progress` - reading position sync
- `/me/bookmarks`, `/me/notes`

### Search Enhancements
- Highlights, autocomplete, facets
- Document chunking for vector search
