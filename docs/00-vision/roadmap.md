# Roadmap — historical

> **This file is history, not a plan.** It was last true in **January 2025** and is kept
> because the MVP record below is worth preserving. Everything under "Current Focus",
> "Next Up" and "Future / Research" has either shipped, been superseded, or been
> declined — annotations below say which.
>
> **For what is actually in flight, broken, or deliberately not being done, read
> [`docs/STATUS.md`](../STATUS.md).** For what changed and when, read
> [`CHANGELOG.md`](../../CHANGELOG.md).

## Current Focus *(as of Jan 2025 — both shipped)*

- [x] **SEO Admin Dashboard** — shipped as the SEO Backfill admin page (coverage,
      templates, jobs, settings) plus Auto Publish.
- [x] **LLM Batch Processing** — shipped as the Auto Publish pipeline and the SEO
      backfill job queue.

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

## Completed (MVP — Dec 2024)

- [x] Core library (upload EPUB/PDF → parse → serve)
- [x] Kindle-like reader (settings, pagination, keyboard)
- [x] Multisite (textstack.app + textstack.dev) — later collapsed to a single site on
      purpose, see [ADR-007](../01-architecture/adr/)
- [x] PostgreSQL full-text search + fuzzy matching
- [x] Prerender SEO (dynamic rendering)
- [x] Author/Genre pages with SEO
- [x] Google OAuth authentication
- [x] User library + reading progress sync
- [x] Bookmarks with auto-save

## Next Up *(as of Jan 2025)*

- [x] Search improvements — semantic/vector search shipped with the RAG work, then deleted
      with it on 2026-09-10. Search is Postgres FTS only.
- [x] Admin Author/Genre CRUD — shipped
- [ ] Slug change redirects (301) — never built, never missed
- [x] Notes feature (highlight + annotate) — shipped, but as notes *on highlights*.
      The separate `Note` entity from this line was built and then abandoned; no row
      was ever written to it.

## Future / Research *(as of Jan 2025 — mostly overtaken)*

- [ ] Next.js SSG migration — not done. The hand-rolled Puppeteer prerender in
      `apps/web/scripts/prerender.mjs` is what runs.
- [ ] Service Worker for true PWA — not done.
- [x] Mobile app (React Native) — shipped. Expo app in `apps/mobile`, live on Play
      Internal Testing.
- [ ] Eye/head tracking scroll — not done, not planned.
- [x] Vector/semantic search — shipped with pgvector and the RAG stack; RAG deleted
      2026-09-10, so not live any more.
- [x] Text-to-speech (TTS) — shipped via Edge TTS, web and mobile.

---

*Live status: [`docs/STATUS.md`](../STATUS.md) · History: [`CHANGELOG.md`](../../CHANGELOG.md)*
