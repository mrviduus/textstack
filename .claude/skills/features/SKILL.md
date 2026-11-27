---
name: features
description: How TextStack's product features work end to end — books and upload flow, transitional chapters, reading sessions, translate/explain/TTS, vocabulary SRS, guest sessions and merge, email/password auth, highlights. Use when you change or debug one of these features, or before you add a new one beside them.
---

# Key concepts and features

This skill was rewritten for one database at M6 (2026-11-17). These parts are gone: the catalog (works, editions, authors, genres), SEO, SSG, auto publish, reading goals/achievements, the tutor and the legacy reading screen. Some can come back on V2: #1366.

## Key Concepts

**A book is the reader's own.** `books` → `book_files` (one row per file version, any of epub, pdf, mobi, azw3, fb2, cbz) → reading state, highlights, vocabulary, shares, checkpoints, insights. Schema: [ADR-031](../../../docs/architecture/adr/ADR-031-v2-schema.md), `database/migrations/`. Sync contract: [`v2-sync-protocol.md`](../../../docs/internal/v2/v2-sync-protocol.md) (a revision per row, an `operation_id` per logical write, change feeds by cursor).

**Upload flow**:
1. The client hashes the file (sha256) and calls `GET /me/v2/books/by-sha256/{sha256}`. The same bytes are the same book.
2. The client calls `PUT /me/v2/books/{id}`, then sends the parts.
3. The client calls `POST …/content`. The server checks the quota inside the attach.

The bytes land under `data/library` (`LibraryFileStore.cs`). The browser extension clips a page through `POST /me/books/clip`.

**Chapters = the TOC from the reading screen** (ADR-033). The reading screen parses the file and syncs its TOC (`PUT …/files/{fileId}/toc`, `book_files.toc`). `GET …/chapters` serves the TOC; it is empty until a reader opens the book. The server parses nothing.

**`chapter_number` is an ordering key, not a display ordinal.** Some books start at 0, some at 1 or 2. Show a chapter's **title** and use the number only to sort.

**Reading sessions**: `PUT /me/v2/reading/sessions/{clientSessionId}`, idempotent by the client's id. The personal pace (time left) reads them.

**Translation**: `POST /translate` (and `/api/translate`) through OpenAI. Config: `OpenAI:ApiKey`, `OpenAI:Model`, `OpenAI:Translate:MaxTextLength`.

**Explain (contextual)**: `POST /explain` gives an LLM explanation of 2–3 sentences for a word in its sentence (`OpenAI:Explain:Model`).
- The cache is a SHA256-keyed file cache at `data/explain-cache`.
- The route is rate limited per IP.
- Impl: `backend/src/Api/Endpoints/ExplainEndpoints.cs`, mapped by `CompatEndpoints.cs`.
- In **definition mode** (native = book language), the web word popup fetches Explain (`apps/web/src/lib/wordBubbleFetch.ts`).

**TTS**: Edge TTS through a direct WebSocket. `backend/src/Tts/TextStack.Tts/` (`EdgeTtsClient`, `EdgeTtsService`: disk cache + startup cleanup).
- Routes: `GET /tts?text=&lang=&voice=&speed=` → `audio/mpeg`, `GET /tts/voices`, `GET /tts/timestamps`. No auth.
- Cache `data/tts-cache/` (env `Tts__CachePath`); config `Tts:MaxTextLength`, `Tts:TimeoutSeconds`.
- Without a writable cache, TTS still works. Web hook: `useTts()`.

**Vocabulary SRS**: words saved on the reading screen sync through `/me/v2/vocabulary/*`. The server saves by key, merges case variants on `word_key`, and adds examples idempotently. To retire a word is not to delete it.
- The server schedules (`SrsEngine.cs` in `backend/src/Vocabulary/TextStack.Vocabulary/`, called by `VocabularySyncService`).
- `POST /me/v2/vocabulary/reviews` records an answer on the locked card. `GET /me/v2/vocabulary/due` is the queue.
- Clients: web `VocabularyPage.tsx`, `VocabularyReviewPage.tsx`, `components/vocabulary/`; mobile `app/vocabulary/review.tsx`.
- `ReviewCardDto.reviewMode` is vestigial (see `packages/shared/src/types/api.ts`).

**Guests**: a guest reads on a **real server-side user row**, which the server makes on demand ([ADR-014](../../../docs/architecture/adr/ADR-014-guest-sessions.md)).
- `POST /auth/guest` makes a user with `is_guest`, a synthesized email and a normal token pair. Every `/me/*` write works for it.
- **Each client has its own triggers.** Web: an upload from the landing (`HeroSection.tsx`) and saving a word on the reading screen (`useReaderVocabulary.ts`). Opening the reading screen is **not** a trigger: a crawler that runs JS made 7,147 of 7,263 guest rows that way until 2026-09-28.
- Mobile: `SessionGate` (`apps/mobile/src/components/SessionGate.tsx`; used by `app/my-books/upload.tsx` and the tabs layout). On every failure, the app opens signed out and does not block.
- Registering **promotes the same row in place**. Signing in to an existing account **merges** the guest per aggregate (`IAccountMergeRepository`, `AuthService`). OAuth grants and MCP keys die with the guest.
- Auth responses carry `guestMergeSkipped`; the web shows it (`GuestMergeSkippedToast` in `App.tsx`).
- Clients send `Authorization` on the merge entry points (`/auth/register`, `/auth/login`, `/auth/google`, `/auth/apple`). They **refresh an expiring token first** (`packages/shared/src/api/tokenExpiry.ts`). An expired bearer merges nothing and still answers 200.
- `capabilitiesFor(user)` (`packages/shared/src/lib/capabilities.ts`) is the single source of guest policy. `isAuthenticated` stays `user !== null`; never inline `user?.isGuest`.
- Entitlements: `Entitlements:Tiers:Guest` = `{ StorageLimitBytes: 50MB, MaxBooks: 1, DailyEnrichmentCap: 50, AiEnabled: false }` (`backend/src/Api/appsettings.json`, `EntitlementOptions.cs`). Unset or `<=0` means unlimited/allowed.
- Rate limiting: `guest-session` per IP per 5 min, `RateLimits:GuestSessionPermitLimit` (prod 3; CI raises it).
- `GuestActivityMiddleware` keeps `LastActiveAt` (10 min debounce in memory). **No guest reaper runs since M6 B3** (see `docs/STATUS.md`).

**Email/password auth** works beside Google and Apple. `ResendEmailService` sends password resets. The pages are `ResetPasswordPage` on web and `app/reset-password.tsx` on mobile.

**Highlights**: highlights live on `/me/v2/annotations` (colours, notes). Bookmarks are annotations of colour `bookmark` (ADR-031 Amended 2026-11-15). The web Highlights page reads `GET /me/highlights/all`.

**Removed, for the record**:
- dictionary (2026-10-03);
- EPUB export (2026-09-28; the app gives back the uploaded file);
- ask/RAG and reading screen chat (2026-09-10);
- the catalog, SEO backfill, auto publish, SSG and the tutor (M6, 2026-11-17).
