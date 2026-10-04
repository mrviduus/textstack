# TextStack Database Schema

> **Partial and partly historical (checked 2026-10-04).** This page details the original ~28 tables.
> The database now has 64 entity sets; reading-engagement extras, collections, insights/review
> questions, MCP/OAuth credentials, AI-ops and podcast tables are listed only in
> [data-model.md](../01-architecture/data-model.md). Source of truth: `backend/src/Domain/Entities/`
> and `backend/src/Infrastructure/Migrations/AppDbContextModelSnapshot.cs`. Multisite is vestigial
> (one site, [ADR-007](../01-architecture/adr/007-single-domain-consolidation.md)); `uk` content was removed 2026-04-21.

## Quick Start
```bash
docker compose up --build
```
Services: API :8080 | Admin :81 | DB is internal (no host port). Web dev server: `pnpm -C apps/web dev` (:5173).

---

## Entity Relationship Diagram (ASCII)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             MULTISITE DOMAIN                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────┐         ┌─────────────┐                                      │
│   │   Site   │ 1────N  │ SiteDomain  │                                      │
│   │──────────│         │─────────────│                                      │
│   │ id       │         │ id          │                                      │
│   │ code   ● │         │ site_id   → │                                      │
│   │ primary  │         │ domain    ● │                                      │
│   │ default  │         │ is_primary  │                                      │
│   │ _domain  │         │ created_at  │                                      │
│   │ _language│         └─────────────┘                                      │
│   │ theme    │                                                              │
│   │ ads_on   │                                                              │
│   │ index_on │                                                              │
│   │ sitemap  │                                                              │
│   │ features │                                                              │
│   └────┬─────┘                                                              │
│        │                                                                    │
│        ├────────────────┬────────────────┬────────────────┐                 │
│        ▼                ▼                ▼                ▼                 │
│   ┌────────┐      ┌──────────┐      ┌────────┐      ┌─────────┐            │
│   │  Work  │      │  Author  │      │  Genre │      │ Edition │            │
│   └────────┘      └──────────┘      └────────┘      └─────────┘            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              METADATA DOMAIN                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌────────────┐                              ┌────────────┐               │
│   │   Author   │                              │   Genre    │               │
│   │────────────│                              │────────────│               │
│   │ id         │                              │ id         │               │
│   │ site_id  → │                              │ site_id  → │               │
│   │ slug     ● │                              │ slug     ● │               │
│   │ name       │                              │ name       │               │
│   │ bio        │                              │ description│               │
│   │ photo_path │                              │ indexable  │               │
│   │ indexable  │                              │ seo_title  │               │
│   │ seo_title  │                              │ seo_desc   │               │
│   │ seo_desc   │                              │ created_at │               │
│   │ created_at │                              │ updated_at │               │
│   │ updated_at │                              └─────┬──────┘               │
│   └─────┬──────┘                                    │                      │
│         │                                           │                      │
│         │              ┌────────────────┐           │                      │
│         └──────────────┤ EditionAuthor  ├───────────┘                      │
│                        │────────────────│           │                      │
│         ┌──────────────┤ edition_id PK→ │           │                      │
│         │              │ author_id  PK→ │───────────┘                      │
│         │              │ order          │                                  │
│         │              │ role           │ ← Author/Translator/etc          │
│         ▼              └────────────────┘                                  │
│   ┌─────────────┐                                                          │
│   │   Edition   │ ←──── M:N via EditionAuthor + M:N via EditionGenres      │
│   └─────────────┘                                                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              CONTENT DOMAIN                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────┐         ┌─────────────┐         ┌───────────┐               │
│   │   Work   │ 1────N  │   Edition   │ 1────N  │  Chapter  │               │
│   │──────────│         │─────────────│         │───────────│               │
│   │ id       │         │ id          │         │ id        │               │
│   │ site_id→ │         │ work_id  →  │         │ edition_id→│               │
│   │ slug  ●  │         │ site_id  →  │         │ number    │               │
│   │ created  │         │ language    │         │ slug      │               │
│   └──────────┘         │ slug     ●  │         │ title     │               │
│                        │ title       │         │ html      │               │
│                        │ description │         │ plain_text│               │
│                        │ status      │         │ word_count│               │
│                        │ source_id →○│         │ search_vec│ ← FTS GIN    │
│                        │ cover_path  │         │ orig_num  │ ← split info │
│                        │ is_public   │         │ part_num  │               │
│                        │ indexable   │ ← SEO   │ total_pts │               │
│                        │ seo_title   │         └───────────┘               │
│                        │ seo_desc    │                                      │
│                        │ canonical   │                                      │
│                        └──────┬──────┘                                      │
│                               │                                             │
│                    ┌──────────┼──────────┐                                  │
│                    │          │          │                                  │
│              ┌─────┴─────┐ ┌──┴───┐ ┌────┴────────┐                         │
│              │ BookFile  │ │Asset │ │IngestionJob │                         │
│              │───────────│ │──────│ │─────────────│                         │
│              │ id        │ │id    │ │ id          │                         │
│              │ edition_id→ │ed_id→│ │ edition_id →│                         │
│              │ file_name │ │kind  │ │ book_file_id→                         │
│              │ path      │ │path  │ │ target_lang │                         │
│              │ format    │ │type  │ │ status      │                         │
│              │ sha256    │ │size  │ │ diagnostics │                         │
│              └───────────┘ └──────┘ └─────────────┘                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                               USER DOMAIN                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌────────────┐         ┌─────────────────┐                                │
│   │    User    │ 1────N  │UserRefreshToken │                                │
│   │────────────│         │─────────────────│                                │
│   │ id         │         │ id              │                                │
│   │ email    ● │         │ user_id       → │                                │
│   │ name       │         │ token           │                                │
│   │ picture    │         │ expires_at      │                                │
│   │ google_sub●│         │ created_at      │                                │
│   │ created    │         └─────────────────┘                                │
│   └─────┬──────┘                                                            │
│         │                                                                   │
│    ┌────┼────────────────┬────────────────┐                                 │
│    │    │                │                │                                 │
│    ▼    ▼                ▼                ▼                                 │
│ ┌──────────────┐  ┌───────────┐  ┌──────────┐  ┌─────────────┐             │
│ │ReadingProgress│  │ Bookmark  │  │   Note   │  │ UserLibrary │             │
│ │──────────────│  │───────────│  │──────────│  │─────────────│             │
│ │ id           │  │ id        │  │ id       │  │ id          │             │
│ │ user_id    → │  │ user_id → │  │ user_id →│  │ user_id   → │             │
│ │ site_id    → │  │ site_id → │  │ site_id →│  │ edition_id →│             │
│ │ edition_id → │  │ edition_id→│  │ edition →│  │ created_at  │             │
│ │ chapter_id → │  │ chapter_id→│  │ chapter →│  └─────────────┘             │
│ │ locator      │  │ locator   │  │ locator  │   ● unique(user,edition)     │
│ │ percent      │  │ title     │  │ text     │                              │
│ │ updated      │  │ created   │  │ version  │ ← conflict resolution        │
│ └──────────────┘  └───────────┘  │ highlight│ → (optional)                 │
│  ● unique(user,site,edition)     │ created  │                              │
│                                  │ updated  │                              │
│                                  └──────────┘                              │
│                                                                            │
│ ┌─────────────┐                                                            │
│ │  Highlight  │                                                            │
│ │─────────────│                                                            │
│ │ id          │                                                            │
│ │ user_id   → │                                                            │
│ │ site_id   → │                                                            │
│ │ edition_id →│                                                            │
│ │ chapter_id →│                                                            │
│ │ anchor_json │ ← TextAnchor serialized                                    │
│ │ color       │ ← yellow|green|pink|blue                                   │
│ │ selected_txt│                                                            │
│ │ note_text   │                                                            │
│ │ version     │                                                            │
│ │ created     │                                                            │
│ │ updated     │                                                            │
│ └─────────────┘                                                            │
│                                                                            │
│ ┌─────────────────┐    ┌───────────────┐    ┌──────────────────┐           │
│ │ ReadingSession  │    │  ReadingGoal  │    │ UserAchievement  │           │
│ │─────────────────│    │───────────────│    │──────────────────│           │
│ │ id              │    │ id            │    │ id               │           │
│ │ user_id       → │    │ user_id     → │    │ user_id        → │           │
│ │ site_id       → │    │ site_id     → │    │ site_id        → │           │
│ │ edition_id    → │    │ goal_type     │    │ achievement_code │           │
│ │ duration_secs   │    │ target_value  │    │ unlocked_at      │           │
│ │ words_read      │    │ year          │    └──────────────────┘           │
│ │ start/end_%     │    └───────────────┘                                   │
│ └─────────────────┘                                                        │
└────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           VOCABULARY DOMAIN                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────────┐ 1────N ┌──────────────────┐                         │
│   │ VocabularyWord   │        │ VocabularyReview  │                         │
│   │──────────────────│        │──────────────────│                         │
│   │ id               │        │ id               │                         │
│   │ user_id        → │        │ vocab_word_id  → │                         │
│   │ site_id        → │        │ user_id        → │                         │
│   │ word             │        │ review_mode      │                         │
│   │ language         │        │ is_correct       │                         │
│   │ translation      │        │ response_time_ms │                         │
│   │ definition       │        │ stage_before     │                         │
│   │ sentence         │        │ stage_after      │                         │
│   │ distractors (J)  │ ← LLM │ created_at       │                         │
│   │ stage            │        └──────────────────┘                         │
│   │ interval_days    │                                                      │
│   │ next_review_at   │                                                      │
│   │ edition_id     →○│ ← source book                                       │
│   └──────────────────┘                                                      │
│                                                                             │
│   SRS: New(0) → Recognition(1) → Recall(2) → Context(3) → Mastered(4)     │
│   Review modes stored: multiple_choice | context (+ practice_ prefix)      │
│   Distractors: Ollama gemma4:e2b generates 5 plausible wrong answers       │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              ADMIN DOMAIN                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌────────────┐         ┌─────────────────┐         ┌───────────────┐     │
│   │ AdminUser  │ 1────N  │AdminRefreshToken│         │ AdminAuditLog │     │
│   │────────────│         │─────────────────│         │───────────────│     │
│   │ id         │         │ id              │         │ id            │     │
│   │ email    ● │         │ admin_user_id → │         │ admin_user_id→│     │
│   │ pass_hash  │         │ token           │         │ action_type   │     │
│   │ role       │         │ expires_at      │         │ entity_type   │     │
│   │ is_active  │         │ created_at      │         │ entity_id     │     │
│   │ created    │         └─────────────────┘         │ payload_json  │     │
│   │ updated    │                                     │ created_at    │     │
│   └────────────┘                                     └───────────────┘     │
│                                                                             │
│   Roles: Admin | Editor | Moderator                                         │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                            MIGRATION DOMAIN                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────────┐                                                      │
│   │ TextStackImport  │ ← Migration tracking from TextStack                  │
│   │──────────────────│                                                      │
│   │ id               │                                                      │
│   │ site_id        → │                                                      │
│   │ identifier       │ ← original TextStack ID                              │
│   │ edition_id     → │                                                      │
│   │ imported_at      │                                                      │
│   └──────────────────┘                                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Legend:
  →   Foreign Key
  ●   Unique Index
  ○   Nullable FK (self-ref for translations)
  N   One-to-Many relationship
  M:N Many-to-Many (via join table)
