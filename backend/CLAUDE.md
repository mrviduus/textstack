# Backend guide

Loaded when working under `backend/`. Rewritten for one database at M6 (2026-11-17). Layers, middleware order and patterns: the root `CLAUDE.md`.

## Key files

| Area | Path |
|------|------|
| Domain | `backend/src/Domain/` (`Library`, `Reading`, `Annotations`, `Vocabulary`, `Discussion`, `Identity`, `Transitional`, `LLM`) |
| Application (services, repository ports) | `backend/src/Application/` (`Library`, `Reading`, `Annotations`, `Vocabulary`, `Discussion`, `Identity`, `Sync`) |
| Data source + repositories (Dapper) | `backend/src/Infrastructure/Persistence/AppDataSource.cs`, `Persistence/Repositories/` |
| Schema ledger | `database/migrations/`, `database/migrate.sh`, `database/run.sh`, `database/README.md`; image `backend/Docker/Migrator.Dockerfile` |
| API entry, middleware | `backend/src/Api/Program.cs`, `backend/src/Api/Middleware/` |
| Sync API (`/me/v2`) | `backend/src/Api/Endpoints/SyncEndpoints.cs`, gate `backend/src/Api/Sync/SyncGate.cs` |
| Old paths on V2 (clip, highlights/all, explain, translate) | `backend/src/Api/Endpoints/CompatEndpoints.cs` |
| Route snapshot | `tests/TextStack.UnitTests/Routes/routes.public.txt` |
| Worker | `backend/src/Worker/Services/` (`IngestionWorker.cs`, `RetentionCleanupWorker.cs`) |
| Extraction | `backend/src/Extraction/TextStack.Extraction/` |
| Storage | `backend/src/Infrastructure/Services/LocalFileStorageService.cs` (`/storage`), `LibraryFileStore.cs` (`/library`) |
| Vocabulary SRS | `backend/src/Vocabulary/TextStack.Vocabulary/` (`SrsEngine.cs`) |
| TTS | `backend/src/Tts/TextStack.Tts/`, `backend/src/Api/Endpoints/TtsEndpoints.cs` |
| Profile, account | `backend/src/Api/Endpoints/ProfileEndpoints.cs`, `AccountEndpoints.cs` |
| Email | `backend/src/Infrastructure/Services/ResendEmailService.cs` |
| AI account policy | `backend/src/Api/Extensions/AiAccountPolicy.cs` |
| MCP | `backend/src/Ai/TextStack.Ai.Mcp/`, manifest `backend/src/Contracts/Mcp/McpManifest.cs` |

## API endpoints

Source of truth: `backend/src/Api/Endpoints/` (`Map*Endpoints()` in `Program.cs`) and, for every ungated route, `tests/TextStack.UnitTests/Routes/routes.public.txt`.

**Public**: `POST /explain`, `POST /translate`, `POST /api/translate`, `GET /api/translate/languages`, `GET /tts?text=&lang=&voice=&speed=` (`/tts/timestamps`, `/tts/voices`), `GET /app/config`, `GET /mcp/manifest`, `GET /health`, `GET /health/ready`

**Auth**: `POST /auth/login`, `/auth/guest`, `/auth/google`, `/auth/apple`, `/auth/refresh`, `/auth/refresh-mobile`, `/auth/logout`, `/auth/register`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/test-login` (only with `ENABLE_TEST_AUTH`), `GET /auth/me`; device flow `POST /auth/device/{code,token,approve,deny}`

**OAuth** (ADR-017): `GET /.well-known/oauth-authorization-server`, `GET /oauth/authorize`, `GET /oauth/requests/{id}`, `POST /oauth/authorize/{approve,deny}`, `POST /oauth/{token,register,revoke}`, `GET /oauth/token-status`; `GET/DELETE /me/oauth/grants`

**Account**: `GET/PUT /me/profile`, `POST/DELETE /me/profile/avatar`, `DELETE /me/account`, `GET/POST/DELETE /me/mcp/keys`

**Sync API** `/me/v2` (every route, payload and code: `docs/internal/v2/v2-sync-protocol.md` "Endpoints"; `SyncGate` filter):
- status: `GET /status`
- library: `GET /library/changes`, `GET /books/by-sha256/{sha256}`, `PUT/PATCH/DELETE /books/{id}`, `POST /books/{id}/restore`, `PUT /books/{id}/files/{fileId}` (replace)
- bytes: `PUT /books/{id}/files/{fileId}/parts/{index}`, `POST|GET|DELETE /books/{id}/files/{fileId}/content`, `PUT|GET /books/{id}/cover`
- transitional chapters (kept, M6 D8): `GET /books/{id}/files/{fileId}/chapters[/{chapterKey}]`
- reading: `GET /reading/changes`, `GET/PUT /books/{id}/reading-state`, `POST /books/{id}/reading-state/reset`, `PUT /reading/sessions/{clientSessionId}`
- annotations (highlights, notes, bookmarks): `GET /annotations/changes`, `PUT/DELETE /annotations/{id}`
- vocabulary: `GET /vocabulary/changes`, `GET /vocabulary/due`, `PUT /vocabulary/words`, `GET/PATCH/DELETE /vocabulary/words/{id}`, `POST /vocabulary/words/{id}/{restore,examples}`, `POST /vocabulary/reviews`
- discussion: `POST/GET /books/{id}/shares`, `GET/DELETE /shares/{id}`, `POST/GET /books/{id}/checkpoints`, `DELETE /checkpoints/{id}`, `PUT /books/{id}/checkpoint-saving`, `GET/POST /books/{id}/insights`

**Old paths answered from V2** (`CompatEndpoints.cs`; clients still call them): `POST /me/books/clip` (browser extension), `GET /me/highlights/all`

**Admin**: `POST /admin/auth/{login,logout,refresh}`, `GET /admin/auth/me`. Nothing else (the admin app is a shell, M6 D2).

**Internal**: none mapped; `/internal/*` stays 403 off the docker network (`PathGates`).

## Extraction

`ExtractorRegistry` maps `.epub`, `.pdf` and `.html` only (no TXT/MD). OCR exists as options only (`ExtractionOptions.EnableOcrFallback`, default off); no OCR engine is wired. Rules: `backend/src/Extraction/TextStack.Extraction/RULES.md`.
