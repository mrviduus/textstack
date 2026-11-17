# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Free book library w/ Kindle-like reader. Upload EPUB/PDF → parse → SEO pages + offline-first sync.

**Live**: [textstack.app](https://textstack.app/) (public) · [textstack.dev](https://textstack.dev/) (admin)

**Stack**: ASP.NET Core (API + Worker) + PostgreSQL + React + React Native (Expo)

**Prerequisites**: Docker, .NET 10 SDK, Node.js (`.nvmrc`), pnpm

**CI/CD**: Push to `main` → auto-deploy. No SSG any more (M6): nginx answers `410 Gone` for the retired catalog URLs (`/en/books|authors|genres|search|sitemap`, `sitemap.xml`).

## V2 program (active)

The project is mid-migration to **V2**: two databases, one cutover ([ADR-030](docs/architecture/adr/ADR-030-two-databases-one-cutover.md), plan [`docs/internal/v2/v2-plan.md`](docs/internal/v2/v2-plan.md), umbrella #1013). The public SEO catalog retires at the end (#992 decision; M6).

- **`textstack_v2`** is the database Api and Worker read (`ConnectionStrings:V2`): own SQL ledger (`make migrate-v2`), Dapper repositories, `/me/v2/*` endpoints. The legacy database is read-only and archived until M6's drop; no code reads it (EF Core went at M6 B3).
- **V2 reader** ([ADR-029](docs/architecture/adr/ADR-029-foliate-for-v2-epub.md) sandbox, [ADR-032](docs/architecture/adr/ADR-032-one-engine-foliate-fork.md) one engine): our foliate-js fork (`mrviduus/foliate-js`, pinned by SHA) built by `apps/mobile/src/lib/v2reader/build.mjs` into a committed generated page under a nonce CSP. Hosts: Android dev route (`__DEV__`) and web `/dev/reader-v2` (dev server only) and `/:lang/library/my/:id/read-v2` (always on). The web build ships `dist/reader-v2/` = a no-store frame shell (nonce filled by nginx `sub_filter`) + the content-hashed page script, asserted on build; nginx locations in `textstack.conf`, checked by `prodCsp.check.mjs`. Own README in `apps/mobile/src/lib/v2reader/`. The only reader (the old engine package was deleted at M6, ADR-025 superseded).
- **Work runs in waves**: kickoff files `.claude/wave-<N>-prompt.md` (pipeline, quality bar, standing rules); current state in [`docs/STATUS.md`](docs/STATUS.md) and #1013 checkboxes. Locator schemes and roles: ADR-031.
- **Keep the V2 status true, until M6 is done** (owner, 2026-11-14). Three places, one picture:
  - **#1013:** a PR that finishes a milestone ticks its box (`Fixes #N` on the milestone issue). A new owner decision or blocker that moves the timeline gets its own issue, linked from #1013.
  - **`docs/STATUS.md`:** updated in every wave-close PR.
  - **The public road on `/changelog`:** `MOVE_STEPS` and `MOVE_UPDATED` in `apps/web/src/lib/changelog.ts`. Every wave-close PR sets each step's `state` (`done` / `now` / `next`) and the date, and adds or removes a `MOVE_OPEN` question when one opens or closes. Reader words, from the glossary; nothing owner-only, nothing about security. The close PR says which steps moved.
  - When M6 is done: the last update marks every step `done`, then this rule and the `/changelog` block go.

## Where to write things down

The PR is the changelog (#1220). Readers see the `/changelog` page (merged PRs by week; `public` ones in plain words, chosen weekly by `/changelog-week`). No GitHub releases for the app: Android notes go to Play's "What's new". Nobody writes changelog lines.

| Where | Job |
|------|-----|
| The PR | **Title** = one scannable line. **One area label** (`reading`, `library`, `highlights`, `vocabulary`, `assistant`, `account`, `data`, `ops`, `documentation`; CI fails without one). **Description** = the full write-up, article source material. |
| `CHANGELOG.md` | **Frozen.** History up to the switch; never add to it. Older halves live in git history only. |
| `internal/incidents/` | Postmortems for anything that broke production. Start from `_TEMPLATE.md`. |
| `docs/STATUS.md` | Where the project is *now*: in flight, deliberately-not-doing. Links to issues; never copies them. |
| GitHub issues | **Every open item** (bug, review finding, deferred work), one issue each, labelled (`reader-engine`, `phase-3-gate`, …). A PR closes it with `Fixes #N`. Public: nothing private. Old STATUS items move to an issue when someone touches them. |

Load-bearing decisions still go to `docs/architecture/adr/`. Details: `.claude/commands/changelog.md`.

## Commands

```bash
# Setup (one-time)
cp .env.example .env          # Edit with real values
make nginx-setup              # Install nginx config (Linux)
make nginx-setup-mac          # Mac
make fix-permissions          # Create data/library etc. owned by uid 1000 (else V2 uploads fail)
make migrate-v2               # Create + migrate textstack_v2 (V2 mode is the default; the api reads it)
make up                       # Start services

# Docker
make up / down / restart / logs / status
make build                    # docker compose up -d --build
make rebuild                  # full rebuild --no-cache
make fix-permissions          # Fix volume permissions

# After editing .env, `docker compose restart <svc>` does NOT re-read env vars
# (they are baked in at container creation). Use force-recreate:
#   docker compose up -d --force-recreate --no-deps <service>

# Deploy
# Deploy: merge to main (deploy.yml). Break-glass: gh workflow run deploy.yml [-f rollback_commit=<sha>]

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
dotnet test tests/TextStack.Persistence.Tests   # Dapper repositories on real Postgres (Testcontainers; needs Docker)
dotnet test --filter "Name~TestMethodName"  # Single test
pnpm -C apps/web test                       # Frontend unit tests (Vitest)
pnpm -C apps/web test:watch                 # Watch mode
pnpm -C apps/web test:e2e                   # Playwright E2E (headless)
pnpm -C apps/web test:e2e:ui                # Playwright E2E (UI mode)

# Lint
dotnet format textstack.sln                  # Backend

# CLI commands (via dotnet run --project backend/src/Api --)
# create-admin <email> <password>            (always Admin: Editor/Moderator collapse to Admin on V2, ADR-031 decided 7)

# Local dev (no Docker)
# From the repo root; the defaults /storage and /library are container paths. Two siblings, never nested:
export Storage__RootPath=data/storage Storage__LibraryRoot=data/library
dotnet run --project backend/src/Api
dotnet run --project backend/src/Worker
pnpm -C apps/web dev          # http://localhost:5173
pnpm -C apps/admin dev        # http://localhost:81

# Build
pnpm -C apps/web build
pnpm -C apps/admin build

# Migrations: plain SQL in database/ (database/README.md, ADR-026). New change = NNNN_<name>.up.sql + .down.sql
make migrate                  # migrator up, with this checkout's database/ mounted (no rebuild needed)
make migrate-status           # applied / pending / unknown versions
make migrate-down V=<n>       # revert versions above n — schema first, then the code
# Only the migrator migrates (ADR-021); the Api never does. Behind schema → /health/ready 503

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

**Storage**: `./data/storage/` — catalog `{id[..2]}/{id}/{file}`, uploads `users/{userId[..2]}/{userId}/books/{userBookId}/` (`LocalFileStorageService.cs`). V2 library: `./data/library/` (`/library`, `Storage:LibraryRoot`), outside the public root — `library/…`, `uploads/…` (`LibraryFileStore.cs`).

## Architecture

```
API → Application → Domain ← Infrastructure
                      ↑
                   Worker
```

- **Domain**: Pure C#, no framework deps
- **Application**: Business logic, interfaces (repositories, `IFileStorageService`)
- **Contracts**: Shared DTOs (request/response models) used by API and Application
- **Infrastructure**: Dapper repositories on `textstack_v2` (snake_case), storage implementations
- **API/Worker**: Orchestration, DI

**Backend class libraries** (`backend/src/`, beyond the layers above): `Extraction` (EPUB/PDF parsers), `Tts` (Edge TTS), `Vocabulary` (DistractorGenerator), `Ai/` (`TextStack.Ai.*`: LLM client, agents, tools, evals, MCP server). There is no EPUB *builder* any more — `TextStack.Epub` was deleted 2026-09-28 with the export it existed for.

### Shared Frontend Packages (`packages/`)

Cross-platform TS code shared by **both** web and mobile, consumed via source path-aliases (NOT published / built) — `apps/web` resolves them in `vite.config.ts` + `tsconfig.json`; mobile via its bundler config.
- **`@textstack/shared`** (`packages/shared/src/`) — the canonical home for platform-agnostic logic: `api/` (client), `types/api`, `i18n/`, `anon/`, `reader/` (bookProgress, progressPayload, continueReading), `vocabLevel`, `vocabularyConstants`, `lib/pathPrefix`. Edit here, not in app copies, when changing logic both clients need.

**Middleware pipeline** (order matters): `ForwardedHeaders` → `Cors` → `AppVersion` (mobile `X-App-Version` → log scope + Sentry tag) → `ExceptionMiddleware` → `UserStoragePolicy` (404 for an upload's files except its cover; must precede StaticFiles) → `StaticFiles(/storage)` → `/health` → `Routing` → `McpKeyAuth` → `RateLimiter` (must follow Routing, or per-endpoint policies are inert) → `GuestActivity` (LastActiveAt, 10 min debounce) → `AdminAuth` (conditional on `/admin/*`) → `PathGates` (`/me/*` → 401 without a user, `/internal/*` → 403 off the docker network; ADR-024)

User routes live under `/me`; `/internal` is local-only by middleware. Every other route is listed in `tests/TextStack.UnitTests/Routes/routes.public.txt` — a new public route fails `PublicRoutesSnapshotTests` until it is added there.

**Site resolution**: Single-site permanent (ADR-007); there is no site id in code any more.

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

## Test Projects

```
tests/
├── TextStack.UnitTests/           # Pure logic, no DB
├── TextStack.IntegrationTests/    # API tests against running server (LiveApiFixture → localhost:8080, override via API_URL env)
├── TextStack.Extraction.Tests/    # Book parsing (EPUB/PDF)
├── TextStack.Persistence.Tests/   # Dapper repositories, Testcontainers Postgres built by database/migrate.sh (ADR-028)
├── TextStack.AiEvals/             # Eval runners on fake LLMs; live evals skip w/o OPENAI_API_KEY
├── TextStack.Ai.Mcp.Tests/        # MCP over-the-wire (loopback)
apps/web/e2e/                      # Playwright E2E (chromium, mobile, admin projects)
apps/mobile/e2e/                   # Mobile Playwright E2E
```

Test naming convention: `{MethodName}_{Scenario}_{ExpectedResult}`

**E2E setup**: Global setup authenticates test user + admin; auth state stored in `apps/web/e2e/.auth/`. CI runs the whole suite once, in V2 mode, as the PR gate.

**Running the integration suite locally**: it trips its own rate limits at production values — a dozen classes seed a book by clipping one, and the GDPR-delete class calls account-delete four times. CI raises the knobs; do the same locally or you will read 429s as failures:

```bash
make migrate-v2               # once: the textstack_v2 database the V2 classes (tests/…/V2) need
CLIP_PERMIT_LIMIT=200 ACCOUNT_DELETE_PERMIT_LIMIT=50 GUEST_SESSION_PERMIT_LIMIT=50 \
  USER_LOGIN_PERMIT_LIMIT=100 DEVICE_CODE_PERMIT_LIMIT=50 MCP_KEYS_PERMIT_LIMIT=100 \
  docker compose up -d --no-deps --force-recreate api
V2_API_TESTS=1 dotnet test tests/TextStack.IntegrationTests   # without V2_API_TESTS the V2 classes skip
# DB-backed tests skip unless Postgres is reachable: start the stack with
# `-f docker-compose.yml -f .github/docker-compose.ci-db.yml` and set
# TEST_V2_DB_CONNECTION="Host=localhost;Port=5432;Database=textstack_v2;Username=<user>;Password=<pw>"   (DeviceAuth, HealthReadyLibrary)
docker compose up -d --no-deps --force-recreate api   # back to production values
```

Also: the windows are 1–5 minutes, so **two overlapping runs throttle each other**. Run the suite once and read the result, rather than re-running to confirm a failure.

**Test env vars**:
- `ENABLE_TEST_AUTH=true` — enables test auth endpoints (needed for integration + E2E)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — needed for admin E2E
- Integration tests set `Host` header: `general.localhost` (public), `textstack.dev` (admin)

## Extraction Pipeline

Supported formats: EPUB, PDF. Processing order: Spelling → Hyphenation → Typography → Semantic. Details in `backend/src/Extraction/TextStack.Extraction/RULES.md`. ARM64 caveat: uses compiled `Regex` not `[GeneratedRegex]` (SIGILL bug).

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
| Features: entities, user books, translate/explain/TTS, vocabulary SRS, guests, auth, auto publish, SEO backfill, SSG | [`internal/claude/features.md`](internal/claude/features.md) |
| Every API route group | [`internal/claude/api-endpoints.md`](internal/claude/api-endpoints.md) |
| Where things live (key files table) | [`internal/claude/key-files.md`](internal/claude/key-files.md) |
| Mobile: Expo, offline, reading path, Play/OTA release | [`internal/claude/mobile.md`](internal/claude/mobile.md) |
| CI/CD, deployment, nginx, MCP server, telemetry | [`internal/claude/operations.md`](internal/claude/operations.md) |