```

---

## Tables Summary

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| `sites` | Multisite config | → works, editions, authors, genres, domains |
| `site_domains` | Domain aliases | → site |
| `authors` | Book authors | → site, → edition_authors |
| `genres` | Book categories | → site, → editions (M:N) |
| `edition_authors` | M:N Edition↔Author | → edition, → author |
| `edition_genres` | M:N Edition↔Genre | → edition, → genre |
| `works` | Canonical book identity | → site, → editions |
| `editions` | Language-specific version | → work, → site, → chapters, → book_files, → genres |
| `chapters` | Book content + FTS | → edition |
| `book_files` | Original uploaded files | → edition |
| `book_assets` | Extracted images/resources | → edition |
| `ingestion_jobs` | Processing queue + diagnostics | → edition, → book_file |
| `users` | Accounts + guests (Google/Apple/email) | → progress, bookmarks, notes, library, tokens |
| `user_refresh_tokens` | JWT refresh for users | → user |
| `user_libraries` | Saved books | → user, → edition |
| `reading_progresses` | Resume position (site-scoped) | → user, → site, → edition, → chapter |
| `bookmarks` | Saved locations (site-scoped) | → user, → site, → edition, → chapter |
| `notes` | User annotations (site-scoped) | → user, → site, → edition, → chapter, → highlight? |
| `highlights` | Text highlights with colors | → user, → site, → edition, → chapter |
| `admin_users` | Admin panel auth | → tokens |
| `admin_refresh_tokens` | JWT refresh | → admin_user |
| `reading_sessions` | Reading time tracking | → user, → site, → edition |
| `reading_goals` | Daily/yearly reading goals | → user, → site |
| `user_achievements` | Unlocked achievements | → user, → site |
| `vocabulary_words` | Saved vocabulary + SRS state | → user, → site, → edition, → chapter |
| `vocabulary_reviews` | Review answer history | → vocabulary_word, → user, → site |
| `textstack_imports` | Migration tracking | → site, → edition |

---

## Detailed Schema

### Multisite Tables

#### `sites`
```sql
id               UUID PRIMARY KEY
code             VARCHAR NOT NULL UNIQUE  -- "general", "ua", etc
primary_domain   VARCHAR NOT NULL
default_language VARCHAR NOT NULL         -- "en", "uk"
theme            VARCHAR NOT NULL DEFAULT 'default'
ads_enabled      BOOLEAN NOT NULL DEFAULT false
indexing_enabled BOOLEAN NOT NULL DEFAULT false
sitemap_enabled  BOOLEAN NOT NULL DEFAULT true
features_json    TEXT NOT NULL DEFAULT '{}'
created_at       TIMESTAMPTZ NOT NULL
updated_at       TIMESTAMPTZ NOT NULL
```

#### `site_domains`
```sql
id         UUID PRIMARY KEY
site_id    UUID NOT NULL → sites(id)
domain     VARCHAR NOT NULL UNIQUE
is_primary BOOLEAN NOT NULL DEFAULT false
created_at TIMESTAMPTZ NOT NULL
```

---

### Metadata Tables

#### `authors`
```sql
id              UUID PRIMARY KEY
site_id         UUID NOT NULL → sites(id)
slug            VARCHAR NOT NULL
name            VARCHAR NOT NULL
bio             TEXT
photo_path      VARCHAR
indexable       BOOLEAN NOT NULL DEFAULT true
seo_title       VARCHAR
seo_description VARCHAR
created_at      TIMESTAMPTZ NOT NULL
updated_at      TIMESTAMPTZ NOT NULL

