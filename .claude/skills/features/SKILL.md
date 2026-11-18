---
name: features
description: How TextStack's product features work end to end — books and upload flow, transitional chapters, reading sessions, translate/explain/TTS, vocabulary SRS, guest sessions and merge, email/password auth, highlights. Use when changing or debugging one of these features, or before adding a new one beside them.
---

# Key concepts and features

Rewritten for one database at M6 (2026-11-17): the catalog (works, editions, authors, genres), SEO, SSG, auto publish, reading goals/achievements, the tutor and the legacy reader are gone. Some may come back on V2: #1366.

## Key Concepts

**A book is the reader's own.** `books` → `book_files` (one row per file version, any of epub, pdf, mobi, azw3, fb2, cbz) → reading state, annotations, vocabulary, shares, checkpoints, insights. Schema: [ADR-031](../../../docs/architecture/adr/ADR-031-v2-schema.md), `database/migrations/`. Sync contract: [`v2-sync-protocol.md`](../../../docs/internal/v2/v2-sync-protocol.md) (revision per row, `operation_id` per logical write, change feeds by cursor).

**Upload flow**: the client hashes the file (sha256) → `GET /me/v2/books/by-sha256/{sha256}` (same bytes = same book) → `PUT /me/v2/books/{id}` → parts → `POST …/content` (quota checked inside the attach). Bytes land under `data/library` (`LibraryFileStore.cs`). The browser extension clips a page through `POST /me/books/clip`.

**Transitional chapters** (`book_chapters`, `ingestion_jobs`, kept by M6 D8): `V2IngestionWorker` extracts an uploaded EPUB/PDF into chapters for the MCP chapter tools and shares. The reader does not read them.

**`chapter_number` is an ordering key, not a display ordinal.** Some books start at 0, some at 1 or 2. Show a chapter's **title** and use the number only to sort.

**Reading sessions**: `PUT /me/v2/reading/sessions/{clientSessionId}`, idempotent by the client's id; the personal pace (time left) reads them.

**Translation**: `POST /translate` (and `/api/translate`) via OpenAI. Config: `OpenAI:ApiKey`, `OpenAI:Model`, `OpenAI:Translate:MaxTextLength`.

**Explain (contextual)**: `POST /explain` — LLM 2–3 sentence explanation of a word in its sentence (`OpenAI:Explain:Model`). SHA256-keyed file cache at `data/explain-cache`. Rate limited per IP. Impl: `backend/src/Api/Endpoints/ExplainEndpoints.cs`, mapped by `V2CompatEndpoints.cs`. In **definition mode** (native = book language) the web word popup fetches Explain (`apps/web/src/lib/wordBubbleFetch.ts`).

**TTS**: Edge TTS via direct WebSocket. `backend/src/Tts/TextStack.Tts/` (`EdgeTtsClient`, `EdgeTtsService`: disk cache + startup cleanup). `GET /tts?text=&lang=&voice=&speed=` → `audio/mpeg`, `GET /tts/voices`, `GET /tts/timestamps`. No auth. Cache `data/tts-cache/` (env `Tts__CachePath`); config `Tts:MaxTextLength`, `Tts:TimeoutSeconds`. Without a writable cache TTS still works. Web hook: `useTts()`.

**Vocabulary SRS**: words saved from the reader sync through `/me/v2/vocabulary/*` (save by key, case variants merge on `word_key`, examples idempotent, retire ≠ delete). The server schedules (`SrsEngine.cs` in `backend/src/Vocabulary/TextStack.Vocabulary/`, called by `VocabularySyncService`); `POST /me/v2/vocabulary/reviews` records an answer on the locked card, `GET /me/v2/vocabulary/due` is the queue. Clients: web `VocabularyPage.tsx`, `VocabularyReviewPage.tsx`, `components/vocabulary/`; mobile `app/vocabulary/review.tsx`. `ReviewCardDto.reviewMode` is vestigial (see `packages/shared/src/types/api.ts`).

**Guest users**: anonymous use on a **real server-side user row**, minted on demand ([ADR-014](../../../docs/architecture/adr/ADR-014-guest-sessions.md)).
- `POST /auth/guest` mints a user with `is_guest`, a synthesized email and a normal token pair; every `/me/*` write works for it.
- **Triggers differ per client.** Web: an upload from the landing (`HeroSection.tsx`) and saving a word in the reader (`useV2ReaderVocabulary.ts`) — **not reader mount** (a crawler that runs JS minted 7,147 of 7,263 guest rows that way until 2026-09-28). Mobile: `SessionGate` (`apps/mobile/src/components/SessionGate.tsx`; used by `app/my-books/upload.tsx` and the tabs layout); every failure opens signed out rather than blocking.
- Registering **promotes the same row in place**; signing in to an existing account **merges** the guest per aggregate (`IAccountMergeRepository`, `V2AuthService`). OAuth grants and MCP keys die with the guest. Auth responses carry `guestMergeSkipped`; the web shows it (`GuestMergeSkippedToast` in `App.tsx`).
- Clients send `Authorization` on the merge entry points (`/auth/register`, `/auth/login`, `/auth/google`, `/auth/apple`) and **refresh an expiring token first** (`packages/shared/src/api/tokenExpiry.ts`): an expired bearer merges nothing and still answers 200.
- `capabilitiesFor(user)` (`packages/shared/src/lib/capabilities.ts`) is the single source of guest policy. `isAuthenticated` stays `user !== null`; never inline `user?.isGuest`.
- Entitlements: `Entitlements:Tiers:Guest` = `{ StorageLimitBytes: 50MB, MaxBooks: 1, DailyEnrichmentCap: 50, AiEnabled: false }` (`backend/src/Api/appsettings.json`, `EntitlementOptions.cs`). Unset / `<=0` = unlimited/allowed.
- Rate limiting: `guest-session` per IP per 5 min, `RateLimits:GuestSessionPermitLimit` (prod 3; CI raises it).
- `GuestActivityMiddleware` keeps `LastActiveAt` (10 min debounce in memory). **No guest reaper runs since M6 B3** (see `docs/STATUS.md`).

**Email/password auth** alongside Google and Apple: `ResendEmailService` sends password resets; `ResetPasswordPage` on web, `app/reset-password.tsx` on mobile.

**Highlights**: annotations on `/me/v2/annotations` (colours, notes; bookmarks are annotations of colour `bookmark`, ADR-031 Amended 2026-11-15). The web Highlights page reads `GET /me/highlights/all`.

**Removed, for the record**: dictionary (2026-10-03), EPUB export (2026-09-28; the app hands back the uploaded file), ask/RAG and reader chat (2026-09-10), the catalog, SEO backfill, auto publish, SSG and the tutor (M6, 2026-11-17).
