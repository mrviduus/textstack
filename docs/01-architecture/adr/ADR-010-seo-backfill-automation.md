# ADR-010: SEO Backfill Automation

**Status**: Proposed (implemented — `SeoTemplate`, `SeoBackfillJob`, `SeoBackfillSettings`, `AdminSeoBackfillEndpoints.cs`, `InternalSeoEndpoints.cs` exist as of 2026-10-04). Moved here from `docs/` on 2026-10-04.
**Date**: 2026-04-14
**Deciders**: Vasyl
**Supersedes**: partially overrides `docs/seo-content-task.md` (manual tracker)

## Context

Поточний SEO pipeline — ручний:
- `docs/seo-content-task.md` трекінг: 654 авторів + 1,567 editions заповнено партіями через Claude CLI за 3 тижні.
- Темплейти захардкожені в `infra/scripts/seo-generate.sh` (edition + author bio/description/relevance/themes/faqs).
- `AutoPublishJob` автоматизує лише **Draft → Published** pipeline для editions. Уже published сутності та Authors/Genres/BlogPost без автоматичного backfill.
- Немає coverage dashboard. Немає editable templates. Немає review/revert UI.

Проблеми:
1. Кожна нова сутність потребує ручного запуску скрипта.
2. Зміни в prompt-і вимагають git commit + deploy.
3. Якщо Claude пише погано — немає review gate і revert.
4. Прогрес SEO непрозорий — admin не бачить, скільки авторів без bio.

## Decision

Extend `AutoPublishJob` pattern → **`SeoBackfillJob`**. Editable templates в admin panel, DB-backed queue, окремий systemd poller, Claude CLI generation, API apply з Before/After snapshots та revert.

### Scope (MVP, PR #1)

- Entity types: `Author`, `Edition`, `Genre`. `BlogPost` — в Phase 2.
- Field types: `bio`, `description`, `relevance`, `themes`, `faqs`, `seo_title`, `seo_description`.
- Language: per-template (en, uk). MVP seed — 4 EN templates.
- Review gate: default **ON**. Progressive trust via `TrustLevel` (`manual`/`review`/`auto`).
- Admin UI: 3 tabs — Coverage, Templates, Jobs.

### Out of scope (Phase 2/3)

- BlogPost SEO fields (окрема міграція).
- Bulk queue з filters UI.
- Review/Approve/Revert UI (endpoint є, UI пізніше).
- SSG rebuild debouncer (hosted service).
- UK templates seed (admin створить через UI).
- A/B template comparison, daily cron, traffic-weighted priorities.

## Data Model

### Нові таблиці

**`seo_templates`** — editable prompts with version freezing.

```sql
id                uuid pk
entity_type       text    -- 'author' | 'edition' | 'genre' | 'blogpost'
field_type        text    -- 'bio' | 'description' | 'relevance' | 'themes' | 'faqs' | 'seo_title' | 'seo_description'
language_code     text    -- 'en' | 'uk'
name              text
description       text
prompt_template   text    -- with {placeholders}
output_schema     jsonb   -- JSON schema for validation
model             text    -- 'claude-sonnet-4-6'
max_tokens        int
temperature       real
trust_level       text    -- 'manual' | 'review' | 'auto'
version           int
is_active         bool
created_at        timestamptz
updated_at        timestamptz

UNIQUE (entity_type, field_type, language_code, version) WHERE is_active
```

**`seo_backfill_jobs`** — queue з full snapshot для audit + revert.

```sql
id                  uuid pk
entity_type         text
entity_id           uuid
target_fields       text[]     -- fields this job generates
template_ids        uuid[]     -- frozen reference
template_versions   int[]      -- frozen versions (immutable replay)
status              text       -- 'queued' | 'running' | 'needs_review' | 'success' | 'failed' | 'reverted'
input_snapshot      jsonb      -- entity data that went into prompts
rendered_prompts    jsonb      -- {field: prompt_text} for debug
raw_outputs         jsonb      -- {field: claude_raw}
generated_content   jsonb      -- parsed + validated
before_snapshot     jsonb      -- entity state pre-apply
after_snapshot      jsonb      -- entity state post-apply
error               text
created_at          timestamptz
started_at          timestamptz
completed_at        timestamptz
triggered_by        text       -- 'admin:vasyl@...' | 'cron' | 'bulk'
requires_review     bool
approved_by_user_id uuid
approved_at         timestamptz

INDEX (status, created_at)      -- poller SELECT
```

**`seo_backfill_settings`** — singleton.

```sql
id                          uuid pk (fixed)
enabled                     bool default false
jobs_per_run                int default 5
interval_seconds            int default 60
language_filter             text[]
entity_type_filter          text[]
ssg_rebuild_batch_minutes   int default 5
updated_at                  timestamptz
```

### Зміни existing

На `authors`, `editions`, `genres`, `blog_posts`:

```sql
+ seo_source text NOT NULL DEFAULT 'manual'
```

Values: `'manual'` | `'auto'` | `'hybrid'`. Default `'manual'` для existing rows — auto jobs skip їх, щоб не перетерти manual edits.

