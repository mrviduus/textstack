# API endpoints

Read when the task touches the API. Rewritten for one database at M6 (2026-11-17). Source of truth: `backend/src/Api/Endpoints/` (`Map*Endpoints()` in `Program.cs`) and, for every ungated route, `tests/TextStack.UnitTests/Routes/routes.public.txt`.

**Public**: `POST /explain`, `POST /translate`, `POST /api/translate`, `GET /api/translate/languages`, `GET /tts?text=&lang=&voice=&speed=` (`/tts/timestamps`, `/tts/voices`), `GET /app/config`, `GET /mcp/manifest`, `GET /health`, `GET /health/ready`

**Auth**: `POST /auth/login`, `/auth/guest`, `/auth/google`, `/auth/apple`, `/auth/refresh`, `/auth/refresh-mobile`, `/auth/logout`, `/auth/register`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/test-login` (only with `ENABLE_TEST_AUTH`), `GET /auth/me`; device flow `POST /auth/device/{code,token,approve,deny}`

**OAuth** (ADR-017): `GET /.well-known/oauth-authorization-server`, `GET /oauth/authorize`, `GET /oauth/requests/{id}`, `POST /oauth/authorize/{approve,deny}`, `POST /oauth/{token,register,revoke}`, `GET /oauth/token-status`; `GET/DELETE /me/oauth/grants`

**Account**: `GET/PUT /me/profile`, `POST/DELETE /me/profile/avatar`, `DELETE /me/account`, `GET/POST/DELETE /me/mcp/keys`

**Sync API** `/me/v2` (every route, payload and code: `docs/internal/v2/v2-sync-protocol.md` "Endpoints"; `V2Gate` filter):
- status: `GET /status`
- library: `GET /library/changes`, `GET /books/by-sha256/{sha256}`, `PUT/PATCH/DELETE /books/{id}`, `POST /books/{id}/restore`, `PUT /books/{id}/files/{fileId}` (replace)
- bytes: `PUT /books/{id}/files/{fileId}/parts/{index}`, `POST|GET|DELETE /books/{id}/files/{fileId}/content`, `PUT|GET /books/{id}/cover`
- transitional chapters (kept, M6 D8): `GET /books/{id}/files/{fileId}/chapters[/{chapterKey}]`
- reading: `GET /reading/changes`, `GET/PUT /books/{id}/reading-state`, `POST /books/{id}/reading-state/reset`, `PUT /reading/sessions/{clientSessionId}`
- annotations (highlights, notes, bookmarks): `GET /annotations/changes`, `PUT/DELETE /annotations/{id}`
- vocabulary: `GET /vocabulary/changes`, `GET /vocabulary/due`, `PUT /vocabulary/words`, `GET/PATCH/DELETE /vocabulary/words/{id}`, `POST /vocabulary/words/{id}/{restore,examples}`, `POST /vocabulary/reviews`
- discussion: `POST/GET /books/{id}/shares`, `GET/DELETE /shares/{id}`, `POST/GET /books/{id}/checkpoints`, `DELETE /checkpoints/{id}`, `PUT /books/{id}/checkpoint-saving`, `GET/POST /books/{id}/insights`

**Old paths answered from V2** (`V2CompatEndpoints.cs`; clients still call them): `POST /me/books/clip` (browser extension), `GET /me/highlights/all`

**Admin**: `POST /admin/auth/{login,logout,refresh}`, `GET /admin/auth/me`. Nothing else (the admin app is a shell, M6 D2).

**Internal**: none mapped; `/internal/*` stays 403 off the docker network (`PathGates`).