UNIQUE(site_id, slug)
```

#### `genres`
```sql
id              UUID PRIMARY KEY
site_id         UUID NOT NULL → sites(id)
slug            VARCHAR NOT NULL
name            VARCHAR NOT NULL
description     TEXT
indexable       BOOLEAN NOT NULL DEFAULT true
seo_title       VARCHAR
seo_description VARCHAR
created_at      TIMESTAMPTZ NOT NULL
updated_at      TIMESTAMPTZ NOT NULL

UNIQUE(site_id, slug)
```

#### `edition_authors` (Join Table)
```sql
edition_id UUID NOT NULL → editions(id) CASCADE
author_id  UUID NOT NULL → authors(id) CASCADE
order      INT NOT NULL DEFAULT 0
role       INT NOT NULL DEFAULT 0  -- 0=Author, 1=Translator, 2=Editor, 3=Illustrator

PRIMARY KEY(edition_id, author_id)
```

#### `edition_genres` (Join Table)
```sql
editions_id UUID NOT NULL → editions(id) CASCADE
genres_id   UUID NOT NULL → genres(id) CASCADE

PRIMARY KEY(editions_id, genres_id)
INDEX(genres_id)
```

---

### Content Tables

#### `works`
```sql
id         UUID PRIMARY KEY
site_id    UUID NOT NULL → sites(id)
slug       VARCHAR NOT NULL
created_at TIMESTAMPTZ NOT NULL

