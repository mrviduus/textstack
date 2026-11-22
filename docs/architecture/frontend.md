# Frontend Architecture

pnpm workspace. React 19 + TypeScript (versions pinned in the `catalog:` of `pnpm-workspace.yaml`).
Web, mobile, browser extension and a retained admin shell; two shared packages.

---

## Apps

### `apps/web/` — the web app (Vite SPA)
- Served by host nginx, plus the reader frame under `dist/reader/` (`infra/nginx/textstack.conf`).
- Pages: home, library, book detail, reader, vocabulary + review, highlights, changelog, MCP landing,
  OAuth consent, device, legal pages.
- i18n: `/:lang/` prefix on all routes, but the only language is `en`
  (`SUPPORTED_LANGUAGES` in `context/LanguageContext.tsx`; Ukrainian removed 2026-04-21).

### `apps/admin/` — admin shell (Vite SPA, `textstack.dev`, port 81)
- English only. Email/password JWT login, separate from user auth.
- Pages: login and an empty home (M6 D2).

### `apps/mobile/` — Expo 57 / React Native 0.86 (Expo Router)
- Android first. The reader opens the book's file kept on the device (`src/lib/v2reader/hostStorage.ts`,
  `localLibrary.ts`), so reading needs no network. iOS has no reader (M6 D4).

## Shared packages (`packages/`)

Consumed as source through path aliases (not built or published).
- `@textstack/shared` — API client, API types, i18n, sentence splitting, anon/guest helpers, reader
  progress logic. Edit here when both web and mobile need the change.

The shared reader lives in `@textstack/reader` (`packages/reader`): our foliate-js fork, built by `packages/reader/src/build.mjs`
into a generated page that both web and mobile host ([ADR-032](adr/ADR-032-one-engine-foliate-fork.md)).

---

## State management (web)

React Context only — no Redux/Zustand. Order in `App.tsx`:
```
BrowserRouter → AuthProvider → GuestLimitsProvider → NativeLanguageProvider → routes
      └─ /:lang/* → LanguageProvider → page routes
```

- **AuthProvider**: Google, Apple, email/password; token refresh; guest sessions.
- **GuestLimitsProvider**: guest session minting triggers (upload, 3rd pending word).
- **NativeLanguageProvider**: translation direction.
- **LanguageProvider**: `lang` from URL, `switchLanguage()`, `getLocalizedPath()`.

---

## Routing

`/` → `/en`. Unprefixed `/library`, `/vocabulary`, legal pages … redirect to `/en/…`. Retired catalog URLs answer `410 Gone` from nginx (M6 D1).

## API client

`apps/web/src/api/client.ts` runs the shared `authFetch` in cookie mode (`initApi({ credentials: 'include' })`;
a 401 refreshes the cookie and retries once). Modules in `apps/web/src/api/`.

## Reader (web)

`pages/ReaderPage.tsx` → `components/reader/ReaderHost.tsx`, which hosts the reader page in a
sandboxed frame (`/:lang/library/my/:id/read`):
- Settings: theme, font, size, line height, alignment, speech speed, inline translations.
- Contents, search in the book, bookmarks, highlights and notes, time left.
- Selection: translate (`POST /api/translate`, OpenAI), contextual Explain, TTS, save a word.
- Progress: `PUT /me/v2/books/{id}/reading-state` (account or guest session).
- EPUB, MOBI, AZW3, FB2, CBZ and PDF ([ADR-029](adr/ADR-029-foliate-for-v2-epub.md)).

## Typography

- **TextStack**: wordmark, headings and book titles.
- **Literata**: default book text (Latin and Cyrillic), bundled offline in the shared reader (SIL OFL).
- **Source Sans 3**: interface text and the sans reading mode (SIL OFL, Adobe's release).
- **OpenDyslexic**: accessibility option.

Web: `--font-serif` / `--font-sans` in `apps/web/src/styles/theme.css`; TextStack as WOFF2 `@font-face`
(`apps/web/src/assets/fonts/`, `font-display: swap`, content-hashed under `/assets/`, one-year immutable cache);
Source Sans 3 via Google Fonts. Mobile bundles the TTFs for native screens in `apps/mobile/assets/fonts/`; the
reader embeds Literata and Source Sans 3 WOFF2 faces plus OpenDyslexic for offline use
(`packages/reader/README.md`, "Reading settings"). Android’s book settings expose Pages/Scroll, persisted locally.

## Key directories (`apps/web/src/`)

```
api/         API modules (client, auth, translation, tts, vocabulary, …)
components/  UI (reader/, vocabulary/, library/, …)
context/     React Context providers
hooks/       ~40 hooks
lib/         helpers (e.g. wordBubbleFetch)
locales/     en.json
pages/       route components
styles/      global CSS
utils/
```
