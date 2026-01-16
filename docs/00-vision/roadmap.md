# Roadmap

## Current Focus

- [ ] **SEO Admin Dashboard** — visibility into SEO health, bulk description editing
- [ ] **LLM Batch Processing** — auto-generate descriptions for ~1000 draft books

## Recently Completed (Jan 2025)

### Offline Reading
- [x] IndexedDB chapter caching
- [x] Download manager with progress tracking
- [x] Resume support for interrupted downloads
- [x] Storage quota checks (50MB minimum)
- [x] Kindle-style library UI (3-dots menu)
- [x] Offline badge indicators

### Reader Enhancements
- [x] Chapter splitting for long chapters
- [x] Mobile immersive mode (auto-hide bars)
- [x] Double-tap fullscreen
- [x] Word-based progress calculation
- [x] Auto-add to library after reading starts

### Search & Navigation
- [x] Enter key navigates to search page
- [x] Search overlay close on navigation

### Admin
- [x] Stats cards on authors/genres pages
- [x] Published filter for sitemap

## Completed (MVP - Dec 2024)

- [x] Core library (upload EPUB/PDF/FB2 → parse → serve)
- [x] Kindle-like reader (settings, pagination, keyboard)
- [x] Multisite (textstack.app + textstack.dev)
- [x] PostgreSQL full-text search + fuzzy matching
- [x] Prerender SEO (dynamic rendering)
- [x] Author/Genre pages with SEO
- [x] Google OAuth authentication
- [x] User library + reading progress sync
- [x] Bookmarks with auto-save

## Next Up

- [ ] Search improvements (faceted, analytics)
- [ ] Admin Author/Genre CRUD
- [ ] Slug change redirects (301)
- [ ] Notes feature (highlight + annotate)

## Future / Research

- [ ] Next.js SSG migration (alternative to prerender)
- [ ] Service Worker for true PWA
- [ ] Mobile app (React Native)
- [ ] Eye/head tracking scroll
- [ ] Vector/semantic search
- [ ] Text-to-speech (TTS)

---

*See [CHANGELOG.md](/CHANGELOG.md) for detailed version history.*
