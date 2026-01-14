# OnlineLib Roadmap

## Phase 0 — Baseline & Migrations

- [x] Docker Compose works on clean machine
- [x] Host storage bind-mounted
- [x] Containers ephemeral, data persistent
- [x] Migrator exits 0
- [x] All migrations applied

## Phase 1 — Upload → Ingest → Read

### Data Model
- [x] Work (canonical book identity)
- [x] Edition (language-specific: EN, UK)
- [x] BookFile (uploaded file)
- [x] Chapter (with FTS)
- [x] IngestionJob (async processing)

### Admin Upload
- [x] `POST /admin/books/upload`
- [x] Save file to storage
- [x] Create Edition + BookFile + Job

### Worker Ingestion
- [x] Poll queued jobs
- [x] Extract chapters (EPUB)
- [x] Store HTML + plain text
- [x] Mark job complete

### Public Pages
- [ ] `/books` — list editions
- [ ] `/books/{slug}` — edition detail
- [ ] `/books/{slug}/chapters/{n}` — chapter page

## Phase 2 — Reader Experience

### Reader UI
- [ ] Chapter navigation
- [ ] Font size/line height controls
- [ ] Light/Sepia/Dark themes
- [ ] Mobile-friendly layout

### Reading Progress
- [x] ReadingProgress entity
- [ ] Save progress on debounce
- [ ] Resume reading

## Phase 3 — Search

- [x] tsvector column (Chapter.SearchVector)
- [x] GIN index
- [ ] `GET /search?q=`
- [ ] Snippet per result
- [ ] Chapter-level links

## Phase 4 — Notes & Bookmarks

- [ ] Save bookmark with locator
- [ ] List bookmarks per book
- [ ] Create/edit/delete notes
- [ ] Export notes (later)

## Phase 5 — SEO Hardening

### Sitemaps
- [ ] `/sitemap.xml` (index)
- [ ] `/sitemap-books.xml`
- [ ] `/sitemap-chapters.xml`

### Structured Data
- [ ] Schema.org Book
- [ ] Breadcrumb markup

### Quality
- [ ] No duplicate URLs
- [ ] Fast TTFB
- [ ] Internal linking

## Phase 6 — Ops & Durability

- [ ] Automated Postgres backups
- [ ] Storage directory backups
- [ ] Restore tested
- [x] Health endpoint (`/health`)
- [x] Admin audit log

## Multisite Checklist

### Database
- [x] `sites` table
- [x] `site_domains` table
- [x] `site_id` on Works
- [x] `site_id` on Editions
- [x] `site_id` on user reading data

### Backend
- [x] SiteResolver middleware
- [x] SiteContext injection
- [x] Public endpoints filter by site
- [ ] Per-site robots.txt
- [ ] Per-site sitemap

### Frontend
- [x] Site context from API
- [x] Per-site theming
- [ ] Site-specific nav

## Immediate Next Tasks

1. Public book list endpoint
2. Public chapter page
3. Reader UI basics
4. Reading progress sync
5. Search endpoint
6. Sitemap generation
