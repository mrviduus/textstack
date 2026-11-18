# TextStack Web App

The web app (textstack.app), built with React + Vite.

## Quick Start

```bash
# From project root
pnpm -C apps/web dev

# Or via Docker
docker compose up web
```

**URL**: http://localhost:5173

## Folder Structure

```
src/
├── api/          # API client functions (`@textstack/shared` client in cookie mode)
├── components/   # UI components; the reader host is `components/reader/V2ReaderHost.tsx`
├── context/      # React contexts (Auth, GuestLimits, NativeLanguage, Language)
├── data/         # Static data
├── hooks/        # Custom React hooks
├── lib/          # Utilities (offlineDb, sync, sentry, ...)
├── locales/      # i18n translations
├── pages/        # Route pages
├── styles/       # Global CSS
├── types/        # TypeScript types
└── utils/        # Helper functions
```

## Key Pages

All under `/:lang` (`/` redirects to `/en`).

| Page | Path | Description |
|------|------|-------------|
| Home | `/` | Landing |
| Library | `/library` | The reader's own books (upload here) |
| Book | `/library/my/:id` | Book details |
| Reader | `/library/my/:id/read` | The V2 reader (`/read-v2` is an alias) |
| Vocabulary | `/vocabulary`, `/vocabulary/review` | Saved words, spaced-repetition review |
| Highlights | `/highlights` | Highlights across books |

## Commands

```bash
pnpm dev        # Start dev server
pnpm build      # Type-check + build
pnpm preview    # Preview production build
pnpm test       # Run tests
pnpm test:watch # Watch mode
```

## Key Features

### Reader (`components/reader/V2ReaderHost.tsx`)
- Hosts the foliate-js fork in a sandboxed frame (`dist/reader-v2/`); built by
  `packages/reader/src/build.mjs`, documented in that folder's README
- Position, highlights and bookmarks sync through `/me/v2`

### Auth (`context/AuthContext.tsx`)
- Google, Apple, email/password; guest sessions
- JWT with refresh tokens in HttpOnly cookies

## State Management

React Context only (no Redux/Zustand): `AuthContext`, `GuestLimitsContext`,
`NativeLanguageContext`, `LanguageContext`; otherwise component state + custom hooks.

## Adding a New Page

1. Create `src/pages/NewPage.tsx`
2. Add route in `src/App.tsx`
3. Add translations in `src/locales/`

## Adding a New Component

1. Create `src/components/NewComponent.tsx`
2. Keep it focused, < 200 lines
3. Extract logic to hooks if complex

## Environment Variables

```env
VITE_API_URL=http://localhost:8080
```

## Testing

Tests use Vitest:
```bash
pnpm test
```

Test files: `*.test.ts` or `*.test.tsx`
