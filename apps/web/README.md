# TextStack Web App

Public-facing reader application built with React + Vite.

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
├── api/          # API client functions
├── components/   # Reusable UI components
├── config/       # Site configuration (themes, sites)
├── context/      # React contexts (Auth, Site, Download)
├── hooks/        # Custom React hooks
├── lib/          # Utilities (offlineDb, etc.)
├── locales/      # i18n translations
├── pages/        # Route pages
├── styles/       # Global CSS
├── types/        # TypeScript types
└── utils/        # Helper functions
```

## Key Pages

| Page | Path | Description |
|------|------|-------------|
| Home | `/` | Book listing |
| Book | `/books/:slug` | Book details + chapters |
| Reader | `/books/:slug/:chapter` | Kindle-like reader |
| Library | `/library` | User's saved books |
| Search | `/search` | Full-text search |
| Author | `/authors/:slug` | Author page |

## Commands

```bash
pnpm dev        # Start dev server
pnpm build      # Type-check + build
pnpm preview    # Preview production build
pnpm test       # Run tests
pnpm test:watch # Watch mode
```

## Key Features

### Reader (`pages/ReaderPage.tsx`)
- Page-based pagination
- Customizable: font, size, theme, width
- Keyboard shortcuts (arrows, F for fullscreen)
- Mobile: swipe, tap zones
- Auto-save reading progress

### Offline Reading (`context/DownloadContext.tsx`, `lib/offlineDb.ts`)
- Download books for offline
- IndexedDB storage
- Resume interrupted downloads
- Storage quota management

### Auth (`context/AuthContext.tsx`)
- Google OAuth
- JWT with refresh tokens
- Library sync across devices

### Site Context (`context/SiteContext.tsx`)
- Multi-site support
- Per-site theming
- Resolves from host header

## State Management

- **Auth**: `AuthContext` - user session, tokens
- **Site**: `SiteContext` - current site, theme
- **Download**: `DownloadContext` - offline book management
- **Local**: Component state + custom hooks

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
