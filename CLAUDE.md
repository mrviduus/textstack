# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Free book library w/ Kindle-like reader. Upload EPUB/PDF → parse → SEO pages + offline-first sync.

**Live**: [textstack.app](https://textstack.app/) (public) · [textstack.dev](https://textstack.dev/) (admin)

**Stack**: ASP.NET Core (API + Worker) + PostgreSQL + React + React Native (Expo)

**Prerequisites**: Docker, .NET 10 SDK, Node.js 18+, pnpm

**CI/CD**: Push to `main` → auto-deploy (no SSG rebuild). Full SSG rebuild: nightly after the backup (`backup.yml`); on demand via the admin panel, `make rebuild-ssg`, or a manual deploy with `rebuild_ssg`.

## Where to write things down

Four files, four jobs. Putting a write-up in the wrong one is how `CHANGELOG.md` reached 1804 lines.

| File | Job |
|------|-----|
| `CHANGELOG.md` | **Index only.** One line per change, grouped by deploy date (CalVer). Never a paragraph. |
| `docs/changelog-archive/<YYYY>-H<1\|2>.md` | The full write-up behind that line. Article source material. |
| `docs/incidents/` | Postmortems for anything that broke production. Start from `_TEMPLATE.md`. |
| `docs/STATUS.md` | Where the project is *now*: in flight, known-broken, deliberately-not-doing. |

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
make rebuild-ssg              # Rebuild SSG pages only

# Database
make backup                   # Backup to ~/backups/textstack/
make backup-list              # List all backups
make restore FILE=path.gz     # Restore from backup
docker compose exec db psql -U app books   # DB shell
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
MIGRATE_TARGET=0 docker compose up migrator   # Rollback all migrations

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
- **`@textstack/shared`** (`packages/shared/src/`) — the canonical home for platform-agnostic logic: `api/` (client), `types/api`, `i18n/`, `text/sentences`, `anon/`, `reader/` (bookProgress, progressPayload, continueReading), `vocabLevel`, `vocabularyConstants`, `lib/pathPrefix`. Edit here, not in app copies, when changing logic both clients need.
- **`@textstack/reader-overlay`** (`packages/reader-overlay/src/`) — DOM overlay engine for the reader (`readerOverlay`, `textWalker`, `mobileBootstrap`). Powers highlight/vocab/search overlay layers in `apps/web/src/components/reader/`.

**Middleware pipeline** (order matters): `ForwardedHeaders` → `Cors` → `AppVersion` (mobile `X-App-Version` → log scope + Sentry tag) → `ExceptionMiddleware` → `StaticFiles(/storage)` → `/health` → `SiteContext` → `LanguageContext` → `Routing` → `McpKeyAuth` → `RateLimiter` (must follow Routing, or per-endpoint policies are inert) → `GuestActivity` (LastActiveAt, 10 min debounce) → `AdminAuth` (conditional on `/admin/*`)

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

## Key Concepts

**Entity Hierarchy**: Site → Work → Edition → Chapter
- Work = canonical book (just slug), Edition = per-language version with metadata
- Edition contains: title, description, cover_path, SEO fields
- Edition ↔ Author via EditionAuthor (M2M), Edition ↔ Genre via `edition_genres` (M2M)
- Chapter contains: html (rendered), plain_text (search), search_vector (FTS)

**User Books**: Users can upload their own books (separate from admin library).
- UserBook → UserChapter (parallel to Work/Edition/Chapter but per-user)
- Upload flow: UserBookFile → UserIngestionJob → Worker extracts chapters
- Pages: `/:lang/library/my/:id` (detail), `/:lang/library/my/:id/read/:chapterSlug` (reader with `mode="userbook"`)
- Metadata enrichment: `BookMetadataGenerator` (Worker) — Ollama fire-and-forget generates genre, year, description from title+author. Fields: Author, Genre, PublishedYear, TotalWordCount

**`chapter_number` is an ordering key, not a display ordinal.** It is not consistently based and never has been: on production every edition starts at 0, but 4 uploaded books start at 2, and locally 5 editions start at 1. `BookDetailPage` renders `chapterNumber + 1` and `UserBookDetailPage` renders it raw, so both are right for the common case and wrong for the exceptions. Anything new that shows a chapter to a reader should show its **title** and use the number only to sort. (`BookInsightsSection` does.)

**Book Upload Flow**:
```
Upload EPUB/PDF → BookFile (stored) → IngestionJob (queued)
     → Worker polls → Extraction → Chapters created → search_vector indexed
```

**Reading Stats**: Full reading analytics system.
- ReadingSession — tracks duration, words read, start/end percent per reading session
- ReadingGoal — daily_minutes or books_per_year targets with streak tracking
- UserAchievement — 20 achievements across milestone/streak/time/special categories
- AchievementChecker (`Application/ReadingTracking/AchievementChecker.cs`) runs after each session
- Frontend: StatsPage with heatmap calendar, weekly chart, goals, achievements grid
- Session tracking: 30s heartbeat, 3min idle threshold, 5min auto-end, localStorage queue, sendBeacon submit

**Dictionary — removed 2026-10-03.** ~~`GET /dictionary/{lang}/{word}`~~ proxied the free api.dictionaryapi.dev, which was flaky (outages, false 404s that our cache then stored for 24h as "not found"). Gone with it: `DictionaryCache`, its sweeper, `DefinitionEnricher` (auto English definition on vocab save — new words now get none; existing data untouched) and the admin backfill endpoint. The web word popup no longer shows phonetic/definition; in **definition mode** (native = book language, nothing to translate) it fetches the contextual Explain instead (`lib/wordBubbleFetch.ts`). Review feedback shows only what is on the card.

**Translation**: `POST /api/translate` via OpenAI (`gpt-4.1-nano`). Config: `OpenAI:ApiKey`, `OpenAI:Model`, `OpenAI:Translate:MaxTextLength`. LibreTranslate dropped 2026-04-22.

**Explain (contextual)**: `POST /api/explain` — LLM-powered 2-3 sentence explanation of a word in the sentence it appears in. Uses `ILlmService` (OpenAI `gpt-4.1-mini` via `OpenAI:Explain:Model` — deliberately stronger than the nano default; kept on mini 2026-10-03 because the saving was cents). SHA256-keyed file cache at `data/explain-cache`, 30d TTL. Rate limited per-IP (20/min). Impl: `backend/src/Api/Endpoints/ExplainEndpoints.cs`.

**TTS (Text-to-Speech)**: Edge TTS via direct WebSocket to `speech.platform.bing.com`. No API key, no deps.
- **`TextStack.Tts`** class library: `EdgeTtsClient` (WebSocket protocol), `EdgeTtsService` (disk cache + `IHostedService` startup cleanup)
- **API**: `GET /api/tts?text=&lang=&voice=&speed=` → `audio/mpeg`, `GET /api/tts/voices?lang=` → voice list. No auth required
- **Two-layer cache**: server disk (`data/tts-cache/`, SHA256 key, 30d TTL, 1GB) + client IndexedDB (30d TTL)
- **Frontend**: `useTts()` hook → speak/stop/isPlaying. Used in vocabulary (word list + SRS cards) and reader (SelectionToolbar, WordPopup, TranslationPopup)
- **Reader wiring**: `ReaderHighlights.tsx` orchestrates — passes `onSpeak` to toolbar/popups
- **Settings**: `ttsSpeed` in `useReaderSettings` (0.75x–2.0x), UI in `ReaderSettingsDrawer`
- **Voices**: `en-US-AriaNeural` (en), 200+ available for native-language TTS
- **Config**: `Tts:CachePath`, `Tts:MaxTextLength` (500), `Tts:TimeoutSeconds` (15). Docker: env `Tts__CachePath=/data/tts-cache`
- **Graceful degradation**: if disk cache unavailable (permissions), TTS still works without caching

**Vocabulary SRS**: Spaced repetition vocabulary builder integrated into the reader.
- **Entity**: `VocabularyWord` — word, translation, definition, sentence, bookTitle, distractors (JSON), hint (LLM-generated), SRS fields (stage, interval, consecutiveCorrect, nextReviewAt)
- **Review entity**: `VocabularyReview` — tracks each answer (isCorrect, responseTimeMs, reviewMode)
- **5 SRS stages**: New(0) → Recognition(1) → Recall(2) → Context(3) → Mastered(4). Logic in `backend/src/Vocabulary/TextStack.Vocabulary/SrsEngine.cs`
- **One card shape on the wire** *(for review)*: `ReviewCardBuilder` emits `multiple_choice` for every card. `SrsEngine.GetReviewMode` still returns `"context"` for stages 3-4 with a sentence, but the builder gives those MC options and rewrites the mode — context cloze *is* MC, with the sentence as the prompt. Typed recall is gone. `ReviewCardDto.reviewMode` is therefore vestigial and no client reads it (see the comment on the field in `packages/shared/src/types/api.ts`). **The Tutor is the exception, as of 2026-09-11**: its plan chooses the shape per card from the calibrated `exerciseType` — `recognition`/`context` come down with options (the cloze prompt separates them), `recall` comes down with none and renders a flashcard. Both build their options from the same `McOptions`, so there is still one implementation of *what the choices are*; what differs is only which card the plan asks for.
- **Review style is a client choice**, not a server one: `ReviewMode = 'blitz' | 'classic'` (`packages/shared/src/vocabularyConstants.ts`) — Blitz renders the MC card, Flashcards renders self-assessment. Persisted per client (`apps/mobile/src/lib/reviewMode.ts`, web `localStorage['practiceMode']`).
- **MC distractors + hint + explanation**: Ollama LLM (`gemma4:e2b`) generates 5 distractors + hint + 2-3 sentence explanation (in native language) per word at save time. Stored in `Distractors` (JSON), `Hint` (varchar 500), `Explanation` (varchar 1000). Fallback: random words from user's vocab pool + hardcoded list. Generator: `Vocabulary/TextStack.Vocabulary/DistractorGenerator.cs`
- **Ollama**: Docker service (`ollama/ollama`), config: `Ollama:BaseUrl`, `Ollama:Model`, `Ollama:TimeoutSeconds` (default 30s). Fire-and-forget generation via `IServiceScopeFactory` after word save
- **MC prompt cascade** (client-side, `MultipleChoiceCard`): blank sentence → definition → translation. No downgrade path — there is nothing left to downgrade to
- **Frontend**: `VocabularyPage.tsx` (word list, filters, search, stats), `VocabularyReviewPage.tsx` (review session), components in `components/vocabulary/`
- **API**: `POST /me/vocabulary/words` (save), `GET /me/vocabulary/words` (list), `DELETE /me/vocabulary/words/{id}`, `PATCH /me/vocabulary/words/{id}`, `GET /me/vocabulary/review` (queue), `POST /me/vocabulary/review` (submit), `GET /me/vocabulary/stats`

**Guest Users**: Anonymous reading on a **real server-side `User` row**, minted on demand. Full posture + rejected alternatives: [ADR-014](docs/01-architecture/adr/ADR-014-guest-sessions.md).
- `POST /auth/guest` mints a `User` with `IsGuest=true`, a synthesized `guest-<hex>@guest.local` email and a normal token pair. All `/me/*` writes work for it — progress, highlights, bookmarks, vocabulary all sync.
- **Triggers differ per client.** Web: upload, and the 3rd pending vocabulary word — **not reader mount**, which was a trigger until 2026-09-28 and minted 7,147 of the 7,263 guest rows then on production, because a crawler that executes JS is indistinguishable from a reader opening a chapter. `readerDoesNotMintOnMount.test.ts` fails the build if it comes back. **Mobile: opening a book or the upload screen** — `SessionGate` (`src/components/SessionGate.tsx`) wraps both reader routes and, since 2026-09-28 (#628), `/my-books/upload`, single-flighted, 3s deadline, and every failure (offline, rate limited, bootstrap wedged) opens the book signed out rather than blocking it.
- Registering **promotes that same row in place** (`AuthService.RegisterWithEmailAsync`); signing in to an existing account **merges** it (`MergeGuestAsync`, one transaction, account's row wins on conflict except `ReadingProgress` = newer wins). `MergeGuestAsync` returns `false` — never throws — on a SQLSTATE-23 conflict, because a throw here is a permanent sign-in outage.
- Auth responses carry `guestMergeSkipped` (`invalid_token` | `merge_conflict`), null on the ordinary path. Additive; **no client reads it yet**, but every occurrence logs a structured Warning.
- Clients must send `Authorization` on the four merge entry points (`/auth/register`, `/auth/login`, `/auth/google`, `/auth/apple`) — and must **refresh an expiring token first** (`packages/shared/src/api/tokenExpiry.ts`). An expired bearer is worse than none: the server ignores it and answers 200 with nothing merged.
- `apps/mobile/src/lib/capabilities.ts` is the single source of guest policy (`capabilitiesFor(user)`). Account-only: AI, identity editing, account deletion, cross-device sync, silent sign-out. Deliberately *not*: reading, translation, saving vocabulary. **Upload was account-only until 2026-09-06 and is now open to a guest** (ADR-014 §3a) — `canUpload` is the one capability that is a *session* predicate (`hasSession`), so it is false only with no session at all — and the upload route's `SessionGate` mints one on arrival. `isAuthenticated` stays `user !== null` (a guest **has** a session); only account questions go through capabilities. `capabilityLiterals.test.ts` fails the build on inline `user?.isGuest` re-derivation.
- A guest's Sign Out is a **destructive confirm**: the three SecureStore keys are the only handle on the row, which `GuestCleanupWorker` then keeps forever, unreachable.
- Server-side enforcement, not just UI: `RequireAiAccount()` (`Api/Extensions/AiAccountPolicy.cs`) returns **403 `account_required`** (distinct from 401 — "sign up" vs "sign in") on the paid-inference surface (tutor). Librarian, ask, book chat, study buddy and RAG indexing were deleted 2026-09-10. Never applied to translate/explain/TTS.
- Entitlements: `Entitlements:Tiers:Guest` = `{ StorageLimitBytes: 50MB, MaxBooks: 1, DailyEnrichmentCap: 50, AiEnabled: false }`. The tier is the only thing metering a guest upload since the 2026-09-06 reversal — the client used to block it by product choice as well, and no longer does. `DailyEnrichmentCap` clamps the user's own daily vocabulary cap (`DailyCapService.EffectiveCap`) and is also checked by `PromoteLookup`. Unset / `<=0` means unlimited/allowed — a config typo costs money, never an outage.
- GuestLimitsContext (web) holds the last-read book and the word-count threshold that triggers minting. There are no client-side usage limits.
- GuestCleanupWorker: every **2h**, deletes guests inactive **30d** — but only those holding nothing durable (vocab, highlights, bookmarks, library, uploads, notes, progress). Engaged guests live indefinitely. ReadingSessions are deliberately excluded from that filter.
- Rate limiting: `guest-session` — **per IP per 5 min**, permit limit from `RateLimits:GuestSessionPermitLimit` (prod 3; CI raises it via `GUEST_SESSION_PERMIT_LIMIT` because the merge suites need ≥6 guests from one host). A configured `<=0` degrades to 3.
- `GuestActivityMiddleware` keeps `LastActiveAt` true for guests, and **did nothing at all until 2026-09-11**: it read `context.User.FindFirst("is_guest")`, but the API registers no ASP.NET authentication middleware (auth is manual per-endpoint via `GetUserId`), so `context.User` is permanently empty and it returned on its first line for every request ever served — `LastActiveAt` was written once, at guest creation. The claim was never missing; `AuthService` has always minted `is_guest` into the token. It now resolves identity from the token like everything else here (`ValidateAccessTokenIdentity`), debounces 10 min in `IMemoryCache` (no read-before-write), and writes with a targeted `ExecuteUpdateAsync`. Note the damage was narrower than it looked: `GuestCleanupWorker`'s filter also spares any guest holding a `ReadingProgress` row, so anyone who actually read a book survived regardless.

**Email/Password Auth**: Email + password login alongside Google/Apple OAuth.
- ResendEmailService for transactional email (password reset)
- PasswordResetToken entity, ResetPasswordPage frontend
- Config: Resend API key

**Export — deleted 2026-09-28.** ~~EPUB export~~. Two routes existed (`GET /me/books/{id}/export/epub`, owner-scoped, and `GET /books/{slug}/export/epub`, anonymous) and **neither ever exported highlights or notes**, whatever this file said for five months: both re-encoded the book's *chapters* into a fresh EPUB, which a test asserted in as many words. The public one was unreachable from any UI from 2026-04-15; the mobile one 401'd on every tap for its whole life, because it was opened in the system browser.

What replaced it: the app hands back **the file the reader uploaded**, from the device when the book is downloaded (`apps/mobile/src/lib/shareOriginal.ts` → `GET /me/books/{id}/file`). A re-encoding of extracted text is a worse copy of a book we already have byte for byte. `EpubExportService`, `ExportEndpoints` and the whole `TextStack.Epub` library went with it.

**Highlights Review**: Spaced review of saved highlights.
- HighlightReviewPage — revisit highlights (a 24h cooldown queue, not real SRS; see `docs/STATUS.md`)
- Practice lives on `VocabularyPage` (the old PracticePage was merged into it); chapter questions review at `/:lang/review/questions` (`ChapterQuestionReviewPage`)

**Auto Publish**: Automated pipeline for publishing Draft books with SEO content.
- Admin page at `/autopublish` — settings, candidates, jobs history
- `seo-publish-poll.sh` (systemd) polls DB every 60s for queued jobs
- `seo-generate.sh` calls Claude CLI (`claude-sonnet-4-6`) to generate SEO fields (description, relevance, themes, FAQs)
- Publishes via `POST /internal/editions/{id}/publish` (Docker network only)
- Settings: books/day, hour UTC, require review, language filter, priority queue
- Auto-triggers Specific SSG rebuild per published book via `PublishEditionAsync() → EnqueueSsgSafe()`

**SEO Backfill**: Template-driven SEO field generation for Authors, Editions, Genres.
- Admin page at `/seo-backfill` — Coverage, Templates, Jobs, Settings tabs
- Entities: `SeoTemplate` (admin-editable prompts, versioned), `SeoBackfillJob` (queue + Before/After snapshots), `SeoBackfillSettings` (singleton)
- `SeoSource` column on Author/Edition/Genre: `manual` | `auto` | `hybrid` — `manual` rows protected from overwrite
- Progressive trust: `TrustLevel` per template — `Manual` (queue by admin only) → `Review` (needs approval) → `Auto` (direct apply). Strictest wins for multi-field jobs
- `seo-backfill-poll.sh` (systemd) claims jobs atomically via `FOR UPDATE SKIP LOCKED`, dispatches per-job
- `seo-backfill-generate.sh` — GET context → Claude CLI per field (3 retries with error feedback) → POST apply; output validated vs per-field JSON schema
- Prompt injection defense: `SeoPromptSanitizer` strips `{{`, `}}`, `assistant:`, `system:`, `</prompt>`, `<|…|>` from entity text before template interpolation
- Immutable replay: job stores `TemplateIds[]` + `TemplateVersions[]` — editing a template creates a new version, old jobs keep their frozen snapshot
- Revert: restores `BeforeSnapshot`, flips `SeoSource` back to `manual`. **No TTL** — revert allowed at any age (snapshot is an immutable audit record)
- Internal endpoints `/internal/seo/{enabled,jobs/claim,jobs/{id}/context,jobs/{id}/apply,jobs/{id}/fail}` (Docker network only)
- Failure alerts: admin email via Resend on any failed job (config `Resend:AdminAlertEmail`, no-op if empty)
- Seed templates: EN + UK variants for Author (Bio/Relevance/Themes/Faqs/SeoTitle/SeoDescription), Edition (Description/Relevance/Themes/Faqs/SeoTitle/SeoDescription), Genre (Description/SeoTitle/SeoDescription — en only)
- Setup: `make seo-backfill-setup` (systemd user unit), `make seo-backfill-restart`, `make seo-backfill-logs`

**SSG**: Puppeteer prerenders SEO pages to static HTML
- nginx serves SSG first, falls back to SPA
- Run `make rebuild-ssg` after content changes
- SSG worker: separate always-running container polling DB every 5s. Supports IndexNow (Bing/Yandex) via `INDEXNOW_KEY`
- Periodic rebuild: configurable from admin panel (SSG Rebuild → Settings: enable/disable, interval hours)

**When to rebuild SSG**:
- After adding/publishing new books
- After updating book metadata
- After adding/updating authors or genres
- NOT needed for: reading progress, bookmarks, user data

## API Endpoints

**Public**: `GET /books`, `/books/{slug}`, `/authors`, `/genres`, `/search?q=`, `/seo/*`, `POST /explain`, `POST /translate`, `GET /api/tts?text=&lang=&voice=&speed=`, `GET /api/tts/voices?lang=`

**Auth**: `POST /auth/login`, `/auth/guest`, `/auth/google`, `/auth/apple`, `/auth/refresh`, `/auth/logout`, `/auth/register`, `/auth/forgot-password`, `/auth/reset-password`

**Profile**: `GET/PUT /me/profile`

**User**: `GET/POST /me/library`, `GET /me/library/shelves`, `/me/progress/{editionId}` (GET/PUT/DELETE), `/me/bookmarks`, `/me/highlights/{editionId}`

**Reading Tracking**: `POST /me/reading/sessions`, `GET /me/reading/sessions`, `GET /me/reading/stats`, `GET /me/reading/stats/daily`, `GET /me/reading/pace`, `GET/POST /me/reading/goals`, `DELETE /me/reading/goals/{id}`, `GET /me/reading/achievements`

**User Books**: `POST /me/books/upload`, `GET /me/books`, `GET /me/books/quota`, `GET /me/books/{id}`, `GET /me/books/{id}/chapters/{slug}`, `GET /me/books/{id}/file` (the stored original, any format, Range-enabled), `GET/PUT /me/books/{id}/progress`, `GET/POST/DELETE /me/books/{id}/bookmarks`, `POST /me/books/{id}/retry`, `DELETE /me/books/{id}`

**Vocabulary**: `POST /me/vocabulary/words`, `GET /me/vocabulary/words?filter=&sort=&search=&limit=&offset=`, `PATCH /me/vocabulary/words/{id}`, `DELETE /me/vocabulary/words/{id}`, `GET /me/vocabulary/review?limit=`, `POST /me/vocabulary/review`, `GET /me/vocabulary/stats`

**Admin**: `POST /admin/books/upload`, `/admin/import/textstack`, `/admin/reimport/textstack`, `/admin/sync/standardebooks`, `/admin/reprocess/{editionId}`, `/admin/reprocess/all`, `GET /admin/ingestion/jobs`, `/admin/ingestion/jobs/{id}/retry`, `/admin/ingestion/jobs/{id}/preview`, `/admin/chapters/{id}` (GET/PUT/DELETE), `/admin/settings`, `/admin/ssg/jobs` (+ `/{id}`, `/start`, `/cancel`), `/admin/ssg/settings` (GET/PUT), `/admin/lint`, CRUD for `/admin/authors`, `/admin/genres`

**Auto Publish Admin**: `GET/PUT /admin/autopublish/settings`, `GET /admin/autopublish/jobs`, `GET /admin/autopublish/jobs/{id}`, `POST /admin/autopublish/jobs/{id}/approve`, `POST /admin/autopublish/jobs/{id}/reject`, `POST /admin/autopublish/jobs/{id}/retry`, `POST /admin/autopublish/trigger`, `POST /admin/autopublish/queue/{editionId}`, `GET /admin/autopublish/candidates`

**SEO Backfill Admin**: `GET /admin/seo/coverage`, `GET /admin/seo/gaps?entityType=&limit=`, `GET/PUT /admin/seo/settings`, `GET /admin/seo/templates`, `GET /admin/seo/templates/{id}`, `POST /admin/seo/templates`, `PUT /admin/seo/templates/{id}` (creates new Version), `POST /admin/seo/templates/{id}/deactivate`, `POST /admin/seo/templates/preview`, `GET /admin/seo/jobs`, `GET /admin/seo/jobs/{id}`, `POST /admin/seo/jobs/{id}/approve`, `POST /admin/seo/jobs/{id}/revert`, `POST /admin/seo/jobs/{id}/retry`, `POST /admin/seo/queue`

**Internal**: `PUT /internal/featured` (Popular shelf, replaces all ranks), `POST /internal/editions/{id}/publish`, `POST /internal/ssg/rebuild-all`, `POST /internal/seo/jobs/claim?limit=`, `GET /internal/seo/jobs/{id}/context`, `POST /internal/seo/jobs/{id}/apply`, `POST /internal/seo/jobs/{id}/fail` (Docker network only)

## Key Files

| Area | Path |
|------|------|
| Domain | `backend/src/Domain/Entities/` |
| Application | `backend/src/Application/` (services, interfaces) |
| API Endpoints | `backend/src/Api/Endpoints/` |
| API Middleware | `backend/src/Api/Middleware/` |
| API Entry | `backend/src/Api/Program.cs` |
| Worker | `backend/src/Worker/Services/IngestionWorker.cs` |
| Extraction | `backend/src/Extraction/` (EPUB/PDF parsers) |
| Search | `backend/src/Search/TextStack.Search/Providers/PostgresFts/PostgresSearchProvider.cs` |
| DB Context | `backend/src/Infrastructure/Persistence/AppDbContext.cs` |
| Web Contexts | `apps/web/src/context/` |
| Web Pages | `apps/web/src/pages/` |
| Reader | `apps/web/src/pages/ReaderPage.tsx` |
| Library | `apps/web/src/pages/LibraryPage.tsx` |
| API Hook | `apps/web/src/hooks/useApi.ts` |
| i18n | `apps/web/src/locales/en.json` |
| Admin | `apps/admin/src/pages/` |
| Stats | `apps/web/src/pages/StatsPage.tsx` |
| Reading Hooks | `apps/web/src/hooks/useReadingSession.ts` |
| Achievements | `backend/src/Application/ReadingTracking/AchievementChecker.cs` |
| Vocabulary API | `backend/src/Api/Endpoints/VocabularyEndpoints.cs` |
| Vocabulary SRS | `backend/src/Vocabulary/TextStack.Vocabulary/SrsEngine.cs`, `ReviewCardBuilder.cs` |
| Distractor Gen | `backend/src/Vocabulary/TextStack.Vocabulary/DistractorGenerator.cs` |
| Vocabulary Page | `apps/web/src/pages/VocabularyPage.tsx` |
| Vocab Review | `apps/web/src/pages/VocabularyReviewPage.tsx` |
| Vocab Components | `apps/web/src/components/vocabulary/` |
| Vocab Hooks | `apps/web/src/hooks/useVocabulary.ts`, `useVocabularyReview.ts` |
| Vocab E2E | `apps/web/e2e/tests/vocabulary.spec.ts` |
| TTS Library | `backend/src/Tts/TextStack.Tts/` (EdgeTtsClient, EdgeTtsService, ITtsService) |
| TTS API | `backend/src/Api/Endpoints/TtsEndpoints.cs` |
| TTS Hook | `apps/web/src/hooks/useTts.ts` |
| Book Metadata | `backend/src/Worker/Services/BookMetadataGenerator.cs` |
| Auto Publish API | `backend/src/Api/Endpoints/AdminAutoPublishEndpoints.cs` |
| Auto Publish Entity | `backend/src/Domain/Entities/AutoPublishJob.cs` |
| Auto Publish Admin | `apps/admin/src/pages/AutoPublishPage.tsx` |
| SEO Generate Script | `infra/scripts/seo-generate.sh` |
| SEO Publish Poller | `infra/scripts/seo-publish-poll.sh` |
| SEO Backfill Admin API | `backend/src/Api/Endpoints/AdminSeoBackfillEndpoints.cs` |
| SEO Backfill Internal API | `backend/src/Api/Endpoints/InternalSeoEndpoints.cs` |
| SEO Backfill Services | `backend/src/Application/Seo/` (JobProcessor, ContextBuilder, ContentApplier, CoverageAnalyzer, TemplateRenderer, ContentValidator, PromptSanitizer) |
| SEO Backfill Entities | `backend/src/Domain/Entities/SeoTemplate.cs`, `SeoBackfillJob.cs`, `SeoBackfillSettings.cs` |
| SEO Backfill Poller | `infra/scripts/seo-backfill-poll.sh`, `infra/scripts/seo-backfill-generate.sh` |
| SEO Backfill systemd | `infra/systemd/seo-backfill-poller.service` |
| SEO Backfill Admin UI | `apps/admin/src/pages/SeoBackfillPage.tsx` |
| Internal Endpoints | `backend/src/Api/Endpoints/InternalEndpoints.cs` |
| SSG Periodic Worker | `backend/src/Api/Services/SsgPeriodicRebuildWorker.cs` |
| SSG | `apps/web/scripts/prerender.mjs` |
| nginx config | `infra/nginx/textstack.conf` |
| Profile API | `backend/src/Api/Endpoints/ProfileEndpoints.cs` |
| Guest Context | `apps/web/src/context/GuestLimitsContext.tsx` |
| Native Lang Context | `apps/web/src/context/NativeLanguageContext.tsx` |
| Email Service | `backend/src/Infrastructure/Services/ResendEmailService.cs` |
| Guest Cleanup | `backend/src/Worker/Services/GuestCleanupWorker.cs` |
| Guest Capabilities (mobile) | `apps/mobile/src/lib/capabilities.ts` |
| Guest Minting (mobile) | `apps/mobile/src/lib/guestSession.ts`, `src/components/SessionGate.tsx` |
| AI Account Policy | `backend/src/Api/Extensions/AiAccountPolicy.cs` |
| Highlights Page | `apps/web/src/pages/HighlightsPage.tsx` |
| Mobile App | `apps/mobile/app/` (Expo Router pages) |
| Mobile API | `apps/mobile/src/lib/api.ts` |
| Mobile Contexts | `apps/mobile/src/context/` |
| Mobile E2E | `apps/mobile/e2e/` |
| CI Workflow | `.github/workflows/ci.yml` |
| Deploy Workflow | `.github/workflows/deploy.yml` |
| Backup Workflow | `.github/workflows/backup.yml` |
| Health Check | `.github/workflows/health-check.yml` |

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

### Mobile App Architecture

**Framework**: Expo 57, React Native 0.86.3, Expo Router (file-based routing). Upgraded 55 → 57 in one
step on 2026-09-28: SDK 56 and 57 bundle the *same* third-party native modules, so stopping at 56
would have bought a second upgrade for no reduction in risk. TypeScript is deliberately held at the
workspace catalog's 5.9 and listed in `expo.install.exclude` — the SDK asks for 6.0, which is a major
across web, admin and packages too and belongs in its own change.

**Pages** (`apps/mobile/app/`): tabs (library, search, upload, vocabulary, profile; `index` redirects), auth, book detail, reader, highlights + review, stats, vocabulary + review, user book upload/read.

**Contexts** (`apps/mobile/src/context/`): AuthContext, DownloadContext, LanguageContext, NativeLanguageContext, ThemeContext, ToastContext.

**Hooks** (`apps/mobile/src/hooks/`), e.g. useCardAnswer, useHaptics, useReaderChapter, useReaderPersistence, useReaderSettings, useReadingSession, useTts, useVocabularyReview.

**API**: Single `apps/mobile/src/lib/api.ts` module (consolidated, not split like web).

**Offline** (`src/lib/offlineDb.ts`, SQLite): covers BOTH catalogue editions and the reader's own uploads (uploads since 2026-09-14). Chapters **and, since 2026-09-27, a PDF upload's original file** (`src/lib/originalFileCache.ts`, under `Paths.document/originals/`, 2 GB budget with LRU eviction) — so a PDF opens offline in the same Original layout it has online instead of being substituted with its extracted text. When the original is missing it still falls back to reflow, and the server progress write is suppressed there to stop a chapter-space position overwriting a `page:<N>` one. `offlineDb.web.ts` is a no-op twin and **every export must exist in both** or the web bundle (which mobile e2e runs against) fails to resolve. Sign-out wipes cached uploads, never catalogue downloads. Details: `docs/05-features/offline-reading.md#mobile`.

**The reading path waits for neither a token nor a network, and that is a rule rather than a
property.** Both chapter loaders (`src/hooks/useReaderChapter.ts`, `src/components/reader/useUserBookReaderSource.ts`)
read SQLite **first** and only then ask the server, whose answer refreshes the stored row in place
(`refreshCachedChapter`, an `UPDATE` that leaves `cached_at` alone — the insert would reorder the
offline table of contents) and never re-renders the chapter under someone reading it. Network-first
was not wrong on a plane, where `fetch` rejects at once; it was wrong on every network that is
present but useless — a captive portal, a tunnel — where the reader waited out the socket timeout in
front of a book already on the phone. `chapterLoadOrder.test.ts` pins the ordering, because nothing
in CI can feel it.

**What an account is still for**, now that reading needs none: cross-device sync, the upload quota,
and **wiping one account's private files when it signs out** — without that last one a reader's PDF
stays on the phone for whoever signs in next. Nothing on the reading path may grow a fourth reason.
An automatic sweep also removes downloads whose book the account no longer has
(`chooseOrphanedDownloads`), which is only safe because the listing it compares against either
succeeded or threw.

**E2E**: Playwright specs in `apps/mobile/e2e/tests/` — navigation, books, search, vocabulary, highlights, reader smoke. Not run by CI (needs a live backend).

**Build**: EAS Build (cloud) for dev/prod. OTA updates via `expo-updates`.

### Releasing to Play Internal Testing

```bash
cd apps/mobile
eas build -p android --profile production --auto-submit-with-profile internal
```

(`--auto-submit` alone FAILS — the profile must be named. `eas.json` has `submit.internal`, `closed` and `production`; `production` opens a 10% staged rollout, which EAS cannot widen afterwards — 25/50/100 is done by hand in Play Console. For JS-only changes prefer an OTA: `npx eas-cli update --branch production --platform android --environment production -m "<msg>"` — `--environment` is REQUIRED whenever the run is non-interactive, and the command fails without it. Verify the runtime first, from `apps/mobile` and nowhere else: `npx expo-updates fingerprint:generate --platform android` silently computes a different hash from the repo root and reports it as valid. CI path, and the one to prefer: the `mobile-release.yml` workflow_dispatch — the repo secret `EXPO_TOKEN` has been set since 2026-09-01. It builds from a clean checkout, which is the only way to avoid the fingerprint poisoning above rather than work around it.)

That single command builds the AAB and pushes it to Internal Testing. Service account key is stored in EAS-managed credentials (uploaded via `eas credentials -p android` or the web dashboard), so `eas submit` works from any machine or CI without a local key file. Local mirror at `apps/mobile/google-service-account.json` (gitignored) is a convenience backup, not required. Service account email: `eas-submit-textstack@orbital-heaven-496518-t5.iam.gserviceaccount.com`. Permission granted: "Release apps to testing tracks" for the TextStack app.

## CI/CD

**GitHub Actions workflows** (`.github/workflows/`):
- **ci.yml** — runs on PR + push to main. Jobs: backend (build, lint, migrations, search tests), frontend (web + admin build), docker (integration tests), e2e (Playwright)
- **deploy.yml** — skips docs, `apps/mobile/**`, `extension/**` pushes (never `packages/**`/lockfile). In parallel: `ci` (merged-tree), `images` (GitHub-hosted `images.yml`: build → `scripts/scan-image-secrets.sh` gate → push `ghcr.io/mrviduus/textstack-<svc>:<sha>`, outputs digests) and `backup` (self-hosted pre-deploy dump; failure blocks deploy). Then self-hosted `deploy`: checkout → web build → dist secret scan → pull `name@digest` (no digest/pull fails → server build) → health → SSG check. Rollback (`rollback_commit`) must be hex and on `origin/main` (`guard` job). Full SSG rebuild only with `rebuild_ssg`; otherwise nightly in backup.yml. Pipeline, deps, controls: `docs/01-architecture/delivery.md`, ADR-020
- **Pins**: every action by commit SHA (`# vX.Y`), every pulled image `tag@sha256:…`; Dependabot moves them. Every workflow has a read-only/none top-level `permissions:`; widen per job only
- **backup.yml** — daily at 3 AM UTC. DB dump + storage tar.gz, keeps 5 newest of each
- **health-check.yml** — every 5 min. Checks API + both frontends

## Deployment

```
Internet → Cloudflare (DNS+SSL) → Cloudflare Tunnel → nginx (port 80)
  ├─ textstack.app → SSG static files + /api/ proxy to :8080 + /mcp proxy to :8090
  └─ textstack.dev → admin panel (:81)
```

Docker services: `db` (pgvector pg16, digest-pinned), `migrator`, `api`, `worker`, `admin`, `ssg-worker`, `aspire-dashboard` (profile-gated), `ollama`, `mcp-server` (profile-gated, `--profile mcp`). All localhost-only, no public ports except 80 via tunnel.

Images: built + secret-scanned on GitHub, pulled by digest from GHCR; secrets only in the server's `.env` at runtime. Never deploy by SSH — break-glass is `gh workflow run deploy.yml`.

**Nginx bot detection**: Regex map identifies crawlers (Google, Bing, Yandex, social bots) → routes to prerendered SSG HTML. Rate limiting zones: API (10r/s), uploads (1r/s), translation (5r/m), MCP (10r/s).

**Systemd services**: `seo-publish-poller` (auto-publish with SEO generation).

**Notable env vars** (beyond `.env.example` basics): `INDEXNOW_KEY`, `INDEXNOW_ENABLED`.

## Extraction Pipeline

Supported formats: EPUB, PDF. Processing order: Spelling → Hyphenation → Typography → Semantic → Linter. Details in `backend/src/Extraction/TextStack.Extraction/RULES.md`. ARM64 caveat: uses compiled `Regex` not `[GeneratedRegex]` (SIGILL bug).

## MCP Server (`backend/src/Ai/TextStack.Ai.Mcp/`)

Thin, stateless MCP↔HTTP bridge (Phase 8) — every tool call becomes an HTTP request to the public TextStack API (no DB/EF/OpenAI). 21 tools. Public catalog: `search_books`, `get_book`, `get_chapter`. The user's own uploads (Bearer): `search_my_library`, `get_my_book`, `get_my_chapter`, `save_my_highlight`, `list_my_book_highlights` — keyed by `bookId` (`UserBook.Id`), which is NOT an `editionId` and does not work in the edition-scoped tools. Write-back, either book type (Bearer): `save_insight`, `get_my_insights` — conclusions from an outside assistant, keyed by chapter **slug** (`BookInsight`, table `book_insight`), one per (user, book, chapter) so a re-run replaces rather than accumulates. Everything else (Bearer): `list_my_highlights`, `list_my_vocabulary` (returns word ids), `save_highlight`. Vocabulary writes (Bearer): `add_vocabulary_words` (≤20 per call, translation or definition required, one result line per word; a 429 or a missing native language stops the batch), `update_vocabulary_word`, `delete_vocabulary_word` — thin over `POST/PATCH/DELETE /me/vocabulary/words`; a save with no `nativeLanguage` falls back to the profile's, and a connect-key/OAuth save is tagged `source = "mcp"` server-side. Wipe-all `DELETE /me/vocabulary/words` refuses OAuth tokens and connect keys. Reading state (Bearer): `get_my_reading` — the shelf, **no arguments**, the only way in when the model holds no id; `get_book_progress`; `set_book_progress` — records a chapter finished ANYWHERE (audiobook, paper) and resumes the reader at the next one. Chapter review (Bearer, either book type): `get_chapter_review`, `save_chapter_review` — the reader's assistant reviews one chapter by the method in `Application/ChapterReview/ReviewMethod.md`; stored in the chapter's `BookInsight.ReviewJson` (ADR-016), questions in `review_question` with their own SRS queue (`/me/review-questions/*`); refused beyond the reader's progress. See `docs/05-features/chapter-review.md`. The tool count is asserted in four places (`McpManifestDriftTests`, `McpStdioSmokeTests`, `McpOverTheWireTests`, `McpManifestEndpointTests`) and the descriptions are mirrored verbatim into `Contracts/Mcp/McpManifest.cs`, which the drift test compares character for character.

**There is no question-answering tool.** `ask_book` and the retrieval spine behind it were deleted 2026-09-10: 7 books of 1498 were ever indexed, and the vision PDF transcription that fed the index was 94% of the project's lifetime LLM spend. An assistant reads `get_chapter` as plain text and reasons over it better, on the reader's own subscription.

**Assistant write ceiling**: `HighlightsEndpoints.MaxAssistantHighlightsPerBook` (200) caps how many highlights one book may receive over MCP, counted by `anchor_json->>'source' = 'mcp'` — the field `SynthesizeAnchor` writes. A person highlighting in the reader is never counted and never capped. `POST /me/highlights` and the vocabulary word writes (POST/PATCH/DELETE `/me/vocabulary/words`) are additionally rate-limited by the `highlight-write` policy (120/min, one budget per user across those routes), which — like `insights` — is **partitioned by user id rather than IP**: the MCP bridge reaches the API from one container address, so an IP key would let one looping client throttle every other MCP user.

**On a PDF upload an MCP highlight is saved and listed but not painted.** The reader renders PDFs as the original document (ADR-012) and `PdfHighlightLayer` only draws `kind:"pdf"` anchors, which are page geometry the bridge cannot produce. `get_my_book` reports `rendersAsOriginalPdf` so the model can say so. Roughly half the uploaded library is PDF.

The write-back exists because the reasoning happens in Claude/ChatGPT — where the reader already has a profile and a year of history — and only the **result** comes home. See `docs/05-features/mcp.md`.

**Dual transport** (env `MCP_TRANSPORT`: `stdio` default | `http`; `--http` flag also selects http). Shared wiring (tool catalog handlers, typed `TextStackApiClient`) in `McpBridgeCore`; the two host builders in `McpHosts`.
- **stdio** (local, single identity): `Host.CreateApplicationBuilder`, **logs→stderr** (stdout is JSON-RPC only — never `Console.Write*`), singleton DI, token from `TEXTSTACK_MCP_TOKEN` (static) or the device flow (`DeviceFlowTokenProvider`, AI-050). Byte-identical to the pre-049 server.
- **http** (AI-049, remote, **multi-user**): `WebApplication`, `.WithHttpTransport(o => o.Stateless = true)`, `app.MapMcp("/mcp")` + `GET /health`. **Bearer required on all of `/mcp`** — none → `401` + `WWW-Authenticate: Bearer resource_metadata=…` (ADR-017); the host also serves the protected-resource metadata. Each connection authenticates with its OWN `Authorization: Bearer <token>` — an OAuth access token (`tso_…`, `OAuthGrant`; AS in the API, `OAuthEndpoints.cs`: authorize → web consent `/en/oauth/consent` → token, CIMD+DCR, refresh rotation, account required), a connect key (`tsk_…`, `McpAccessKey`) or the AI-050 device-flow JWT — read per-request by `HttpContextTokenProvider` (SCOPED; `McpToolCatalog` + provider scoped so no identity leaks across connections). NEVER touches the device-flow cache. Package: `ModelContextProtocol.AspNetCore` 1.4.0 (matches the pinned `ModelContextProtocol`).

**Deploy** (http mode): Docker `mcp-server` (`backend/Docker/Mcp.Dockerfile`, profile `mcp`) binds `http://+:8090`, mapped `127.0.0.1:8090`; talks to the API over the **internal** docker network (`TEXTSTACK_API_URL=http://api:8080`). nginx `location /mcp` (upstream `textstack_mcp`, zone `mcp_limit`) proxies with SSE settings (`proxy_buffering off`, `Connection ""`, relays `Authorization`, 3600s timeouts). Behind Cloudflare tunnel — no new cloud. Bring up: `docker compose --profile mcp up -d mcp-server`. nginx config (incl. `/mcp` and the OAuth well-known/`/oauth/` blocks) is synced by `deploy.yml` ("Sync nginx config").

## Telemetry

OpenTelemetry → Aspire Dashboard (`localhost:18888`). OTLP: `:18889`. Services: `textstack-api`, `textstack-worker`.

## Package Management

Central versioning via `Directory.Packages.props` — don't add `<Version>` in individual csproj files. Target: `net10.0` (set in `Directory.Build.props`).

## Verifying SSG

After content changes, verify SSG is serving correctly:
```bash
# Check header indicates SSG (not SPA fallback)
curl -I https://textstack.app/en/books/dracula/ | grep X-SEO-Render
# Expected: X-SEO-Render: ssg

# Check SPA routes still work
curl -I https://textstack.app/en/search | grep X-SEO-Render
# Expected: X-SEO-Render: spa
```
