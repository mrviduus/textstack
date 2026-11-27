# CLAUDE.md

This file gives guidance to Claude Code (claude.ai/code) for work with the code in this repository.

## Project

A personal book library with an e-book reading screen. The reader adds an EPUB, MOBI, AZW3, FB2, CBZ or PDF file. Then the reader reads it on the web and on Android, with sync, and offline on the phone.

**Live**: [textstack.app](https://textstack.app/) (app) · [textstack.dev](https://textstack.dev/) (admin shell)

**Stack**: ASP.NET Core (API + Worker) + PostgreSQL (one database, `textstack_v2`, Dapper) + React + React Native (Expo)

**Prerequisites**: Docker, .NET 11 SDK, Node.js (`.nvmrc`), pnpm

**CI/CD**: Push to `main` → auto-deploy.

**History**: the V2 program (#1013) finished on 2026-11-17. The result: one database, one reading screen, and no public catalog, SEO or SSG. The plan and the decisions stay as history: [`docs/internal/v2/`](docs/internal/v2/), ADR-029–032. Where the project is now: [`docs/STATUS.md`](docs/STATUS.md).

**The reading screen** ([ADR-029](docs/architecture/adr/ADR-029-foliate-for-v2-epub.md) sandbox, [ADR-032](docs/architecture/adr/ADR-032-one-engine-foliate-fork.md) one engine):
- The engine is our foliate-js fork (`mrviduus/foliate-js`, pinned by SHA). `packages/reader/src/build.mjs` builds it into a generated page. The page is committed and runs under a nonce CSP.
- Android host: `apps/mobile/src/components/reader/ReaderScreen.tsx`, route `app/my-books/read/…`. Dev route: `app/dev/epub.tsx`, only in `__DEV__`.
- Web host: `apps/web/src/components/reader/ReaderHost.tsx`, route `/:lang/library/my/:id/read`. Dev route: `/dev/reader`, only on the dev server (`main.tsx`).
- The web build ships `dist/reader/`: a no-store frame shell and the content-hashed page script. nginx `sub_filter` fills the nonce in the shell. The nginx locations are in `infra/nginx/textstack.conf`, and `prodCsp.check.mjs` checks them.
- `packages/reader/` has its own README. iOS has no reading screen (M6 D4).

## Where to write things down

The PR is the changelog (#1220). Readers see the `/changelog` page: merged PRs by week. It shows the `public` PRs in plain words; `/changelog-week` chooses them each week. The app has no GitHub releases: Android notes go to Play's "What's new". Nobody writes changelog lines.

| Where | Job |
|------|-----|
| The PR | **Title** = one scannable line. **One area label** (`reading`, `library`, `highlights`, `vocabulary`, `assistant`, `account`, `data`, `ops`, `documentation`; CI fails without one). **Description** = the full write-up, the source material for articles. |
| `CHANGELOG.md` | **Frozen.** History up to the switch; never add to it. Older halves live in git history only. |
| `docs/internal/incidents/` | Postmortems for anything that broke production. Start from `_TEMPLATE.md`. |
| `docs/STATUS.md` | Where the project is *now*: work in flight, and what we deliberately do not do. It links to issues and never copies them. |
| GitHub issues | **Every open item** (bug, review finding, deferred work), one issue each, with a label. A PR closes the issue with `Fixes #N`. Issues are public: put nothing private in them. When someone touches an old STATUS item, the item moves to an issue. |

Decisions that the design depends on still go to `docs/architecture/adr/`. Details: `.claude/commands/changelog.md`.

## Commands

```bash
# Setup (one-time)
cp .env.example .env          # Edit with real values
make nginx-setup              # Install nginx config (Linux)
make nginx-setup-mac          # Mac
make fix-permissions          # Create data/library etc. owned by uid 1000 (else uploads fail)
make up                       # Start services (the migrator runs first; api/worker wait for it)

# Docker
make up / down / restart / logs / status
make build                    # docker compose up -d --build
make rebuild                  # full rebuild --no-cache
make fix-permissions          # Fix volume permissions

# After editing .env, `docker compose restart <svc>` does NOT re-read env vars
# (they are baked in at container creation). Use force-recreate:
#   docker compose up -d --force-recreate --no-deps <service>

# Deploy: merge to main (deploy.yml). Break-glass: gh workflow run deploy.yml [-f rollback_commit=<sha>]

# Database (textstack_v2; TEXTSTACK_DB in .env)
make backup                   # Checked dump to ~/backups/textstack/
make backup-list              # List all backups
make restore FILE=path.gz     # Restore into an absent database (make migrate-drop first)
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" textstack_v2'   # DB shell (user from .env; prod's user is not `app`)
docker compose down -v                      # Reset all (loses data)

# Migrations: plain SQL in database/migrations (database/README.md, ADR-026). New change = NNNN_<name>.up.sql + .down.sql
make migrate                  # migrator up, with this checkout's database/ mounted (no rebuild needed)
make migrate-status           # applied / pending / unknown versions
make migrate-down V=<n>       # revert versions above n — schema first, then the code
make migrate-drop CONFIRM=textstack_v2   # drop the whole database (the baseline has no down)
# Only the migrator migrates (ADR-021); the Api never does. Behind schema → /health/ready 503

# Tests
dotnet test                                 # All tests (.runsettings excludes Category=Load)
dotnet test tests/TextStack.UnitTests
dotnet test tests/TextStack.IntegrationTests
dotnet test tests/TextStack.Persistence.Tests   # Dapper repositories on real Postgres (Testcontainers; needs Docker)
dotnet test --filter "Name~TestMethodName"  # Single test
pnpm -C apps/web test                       # Frontend unit tests (Vitest)
pnpm -C apps/web test:watch                 # Watch mode
pnpm -C apps/web test:e2e                   # Playwright E2E (headless)
pnpm -C apps/web test:e2e:ui                # Playwright E2E (UI mode)
node tools/checks/check-doc-links.mjs            # Every relative link in tracked .md files resolves (CI docs-links)

# Lint
dotnet format textstack.sln                  # Backend

# CLI (via dotnet run --project backend/src/Api --)
# create-admin <email> <password>            (one role: Admin, ADR-031 decided 7)

# Local dev (no Docker)
# From the repo root; the defaults /storage and /library are container paths. Two siblings, never nested.
# ConnectionStrings__Default must point at a textstack_v2 built by `make migrate`.
export Storage__RootPath=data/storage Storage__LibraryRoot=data/library
dotnet run --project backend/src/Api
dotnet run --project backend/src/Worker
pnpm -C apps/web dev          # http://localhost:5173
pnpm -C apps/admin dev        # http://localhost:81

# Build
pnpm -C apps/web build
pnpm -C apps/admin build

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
| Aspire | http://127.0.0.1:18888 (`--profile observability`) | — |

**Storage**:
- `./data/storage/` (`/storage`, the public root) holds avatars and the covers of uploaded books (`LocalFileStorageService.cs`).
- The book files are in `./data/library/` (`/library`, `Storage:LibraryRoot`), outside the public root: `library/…`, `uploads/…` (`LibraryFileStore.cs`).

## Architecture

```
API → Application → Domain ← Infrastructure
                      ↑
                   Worker
```

- **Domain**: Pure C#, no framework dependencies
- **Application**: Business logic, repository interfaces
- **Contracts**: Shared DTOs (request/response models) for API and Application
- **Infrastructure**: Dapper repositories over one `AppDataSource` (`Infrastructure/Persistence/`, ADR-028), file stores. No EF Core.
- **API/Worker**: Orchestration, DI. The Worker runs `RetentionCleanupWorker` (retention rules and the byte sweeps of the library). The Worker parses no books: the reading screen (`packages/reader`) is the only parser (ADR-033).

**Backend class libraries** (`backend/src/`, in addition to the layers in the diagram): `Tts` (Edge TTS), `Vocabulary` (SRS, distractors), `Observability` (Sentry scrubber), `Ai/` (`TextStack.Ai.*`: LLM client, evals, MCP server).

### Shared Frontend Package (`packages/`)

**`@textstack/shared`** (`packages/shared/src/`): cross-platform TS for web and mobile.
- Nobody publishes or builds the package. The apps use it through source path aliases: `apps/web` resolves it in `vite.config.ts` and `tsconfig.json`, mobile in its bundler config.
- It holds the platform-agnostic logic: `api/` (client, sync calls: `sync`, `books`, `upload`, `vocabulary`), `types/api`, `i18n/`, `reader/` (locators, `pageEntry`, progress), `lib/` (`capabilities`, …), `vocabularyConstants`.
- If both clients need a change, edit it here, not in app copies.

**Middleware pipeline** (`backend/src/Api/Program.cs`). The order matters:
1. `ForwardedHeaders`
2. `Cors`
3. `AppVersion`: mobile `X-App-Version` → log scope + Sentry tag
4. `ExceptionMiddleware`
5. `UserStoragePolicy`: 404 under users/, library/, uploads/. It must come before StaticFiles.
6. `StaticFiles(/storage)`
7. `/health`, `/health/ready`
8. `Routing`
9. `WriteFreeze`: off if not configured
10. `McpKeyAuth`
11. `RateLimiter`: it must come after Routing. If not, the per-endpoint policies do nothing.
12. `AccountGuard`: refuses the tokens of a reset or deleted account
13. `GuestActivity`: LastActiveAt, 10 min debounce
14. `AdminAuth`: `/admin/*` except `/admin/auth`
15. `PathGates`: `/me/*` → 401 without a user, `/internal/*` → 403 off the docker network (ADR-024)

User routes are under `/me`; the sync API is under `/me/v2`. A middleware keeps `/internal` local-only. `tests/TextStack.UnitTests/Routes/routes.public.txt` lists every other route. A new public route fails `PublicRoutesSnapshotTests` until you add it to that file.

**Patterns**:
- Endpoints: `Map{Domain}Endpoints()` in `Api/Endpoints/`
- SQL inline, next to the method that runs it; no stored procedures (`docs/architecture/data-access.md` rule 13)
- Test naming: `{Method}_{Scenario}_{Expected}`

### Frontend Architecture

**No Redux/Zustand** — React Context only. Provider hierarchy in `apps/web/src/App.tsx`:
```
BrowserRouter → AuthProvider → GuestLimitsProvider → NativeLanguageProvider → AppRoutes
  └─ /:lang/* → LanguageProvider → Header + page routes
```

- **AuthProvider**: Google Sign-In, email/password, Apple auth, auto-refresh token, guest sessions
- **GuestLimitsProvider**: the word-count threshold that creates a guest session
- **NativeLanguageProvider**: the reader's native language, for the direction of translations and definitions
- **LanguageProvider**: only inside language routes. Takes `lang` from the URL params and gives `switchLanguage()`, `getLocalizedPath()`

Context files: `apps/web/src/context/{Auth,GuestLimits,NativeLanguage,Language}Context.tsx`

**Pages**: landing, library, book detail, reading screen, vocabulary + review, highlights, and static pages (about, privacy, terms, dmca, delete-account, contact, mcp, changelog, oauth consent, device, connect-extension, reset-password). Root `/` → `/en`.

**i18n**: `apps/web/src/locales/en.json`. Hook: `useTranslation()`. Languages: `['en']`.

**API client layer**: `apps/web/src/api/` — `client.ts` (runs `@textstack/shared`'s api client in cookie mode via `initApi({ credentials: 'include' })`), `sync.ts` (sync), `auth.ts`, `oauth.ts`, `translation.ts`, `tts.ts`, `userBooks.ts`, `vocabulary.ts`.

**Hooks** (`apps/web/src/hooks/`), for example, reading screen: `useReadingSession`, `useReaderSettings`, `useReaderVocabulary`, `useImmersiveMode`, `useTextTranslation`, `useTts`, `useDarkMode`; library: `useLibrarySource`, `useLibraryStatus`, `useLibrarySort`, `useLibrarySearch`, `useBookActions`; vocabulary: `useVocabulary`, `useVocabularyReview`; UI: `useFocusTrap`, `useIsMobile`, `useScrolled`, `useDebounce`, `useOnline`.

**Admin panel**: `apps/admin/`, a shell (M6 D2): login and an empty home. Backend: `/admin/auth/*` + `AdminAuthMiddleware`. `create-admin` makes the admins.

## Test Projects

```
tests/
├── TextStack.UnitTests/           # Pure logic, no DB
├── TextStack.IntegrationTests/    # API tests against running server (LiveApiFixture → localhost:8080, override via API_URL env)
├── TextStack.Persistence.Tests/   # Dapper repositories, Testcontainers Postgres built by database/migrate.sh (ADR-028)
├── TextStack.AiEvals/             # Eval runners on fake LLMs; live evals skip w/o OPENAI_API_KEY
├── TextStack.Ai.Mcp.Tests/        # MCP over-the-wire (loopback)
apps/web/e2e/                      # Playwright E2E (auth, smoke, delete-account, reader, reader-dev, sync)
apps/mobile/e2e/                   # Mobile Playwright E2E (not run by CI; needs a live backend)
```

**E2E setup**: global setup logs in the test user (`helpers/api.ts` `testLogin`) and stores its state in `apps/web/e2e/.auth/`.

**Running the integration suite locally**: at production values, the suite goes over its own rate limits. CI sets higher limits. Do the same locally, or you will read 429s as failures:

```bash
make migrate                  # once: the database the suite reads
CLIP_PERMIT_LIMIT=200 ACCOUNT_DELETE_PERMIT_LIMIT=50 GUEST_SESSION_PERMIT_LIMIT=50 \
  USER_LOGIN_PERMIT_LIMIT=100 DEVICE_CODE_PERMIT_LIMIT=50 MCP_KEYS_PERMIT_LIMIT=100 \
  docker compose up -d --no-deps --force-recreate api
SYNC_API_TESTS=1 dotnet test tests/TextStack.IntegrationTests   # without SYNC_API_TESTS the /me/v2 classes skip
# DB-backed tests (DeviceAuth, HealthReadyLibrary, …) skip unless Postgres is reachable: start the
# stack with `-f docker-compose.yml -f .github/docker-compose.ci-db.yml` and set
# TEST_DB_CONNECTION="Host=localhost;Port=5432;Database=textstack_v2;Username=<user>;Password=<pw>"
docker compose up -d --no-deps --force-recreate api   # back to production values
```

The rate-limit windows are 1–5 minutes, so **two overlapping runs throttle each other**. Run the suite once and read the result. Do not run it again to confirm a failure.

**Test env vars**:
- `ENABLE_TEST_AUTH=true`: turns on the test auth endpoints (the integration and E2E tests need them)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD`: the admin login tests
- `SYNC_API_TESTS=1`, `TEST_DB_CONNECTION`: see "Running the integration suite locally"

## Package Management

`Directory.Packages.props` holds all package versions. Do not add `<Version>` in a csproj file. Target: `net11.0` (set in `Directory.Build.props`).

## Rules that bite (always on)

- **`chapter_number` is an ordering key, not a display ordinal.** Some books start at 0, some at 1 or 2. Show a chapter's **title**; use the number only to sort.
- **Mobile reading needs no token and no network.** The reading screen opens the book file that stays on the device (`apps/mobile/src/lib/reader/hostStorage.ts`) and the local library (`localLibrary.ts`). Sync runs beside it. The reading path must not need an account.
- **A `.web.ts` twin mirrors every export** of its native module (`apps/mobile/src/lib/offlineDb.web.ts`, `reader/deviceLibrary.web.ts`). If not, the web bundle fails to resolve. Mobile e2e runs against the web bundle.
- **Guest = a real session.** `isAuthenticated` is `user !== null`. Send account-only questions through `capabilitiesFor(user)` (`packages/shared/src/lib/capabilities.ts`; mobile `capabilities.ts` re-exports it). Never inline `user?.isGuest` (ADR-014).
- **MCP has 18 tools; four tests assert the count** (`McpManifestDriftTests`, `McpStdioSmokeTests`, `McpOverTheWireTests`, `McpManifestEndpointTests`). The descriptions are in one place: `backend/src/Contracts/Mcp/McpManifest.cs`. Change all of them together.
- **ARM64: compiled `Regex`, never `[GeneratedRegex]`** (SIGILL bug).
- **Docs, comments, ADRs, commits, PRs: English only.** The English follows [`docs/writing.md`](docs/writing.md) (simple technical English) and uses the words of [`docs/glossary.md`](docs/glossary.md). Cyrillic is allowed only as real input data (tests, fixtures, seed migrations, translation examples).
- **Never deploy by SSH.** Deploy = merge to `main`; break-glass `gh workflow run deploy.yml`.

## Area guides and key files

When you work in an area, its guide loads by itself: `backend/CLAUDE.md` (key files, every API route) and `apps/mobile/CLAUDE.md` (Expo, offline, Play/OTA release). Procedures and topic guides are skills in `.claude/skills/` (`features`, `operations`, `add-entity`). Runbooks and postmortems: `docs/internal/ops/`, `docs/internal/incidents/`.

| Area | Path |
|------|------|
| Reading screen host, web | `apps/web/src/pages/ReaderPage.tsx`, `apps/web/src/components/reader/ReaderHost.tsx`, `apps/web/src/lib/readerSync.ts` |
| Shared client + locators | `packages/shared/src/api/sync.ts`, `packages/shared/src/reader/pageEntry.ts` |
| Guest policy | `packages/shared/src/lib/capabilities.ts` |
| Web contexts, pages | `apps/web/src/context/`, `apps/web/src/pages/` |
| Library (web) | `apps/web/src/pages/LibraryPage.tsx`, `UserBookDetailPage.tsx` |
| Vocabulary (web) | `apps/web/src/pages/VocabularyPage.tsx`, `VocabularyReviewPage.tsx`, `apps/web/src/components/vocabulary/` |
| Highlights (web) | `apps/web/src/pages/HighlightsPage.tsx` |
| TTS (web) | `apps/web/src/hooks/useTts.ts` |
| Changelog page | `apps/web/src/lib/changelog.ts`, `apps/web/src/pages/ChangelogPage.tsx` |
| Admin shell | `apps/admin/src/pages/` (login, home) |
| nginx | `infra/nginx/textstack.conf` |
| Workflows | `.github/workflows/` (`ci.yml`, `deploy.yml`, `backup.yml`, `restore-drill.yml`, `health-check.yml`, `images.yml`) |
