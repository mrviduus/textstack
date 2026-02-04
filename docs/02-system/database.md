# TextStack Database Schema

## Quick Start
```bash
docker compose up --build
```
All services: API :8080 | Web :5173 | Admin :81 | DB :5432

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
│                              SEO DOMAIN                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────┐         ┌────────────────┐                               │
│   │ SeoCrawlJob  │ 1────N  │ SeoCrawlResult │                               │
│   │──────────────│         │────────────────│                               │
│   │ id           │         │ id             │                               │
│   │ site_id    → │         │ job_id       → │                               │
│   │ max_pages    │         │ url            │                               │
│   │ concurrency  │         │ url_type       │                               │
│   │ delay_ms     │         │ status_code    │                               │
│   │ user_agent   │         │ content_type   │                               │
│   │ status       │         │ html_bytes     │                               │
│   │ total_urls   │         │ title          │                               │
│   │ pages_crawld │         │ meta_desc      │                               │
│   │ errors_count │         │ h1             │                               │
│   │ error        │         │ canonical      │                               │
│   │ created_at   │         │ meta_robots    │                               │
│   │ started_at   │         │ x_robots_tag   │                               │
│   │ finished_at  │         │ fetched_at     │                               │
│   └──────────────┘         │ fetch_error    │                               │
│                            └────────────────┘                               │
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
| `users` | Google OAuth users | → progress, bookmarks, notes, library, tokens |
| `user_refresh_tokens` | JWT refresh for users | → user |
| `user_libraries` | Saved books | → user, → edition |
| `reading_progresses` | Resume position (site-scoped) | → user, → site, → edition, → chapter |
| `bookmarks` | Saved locations (site-scoped) | → user, → site, → edition, → chapter |
| `notes` | User annotations (site-scoped) | → user, → site, → edition, → chapter, → highlight? |
| `highlights` | Text highlights with colors | → user, → site, → edition, → chapter |
| `admin_users` | Admin panel auth | → tokens, → logs |
| `admin_refresh_tokens` | JWT refresh | → admin_user |
| `admin_audit_logs` | Action history | → admin_user |
| `seo_crawl_jobs` | Sitemap crawler jobs | → site, → results |
| `seo_crawl_results` | Crawler results per URL | → job |
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
format          INT NOT NULL      -- 0=Epub, 1=Pdf, 2=Fb2
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
source_format     VARCHAR           -- detected format (epub, fb2, pdf)
units_count       INT               -- number of chapters/units extracted
text_source       VARCHAR           -- where text came from (epub content, pdf ocr, etc)
confidence        FLOAT             -- extraction confidence (0.0-1.0)
warnings_json     TEXT              -- JSON array of extraction warnings
```

---

### User Tables

#### `users`
```sql
id             UUID PRIMARY KEY
email          VARCHAR(255) NOT NULL UNIQUE
name           VARCHAR(255)
picture        VARCHAR           -- avatar URL from Google
google_subject VARCHAR(255) NOT NULL UNIQUE
created_at     TIMESTAMPTZ NOT NULL
```

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

#### `admin_audit_logs`
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

### SEO Tables

#### `seo_crawl_jobs`
```sql
id            UUID PRIMARY KEY
site_id       UUID NOT NULL → sites(id)
max_pages     INT NOT NULL DEFAULT 500
concurrency   INT NOT NULL DEFAULT 4
crawl_delay_ms INT NOT NULL DEFAULT 200
user_agent    VARCHAR NOT NULL DEFAULT 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
status        INT NOT NULL    -- 0=Queued, 1=Running, 2=Completed, 3=Failed, 4=Cancelled
total_urls    INT NOT NULL
pages_crawled INT NOT NULL
errors_count  INT NOT NULL
error         TEXT
created_at    TIMESTAMPTZ NOT NULL
started_at    TIMESTAMPTZ
finished_at   TIMESTAMPTZ
```

#### `seo_crawl_results`
```sql
id               UUID PRIMARY KEY
job_id           UUID NOT NULL → seo_crawl_jobs(id)
url              VARCHAR NOT NULL
url_type         VARCHAR NOT NULL  -- "book", "author", "genre"
status_code      INT
content_type     VARCHAR
html_bytes       INT
title            VARCHAR
meta_description VARCHAR
h1               VARCHAR
canonical        VARCHAR
meta_robots      VARCHAR
x_robots_tag     VARCHAR
fetched_at       TIMESTAMPTZ NOT NULL
fetch_error      TEXT
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

## Enums

```csharp
EditionStatus      { Draft=0, Published=1, Hidden=2 }
BookFormat         { Epub=0, Pdf=1, Fb2=2 }
JobStatus          { Queued=0, Processing=1, Completed=2, Failed=3 }
AdminRole          { Admin=0, Editor=1, Moderator=2 }
AuthorRole         { Author=0, Translator=1, Editor=2, Illustrator=3 }
AssetKind          { Cover=0, InlineImage=1 }
SeoCrawlJobStatus  { Queued=0, Running=1, Completed=2, Failed=3, Cancelled=4 }
```

---

## Key Design Decisions

1. **Multisite architecture** - Site scopes all content (works, editions, authors, genres)
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
17. **SEO crawler** - SeoCrawlJob/SeoCrawlResult for sitemap validation
18. **TextStack migration** - TextStackImport tracks migrated content
19. **Highlights** - Text anchoring with prefix/exact/suffix for reliable text location
20. **Note-Highlight link** - Notes can optionally link to highlights via HighlightId
