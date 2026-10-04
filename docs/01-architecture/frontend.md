# Frontend Architecture

pnpm workspace. React 19 + TypeScript (versions pinned in the `catalog:` of `pnpm-workspace.yaml`).
Three apps, two shared packages.

---

## Apps

### `apps/web/` — public site (Vite SPA)
- Served by host nginx: crawlers get prerendered SSG HTML, people get the SPA
  ([ssg-prerender.md](../02-system/ssg-prerender.md)).
- Pages: home, books, book detail, reader, authors, genres, search, library (catalog + own uploads),
  vocabulary + review + tutor, highlights + review, chapter review, stats, MCP landing, OAuth
  consent, legal pages.
- i18n: `/:lang/` prefix on all routes, but the only language is `en`
  (`SUPPORTED_LANGUAGES` in `context/LanguageContext.tsx`; Ukrainian removed 2026-04-21).

### `apps/admin/` — admin panel (Vite SPA, `textstack.dev`, port 81)
- English only. Email/password JWT login, separate from user auth.
- Pages: Dashboard, Upload, Jobs, User Uploads, Editions, Chapter editor, Authors, Genres, Tools,
  SSG Rebuild (+ job), Auto Publish, SEO Backfill, Book Quality, AI Quality, Settings.

### `apps/mobile/` — Expo 57 / React Native 0.86 (Expo Router)
- Android first. Offline reading via SQLite (`src/lib/offlineDb.ts`). See CLAUDE.md "Mobile App
  Architecture".

## Shared packages (`packages/`)

Consumed as source through path aliases (not built or published).
- `@textstack/shared` — API client, API types, i18n, sentence splitting, anon/guest helpers, reader
  progress logic. Edit here when both web and mobile need the change.
- `@textstack/reader-overlay` — DOM overlay engine (highlight/vocab/search layers) for the web
  reader and the mobile WebView bundle.

---

## State management (web)

React Context only — no Redux/Zustand. Order in `App.tsx`:
```
BrowserRouter → SiteProvider → AuthProvider → GuestLimitsProvider → NativeLanguageProvider
  → DownloadProvider → routes
      └─ /:lang/* → LanguageProvider → page routes
```

- **SiteProvider**: fetches `/api/site/context`.
- **AuthProvider**: Google, Apple, email/password; token refresh; skips Google script for bots.
- **GuestLimitsProvider**: guest session minting triggers (upload, 3rd pending word).
- **NativeLanguageProvider**: translation direction.
- **DownloadProvider**: IndexedDB offline downloads.
- **LanguageProvider**: `lang` from URL, `switchLanguage()`, `getLocalizedPath()`.

---

## Routing

`/` → 301 `/en/` (nginx). Legacy unprefixed `/books|authors|genres|…` and `/uk/*` → 301 to `/en/…`.

## API client

`useApi()` → `createApi(language)` → typed methods; `fetchJsonWithRetry()` retries on 5xx/429.
Modules in `apps/web/src/api/`.

## Reader (web)

`pages/ReaderPage.tsx` (catalog and `mode="userbook"`):
- Settings: font, size, line height, width, theme, alignment, TTS speed.
- Navigation: TOC drawer, prev/next, keyboard, swipe.
- Offline: cache-first from IndexedDB.
- Selection: highlights, translate (`POST /api/translate`, OpenAI), contextual Explain, TTS.
  The free-dictionary lookup was removed 2026-10-03.
- Progress: server when there is a session (account or guest), else `localStorage`.
- Uploaded PDFs render as the original document (PDF.js), not reflowed ([ADR-012](adr/ADR-012-pdf-original-first-lazy-parse.md)).

## SEO

- SSG: `ssg-worker` container runs Puppeteer (`scripts/prerender.mjs`) for home, catalog, book,
  author, genre and static pages.
- `SeoHead` component: title, description, canonical, robots, OG, JSON-LD.

## Key directories (`apps/web/src/`)

```
api/         API modules (client, auth, translation, tts, vocabulary, …)
components/  UI (reader/, vocabulary/, library/, …)
context/     React Context providers
hooks/       ~70 hooks
lib/         helpers (e.g. wordBubbleFetch)
locales/     en.json
pages/       route components
styles/      global CSS
utils/
```
