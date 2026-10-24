# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Free book library w/ Kindle-like reader. Upload EPUB/PDF → parse → SEO pages + offline-first sync.

**Live**: [textstack.app](https://textstack.app/) (public) · [textstack.dev](https://textstack.dev/) (admin)

**Stack**: ASP.NET Core (API + Worker) + PostgreSQL + React + React Native (Expo)

**Prerequisites**: Docker, .NET 10 SDK, Node.js (`.nvmrc`), pnpm

**CI/CD**: Push to `main` → auto-deploy (no SSG rebuild). Full SSG rebuild: nightly after the backup (`backup.yml`); on demand via the admin panel, `make rebuild-ssg`, or a manual deploy with `rebuild_ssg`.

## Where to write things down

Four files, four jobs — plus GitHub issues for open items. Putting a write-up in the wrong one is how `CHANGELOG.md` reached 1804 lines.

| File | Job |
|------|-----|
| `CHANGELOG.md` | **Index only.** One line per change, grouped by deploy date (CalVer). Never a paragraph. |
| `docs/changelog-archive/<YYYY>-H<1\|2>.md` | The full write-up behind that line. Article source material. |
| `docs/incidents/` | Postmortems for anything that broke production. Start from `_TEMPLATE.md`. |
| `docs/STATUS.md` | Where the project is *now*: in flight, deliberately-not-doing. Links to issues; never copies them. |
| GitHub issues | **Every open item** (bug, review finding, deferred work), one issue each, labelled (`reader-engine`, `phase-3-gate`, …). A PR closes it with `Fixes #N`. Public: nothing private. Old STATUS items move to an issue when someone touches them. |

Load-bearing decisions still go to `docs/01-architecture/adr/`. Details: `.claude/commands/changelog.md`.

## Commands

```bash
# Setup (one-time)
cp .env.example .env          # Edit with real values
make nginx-setup              # Install nginx config (Linux)
make nginx-setup-mac          # Mac
make up                       # Start services

# Docker
make up / down / restart / logs / status
make build                    # docker compose up -d --build
make rebuild                  # full rebuild --no-cache
make clean-ssg                # remove dist/ssg*
make fix-permissions          # Fix volume permissions
make featured SLUGS="a b c"   # Replace the Popular shelf (run on the server; ranks 1..N in order)
make featured-show            # Print the current Popular shelf

# After editing .env, `docker compose restart <svc>` does NOT re-read env vars
# (they are baked in at container creation). Use force-recreate:
#   docker compose up -d --force-recreate --no-deps <service>

# Deploy
# Deploy: merge to main (deploy.yml). Break-glass: gh workflow run deploy.yml [-f rollback_commit=<sha>]
make rebuild-ssg              # Queue a Full SSG rebuild job (ssg-worker), follow it to the end

# Database
make backup                   # Backup to ~/backups/textstack/
make backup-list              # List all backups
make restore FILE=path.gz     # Restore from backup
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'   # DB shell (user/db come from .env; prod's user is not `app`)
docker compose down -v                      # Reset all (loses data)

# Tests
dotnet test                                 # All tests (.runsettings excludes Category=Load; none exist today)
dotnet test tests/TextStack.UnitTests
dotnet test tests/TextStack.IntegrationTests
dotnet test tests/TextStack.Extraction.Tests
dotnet test tests/TextStack.Search.Tests
dotnet test --filter "Name~TestMethodName"  # Single test
pnpm -C apps/web test                       # Frontend unit tests (Vitest)
pnpm -C apps/web test:watch                 # Watch mode
pnpm -C apps/web test:e2e                   # Playwright E2E (headless)
pnpm -C apps/web test:e2e:ui                # Playwright E2E (UI mode)

# Lint
dotnet format textstack.sln                  # Backend

# CLI commands (via dotnet run --project backend/src/Api --)
# create-admin <email> <password> [role]
# optimize-images [--dry-run]
# import-textstack <book-path>
# backfill-pdf-page-counts [--dry-run]   (fills null UserBook.PageCount for PDF uploads)

# Local dev (no Docker)
dotnet run --project backend/src/Api
dotnet run --project backend/src/Worker
pnpm -C apps/web dev          # http://localhost:5173
pnpm -C apps/admin dev        # http://localhost:81

# Build
pnpm -C apps/web build
pnpm -C apps/admin build

# Migrations
dotnet ef migrations add <Name> --project backend/src/Infrastructure --startup-project backend/src/Api
docker compose run --rm -e MIGRATE_TARGET=<Name> migrator   # Roll back to <Name> (0 = all). Never put MIGRATE_TARGET in .env
# Only the migrator migrates (ADR-021). Api: Development + launchSettings flag only; behind schema → /health/ready 503

# Mobile app (apps/mobile)
cd apps/mobile
npx expo start                    # Dev server (Expo Go — limited native modules)
npx expo run:ios                  # Local iOS build (requires Xcode)
npx expo run:android              # Local Android build (requires Android Studio)
npx tsc --noEmit                  # TypeScript check
npm run build:dev:ios             # EAS dev build (cloud, requires eas login)
npm run build:prod                # EAS production build
npm run submit:ios                # Submit to App Store
npm run submit:android            # Submit to Google Play
```

| Service | Local | Prod |
|---------|-------|------|
| Web | http://localhost:5173 | https://textstack.app |
| API | http://localhost:8080 | https://textstack.app/api |
| API Docs | http://localhost:8080/scalar/v1 | — |
| Admin | http://localhost:81 | https://textstack.dev |
| Aspire | http://127.0.0.1:18888 | — |

**Storage**: `./data/storage/` — catalog `{id[..2]}/{id}/{file}`, uploads `users/{userId[..2]}/{userId}/books/{userBookId}/` (`LocalFileStorageService.cs`).

## Architecture

```
API → Application → Domain ← Infrastructure
                      ↑
                   Worker
```

- **Domain**: Pure C#, no framework deps
- **Application**: Business logic, interfaces (`IAppDbContext`, `IFileStorageService`)
- **Contracts**: Shared DTOs (request/response models) used by API and Application
- **Infrastructure**: EF Core (snake_case naming), storage implementations
- **API/Worker**: Orchestration, DI

**Backend class libraries** (`backend/src/`, beyond the layers above): `Extraction` (EPUB/PDF parsers), `Search` (FTS providers), `Tts` (Edge TTS), `Vocabulary` (DistractorGenerator), `Ai/` (`TextStack.Ai.*`: LLM client, agents, tools, evals, MCP server). There is no EPUB *builder* any more — `TextStack.Epub` was deleted 2026-09-28 with the export it existed for.

### Shared Frontend Packages (`packages/`)

Cross-platform TS code shared by **both** web and mobile, consumed via source path-aliases (NOT published / built) — `apps/web` resolves them in `vite.config.ts` + `tsconfig.json`; mobile via its bundler config.
- **`@textstack/shared`** (`packages/shared/src/`) — the canonical home for platform-agnostic logic: `api/` (client), `types/api`, `i18n/`, `anon/`, `reader/` (bookProgress, progressPayload, continueReading), `vocabLevel`, `vocabularyConstants`, `lib/pathPrefix`. Edit here, not in app copies, when changing logic both clients need.
- **`@textstack/reader-engine`** (`packages/reader-engine/`) — the reader engine ([ADR-025](docs/01-architecture/adr/ADR-025-reader-engine-package.md)): the reader's rendering and position; mobile (reflow + PDF) and web read only through it; old readers deleted in Phase 6 (#848 web, #866 mobile, #868 cleanup). Own rules in its `CLAUDE.md`, own agent `.claude/agents/reader-engine.md`, built test-first.

**Middleware pipeline** (order matters): `ForwardedHeaders` → `Cors` → `AppVersion` (mobile `X-App-Version` → log scope + Sentry tag) → `ExceptionMiddleware` → `StaticFiles(/storage)` → `/health` → `SiteContext` → `LanguageContext` → `Routing` → `McpKeyAuth` → `RateLimiter` (must follow Routing, or per-endpoint policies are inert) → `GuestActivity` (LastActiveAt, 10 min debounce) → `AdminAuth` (conditional on `/admin/*`) → `PathGates` (`/me/*` → 401 without a user, `/internal/*` → 403 off the docker network; ADR-024)

User routes live under `/me`; `/internal` is local-only by middleware. Every other route is listed in `tests/TextStack.UnitTests/Routes/routes.public.txt` — a new public route fails `PublicRoutesSnapshotTests` until it is added there.

**Site resolution**: Single-site permanent (ADR-007). `SiteContextMiddleware` resolves host → SiteId. The single site id is exposed process-wide via `ICurrentSite` (config `Site:Id`, default `SiteConstants.DefaultSiteId`); EF global query filters key on it (see `ISiteScoped`). The dev `?site=` override was removed (R1b) — internal host-less callers (e.g. `ssg-worker.mjs`) must send a resolvable `Host` header.

**Patterns**:
- Endpoints: `Map{Domain}Endpoints()` in `Api/Endpoints/`
- Test naming: `{Method}_{Scenario}_{Expected}`

### Frontend Architecture

**No Redux/Zustand** — React Context only. Provider hierarchy in `App.tsx`:
```
BrowserRouter → SiteProvider → AuthProvider → GuestLimitsProvider → NativeLanguageProvider → DownloadProvider → AppRoutes
  └─ /:lang/* → LanguageProvider → Header + page routes
```

- **SiteProvider**: Fetches `/api/site/context`, provides `site` to all children
- **AuthProvider**: Google Sign-In, email/password, Apple auth, auto-refresh token, skips Google for bots
- **GuestLimitsProvider**: Tracks guest usage limits (pages read, words saved) before requiring sign-up
- **NativeLanguageProvider**: User's native language for translations/definitions direction
- **DownloadProvider**: Offline reading — IndexedDB cache, download progress, resume
- **LanguageProvider**: Inside language routes only. Extracts `lang` from URL params, provides `switchLanguage()`, `getLocalizedPath()`

Context files: `apps/web/src/context/{Site,Auth,GuestLimits,NativeLanguage,Download,Language}Context.tsx`

**i18n**: JSON file in `apps/web/src/locales/en.json`. Hook: `useTranslation()`. Languages: `['en']`.

**Routing**: Language-prefixed routes (`/:lang/books`, `/:lang/authors`, etc). Root `/` → `/en`.

**API client**: `useApi()` hook → `createApi(language)` → methods like `getBooks()`, `getBook(slug)`. Uses `fetchJsonWithRetry()`.

**API client layer**: `apps/web/src/api/` — modules incl. `client.ts` (base; runs `@textstack/shared`'s api client in cookie mode via `initApi({ credentials: 'include' })`), `auth.ts`, `explain.ts`, `oauth.ts`, `readingTracking.ts`, `reviewQuestions.ts`, `translation.ts`, `tts.ts`, `userBooks.ts`, `userData.ts`, `vocabulary.ts`. `useApi()` hook wraps these.

**Hooks** (`apps/web/src/hooks/`), e.g. Reader: `useReadingSession`, `useReadingProgress`, `useReaderKeyboard`, `useReaderSettings`, `useReaderVocabulary`, `useImmersiveMode`, `useInBookSearch`, `useTextSelection`, `useTextTranslation`, `useDarkMode`. Library/data: `useLibrary`, `useBookmarks`, `useHighlights`, `useBookStats`, `useVocabulary`, `useVocabularyReview`, `useVocabDailyStats`, `useReadingStats`, `useReadingGoals`, `useAchievements`. UI: `useFocusTrap`, `useIsMobile`, `useScrolled`, `useDebounce`, `useSoundEffects`, `useCardAnswer`, `useQuickStats`. Network: `useNetworkRecovery`.

**Admin panel**: Separate React app (`apps/admin/`), English-only, JWT auth. Pages: Dashboard, Upload, User Uploads, Jobs queue, Editions list/edit, Authors CRUD, Genres CRUD, Chapter editor, SSG rebuild + job detail, Auto Publish, SEO Backfill, Book Quality, AI Quality, Tools, Settings.

## Search

PostgreSQL FTS only: raw SQL (Dapper) in `TextStack.Search/Providers/PostgresFts/PostgresSearchProvider.cs`, querying `chapters`/`editions` directly. `chapters.search_vector` is maintained by a DB trigger — there is no indexer and nothing to reindex. (The write-only `search_documents` copy, its `reindex-search` CLI and the never-deployed Meilisearch provider were deleted 2026-10-01.)

After schema changes:
1. Update `PostgresSearchProvider`
2. Run `dotnet test tests/TextStack.IntegrationTests --filter SearchEndpoint`
3. Test: `https://textstack.app/en/search?q=test`

## Test Projects

```
tests/
├── TextStack.UnitTests/           # Pure logic, no DB
├── TextStack.IntegrationTests/    # API tests against running server (LiveApiFixture → localhost:8080, override via API_URL env)
├── TextStack.Extraction.Tests/    # Book parsing (EPUB/PDF)
├── TextStack.Search.Tests/        # Search logic
├── TextStack.AiEvals/             # Eval runners on fake LLMs; live evals skip w/o OPENAI_API_KEY
├── TextStack.Ai.Mcp.Tests/        # MCP over-the-wire (loopback)
apps/web/e2e/                      # Playwright E2E (chromium, mobile, admin projects)
apps/mobile/e2e/                   # Mobile Playwright E2E
```

Test naming convention: `{MethodName}_{Scenario}_{ExpectedResult}`

**E2E setup**: Global setup authenticates test user + admin, discovers books from API → `.test-data.json`. Auth state stored in `apps/web/e2e/.auth/`. Page object helpers in `apps/web/e2e/helpers/`.

**Running the integration suite locally**: it trips its own rate limits at production values — a dozen classes seed a book by clipping one, and the GDPR-delete class calls account-delete four times. CI raises the knobs; do the same locally or you will read 429s as failures:

```bash
CLIP_PERMIT_LIMIT=200 ACCOUNT_DELETE_PERMIT_LIMIT=50 GUEST_SESSION_PERMIT_LIMIT=50 \
  USER_LOGIN_PERMIT_LIMIT=100 \
  docker compose up -d --no-deps --force-recreate api
dotnet test tests/TextStack.IntegrationTests
docker compose up -d --no-deps --force-recreate api   # back to production values
```

Also: the windows are 1–5 minutes, so **two overlapping runs throttle each other**. Run the suite once and read the result, rather than re-running to confirm a failure.

**Test env vars**:
- `ENABLE_TEST_AUTH=true` — enables test auth endpoints (needed for integration + E2E)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — needed for admin E2E
- Integration tests set `Host` header: `general.localhost` (public), `textstack.dev` (admin)

**Vocabulary E2E tests** (`apps/web/e2e/tests/vocabulary.spec.ts`): serial suite; `beforeAll` logs in, wipes the test user's words and saves 3 common words via the API (inline `TEST_WORDS` — rare words would route to `WordLookup` and never reach the SRS list). Covers: flashcards is the default mode, the streak badge shows when words are due, a review session starts in flashcard mode.

## Extraction Pipeline

Supported formats: EPUB, PDF. Processing order: Spelling → Hyphenation → Typography → Semantic → Linter. Details in `backend/src/Extraction/TextStack.Extraction/RULES.md`. ARM64 caveat: uses compiled `Regex` not `[GeneratedRegex]` (SIGILL bug).

## Package Management

Central versioning via `Directory.Packages.props` — don't add `<Version>` in individual csproj files. Target: `net10.0` (set in `Directory.Build.props`).


## Rules that bite (always on)

- **`chapter_number` is an ordering key, not a display ordinal** (some editions start at 0, some at 1 or 2). Show a chapter's **title**; use the number only to sort.
- **Mobile reading path waits for neither a token nor a network** — chapter loaders read SQLite first, then refresh from the server (`chapterLoadOrder.test.ts`). Nothing on the reading path may need an account.
- **`offlineDb.web.ts` mirrors every export of `offlineDb.ts`**, or the web bundle (which mobile e2e runs against) fails to resolve.
- **Guest = a real session.** `isAuthenticated` is `user !== null`; account-only questions go through `capabilitiesFor(user)` (mobile `capabilities.ts`), never inline `user?.isGuest` (ADR-014).
- **MCP tool count is asserted in four tests** and descriptions are mirrored verbatim in `Contracts/Mcp/McpManifest.cs` — change all together.
- **Docs, comments, ADRs, commits, PRs: English only.** Cyrillic is allowed only as real input data (tests, fixtures, seed migrations, translation examples).
- **Never deploy by SSH.** Deploy = merge to `main`; break-glass `gh workflow run deploy.yml`.

## Reference — read when the task touches it

| Topic | File |
|---|---|
| Features: entities, user books, translate/explain/TTS, vocabulary SRS, guests, auth, auto publish, SEO backfill, SSG | [`docs/claude/features.md`](docs/claude/features.md) |
| Every API route group | [`docs/claude/api-endpoints.md`](docs/claude/api-endpoints.md) |
| Where things live (key files table) | [`docs/claude/key-files.md`](docs/claude/key-files.md) |
| Mobile: Expo, offline, reading path, Play/OTA release | [`docs/claude/mobile.md`](docs/claude/mobile.md) |
| CI/CD, deployment, nginx, MCP server, telemetry, verifying SSG | [`docs/claude/operations.md`](docs/claude/operations.md) |
