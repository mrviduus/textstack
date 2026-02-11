# Changelog

## [Unreleased]

### Rebrand: OnlineLib → TextStack
- **Solution & projects renamed** - `onlinelib.sln` → `textstack.sln`, `OnlineLib.*` → `TextStack.*`
- **C# namespaces updated** - 70+ files migrated to `TextStack.*` namespaces
- **Telemetry renamed** - service names `textstack-api/worker`, activity sources `TextStack.*`
- **GitHub repo renamed** - `github.com/mrviduus/textstack`
- **Deployment paths updated** - workflows, Makefile, nginx config

### Single Domain Consolidation (ADR-007)
- **textstack.app** - single public domain for all books
- **textstack.dev** - admin panel only (auth-gated, noindex)
- **Migration** - merge programming books to general site
- **Admin Tools page** - reprocess, reimport, sync operations
- **Removed multisite code** - HostSiteResolver, SiteService, AdminSitesEndpoints
- **Admin port** - changed from 5174 → 81 (easier to remember)
- **SSG Worker** - Docker service polls DB for rebuild jobs, prerenders pages automatically
- **See**: `docs/01-architecture/adr/007-single-domain-consolidation-deploy.md`

### Removed
- **DjVu format support** — unused, removed extractor, tests, Docker deps
- **Tempo** - distributed tracing service removed to save ~350MB RAM
- **Multisite infrastructure** — HostSiteResolver, SiteService, SitesPage (ADR-007)
  - Traces still collected via OTEL but not stored
  - To restore Tempo in future, see `docs/tempo-restore.md`

### Offline Reading (PWA)
- **IndexedDB storage** - chapters cached locally for offline reading
- **Download manager** - global context tracks active downloads, progress, errors
- **Resume support** - paused/interrupted downloads continue from last chapter
- **Storage quota check** - warns when <50MB available, handles QuotaExceededError
- **Kindle-style library UI** - 3-dots menu with download/resume/remove options
- **Offline badge** - visual indicator (download icon, spinner, pause icon)
- **Cache-first reader** - serves from IndexedDB when available

### User Authentication
- **Google OAuth** - cookie-based auth with JWT refresh
- **User library** - save/unsave books, persisted server-side
- **Reading progress sync** - resume position synced to server
- **Continue Reading** - library shows last read chapter with progress bar

### Library
- **My Library page** - grid view of saved books
- **Progress indicators** - visual progress bar per book
- **Read/unread status** - mark books as read
- **Quick actions** - context menu for common operations

### Search Improvements
- **Enter to search** - pressing Enter navigates directly to search page
- **Overlay close fix** - View All Results properly closes overlay
- **Direct navigation** - search input triggers page navigation

### Admin
- **Stats cards** - authors/genres pages show count summaries
- **Genres filter alignment** - consistent with authors page layout
- **Published filter** - sitemap/admin respects publication status

### SEO - Chapter Splitting
- **Chapter splitter** - long chapters auto-split at word boundaries (HTML block-aware)
- **Site-level config** - `MaxWordsPerPart` per site (general: 1000, programming: 2000)
- **Split-on-publish** - chapters split before publishing, reload after split
- **Reprocessing API** - `POST /admin/reprocess/split-existing` for batch reprocess
- **GeneratedRegex** - compiled regex patterns for performance

### Reader
- **Theme cleanup** - reader theme properly reset on unmount (fixes body class leak)
- **Mobile progress** - footer shows overall book % instead of chapter %
- **Help button** - hidden on mobile (keyboard shortcuts not applicable)
- **Scroll tracking** - mobile progress bar reflects scroll position
- **Double-tap fullscreen** - double-tap on content toggles fullscreen (mobile)

### SEO
- **Legacy URL redirects** - 301 redirect `/authors/*` → `/en/authors/*` (nginx + React Router)
- **Google Search Console fix** - non-prefixed URLs now properly redirect to language-prefixed versions

### i18n
- **Full Ukrainian i18n** — all pages translated (en/uk JSON files)
- **Dynamic language** in library list view links

### E2E Testing
- **Playwright e2e tests** — chromium, mobile, admin projects with CI pipeline
- **Flaky test fixes** — bookmark test waits for btn enabled before click

### Reader
- **Text selection** — highlights, translate (LibreTranslate), dictionary
- **iOS selection toolbar fix** — use `selectionchange` event, suppress native context menu in PWA

### Infrastructure
- **Regex timeouts** in text processors
- **Retry on 5xx/429 errors** — error state in home sections
- **Separate storage URL config** — reader highlights height fix

### SEO
- **Trailing slashes** on all sitemap URLs (books, authors, pages)
- **IndexNow API key** for Bing indexing
- **URL redirects & canonicalization** — redirect logic in HTTP block for Cloudflare SSL

### Ops
- **Sudoers** for passwordless nginx deploy
- **Backup directory** → `~/backups/textstack`
- **Docker context fix** — `.dockerignore` to exclude data folder, permission fixes

### Removed
- **Old IndexNow key file**
- **Redundant download button** from library list

### Documentation
- **database.md** - Updated to match actual schema: added UserRefreshToken, BookAsset, TextStackImport, SeoCrawlJob, SeoCrawlResult; fixed Chapter/User/IngestionJob/ReadingProgress/Bookmark/Note schemas; removed non-existent search_documents table

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
- **Admin app** - separate React app on port 81

### Changed
- Rebrand to **TextStack**, default language to English
- Book/Translation → Work/Edition data model
- Swashbuckle → Scalar.AspNetCore for OpenAPI
- Docker compose defaults (`.env` optional)

### Technical
- Fresh migration: `Initial_WorkEdition_Admin`
- Removed: Book, BookTranslation, ChapterTranslation entities

