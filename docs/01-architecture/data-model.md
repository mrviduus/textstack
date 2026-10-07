# Data Model Overview

One-page map of Postgres entities. For exact columns + types read
`backend/src/Domain/Entities/` — C# records are the source of truth.
For schema evolution read `backend/src/Infrastructure/Migrations/`
(138 migrations as of 2026-10-04, chronological). `AppDbContext` is split into partials by area
(`AppDbContext.Catalog.cs`, `.Reading.cs`, `.Vocabulary.cs`, `.Ai.cs`, `.OAuth.cs`, …). 64 `DbSet`s.

## Grouped by domain

### 1. Catalog (admin-curated library)

Canonical books and their metadata. Admins create/edit; SSG prerenders pages
for SEO.

- `Work` — canonical title (just slug)
- `Edition` — per-language version of a Work. Title, description, cover, SEO fields
- `Chapter` — rendered HTML + plain text + FTS vector
- `Author`, `EditionAuthor` — many-to-many
- `Genre` — Edition ↔ Genre many-to-many via `edition_genres` (`Edition.Genres`)
- `BookFile`, `BookAsset` — raw uploaded originals + derived covers
- `IngestionJob` — async pipeline (upload → parse → chapters)
- `AutoPublishJob`, `BookQualityJob`, `LintResult` — quality/autopublish pipelines

### 2. SEO + search

Supporting the discovery layer.

- `SsgRebuildJob`, `SsgRebuildResult` — Puppeteer prerender queue
- `SeoTemplate`, `SeoBackfillJob`, `SeoBackfillSettings` — admin SEO automation
- `TextStackImport` — bulk import pipeline

Search has no table of its own: `chapters.search_vector` is maintained by a DB trigger
(`search_documents` was dropped 2026-10-01).

### 3. Users + auth

End-users and their authentication primitives.

- **`User` — PII** (email, optional name, OAuth subject IDs)
- `UserRefreshToken` — refresh tokens (random string, stored as-is)
- `DeviceAuthorization` — MCP device-flow codes
- `McpAccessKey` — `tsk_…` connect keys
- `OAuthClient`, `OAuthAuthorizationRequest`, `OAuthGrant` — our OAuth AS for MCP ([ADR-017](adr/ADR-017-mcp-oauth-authorization-server.md))
- `PasswordResetToken` — short-lived email reset
- **`AdminUser` — PII** (email only)
- `AdminRefreshToken`, `AdminSettings`

### 4. User-uploaded books (parallel to catalog)

Separate from admin catalog — each user has their own library.

- `UserBook` → `UserChapter`
- `UserBookFile` — original upload (may hold filename; not PII)
- `UserIngestionJob` — per-user async parse
- `UserBookBookmark`
- `UserLibrary` — User ↔ Edition favorites
- `Collection`, `BookCollection` — user shelves; `BookCollection.BookType` is `userbook` | `savedbook` (polymorphic, no FK to the book)

### 5. Reading engagement

What users do while reading. Drives stats, achievements, offline sync.

- `ReadingProgress` — per-book position
- `ReadingSession` — time-boxed session (30s heartbeat, duration, words read)
- `ReadingGoal` — daily_minutes / books_per_year target
- `UserAchievement` — 20 achievements (milestones/streaks)
- `Bookmark`, `Highlight`, `Note` — annotations
- `BookInsight` — one assistant conclusion per (user, book, chapter); `ReviewJson` holds the chapter review ([ADR-016](adr/ADR-016-chapter-review-lives-in-book-insight.md))
- `ReviewQuestion` — self-check questions from chapter reviews, own SRS queue
- `UserVocabularySettings`

### 6. Vocabulary SRS

Spaced-repetition language learning layer.

- `VocabularyWord` — saved word + LLM-generated distractors/hint/explanation + SRS state (stage, interval)
- `VocabularyReview` — each answer event (correct, time, mode)
- `PendingVocabularyWord` — saves over the daily cap; `DailyCapReconcilerWorker` promotes them into `VocabularyWord` later
- `WordLookup` — tapped rare words kept out of SRS until tapped again
- `WordFrequency` — Zipf frequency reference data (loaded at startup)
- `WordCluster` — groups of saved words (book / concept clusters; concept clustering uses `VocabularyWord.Embedding`, pgvector)
- `TutorSession` — Learning Tutor state between turns

