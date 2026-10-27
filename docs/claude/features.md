# Key concepts and features

Moved verbatim from `CLAUDE.md` (2026-10-12) to keep the always-loaded context small. Read when the task touches this area.

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

**Translation**: `POST /api/translate` via OpenAI (`gpt-4.1-mini`). Config: `OpenAI:ApiKey`, `OpenAI:Model`, `OpenAI:Translate:MaxTextLength`. LibreTranslate dropped 2026-04-22.

**Explain (contextual)**: `POST /api/explain` — LLM-powered 2-3 sentence explanation of a word in the sentence it appears in. Uses `ILlmService` (OpenAI `gpt-4.1-mini` via `OpenAI:Explain:Model` — kept on mini 2026-10-03 because the saving was cents; translate is on mini too since 2026-10-24). SHA256-keyed file cache at `data/explain-cache`, 30d TTL. Rate limited per-IP (20/min). Impl: `backend/src/Api/Endpoints/ExplainEndpoints.cs`.

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

**Guest Users**: Anonymous reading on a **real server-side `User` row**, minted on demand. Full posture + rejected alternatives: [ADR-014](../01-architecture/adr/ADR-014-guest-sessions.md).
- `POST /auth/guest` mints a `User` with `IsGuest=true`, a synthesized `guest-<hex>@guest.local` email and a normal token pair. All `/me/*` writes work for it — progress, highlights, bookmarks, vocabulary all sync.
- **Triggers differ per client.** Web: upload, and the 3rd pending vocabulary word — **not reader mount**, which was a trigger until 2026-09-28 and minted 7,147 of the 7,263 guest rows then on production, because a crawler that executes JS is indistinguishable from a reader opening a chapter. `readerDoesNotMintOnMount.test.ts` fails the build if it comes back. **Mobile: opening a book, the upload screen, or tapping Download on a catalog book** (the last since 2026-10-09, QA-007 LIB-1: a download is intent and the book must land in the Library) — `SessionGate` (`src/components/SessionGate.tsx`) wraps both reader routes and, since 2026-09-28 (#628), `/my-books/upload`, single-flighted, 3s deadline, and every failure (offline, rate limited, bootstrap wedged) opens the book signed out rather than blocking it.
- Registering **promotes that same row in place** (`AuthService.RegisterWithEmailAsync`); signing in to an existing account **merges** it (`MergeGuestAsync`, one transaction, account's row wins on conflict except `ReadingProgress` = newer wins). `MergeGuestAsync` returns `false` — never throws — on a SQLSTATE-23 conflict, because a throw here is a permanent sign-in outage.
- Auth responses carry `guestMergeSkipped` (`invalid_token` | `merge_conflict`), null on the ordinary path. Additive; **no client reads it yet**, but every occurrence logs a structured Warning.
- Clients must send `Authorization` on the four merge entry points (`/auth/register`, `/auth/login`, `/auth/google`, `/auth/apple`) — and must **refresh an expiring token first** (`packages/shared/src/api/tokenExpiry.ts`). An expired bearer is worse than none: the server ignores it and answers 200 with nothing merged.
- `apps/mobile/src/lib/capabilities.ts` is the single source of guest policy (`capabilitiesFor(user)`). Account-only: AI, identity editing, account deletion, cross-device sync, silent sign-out. Deliberately *not*: reading, translation, saving vocabulary. **Upload was account-only until 2026-09-06 and is now open to a guest** (ADR-014 §3a) — `canUpload` is the one capability that is a *session* predicate (`hasSession`), so it is false only with no session at all — and the upload route's `SessionGate` mints one on arrival. `isAuthenticated` stays `user !== null` (a guest **has** a session); only account questions go through capabilities. `capabilityLiterals.test.ts` fails the build on inline `user?.isGuest` re-derivation.
- A guest's Sign Out is a **destructive confirm**: the three SecureStore keys are the only handle on the row, which `GuestCleanupWorker` then keeps forever, unreachable.
- Server-side enforcement, not just UI: `RequireAiAccount()` (`Api/Extensions/AiAccountPolicy.cs`) returns **403 `account_required`** (distinct from 401 — "sign up" vs "sign in") on the paid-inference surface (tutor). Librarian, ask, book chat, study buddy and RAG indexing were deleted 2026-09-10. Never applied to translate/explain/TTS.
- Entitlements: `Entitlements:Tiers:Guest` = `{ StorageLimitBytes: 50MB, MaxBooks: 1, DailyEnrichmentCap: 50, AiEnabled: false }`. The tier is the only thing metering a guest upload since the 2026-09-06 reversal — the client used to block it by product choice as well, and no longer does. `DailyEnrichmentCap` clamps the user's own daily vocabulary cap (`DailyCapService.EffectiveCap`) and is also checked by `PromoteLookup`. Unset / `<=0` means unlimited/allowed — a config typo costs money, never an outage.
- GuestLimitsContext (web) holds the last-read book and the word-count threshold that triggers minting. There are no client-side usage limits.
- GuestCleanupWorker: every **2h**, deletes guests inactive **30d** — but only those holding nothing durable (vocab, highlights, bookmarks, library, uploads, progress). Engaged guests live indefinitely. ReadingSessions are deliberately excluded from that filter.
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
- Publishing queues no SSG rebuild (ADR-023): the book reaches crawlers at the nightly Full rebuild

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
- SSG worker: separate always-running container, the queue's only consumer (ADR-022). The API only inserts a `Queued` Full job (nightly / `make rebuild-ssg` / admin button; a Queued or Running Full blocks the nightly and `make` path); the worker claims it every 5s (`FOR UPDATE SKIP LOCKED` → `Running`) and, before every claim, fails any `Running` row (between jobs nothing of its own is running, so such a row is dead). Supports IndexNow (Bing/Yandex) via `INDEXNOW_KEY`
- Schedule: only `backup.yml`'s nightly Full rebuild (the periodic worker and its admin settings were deleted 2026-10-08)

**When to rebuild SSG**: nothing rebuilds on an edit (no per-edit jobs since 2026-10-08, ADR-023).
After adding/publishing books, editing metadata, authors, genres or the Popular shelf, crawlers see the
change after the nightly Full rebuild; for it now, run `make rebuild-ssg` or the admin "New Rebuild"
button. NOT needed for: reading progress, bookmarks, user data