UNIQUE(site_id, slug)
```

#### `editions`
```sql
id                 UUID PRIMARY KEY
work_id            UUID NOT NULL → works(id)
site_id            UUID NOT NULL → sites(id)
language           VARCHAR NOT NULL  -- "en", "uk"
slug               VARCHAR NOT NULL
title              VARCHAR NOT NULL
description        TEXT
status             INT NOT NULL      -- 0=Draft, 1=Published, 2=Hidden
published_at       TIMESTAMPTZ
source_edition_id  UUID → editions(id)  -- for translations
cover_path         VARCHAR
is_public_domain   BOOLEAN NOT NULL
created_at         TIMESTAMPTZ NOT NULL
updated_at         TIMESTAMPTZ NOT NULL

-- SEO fields
indexable          BOOLEAN NOT NULL DEFAULT true
seo_title          VARCHAR
seo_description    VARCHAR
canonical_override VARCHAR

UNIQUE(work_id, language)
UNIQUE(site_id, language, slug)
INDEX GIST(lower(title) gist_trgm_ops)  -- trigram search
```

#### `chapters`
```sql
id                      UUID PRIMARY KEY
edition_id              UUID NOT NULL → editions(id)
chapter_number          INT NOT NULL
slug                    VARCHAR
title                   VARCHAR NOT NULL
html                    TEXT NOT NULL
plain_text              TEXT NOT NULL
word_count              INT