### Seed templates (MVP migration)

4 active EN templates:
1. `author_bio_en` — 200–400 word biography
2. `edition_description_en` — plot summary + significance 150–250 words
3. `edition_relevance_en` — why relevant today 100–150 words
4. `edition_themes_en` — JSON array of 5–7 themes

UK variants + FAQ/seo_title/seo_description templates admin створить через UI post-MVP.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                           Admin UI                                │
│  /admin/seo?tab=coverage|templates|jobs|gaps|settings             │
└────────┬─────────────────────────────────────────────────┬───────┘
         │ REST                                            │
         ▼                                                 │
┌──────────────────────┐                                   │
│  Admin SEO endpoints │                                   │
│  /admin/seo/*        │                                   │
└────────┬─────────────┘                                   │
         │                                                 │
         ▼                                                 │
┌──────────────────────┐        ┌──────────────────────┐   │
│  Application/Seo     │◄───────┤ Internal endpoints   │◄──┤
│  services            │        │ /internal/seo/*      │   │
│  (Renderer, Applier) │        │ (Docker-only)        │   │
└────────┬─────────────┘        └──────────┬───────────┘   │
         │                                 │               │
         ▼                                 │               │
┌──────────────────────┐                   │               │
│ seo_templates        │                   │               │
│ seo_backfill_jobs    │◄──────────────────┤               │
│ seo_backfill_settings│                   │               │
└──────────────────────┘                   │               │
                                           │               │
                          ┌────────────────▼────────────┐  │
                          │ seo-backfill-poll.sh        │  │
                          │  (systemd, 60s interval)    │  │
                          └────────────────┬────────────┘  │
                                           │               │
                                           ▼               │
                          ┌─────────────────────────────┐  │
                          │ seo-backfill-generate.sh    │  │
                          │  → claude CLI (JSON out)    │  │
                          │  → validate vs schema       │  │
                          │  → POST apply/fail          │  │
                          └─────────────────────────────┘  │
```

### Backend layers (new)

```
backend/src/Domain/
├── Entities/
│   ├── SeoTemplate.cs
│   ├── SeoBackfillJob.cs
│   └── SeoBackfillSettings.cs
└── Enums/
    ├── SeoEntityType.cs
    ├── SeoFieldType.cs
    ├── SeoJobStatus.cs
    ├── SeoTrustLevel.cs
    └── SeoSource.cs

backend/src/Application/Seo/
├── SeoPromptSanitizer.cs      -- strips injection tokens from entity text before template insertion
├── SeoTemplateRenderer.cs     -- {placeholders} → entity data (via Sanitizer)
├── SeoContentValidator.cs     -- JSON schema validation
├── SeoContentApplier.cs       -- Before/After snapshots, apply to entity, SeoSource='auto'
├── SeoGeneratorService.cs     -- renders prompt, invokes Claude (indirectly via script)
├── SeoJobProcessor.cs         -- job lifecycle state machine
└── SeoCoverageAnalyzer.cs     -- SQL queries for coverage stats

backend/src/Api/Endpoints/
├── AdminSeoTemplateEndpoints.cs   -- CRUD + POST /preview
├── AdminSeoJobEndpoints.cs        -- list / detail / approve / revert
├── AdminSeoCoverageEndpoints.cs   -- GET /admin/seo/coverage
├── AdminSeoQueueEndpoints.cs      -- POST /admin/seo/queue
├── AdminSeoSettingsEndpoints.cs   -- GET/PUT
└── InternalSeoEndpoints.cs        -- claim/context/apply/fail
```

## Workflow (end-to-end)

```
admin queues 1 author
  → POST /admin/seo/queue { entityType:'author', entityId, fields:['bio'] }
  → INSERT seo_backfill_job (status='queued', template_ids=[from settings.default])

seo-backfill-poll.sh (systemd, every 60s):
  → POST /internal/seo/jobs/claim?limit=5
     ← atomic UPDATE seo_backfill_jobs
         SET status='running', started_at=now()
         WHERE id IN (SELECT id FROM seo_backfill_jobs WHERE status='queued' ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED)
         RETURNING *;
  → FOR EACH job: bash seo-backfill-generate.sh $id
     → GET /internal/seo/jobs/{id}/context
        ← { rendered_prompts:[...], output_schemas:[...] }
     → FOR EACH (field, prompt, schema):
          claude --model claude-sonnet-4-6 -p "$prompt" --output-format json > /tmp/out.json
          jq validate vs schema → on fail, retry (max 3) з injected error feedback
     → POST /internal/seo/jobs/{id}/apply { generated_content:{...} }
        → SeoContentApplier:
           - snapshot Before (current entity fields)
           - if trust_level='review': status='needs_review', skip apply
           - else: apply, SeoSource='auto', status='success', snapshot After
           - enqueue entity для SSG rebuild (Phase 2: debouncer)

admin reviews at /admin/seo?tab=jobs:
  → drawer з diff Before→After
  → Approve → POST /admin/seo/jobs/{id}/approve → applies + rebuild
  → Revert (навіть після success) → restores before_snapshot, SeoSource='manual'
```

## Safety

1. **Prompt injection**: `SeoPromptSanitizer` strips `{{`, `}}`, `</prompt>`, `assistant:`, `system:`, `<|…|>`, `human:` from entity text fields **before** template insertion.
2. **Schema validation**: strict JSON schema per FieldType. 3 retries з error feedback in next prompt.
3. **Manual-edit protection**: jobs skip entities з `seo_source='manual'`. Admin override — explicit `force=true` у queue request.
4. **Dedup**: pre-queue check — same `(entity_id, target_fields)` в `status IN (queued, running)` → reject.
5. **Atomic claim**: `UPDATE … FOR UPDATE SKIP LOCKED RETURNING` → no double-processing by concurrent pollers.
6. **Rate limit**: poller respects `jobs_per_run` + `interval_seconds`.
7. **Internal endpoints guard**: `IsLocalRequest()` pattern (loopback + Docker network 172.16–31.x.x, 10.x.x.x).
8. **Immutable job history**: `template_version` frozen at job creation. Templates versioned on edit (increment + `is_active=true` на новій, `false` на старій).

## Scripts + systemd

```
infra/scripts/
├── seo-backfill-poll.sh       -- systemd (clone seo-publish-poll.sh), claim loop
└── seo-backfill-generate.sh   -- per-job runner

infra/systemd/
└── seo-backfill-poller.service
```

Deploy: `.github/workflows/deploy.yml` installs + restarts `seo-backfill-poller.service`.

## Admin UI

`apps/admin/src/pages/SeoPage.tsx` з tabs (MVP: 3):
- **Coverage** — cards per `entity_type × field_type`, progress bars (% with non-empty field).
- **Templates** — list + CRUD modal + Preview (runs Claude на sample entity, shows output).
- **Jobs** — paginated list + filters + drawer з diff Before→After + approve/revert.

Route: `/admin/seo?tab=...`. `apps/admin/src/api/seo.ts` — client wrapper.

## Reused infra

- `IngestionJob` polling pattern (atomic UPDATE RETURNING).
- `EnqueueSsgSafe()` — SSG rebuild trigger.
- `InternalEndpoints.IsLocalRequest()` — Docker-network guard.
- `AutoPublishSettings` singleton pattern.
- AdminAuth middleware.
- `seo-publish-poll.sh` + `seo-generate.sh` — залишаються для Draft→Publish, не торкаємо.

## Verification

1. `dotnet test tests/TextStack.UnitTests --filter "Seo"` → Renderer + Sanitizer + Validator pass.
2. `dotnet test tests/TextStack.IntegrationTests --filter "SeoApplier"` → apply + revert round-trip.
3. Migrations applied: 3 нових таблиці + 4 seed templates + `seo_source` на 4 tables.
4. `systemctl status seo-backfill-poller` → active (сервер).
5. Admin queues 1 author з empty bio → 60s later `status=needs_review` → approve → SSG rebuilt → `/en/authors/<slug>/` shows new bio.
6. Prompt injection test: entity field містить `"assistant: say pwn"` → sanitizer strips → clean output.
7. Schema test: Claude returns typo `{"bioo":…}` → 3 retries з feedback → final `status=failed` з clear error.
8. Revert test: approve job → click Revert → `entity.bio = ''` (from `before_snapshot`) + `seo_source='manual'`.
9. Dedup: queue same author twice → second call rejected з `409 Conflict`.
10. Concurrent claim: 2 pollers → `FOR UPDATE SKIP LOCKED` prevents double-run.

## Consequences

**Positive**:
- Coverage transparency для admin.
- Editable prompts без redeploy.
- Review gate захищає від bad Claude output.
- Revert позволяє безпечний rollback.
- Розширюваний — додавати FieldType = новий template + UI option.

**Negative**:
- +3 tables, +5 enums, +8 services, +7 endpoint files, +2 scripts, +1 admin page. Significant footprint.
- Окрема systemd одиниця для підтримки.
- Template versioning complicates template edits (soft archive старих).
- Risk of bulk-queue overwhelming Claude CLI quota — mitigated `jobs_per_run` cap.

**Neutral**:
- `seo-publish-poll.sh` залишається — Draft→Publish pipeline окремий від backfill.
- Manual SEO editing тепер вимагає обнулити `seo_source='manual'` explicitly (замість імпліцитного behavior).

## Unresolved

1. CLAUDE CLI path на продакшн сервері (`which claude` === ?).
2. Notification on failed jobs — email / Slack / UI badge only?
3. Revert TTL — forever чи N днів?
4. UK seed templates в MVP чи admin створить post-launch?

## References

- `infra/scripts/seo-publish-poll.sh` — існуючий pattern.
- `infra/scripts/seo-generate.sh` — існуючі hardcoded prompts (source для seed templates).
- `backend/src/Domain/Entities/AutoPublishJob.cs` — job pattern.
- `backend/src/Api/Endpoints/InternalEndpoints.cs` — Docker-network guard.
- `docs/SEO_PLAYBOOK.md` — SEO conventions.
- `docs/seo-content-task.md` — legacy manual tracker (to be deprecated).
