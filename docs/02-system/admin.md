# Admin Panel

Private content tool. Separate React app (`apps/admin/`), separate auth. Checked against code
2026-10-04.

## Access

- Prod: `https://textstack.dev` (nginx serves the admin SPA, `X-Robots-Tag: noindex, nofollow`).
  Local: `http://localhost:81`.
- Not linked from the public UI, not in any sitemap.
- In the repo, protection is the login only — nginx has no IP allowlist (any Cloudflare Access rule would live outside the repo).

## Authentication

Separate from user auth (`AdminUser` ≠ `User`). Email + BCrypt password, JWT access token +
`AdminRefreshToken`.

```
POST /admin/auth/login     POST /admin/auth/refresh
POST /admin/auth/logout    GET  /admin/auth/me
```

`AdminAuthMiddleware` guards every `/admin/*` path except `/admin/auth/*` and stores the role in
`HttpContext.Items`. Roles exist (`AdminRole`: Admin, Editor, Moderator) but **no endpoint checks
them** — any active admin can do everything.

There is no audit log: `admin_audit_logs` was dropped on 2026-01-22 (migration `RemoveAdminAuditLog`).

## Pages (`apps/admin/src/pages/`)

Dashboard · Upload · Jobs (ingestion) · User Uploads (moderation, takedown) · Editions + edit
(SEO fields, cover) · Chapter editor · Authors · Genres · Tools (import/sync/reprocess) ·
SSG Rebuild (+ job detail) · Auto Publish · SEO Backfill · Book Quality · AI Quality
(traces, evals, shadow, models, budgets) · Settings.

There is no Sites page (removed with multisite, ADR-007).

## API (main groups)

| Area | Routes | File |
|------|--------|------|
| Upload / jobs | `POST /admin/books/upload`, `GET /admin/ingestion/jobs[/{id}[/preview]]`, `POST …/{id}/retry` | `AdminEndpoints.cs` |
| Editions | `GET/PUT/DELETE /admin/editions/{id}`, `POST …/publish`, `…/unpublish`, `POST/DELETE …/cover` | `AdminEndpoints.cs` |
| Chapters | `GET/PUT/DELETE /admin/chapters/{id}` | `AdminEndpoints.cs` |
| Imports | `/admin/import/textstack`, `/admin/reimport/textstack`, `/admin/sync/standardebooks`, `/admin/restore/standardebooks`, `/admin/reprocess/{id|all}` | `AdminEndpoints.cs` |
| User uploads | `GET /admin/user-uploads[/stats]`, `DELETE …/{id}`, `POST …/{id}/takedown` | `AdminEndpoints.cs` |
| Authors / genres | CRUD | `AdminAuthorsEndpoints.cs`, `AdminGenresEndpoints.cs` |
| SSG | `/admin/ssg/*` | `AdminSsgRebuildEndpoints.cs` |
| Auto publish | `/admin/autopublish/*` | `AdminAutoPublishEndpoints.cs` |
| SEO backfill | `/admin/seo/*` | `AdminSeoBackfillEndpoints.cs` |
| Quality, lint, settings, diagnostics | `/admin/…` | `AdminBookQualityEndpoints.cs`, `AdminLintEndpoints.cs`, `AdminSettingsEndpoints.cs`, `AdminDiagnosticsEndpoints.cs` |
| AI quality | `/admin/ai-quality/*` | `AdminAiQualityEndpoints*.cs` |
| Stats | `GET /admin/stats` | `AdminEndpoints.cs` |

Upload form fields: `file`, `siteId`, `title`, `language`, `description?`, `workId?`,
`sourceEditionId?`, `authorIds?`, `genreId?`. A successful ingestion publishes the edition
([ingestion.md](ingestion.md)).

## Key files

| File | Purpose |
|------|---------|
| `apps/admin/` | React admin app |
| `backend/src/Api/Endpoints/Admin*.cs` | Admin API |
| `backend/src/Api/Middleware/AdminAuthMiddleware.cs` | Auth gate |
| `backend/src/Application/Admin/AdminService*.cs` | Business logic (partials) |
| `backend/src/Domain/Entities/AdminUser.cs` | Admin entity |

## See also

- [Ingestion pipeline](ingestion.md) · [Database](database.md) · CLI `create-admin` in CLAUDE.md