-- Split chapter tracking (for very long chapters)
original_chapter_number INT              -- original number before split (for TOC grouping)
part_number             INT              -- part within original (1, 2, 3...)
total_parts             INT              -- total parts (for "Part 2 of 5" display)

search_vector           TSVECTOR         -- GIN indexed for FTS
created_at              TIMESTAMPTZ NOT NULL
updated_at              TIMESTAMPTZ NOT NULL

UNIQUE(edition_id, chapter_number)
INDEX(edition_id, slug)
INDEX GIN(search_vector)
TRIGGER chapters_search_vector_update  -- auto-updates search_vector
```

#### `book_files`
```sql
id              UUID PRIMARY KEY
edition_id      UUID NOT NULL → editions(id)
original_name   VARCHAR NOT NULL
storage_path    VARCHAR NOT NULL
format          INT NOT NULL      -- 0=Epub, 1=Pdf, 2=Fb2 (legacy, no longer accepted)
sha256          VARCHAR
uploaded_at     TIMESTAMPTZ NOT NULL
```

#### `book_assets`
```sql
id              UUID PRIMARY KEY
edition_id      UUID NOT NULL → editions(id)
kind            INT NOT NULL      -- 0=Cover, 1=InlineImage
original_path   VARCHAR NOT NULL  -- path inside EPUB/source
storage_path    VARCHAR NOT NULL  -- path on disk
content_type    VARCHAR NOT NULL  -- MIME type
byte_size       BIGINT NOT NULL
created_at      TIMESTAMPTZ NOT NULL
```

#### `ingestion_jobs`
```sql
id                UUID PRIMARY KEY
edition_id        UUID NOT NULL → editions(id)
book_file_id      UUID NOT NULL → book_files(id)
target_language   VARCHAR NOT NULL
work_id           UUID → works(id)
source_edition_id UUID → editions(id)
status            INT NOT NULL      -- 0=Queued, 1=Processing, 2=Done, 3=Failed
attempt_count     INT NOT NULL
error             TEXT
created_at        TIMESTAMPTZ NOT NULL
started_at        TIMESTAMPTZ
finished_at       TIMESTAMPTZ

