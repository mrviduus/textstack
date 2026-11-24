# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Personal book library w/ a Kindle-like reader. Upload EPUB, MOBI, AZW3, FB2, CBZ or PDF → read it on web and Android, synced, offline on the phone.

**Live**: [textstack.app](https://textstack.app/) (app) · [textstack.dev](https://textstack.dev/) (admin shell)

**Stack**: ASP.NET Core (API + Worker) + PostgreSQL (one database, `textstack_v2`, Dapper) + React + React Native (Expo)

**Prerequisites**: Docker, .NET 11 SDK, Node.js (`.nvmrc`), pnpm

**CI/CD**: Push to `main` → auto-deploy.

**History**: the V2 program (#1013) finished 2026-11-17: one database, one reader, the public catalog/SEO/SSG retired. Plan and decisions, kept as history: [`docs/internal/v2/`](docs/internal/v2/), ADR-029–032. Where the project is now: [`docs/STATUS.md`](docs/STATUS.md).

**The reader** ([ADR-029](docs/architecture/adr/ADR-029-foliate-for-v2-epub.md) sandbox, [ADR-032](docs/architecture/adr/ADR-032-one-engine-foliate-fork.md) one engine): our foliate-js fork (`mrviduus/foliate-js`, pinned by SHA) built by `packages/reader/src/build.mjs` into a committed generated page under a nonce CSP. Hosts: Android `apps/mobile/src/components/reader/ReaderScreen.tsx` (route `app/my-books/read/…`; dev route `app/dev/epub.tsx`, `__DEV__` only) and web `apps/web/src/components/reader/ReaderHost.tsx` (route `/:lang/library/my/:id/read`; dev route `/dev/reader`, dev server only, `main.tsx`). The web build ships `dist/reader/` = a no-store frame shell (nonce filled by nginx `sub_filter`) + the content-hashed page script; nginx locations in `infra/nginx/textstack.conf`, checked by `prodCsp.check.mjs`. Own README in `packages/reader/`. iOS has no reader (M6 D4).

## Where to write things down

The PR is the changelog (#1220). Readers see the `/changelog` page (merged PRs by week; `public` ones in plain words, chosen weekly by `/changelog-week`). No GitHub releases for the app: Android notes go to Play's "What's new". Nobody writes changelog lines.

| Where | Job |
|------|-----|
| The PR | **Title** = one scannable line. **One area label** (`reading`, `library`, `highlights`, `vocabulary`, `assistant`, `account`, `data`, `ops`, `documentation`; CI fails without one). **Description** = the full write-up, article source material. |
| `CHANGELOG.md` | **Frozen.** History up to the switch; never add to it. Older halves live in git history only. |
| `docs/internal/incidents/` | Postmortems for anything that broke production. Start from `_TEMPLATE.md`. |
| `docs/STATUS.md` | Where the project is *now*: in flight, deliberately-not-doing. Links to issues; never copies them. |
| GitHub issues | **Every open item** (bug, review finding, deferred work), one issue each, labelled. A PR closes it with `Fixes #N`. Public: nothing private. Old STATUS items move to an issue when someone touches them. |

Load-bearing decisions still go to `docs/architecture/adr/`. Details: `.claude/commands/changelog.md`.

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

**Storage**: `./data/storage/` (`/storage`, public root) holds avatars and upload covers (`LocalFileStorageService.cs`). Book bytes: `./data/library/` (`/library`, `Storage:LibraryRoot`), outside the public root — `library/…`, `uploads/…` (`LibraryFileStore.cs`).

## Architecture

```
API → Application → Domain ← Infrastructure
                      ↑
                   Worker
```

- **Domain**: Pure C#, no framework deps
- **Application**: Business logic, repository interfaces
- **Contracts**: Shared DTOs (request/response models) used by API and Application
- **Infrastructure**: Dapper repositories over one `AppDataSource` (`Infrastructure/Persistence/`, ADR-028), file stores. No EF Core.
- **API/Worker**: Orchestration, DI. The Worker runs `RetentionCleanupWorker` (retention rules + the library's byte sweeps). It parses no books: the reader is the only parser (ADR-033).

**Backend class libraries** (`backend/src/`, beyond the layers above): `Tts` (Edge TTS), `Vocabulary` (SRS, distractors), `Observability` (Sentry scrubber), `Ai/` (`TextStack.Ai.*`: LLM client, agents, tools, evals, MCP server).

### Shared Frontend Package (`packages/`)

**`@textstack/shared`** (`packages/shared/src/`) — cross-platform TS shared by web and mobile, consumed via source path-aliases (not published / built; `apps/web` resolves it in `vite.config.ts` + `tsconfig.json`, mobile via its bundler config). The home for platform-agnostic logic: `api/` (client, sync calls: `sync`, `books`, `upload`, `vocabulary`), `types/api`, `i18n/`, `reader/` (locators, `pageEntry`, progress), `lib/` (`capabilities`, `pathPrefix`, …), `vocabLevel`, `vocabularyConstants`. Edit here, not in app copies, when both clients need it.

**Middleware pipeline** (`backend/src/Api/Program.cs`; order matters): `ForwardedHeaders` → `Cors` → `AppVersion` (mobile `X-App-Version` → log scope + Sentry tag) → `ExceptionMiddleware` → `UserStoragePolicy` (404 for an upload's files except its cover; must precede StaticFiles) → `StaticFiles(/storage)` → `/health`, `/health/ready` → `Routing` → `WriteFreeze` (off unless configured) → `McpKeyAuth` → `RateLimiter` (must follow Routing, or per-endpoint policies are inert) → `AccountGuard` (refuses tokens of a reset or deleted account) → `GuestActivity` (LastActiveAt, 10 min debounce) → `AdminAuth` (`/admin/*` except `/admin/auth`) → `PathGates` (`/me/*` → 401 without a user, `/internal/*` → 403 off the docker network; ADR-024)

User routes live under `/me` (sync API under `/me/v2`); `/internal` is local-only by middleware. Every other route is listed in `tests/TextStack.UnitTests/Routes/routes.public.txt` — a new public route fails `PublicRoutesSnapshotTests` until it is added there.

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
- **GuestLimitsProvider**: word-count threshold that mints a guest session
- **NativeLanguageProvider**: User's native language for translations/definitions direction
- **LanguageProvider**: Inside language routes only. Extracts `lang` from URL params, provides `switchLanguage()`, `getLocalizedPath()`

Context files: `apps/web/src/context/{Auth,GuestLimits,NativeLanguage,Language}Context.tsx`

**Pages**: landing, library, book detail, reader, vocabulary + review, highlights, and static pages (about, privacy, terms, dmca, delete-account, contact, mcp, changelog, oauth consent, device, connect-extension, reset-password). Root `/` → `/en`.

**i18n**: `apps/web/src/locales/en.json`. Hook: `useTranslation()`. Languages: `['en']`.

**API client layer**: `apps/web/src/api/` — `client.ts` (runs `@textstack/shared`'s api client in cookie mode via `initApi({ credentials: 'include' })`), `sync.ts` (sync), `auth.ts`, `explain.ts`, `oauth.ts`, `translation.ts`, `tts.ts`, `userBooks.ts`, `userData.ts`, `vocabulary.ts`.

**Hooks** (`apps/web/src/hooks/`), e.g. reader: `useReadingSession`, `useReaderSettings`, `useReaderVocabulary`, `useImmersiveMode`, `useTextTranslation`, `useTts`, `useDarkMode`; library: `useLibrarySource`, `useLibraryStatus`, `useLibrarySort`, `useLibrarySearch`, `useBookActions`; vocabulary: `useVocabulary`, `useVocabularyReview`; UI: `useFocusTrap`, `useIsMobile`, `useScrolled`, `useDebounce`, `useOnline`.

**Admin panel**: `apps/admin/`, a shell (M6 D2): login and an empty home. Backend: `/admin/auth/*` + `AdminAuthMiddleware`; admins come from `create-admin`.

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

**Running the integration suite locally**: it trips its own rate limits at production values. CI raises the knobs; do the same locally or you will read 429s as failures:

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

Also: the windows are 1–5 minutes, so **two overlapping runs throttle each other**. Run the suite once and read the result, rather than re-running to confirm a failure.

**Test env vars**:
- `ENABLE_TEST_AUTH=true` — enables test auth endpoints (needed for integration + E2E)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — the admin login tests
- `SYNC_API_TESTS=1`, `TEST_DB_CONNECTION` — see above

## Package Management

Central versioning via `Directory.Packages.props` — don't add `<Version>` in individual csproj files. Target: `net11.0` (set in `Directory.Build.props`).

## Rules that bite (always on)

- **`chapter_number` is an ordering key, not a display ordinal** (some books start at 0, some at 1 or 2). Show a chapter's **title**; use the number only to sort.
- **Mobile reading needs neither a token nor a network** — the reader opens the book's file retained on the device (`apps/mobile/src/lib/reader/hostStorage.ts`) and its local library (`localLibrary.ts`); sync runs beside it. Nothing on the reading path may need an account.
- **A `.web.ts` twin mirrors every export** of its native module (`apps/mobile/src/lib/offlineDb.web.ts`, `reader/deviceLibrary.web.ts`), or the web bundle (which mobile e2e runs against) fails to resolve.
- **Guest = a real session.** `isAuthenticated` is `user !== null`; account-only questions go through `capabilitiesFor(user)` (`packages/shared/src/lib/capabilities.ts`, re-exported by mobile `capabilities.ts`), never inline `user?.isGuest` (ADR-014).
- **MCP has 18 tools; the count is asserted in four tests** (`McpManifestDriftTests`, `McpStdioSmokeTests`, `McpOverTheWireTests`, `McpManifestEndpointTests`) and descriptions live once in `backend/src/Contracts/Mcp/McpManifest.cs` — change all together.
- **ARM64: compiled `Regex`, never `[GeneratedRegex]`** (SIGILL bug).
- **Docs, comments, ADRs, commits, PRs: English only.** Cyrillic is allowed only as real input data (tests, fixtures, seed migrations, translation examples).
- **Never deploy by SSH.** Deploy = merge to `main`; break-glass `gh workflow run deploy.yml`.

## Area guides and key files

Area guides load on their own: `backend/CLAUDE.md` (key files, every API route) and `apps/mobile/CLAUDE.md` (Expo, offline, Play/OTA release) when working there; procedures and topic guides are skills in `.claude/skills/` (`features`, `operations`, `add-entity`, `add-tool`). Runbooks and postmortems: `docs/internal/ops/`, `docs/internal/incidents/`.

| Area | Path |
|------|------|
| Reader host, web | `apps/web/src/pages/ReaderPage.tsx`, `apps/web/src/components/reader/ReaderHost.tsx`, `apps/web/src/lib/readerSync.ts` |
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
