# Key files

Moved verbatim from `CLAUDE.md` (2026-10-12) to keep the always-loaded context small. Read when the task touches this area.

## Key Files

| Area | Path |
|------|------|
| Domain | `backend/src/Domain/Entities/` |
| Application | `backend/src/Application/` (services, interfaces) |
| API Endpoints | `backend/src/Api/Endpoints/` |
| API Middleware | `backend/src/Api/Middleware/` |
| API Entry | `backend/src/Api/Program.cs` |
| Worker | `backend/src/Worker/Services/IngestionWorker.cs` |
| Extraction | `backend/src/Extraction/` (EPUB/PDF parsers) |
| Search | `backend/src/Search/TextStack.Search/Providers/PostgresFts/PostgresSearchProvider.cs` |
| DB Context | `backend/src/Infrastructure/Persistence/AppDbContext.cs` |
| Web Contexts | `apps/web/src/context/` |
| Web Pages | `apps/web/src/pages/` |
| Reader | `apps/web/src/pages/ReaderPage.tsx` |
| Library | `apps/web/src/pages/LibraryPage.tsx` |
| API Hook | `apps/web/src/hooks/useApi.ts` |
| i18n | `apps/web/src/locales/en.json` |
| Admin | `apps/admin/src/pages/` |
| Stats | `apps/web/src/pages/StatsPage.tsx` |
| Reading Hooks | `apps/web/src/hooks/useReadingSession.ts` |
| Achievements | `backend/src/Application/ReadingTracking/AchievementChecker.cs` |
| Vocabulary API | `backend/src/Api/Endpoints/VocabularyEndpoints.cs` |
| Vocabulary SRS | `backend/src/Vocabulary/TextStack.Vocabulary/SrsEngine.cs`, `ReviewCardBuilder.cs` |
| Distractor Gen | `backend/src/Vocabulary/TextStack.Vocabulary/DistractorGenerator.cs` |
| Vocabulary Page | `apps/web/src/pages/VocabularyPage.tsx` |
| Vocab Review | `apps/web/src/pages/VocabularyReviewPage.tsx` |
| Vocab Components | `apps/web/src/components/vocabulary/` |
| Vocab Hooks | `apps/web/src/hooks/useVocabulary.ts`, `useVocabularyReview.ts` |
| Vocab E2E | `apps/web/e2e/tests/vocabulary.spec.ts` |
| TTS Library | `backend/src/Tts/TextStack.Tts/` (EdgeTtsClient, EdgeTtsService, ITtsService) |
| TTS API | `backend/src/Api/Endpoints/TtsEndpoints.cs` |
| TTS Hook | `apps/web/src/hooks/useTts.ts` |
| Book Metadata | `backend/src/Worker/Services/BookMetadataGenerator.cs` |
| Auto Publish API | `backend/src/Api/Endpoints/AdminAutoPublishEndpoints.cs` |
| Auto Publish Entity | `backend/src/Domain/Entities/AutoPublishJob.cs` |
| Auto Publish Admin | `apps/admin/src/pages/AutoPublishPage.tsx` |
| SEO Generate Script | `infra/scripts/seo-generate.sh` |
| SEO Publish Poller | `infra/scripts/seo-publish-poll.sh` |
| SEO Backfill Admin API | `backend/src/Api/Endpoints/AdminSeoBackfillEndpoints.cs` |
| SEO Backfill Internal API | `backend/src/Api/Endpoints/InternalSeoEndpoints.cs` |
| SEO Backfill Services | `backend/src/Application/Seo/` (JobProcessor, ContextBuilder, ContentApplier, CoverageAnalyzer, TemplateRenderer, ContentValidator, PromptSanitizer) |
| SEO Backfill Entities | `backend/src/Domain/Entities/SeoTemplate.cs`, `SeoBackfillJob.cs`, `SeoBackfillSettings.cs` |
| SEO Backfill Poller | `infra/scripts/seo-backfill-poll.sh`, `infra/scripts/seo-backfill-generate.sh` |
| SEO Backfill systemd | `infra/systemd/seo-backfill-poller.service` |
| SEO Backfill Admin UI | `apps/admin/src/pages/SeoBackfillPage.tsx` |
| Internal Endpoints | `backend/src/Api/Endpoints/InternalEndpoints.cs` |
| SSG | `apps/web/scripts/prerender.mjs` |
| nginx config | `infra/nginx/textstack.conf` |
| Profile API | `backend/src/Api/Endpoints/ProfileEndpoints.cs` |
| Guest Context | `apps/web/src/context/GuestLimitsContext.tsx` |
| Native Lang Context | `apps/web/src/context/NativeLanguageContext.tsx` |
| Email Service | `backend/src/Infrastructure/Services/ResendEmailService.cs` |
| Guest Cleanup | `backend/src/Worker/Services/GuestCleanupWorker.cs` |
| Guest Capabilities (mobile) | `apps/mobile/src/lib/capabilities.ts` |
| Guest Minting (mobile) | `apps/mobile/src/lib/guestSession.ts`, `src/components/SessionGate.tsx` |
| AI Account Policy | `backend/src/Api/Extensions/AiAccountPolicy.cs` |
| Highlights Page | `apps/web/src/pages/HighlightsPage.tsx` |
| Mobile App | `apps/mobile/app/` (Expo Router pages) |
| Mobile API | `apps/mobile/src/lib/api.ts` |
| Mobile Contexts | `apps/mobile/src/context/` |
| Mobile E2E | `apps/mobile/e2e/` |
| CI Workflow | `.github/workflows/ci.yml` |
| Deploy Workflow | `.github/workflows/deploy.yml` |
| Backup Workflow | `.github/workflows/backup.yml` |
| Health Check | `.github/workflows/health-check.yml` |