-- Extraction diagnostics (persisted after extraction)
source_format     VARCHAR           -- detected format (epub, pdf)
units_count       INT               -- number of chapters/units extracted
text_source       VARCHAR           -- where text came from (epub content, pdf ocr, etc)
confidence        FLOAT             -- extraction confidence (0.0-1.0)
warnings_json     TEXT              -- JSON array of extraction warnings
```

---

### User Tables

#### `users`
Columns from `Domain/Entities/User.cs` (types: see the model snapshot):
```
id, email, name?, picture?, password_hash?, google_subject?, apple_subject?,
storage_used_bytes, is_guest, tier, storage_limit_override_bytes?, last_active_at?,
created_at, promoted_at?, native_language?
```
Guests: `is_guest = true`, synthesized `guest-<hex>@guest.local` email ([ADR-014](../01-architecture/adr/ADR-014-guest-sessions.md)).

#### `user_refresh_tokens`
```sql
id         UUID PRIMARY KEY
user_id    UUID NOT NULL → users(id) CASCADE
token      VARCHAR NOT NULL UNIQUE
expires_at TIMESTAMPTZ NOT NULL
created_at TIMESTAMPTZ NOT NULL
```

#### `user_libraries`
```sql
id         UUID PRIMARY KEY
user_id    UUID NOT NULL → users(id) CASCADE
edition_id UUID NOT NULL → editions(id) CASCADE
created_at TIMESTAMPTZ NOT NULL

UNIQUE(user_id, edition_id)
```

#### `reading_progresses`
```sql
id         UUID PRIMARY KEY
user_id    UUID NOT NULL → users(id) CASCADE
site_id    UUID NOT NULL → sites(id)
edition_id UUID NOT NULL → editions(id) CASCADE
chapter_id UUID NOT NULL → chapters(id) CASCADE
locator    TEXT NOT NULL   -- JSON: {"type":"text","chapterId":"...","offset":123}
percent    FLOAT
updated_at TIMESTAMPTZ NOT NULL

UNIQUE(user_id, site_id, edition_id)
```

#### `bookmarks`
```sql
id         UUID PRIMARY KEY
user_id    UUID NOT NULL → users(id) CASCADE
site_id    UUID NOT NULL → sites(id)
edition_id UUID NOT NULL → editions(id) CASCADE
chapter_id UUID NOT NULL → chapters(id) CASCADE
locator    TEXT NOT NULL
title      VARCHAR
created_at TIMESTAMPTZ NOT NULL
```

#### `notes`
```sql
id           UUID PRIMARY KEY
user_id      UUID NOT NULL → users(id) CASCADE
site_id      UUID NOT NULL → sites(id)
edition_id   UUID NOT NULL → editions(id) CASCADE
chapter_id   UUID NOT NULL → chapters(id) CASCADE
highlight_id UUID → highlights(id) CASCADE  -- optional link to highlight
locator      TEXT NOT NULL
text         TEXT NOT NULL
version      INT NOT NULL     -- conflict resolution for sync
created_at   TIMESTAMPTZ NOT NULL
updated_at   TIMESTAMPTZ NOT NULL
```

#### `highlights`
```sql
id            UUID PRIMARY KEY
user_id       UUID NOT NULL → users(id) CASCADE
site_id       UUID NOT NULL → sites(id)
edition_id    UUID NOT NULL → editions(id) CASCADE
chapter_id    UUID NOT NULL → chapters(id) CASCADE
anchor_json   TEXT NOT NULL   -- JSON: {"prefix":"...","exact":"...","suffix":"...","startOffset":N,"endOffset":N}
color         VARCHAR NOT NULL  -- yellow | green | pink | blue
selected_text TEXT NOT NULL   -- denormalized for display
note_text     TEXT            -- inline note (optional)
version       INT NOT NULL    -- optimistic concurrency
created_at    TIMESTAMPTZ NOT NULL
updated_at    TIMESTAMPTZ NOT NULL
```

---

### Admin Tables

#### `admin_users`
```sql
id            UUID PRIMARY KEY
email         VARCHAR NOT NULL UNIQUE
password_hash VARCHAR NOT NULL
role          INT NOT NULL      -- 0=Admin, 1=Editor, 2=Moderator
is_active     BOOLEAN NOT NULL DEFAULT true
created_at    TIMESTAMPTZ NOT NULL
updated_at    TIMESTAMPTZ NOT NULL
```

#### `admin_refresh_tokens`
```sql
id            UUID PRIMARY KEY
admin_user_id UUID NOT NULL → admin_users(id) CASCADE
token         VARCHAR NOT NULL UNIQUE
expires_at    TIMESTAMPTZ NOT NULL
created_at    TIMESTAMPTZ NOT NULL
```

#### `admin_audit_logs` — **dropped 2026-01-22** (migration `RemoveAdminAuditLog`; kept here as history)
```sql
id            UUID PRIMARY KEY
admin_user_id UUID NOT NULL → admin_users(id) RESTRICT
action_type   VARCHAR NOT NULL
entity_type   VARCHAR NOT NULL
entity_id     UUID
payload_json  TEXT
created_at    TIMESTAMPTZ NOT NULL

