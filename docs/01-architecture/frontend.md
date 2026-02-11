# Frontend Architecture

Stack: React 18 + Vite + TypeScript. Two apps, no shared packages.

---

## Apps

### `apps/web/` — Public site
- Vite SPA, served via nginx (SSG first, SPA fallback)
- Pages: Home, Books, Authors, Genres, Reader, Library, Search, About, Privacy, Terms, Contact
- i18n: `/:lang/` prefix on all routes. Languages: `en`, `uk`. JSON files in `src/locales/`.

### `apps/admin/` — Admin panel
- Vite SPA on port 81 (`textstack.dev`)
- English only, no i18n
- Password-based JWT auth, sidebar layout
- Pages: Books, Authors, Genres, Editions, Chapters, Ingestion Jobs, Tools, Stats

---

## State Management

React Context only — no Redux/Zustand.

Provider hierarchy in `App.tsx`:
```
SiteProvider → AuthProvider → DownloadProvider → LanguageProvider → {children}
```

- **SiteProvider**: fetches `/api/site/context`, provides `site` to all children
- **AuthProvider**: Google Sign-In, auto-refresh token, skips Google for bots
- **DownloadProvider**: IndexedDB offline downloads, progress tracking
- **LanguageProvider**: extracts `lang` from URL, provides `switchLanguage()`, `getLocalizedPath()`

---

## Routing

Language-prefixed routes: `/:lang/books`, `/:lang/authors/:slug`, etc.

Root `/` redirects to `/en`. Legacy `/authors/*` → 301 to `/en/authors/*`.

---

## API Client

`useApi()` hook → `createApi(language)` → typed methods (`getBooks()`, `getBook(slug)`, etc.).

Uses `fetchJsonWithRetry()` with retry on 5xx/429.

---

## Reader

`ReaderPage.tsx` — Kindle-like reader with:
- Settings: font size, line height, width, theme (light/sepia/dark), font family, alignment
- Navigation: TOC drawer, chapter prev/next, keyboard shortcuts, mobile swipe
- Offline: cache-first from IndexedDB
- Text selection: highlights, translate (LibreTranslate), dictionary
- Progress: autosave to server (authenticated) or localStorage (anonymous)

---

## SEO

- SSG: Puppeteer prerenders book/author/genre pages to static HTML
- nginx serves SSG → SPA fallback (check `X-SEO-Render` header)
- `SeoHead` component: title, description, canonical, robots, OG tags, JSON-LD

---

## Key Directories

```
apps/web/src/
├── pages/          # Route components
├── components/     # Shared UI
├── contexts/       # React Context providers
├── hooks/          # useApi, useTranslation, etc.
├── locales/        # en.json, uk.json
├── styles/         # Global CSS
└── utils/          # Helpers
```