### 7. AI ops (model gateway, evals)

- `LlmTrace` — sampled LLM call traces (cost, latency)
- `ShadowRun` — primary vs shadow model comparisons
- `ModelRegistration` (table `models`), `ModelPromotion` — model registry + promote/rollback
- `EvalRun` — eval score history
- `DriftCentroid` — daily embedding centroids (pgvector) for drift alerts
- `AgentRun` — persisted agent run steps

### 8. Multisite (legacy — single-site permanent, ADR-007)

- `Site`, `SiteDomain` — still resolved per request; `ISiteScoped` entities carry `SiteId` and get
  an EF global query filter on `ICurrentSite.Id` (see [multisite.md](multisite.md))

## Ownership graph (high-level)

```
Site ─┬─ Work ── Edition ─┬─ Chapter
      │                    ├─ EditionAuthor ─ Author
      │                    └─ edition_genres ─ Genre (M:N)
      │
      ├─ User ─┬─ UserRefreshToken
      │       ├─ UserLibrary ─ Edition (favorites)
      │       ├─ ReadingProgress, ReadingSession, ReadingGoal, UserAchievement
      │       ├─ Bookmark, Highlight, Note            (on Chapter)
      │       ├─ VocabularyWord → VocabularyReview
      │       └─ UserBook ─┬─ UserChapter
      │                    ├─ UserBookFile
      │                    ├─ UserBookBookmark
      │                    └─ UserIngestionJob
      │
      └─ AdminUser ─ AdminRefreshToken
```

## PII / GDPR map

Tables that hold personal data, for data-flow / subject-access-request
planning.

| Table | Fields | Notes |
|-------|--------|-------|
| `User` | email, name?, google_subject?, apple_subject?, last_active_at | Primary PII |
| `AdminUser` | email | Internal staff accounts |
| `UserRefreshToken` | user_id + token (plain) | Session binding |
| `AdminRefreshToken` | admin_user_id + cookie hash | Session binding |
| `PasswordResetToken` | user_id + short-lived token hash | Auto-expires |
| `ReadingSession`, `ReadingProgress`, `ReadingGoal`, `UserAchievement` | user_id FK | Activity, behavioural |
| `VocabularyWord`, `VocabularyReview`, `UserVocabularySettings` | user_id FK | Learning patterns |
| `Bookmark`, `Highlight`, `Note`, `BookInsight`, `ReviewQuestion` | user_id FK | Reading annotations, assistant output |
| `McpAccessKey`, `OAuthGrant`, `DeviceAuthorization` | user_id FK | Credentials |
| `LlmTrace`, `ShadowRun` | prompt/response text (PII-scrubbed before write) | AI observability |
| `UserBook`, `UserChapter`, `UserBookFile`, `UserBookBookmark`, `UserLibrary`, `UserIngestionJob` | user_id FK | User-uploaded content + library |

**Guest users**: `User` rows with `is_guest = true` ([ADR-014](adr/ADR-014-guest-sessions.md)).
`GuestCleanupWorker` runs every 2 h and deletes guests inactive 30 days **that hold nothing durable**
(vocab, highlights, bookmarks, library, uploads, notes, progress). Engaged guests are kept.

**Account deletion**: self-service hard delete, `DELETE /me/account` (`AccountEndpoints.cs`,
rate-limited, refuses OAuth tokens).

## Migrations

- Count: 138. Not all additive: e.g. `RemoveAdminAuditLog` (2026-01-22), `DropSearchDocuments` (2026-10-01).
- Tool: `dotnet ef migrations add <Name> --project backend/src/Infrastructure --startup-project backend/src/Api`
- Rollback all: `docker compose run --rm -e MIGRATE_TARGET=0 migrator`
- Migrator runs as one-shot container in prod compose; `api` waits on
  `service_completed_successfully`. It is the only thing that migrates
  ([ADR-021](adr/ADR-021-migrations-owned-by-the-migrator.md)); a schema behind the Api's build shows as
  `/health/ready` 503 (`components.schema`).

## See also

- [CLAUDE.md](../../CLAUDE.md#key-concepts) — entity descriptions + workflows
- [backend/src/Domain/Entities/](../../backend/src/Domain/Entities/) — C# records
- [docs/01-architecture/multisite.md](multisite.md) — site resolution (ADR-007)
- [docs/03-ops/backup.md](../03-ops/backup.md) — backup + restore drill