INDEX(action_type)
INDEX(admin_user_id)
INDEX(created_at)
```

---

### Migration Tables

#### `textstack_imports`
```sql
id          UUID PRIMARY KEY
site_id     UUID NOT NULL → sites(id)
identifier  VARCHAR NOT NULL  -- original TextStack ID
edition_id  UUID NOT NULL → editions(id)
imported_at TIMESTAMPTZ NOT NULL

UNIQUE(site_id, identifier)
```

---

### Reading Tracking Tables

#### `reading_sessions`
```sql
id               UUID PRIMARY KEY
user_id          UUID NOT NULL → users(id) CASCADE
site_id          UUID NOT NULL → sites(id)
edition_id       UUID → editions(id)
user_book_id     UUID → user_books(id)
started_at       TIMESTAMPTZ NOT NULL
ended_at         TIMESTAMPTZ
duration_seconds INT NOT NULL
words_read       INT NOT NULL DEFAULT 0
start_percent    FLOAT NOT NULL DEFAULT 0
end_percent      FLOAT NOT NULL DEFAULT 0
created_at       TIMESTAMPTZ NOT NULL

INDEX(user_id, site_id, started_at)
```

#### `reading_goals`
```sql
id                  UUID PRIMARY KEY
user_id             UUID NOT NULL → users(id) CASCADE
site_id             UUID NOT NULL → sites(id)
goal_type           VARCHAR NOT NULL  -- "daily_minutes" | "books_per_year"
target_value        INT NOT NULL
year                INT NOT NULL DEFAULT 0  -- 0 = recurring
is_active           BOOLEAN NOT NULL DEFAULT true
streak_min_minutes  INT NOT NULL DEFAULT 5
created_at          TIMESTAMPTZ NOT NULL
updated_at          TIMESTAMPTZ NOT NULL

INDEX(user_id, site_id, goal_type)
```

#### `user_achievements`
```sql
id               UUID PRIMARY KEY
user_id          UUID NOT NULL → users(id) CASCADE
site_id          UUID NOT NULL → sites(id)
achievement_code VARCHAR NOT NULL
unlocked_at      TIMESTAMPTZ NOT NULL

UNIQUE(user_id, site_id, achievement_code)
```

---

### Vocabulary Tables

#### `vocabulary_words`
```sql
id                  UUID PRIMARY KEY
user_id             UUID NOT NULL → users(id) CASCADE
site_id             UUID NOT NULL → sites(id)
word                VARCHAR NOT NULL
language            VARCHAR NOT NULL
translation         VARCHAR
definition          VARCHAR
edition_id          UUID → editions(id)
chapter_id          UUID → chapters(id)
user_book_id        UUID → user_books(id)
sentence            VARCHAR           -- original context sentence
book_title          VARCHAR           -- denormalized for display
distractors         TEXT              -- JSON array: ["word1","word2",...] from Ollama LLM

-- SRS fields
stage               INT NOT NULL DEFAULT 0       -- 0=New,1=Recognition,2=Recall,3=Context,4=Mastered
interval_days       FLOAT NOT NULL DEFAULT 0
consecutive_correct INT NOT NULL DEFAULT 0
next_review_at      TIMESTAMPTZ NOT NULL
last_reviewed_at    TIMESTAMPTZ
total_reviews       INT NOT NULL DEFAULT 0
correct_reviews     INT NOT NULL DEFAULT 0
created_at          TIMESTAMPTZ NOT NULL
updated_at          TIMESTAMPTZ NOT NULL

