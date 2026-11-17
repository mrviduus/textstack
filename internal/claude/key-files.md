# Key files

Read when the task touches this area. Rewritten for one database at M6 (2026-11-17).

| Area | Path |
|------|------|
| Domain | `backend/src/Domain/` (`Library`, `Reading`, `Annotations`, `Vocabulary`, `Discussion`, `Identity`, `Transitional`, `LLM`) |
| Application (services, repository ports) | `backend/src/Application/` (`Library`, `Reading`, `Annotations`, `Vocabulary`, `Discussion`, `Identity`, `Sync`) |
| Data source + repositories (Dapper) | `backend/src/Infrastructure/Persistence/V2DataSource.cs`, `Persistence/Repositories/` |
| Schema ledger | `database/migrations/`, `database/migrate.sh`, `database/run.sh`, `database/README.md`; image `backend/Docker/Migrator.Dockerfile` |
| API entry, middleware | `backend/src/Api/Program.cs`, `backend/src/Api/Middleware/` |
| Sync API (`/me/v2`) | `backend/src/Api/Endpoints/V2Endpoints.cs`, gate `backend/src/Api/V2/V2Gate.cs` |
| Old paths on V2 (clip, highlights/all, explain, translate) | `backend/src/Api/Endpoints/V2CompatEndpoints.cs` |
| Route snapshot | `tests/TextStack.UnitTests/Routes/routes.public.txt` |
| Worker | `backend/src/Worker/Services/` (`V2IngestionWorker.cs`, `RetentionCleanupWorker.cs`) |
| Extraction | `backend/src/Extraction/TextStack.Extraction/` |
| Storage | `backend/src/Infrastructure/Services/LocalFileStorageService.cs` (`/storage`), `LibraryFileStore.cs` (`/library`) |
| Vocabulary SRS | `backend/src/Vocabulary/TextStack.Vocabulary/` (`SrsEngine.cs`) |
| TTS | `backend/src/Tts/TextStack.Tts/`, `backend/src/Api/Endpoints/TtsEndpoints.cs`, web `apps/web/src/hooks/useTts.ts` |
| Profile, account | `backend/src/Api/Endpoints/ProfileEndpoints.cs`, `AccountEndpoints.cs` |
| Email | `backend/src/Infrastructure/Services/ResendEmailService.cs` |
| AI account policy | `backend/src/Api/Extensions/AiAccountPolicy.cs` |
| MCP | `backend/src/Ai/TextStack.Ai.Mcp/`, manifest `backend/src/Contracts/Mcp/McpManifest.cs` |
| Reader page (both hosts) | `apps/mobile/src/lib/v2reader/` (`build.mjs`, `page.mjs`, `v2ReaderPage.generated.ts`, README) |
| Reader host, web | `apps/web/src/pages/V2ReaderPage.tsx`, `apps/web/src/components/reader/V2ReaderHost.tsx`, `apps/web/src/lib/v2ReaderSync.ts` |
| Reader host, Android | `apps/mobile/src/components/v2reader/V2ReaderScreen.tsx`, `apps/mobile/app/my-books/read/` |
| Shared client + locators | `packages/shared/src/api/v2.ts`, `packages/shared/src/reader/v2PageEntry.ts` |
| Mobile local library + sync | `apps/mobile/src/lib/v2reader/localLibrary.ts`, `sync.ts` |
| Web contexts, pages | `apps/web/src/context/`, `apps/web/src/pages/` |
| Library | `apps/web/src/pages/LibraryPage.tsx`, `UserBookDetailPage.tsx` |
| Vocabulary (web) | `apps/web/src/pages/VocabularyPage.tsx`, `VocabularyReviewPage.tsx`, `apps/web/src/components/vocabulary/` |
| Highlights (web) | `apps/web/src/pages/HighlightsPage.tsx` |
| Changelog page | `apps/web/src/lib/changelog.ts`, `apps/web/src/pages/ChangelogPage.tsx` |
| i18n | `apps/web/src/locales/en.json` |
| Admin shell | `apps/admin/src/pages/` (login, home) |
| Guest policy | `packages/shared/src/lib/capabilities.ts`; mobile `apps/mobile/src/lib/guestSession.ts`, `src/components/SessionGate.tsx` |
| Mobile app, API, contexts, e2e | `apps/mobile/app/`, `apps/mobile/src/lib/api.ts`, `apps/mobile/src/context/`, `apps/mobile/e2e/` |
| nginx | `infra/nginx/textstack.conf` |
| Workflows | `.github/workflows/` (`ci.yml`, `deploy.yml`, `backup.yml`, `restore-drill.yml`, `health-check.yml`, `images.yml`) |
