# API endpoints

Moved verbatim from `CLAUDE.md` (2026-10-12) to keep the always-loaded context small. Read when the task touches this area.

## API Endpoints

**Public**: `GET /books`, `/books/{slug}`, `/authors`, `/genres`, `/search?q=`, `/seo/*`, `POST /explain`, `POST /translate`, `GET /api/tts?text=&lang=&voice=&speed=`, `GET /api/tts/voices?lang=`

**Auth**: `POST /auth/login`, `/auth/guest`, `/auth/google`, `/auth/apple`, `/auth/refresh`, `/auth/logout`, `/auth/register`, `/auth/forgot-password`, `/auth/reset-password`

**Profile**: `GET/PUT /me/profile`

**User**: `GET/POST /me/library`, `GET /me/library/shelves`, `/me/progress/{editionId}` (GET/PUT/DELETE), `/me/bookmarks`, `/me/highlights/{editionId}`

**Reading Tracking**: `POST /me/reading/sessions`, `GET /me/reading/sessions`, `GET /me/reading/stats`, `GET /me/reading/stats/daily`, `GET /me/reading/pace`, `GET/POST /me/reading/goals`, `DELETE /me/reading/goals/{id}`, `GET /me/reading/achievements`

**User Books**: `POST /me/books/upload`, `GET /me/books`, `GET /me/books/quota`, `GET /me/books/{id}`, `GET /me/books/{id}/chapters/{slug}`, `GET /me/books/{id}/file` (the stored original, any format, Range-enabled), `GET/PUT /me/books/{id}/progress`, `GET/POST/DELETE /me/books/{id}/bookmarks`, `POST /me/books/{id}/retry`, `DELETE /me/books/{id}`

**Vocabulary**: `POST /me/vocabulary/words`, `GET /me/vocabulary/words?filter=&sort=&search=&limit=&offset=`, `PATCH /me/vocabulary/words/{id}`, `DELETE /me/vocabulary/words/{id}`, `GET /me/vocabulary/review?limit=`, `POST /me/vocabulary/review`, `GET /me/vocabulary/stats`

**Admin**: `POST /admin/books/upload`, `/admin/import/textstack`, `/admin/reimport/textstack`, `/admin/sync/standardebooks`, `/admin/reprocess/{editionId}`, `/admin/reprocess/all`, `GET /admin/ingestion/jobs`, `/admin/ingestion/jobs/{id}/retry`, `/admin/ingestion/jobs/{id}/preview`, `/admin/chapters/{id}` (GET/PUT/DELETE), `/admin/settings`, `/admin/ssg/jobs` (+ `/{id}`, `/cancel`), `/admin/lint`, CRUD for `/admin/authors`, `/admin/genres`

**Auto Publish Admin**: `GET/PUT /admin/autopublish/settings`, `GET /admin/autopublish/jobs`, `GET /admin/autopublish/jobs/{id}`, `POST /admin/autopublish/jobs/{id}/approve`, `POST /admin/autopublish/jobs/{id}/reject`, `POST /admin/autopublish/jobs/{id}/retry`, `POST /admin/autopublish/trigger`, `POST /admin/autopublish/queue/{editionId}`, `GET /admin/autopublish/candidates`

**SEO Backfill Admin**: `GET /admin/seo/coverage`, `GET /admin/seo/gaps?entityType=&limit=`, `GET/PUT /admin/seo/settings`, `GET /admin/seo/templates`, `GET /admin/seo/templates/{id}`, `POST /admin/seo/templates`, `PUT /admin/seo/templates/{id}` (creates new Version), `POST /admin/seo/templates/{id}/deactivate`, `POST /admin/seo/templates/preview`, `GET /admin/seo/jobs`, `GET /admin/seo/jobs/{id}`, `POST /admin/seo/jobs/{id}/approve`, `POST /admin/seo/jobs/{id}/revert`, `POST /admin/seo/jobs/{id}/retry`, `POST /admin/seo/queue`

**Internal**: `PUT /internal/featured` (Popular shelf, replaces all ranks), `POST /internal/editions/{id}/publish`, `POST /internal/ssg/rebuild-all`, `POST /internal/seo/jobs/claim?limit=`, `GET /internal/seo/jobs/{id}/context`, `POST /internal/seo/jobs/{id}/apply`, `POST /internal/seo/jobs/{id}/fail` (Docker network only)