UNIQUE(user_id, site_id, word, language)
INDEX(user_id, site_id, next_review_at)  -- review queue query
INDEX(user_id, site_id, stage)
```

#### `vocabulary_reviews`
```sql
id                 UUID PRIMARY KEY
vocabulary_word_id UUID NOT NULL → vocabulary_words(id) CASCADE
user_id            UUID NOT NULL → users(id) CASCADE
site_id            UUID NOT NULL → sites(id)
review_mode        VARCHAR NOT NULL  -- "multiple_choice" | "context", each also with a
                                     -- "practice_" prefix. Written from SrsEngine.GetReviewMode,
                                     -- so "context" appears here even though the card DTO never
                                     -- carries it (ReviewCardBuilder rewrites it to MC). Typed
                                     -- recall was removed; old rows may still hold "typed_recall".
is_correct         BOOLEAN NOT NULL
response_time_ms   INT NOT NULL
stage_before       INT NOT NULL
stage_after        INT NOT NULL
created_at         TIMESTAMPTZ NOT NULL

INDEX(user_id, site_id, created_at)  -- stats queries
INDEX(vocabulary_word_id)
```

---

## Enums

```csharp
EditionStatus      { Draft=0, Published=1, Hidden=2 }
BookFormat         { Epub=0, Pdf=1, Fb2=2 (legacy, no longer accepted), Html=3, Other=99 }
JobStatus          { Queued=0, Processing=1, Succeeded=2, Failed=3 }
AdminRole          { Admin=0, Editor=1, Moderator=2 }
AuthorRole         { Author=0, Translator=1, Editor=2, Illustrator=3 }
AssetKind          { Cover=0, InlineImage=1 }
```

---

## Key Design Decisions

1. **Multisite architecture** - Site scopes all content (works, editions, authors, genres). Now single site; EF global query filter on `ISiteScoped`
2. **Work/Edition split** - Enables multilingual support (same book, different languages)
3. **Edition.SourceEditionId** - Links translations to original
4. **EditionAuthor join** - M:N with role (author/translator/editor/illustrator) + order
5. **EditionGenres join** - M:N Edition↔Genre
6. **Site-scoped user data** - ReadingProgress, Bookmark, Note include SiteId for multisite
7. **Note versioning** - Version field for conflict resolution during sync
8. **FTS in Chapter** - PostgreSQL tsvector + GIN for search (with auto-update trigger)
9. **Chapter splitting** - OriginalChapterNumber/PartNumber/TotalParts for long chapters
10. **Separate Admin auth** - AdminUser != User (different auth flows)
11. **User refresh tokens** - Separate from admin tokens, cookie-based JWT
12. **UserLibrary** - Many-to-many User↔Edition for "My Library"
13. **SEO fields** - indexable, seo_title, seo_description on Author, Genre, Edition
14. **Trigram search** - GIST index on edition title for fuzzy matching
15. **BookAssets** - Extracted images/covers stored with metadata
16. **Ingestion diagnostics** - SourceFormat/UnitsCount/TextSource/Confidence/Warnings for debugging
17. **TextStack migration** - TextStackImport tracks migrated content
18. **Highlights** - Text anchoring with prefix/exact/suffix for reliable text location
19. **Note-Highlight link** - Notes can optionally link to highlights via HighlightId
20. **Reading sessions** - 30s heartbeat, 3min idle, 5min auto-end; localStorage queue + sendBeacon
21. **Reading goals** - Daily minutes or books/year with streak tracking (min minutes threshold)
22. **Achievements** - 20 codes across milestone/streak/time/special; AchievementChecker runs after sessions
23. **Vocabulary SRS** - 5-stage spaced repetition (New→Recognition→Recall→Context→Mastered)
25. **LLM distractors** - Ollama gemma4:e2b generates MC wrong answers at word save time; stored as JSON
26. **Fire-and-forget distractors** - IServiceScopeFactory creates scoped DbContext for background generation
27. **Vocabulary word uniqueness** - unique(user_id, site_id, word, language) prevents duplicates
