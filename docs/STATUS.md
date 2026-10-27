# Status

**Last updated: 2026-10-24.** Where the project is *now*: what is live, half-finished, known-broken or deliberately not done. What the product does: [`docs/README.md`](README.md). What changed and when: [`CHANGELOG.md`](../CHANGELOG.md) and [`changelog-archive/`](changelog-archive/). Closed items are deleted from here, not struck through; git history keeps them.

> **Keeping it honest:** a PR that finishes a line here deletes or moves that line in the same PR. New open items go to [GitHub issues](https://github.com/mrviduus/textstack/issues) with a label; the items below move to an issue when someone touches them.

---

## Shipped and live

| Area | State |
|---|---|
| **Reader** (web + mobile) | EPUB + PDF (original-first, [ADR-012](01-architecture/adr/ADR-012-pdf-original-first-lazy-parse.md)), page-based progress, highlights, TTS, vocabulary SRS, one chapter at a time. Both clients read through `packages/reader-engine` ([ADR-025](01-architecture/adr/ADR-025-reader-engine-package.md), Phases 0–6 done 2026-10-15, old readers deleted). Position rules: [ADR-019](01-architecture/adr/ADR-019-reader-position-rules.md); re-ingest keeps readers' data ([ADR-018](01-architecture/adr/ADR-018-reingest-updates-chapters-in-place.md)). The free dictionary is gone (2026-10-03). |
| **Sync** | Progress last-write-wins per client clock; offline highlights replay with a three-way merge; reading sessions queued on both clients. |
| **Security & ops** | All P0/P1 items of the [architecture review 2026-10](01-architecture/review-2026-10/00-summary.md) fixed. `/me` and `/internal` fail closed by path ([ADR-024](01-architecture/adr/ADR-024-auth-fails-closed-by-path.md)); every ungated route is in `tests/TextStack.UnitTests/Routes/routes.public.txt`. Only the migrator migrates ([ADR-021](01-architecture/adr/ADR-021-migrations-owned-by-the-migrator.md)). |
| **Backups** | Nightly off-site copy to Cloudflare R2 (restic) and a monthly restore drill. [`backup.md`](03-ops/backup.md). |
| **AI platform** | Translate and Explain/enrichment on OpenAI; vocabulary distractors, tags and fallback metadata on local Ollama; SEO publishing crews; Tutor study planner. Reader-facing chat surfaces were deleted 2026-09-10; the conversation happens in the reader's own assistant. |
| **Assistant handoff (MCP)** | 21 tools (`backend/src/Contracts/Mcp/McpManifest.cs`) over stdio + streamable HTTP; OAuth sign-in ([ADR-017](01-architecture/adr/ADR-017-mcp-oauth-authorization-server.md)) or connect key for ChatGPT; conclusions come back as `BookInsight`; chapter review ([ADR-016](01-architecture/adr/ADR-016-chapter-review-lives-in-book-insight.md)). [`assistant-handoff.md`](05-features/assistant-handoff.md), [`mcp.md`](05-features/mcp.md). |
| **Observability** | Sentry on API, Worker, MCP server, ssg-worker and mobile; OpenTelemetry → Aspire locally only. [`delivery.md`](01-architecture/delivery.md#observability). |
| **Entitlements & guests** | `UserTier { Guest, Free, Supporter, Staff }`, config-driven quotas; guests get a real server session that registering promotes in place ([ADR-014](01-architecture/adr/ADR-014-guest-sessions.md)). |
| **SEO / SSG** | Prerendered pages, sitemap, IndexNow; frozen since #992 (no nightly rebuild, no age alarm; manual rebuilds only, future undecided in #992). Four incidents since 2026-08-11 ([list](incidents/README.md)); now watched two ways (worker refuses a rebuild that lost files, crawler health check every 5 min). Hung rebuilds end `Failed` after 5 min without a rendered route. |
| **Mobile** | Android is in **production on Google Play** (owner, 2026-10-23); Internal and Closed tracks stay for testing. Expo SDK 57 / RN 0.86. OTA via `expo-updates` on merge; a moved runtime fingerprint builds and submits to Internal instead. Offline by default: own uploads stored on the device (2 GB LRU), library downloads on Wi-Fi, chapter loaders read the device first. Release runbook: [`play-store-release.md`](03-ops/play-store-release.md). |
| **Delivery** | Build once on GitHub, deploy by digest ([ADR-020](01-architecture/adr/ADR-020-build-once-deploy-by-digest.md), [`delivery.md`](01-architecture/delivery.md)); secret-scanned images; pre-deploy dump; pinned actions. One Node version in `.nvmrc`, one pnpm workspace with a version catalog, weekly dependency refresh PR. |
| **Catalog** | Curated **Popular** shelf (`Edition.FeaturedRank`; admin or `make featured`). Search is Postgres FTS over `chapters` only. |

## In flight

**Focus (owner): no new side work.** Anything new goes into Known-broken below and is not started, unless it is a production outage or a security problem.

- **Reader engine follow-ups** (ADR-025 done): owner step EAS variables after the bake (#867); owner pass of web Phase 4 on prod; open #829, #835, #850, #851, #856 (bundle budget), #846 (test review), #824 (e2e blind spots), #857 (nginx security headers).
- **Reader after R4:** split web `ReaderPage.tsx` (~900 lines) and `ReaderHighlights.tsx` (661) by job, as #731 did for mobile. **Every R1–R4 mobile fix is unit-tested only: the owner's Android phone checklist is still owed** ([QA-007](qa/scenarios/QA-007-reader-android-r1-r4.md)).
- **Delivery, owner steps (ADR-020):** repo settings (require actions pinned to a full SHA, allowed actions = GitHub + verified + listed, turn off "Actions can approve PRs", delete the unused `CLAUDE_CODE_OAUTH_TOKEN` secret, enable non-provider secret patterns). Then measure an `images` run after the slim Dockerfiles and delete *Free disk space* if there is room.
- **Assistant handoff, owner checks:** that the mobile Claude and ChatGPT apps accept a custom connector at all, and one live end-to-end conversation on a phone.
- **Chunked upload:** 1 of 8 steps (tiers, #449). Files over ~100 MB still fail at Cloudflare's body cap with `Upload failed: 413`.
- **Two-audience onboarding** ("I work in tech" / "I'm learning English"), planned, not started. Was deferred until Play production, which is now live. The mobile card still says "Learn a language by reading real books". [Plan](marketing/onboarding-consilium-2026-10-08.md). Prod nit: 10 arXiv editions have their abstract inside "About this edition".
- **Later, in 2–3 bundled PRs:** the rest of [review 2026-10](01-architecture/review-2026-10/00-summary.md) (#19 admin roles/audit, #20 book models, #21 LLM jobs on the owner's Claude login, #24 web `api/` duplicate, #25 two SEO engines, #26 GDPR traces, #31 ADR numbering, #32 housekeeping) and the ADR-022/023/024 remainder (`/storage` covers #956, delete the book quality queue, reconciler enrichment).
- **Article:** Sentry write-up, draft on vasyl.blog; needs edits, image, publish, then a DEV cross-post.

## Known-broken / open follow-ups

Each is a real defect, known and not yet fixed.

**Ingestion, SSG, ops**
- **Upload covers are readable by URL without auth** (`/storage`, ADR-024 step 2) — #956.
- **`/internal` trusts a forwarded address from the home LAN** (ADR-024): `ForwardedHeaders` trusts `X-Forwarded-For` from 192.168/16. nginx refuses it from outside. Fix: shared-secret header (ADR-024 step 3, after #19).
- **Six user routes live outside `/me`** and rely on their handler's check: `GET /auth/me`, `POST /auth/device/approve|deny`, `POST /oauth/authorize/approve|deny`, `GET /oauth/token-status`. No plan to move them.
- **Mobile OTA targets one runtime only** (#762, issue #914): it publishes to the runtime of the newest *finished* production build. If production runs an older build than Closed testing, production stops receiving OTAs. **Fix before the second store release.** [Runbook](03-ops/play-store-release.md#known-limits-of-the-automatic-ota).
- **Deploy-interrupted uploads (ADR-022, fixed #769)** were not yet watched through a real deploy: check the next deploy's Worker log for "interrupted by shutdown; returned to queue" and that no upload ends `Failed`.
- **Interrupted ingestion can leave orphan image files** (disk only). Fix: deterministic image names, or sweep `assets/` against `book_assets`.
- **Vocabulary words promoted by the hourly reconciler are never enriched** (`DailyCapService.ReconcileUserAsync` does not call `QueueEnrichment`).
- **Cancelling a Running SSG job does not stop it:** ssg-worker never re-reads the row and its final status overwrites `Cancelled`.
- **Unverified:** does ssg-worker's `Host` header reach the API? Node `fetch` to `http://127.0.0.1:<port>` with `host: 'localhost'` got a 400 locally; prod works (`API_URL=http://api:8080`), but not checked why.
- **SSG stall detection ignores first-pass failures** (`SSG_JOB_STALL_MS`): a good build with ~160 consecutive failures is stopped; a moving job can outlast the deploy's 40-min SSG wait.
- **SSG treats any failed API call as a failed page,** including secondary calls the app hides; one broken endpoint fails every rebuild (loud: `Failed` jobs, Sentry).
- **Soft-404s to crawlers:** the catch-all nginx `location /` returns 200 for non-SSG paths. **Dead nginx block:** `location /ssg/` aliases a directory that does not exist. **`X-SEO-Render` lies:** set from `map $is_bot`, reports "you look like a bot".
- **GitHub scheduled backups run hours late** (`backup.yml` cron 03:00 UTC started 10:12 on 2026-10-05). Consider triggering from the server's cron, GitHub schedule as a fallback.
- **Server hygiene:** three `.env.bak*` files with live secrets; the server's `node_modules` does not match the lockfile (delete root and `apps/*/node_modules` once, by hand).
- **Review 2026-10 P2 still open:** #15 one claim rule for the 11 polled queues, #16 background services inside the API and fire-and-forget vocab enrichment, #18 auth opt-in per endpoint, #19 admin roles unchecked / no audit log / admin API on the public host, #20 one `BookRef` rule, #24, #25, #26 (GDPR delete leaves LLM trace text, caches, backups). Also `claude-isolated.sh` under `env -i` is untested on the server.
- **`llm_traces` grows without bound** (prompts and book excerpts, no cleanup job; account deletion anonymises). Check the size before writing a retention job.
- **Four dependency advisories have no fix to apply** (`decode-uri-component`, `uuid` inside Expo's tree; `braces`, `node-forge` with no fixed release). Listed in `KNOWN` in `scripts/check-advisories.mjs`; none ships in the app. Currently the `advisories` check also warns on `undici` GHSA-4qv8-2p9j-2685 and GHSA-f72v-6w45-q472 (Dependabot opens the fix).
- **`@sentry/react-native` is ahead of the Expo SDK pin** (8.24 vs `~7.11`); recorded in `expo.install.exclude` as deliberate, but nobody remembers whether it was.
- **Play Console** (#915, #916): the Data Safety form may still hold the pre-2026-08-20 answers, which contradict the privacy policy; the correct answers are in [`play-store-release.md`](03-ops/play-store-release.md). The store listing text was updated 2026-10-24 (in review); the **feature graphic and one screenshot still show "Ask this book"**, which no longer exists.
- **One permission group still requested without need:** 20 OEM launcher/badge permissions from ShortcutBadger via `expo-notifications` (WATCH list in `apps/mobile/scripts/check-android-permissions.mjs`). Confirm in Play Console → App content that the foreground-service declaration is gone (removed in 1.1.0).
- **Notification permission dialog (P2-5)** from the 2026-08-26 pass: no code path in the app can produce it (`targetSdkVersion: 36`). Reproduce with `adb logcat` on an emulator before changing anything.

**Reader and mobile**
- **Shared `nearestOccurrence` tie-break overrides a context-unique match** (ADR-025 spike): the engine's `resolve.ts` `breakTie` fixes it; apps got it by switching to the engine. Verify nothing else still uses the old one.
- **Mobile:** Continue on a catalog PDF read in Original layout (`page:N`, no chapter) opens the detail screen; guest Library empty online after a download without "Save to Library"; Library "Continue" opens book detail, not the reader; native selection handles stay after highlighting; dev-build toast "injectJs failed: markVocabWords is …" (check whether vocab marks can miss on first paint); highlight anchors over a saved word include its inline gloss (resolve only fuzzily).
- **Gloss backfill** translates saved words without their sentence and uses the open book's language for words saved from other books (mobile `useReaderVocabMap`, web `useReaderVocabulary`).
- **Web:** a new reader who confirms a native language different from the browser's guess while a word popup is open can save that word with the guessed-language translation. **Web has no service worker,** so "Download" is not real offline in a fresh tab.
- **Web `useReaderScrollSync` `ponytail:` ceiling** (#729): after an open the server has not answered, a layout shift above the reading line larger than 48 px reads as the reader moving, and the stale local place is saved.
- **ADR-019 owner questions** ([end of the ADR](01-architecture/adr/ADR-019-reader-position-rules.md#open-questions-owner)): after a TOC jump, should a newer same-chapter position from another device move the reader silently on mobile? Should web get the "read further on another device" toast?
- **Anchors:** web's anchor creator skips `.vocab-inline-translation` text, the phone's `getRangeAnchor` does not (only the PDF body fallback); the `mcp.json` anchor fixture is copied by hand from `SynthesizeAnchor`; an MCP highlight of a repeated quote lands on the first occurrence.
- **PDF:** highlights have no context and never will (PDF-rect anchors carry only `exact`); the mobile viewer measures against `innerHeight` including any strip RN chrome overlays.
- **A word tap can still dispatch two messages one character apart** (reader bridge tap plus Android `selectionchange`; suspected `WORD_RE` straight vs curly apostrophe). Measure both strings before changing anything.
- **Offline by default, not verified on a device:** the automatic Wi-Fi sweep fetching a library it does not hold, the 2 GB budget and its eviction order, the full-disk stop.
- **Mobile tests:** reader hooks have no tests of their own (wiring guards `readerR3Wiring.test.ts`, `readerR4Wiring.test.ts`); Lane A e2e is 17 tests in 6 specs that CI does not run (need a live backend), see [`MOBILE-TEST-PLAN.md`](qa/MOBILE-TEST-PLAN.md); `useBookLibrary` and #782/#783 review leftovers are cleanup, not bugs.
- **A new user is shown nothing that explains the app** (`onboarding/language` only asks the native language; guests are not asked). A guest can finish the loop, but nothing on Discover says so.
- **An abandoned guest upload is permanent disk:** `GuestCleanupWorker` preserves any guest holding an upload. Deliberately not solved until the real occupancy figure is known.
- **iOS Universal Links were never configured** (no `associatedDomains`, empty entitlements).
- **Login answers 500, not 401,** when a stored password hash is malformed (BCrypt throws in `AuthService`); only reachable with bad data.

**Data and product**
- **`BookInsight.Source` is a constant** (`"mcp"`, never updated on replace), and the Edition FK cascades: deleting a catalog edition hard-deletes every reader's insights about it.
- **Highlight "revisit" has no recall model:** `Highlight` carries only `LastReviewedAt` and a 24-hour cooldown; making it real needs new columns and an SRS path.
- **`ReviewCardDto.reviewMode` is a dead field** (no client reads it; `'context'` cannot reach the wire), and **`selfAssessment` is captured and discarded** (the three-button card sends it, no server code reads it).
- **`RetrievedCard` carries no review history,** so the tutor's grounded re-projection relies on the prompt rule alone.
- **`t()` has no plural rules;** `plural()` in `packages/shared` handles English one-vs-many in code.
- **Four QA accounts and their guest rows sit on production** (`qa-guest-{a,b,c,d}-20260906@textstack.app` plus abandoned guest rows holding vocabulary); the findings they were created for are closed, so they can go.

## Under discussion (no decision)

- **Where the parser runs:** server (today), on the device, or hybrid local-first (parse on the device for instant reading, server for sync and search).

## Deliberately not doing

Recorded so they stop being re-proposed:

- **Z-Library integration.** The legal public-domain alternative (Gutendex import) is planned instead: `~/.claude/plans/textstack-public-domain-discovery.md`.
- **Billing / Stripe / tier upgrade from the UI.** Tiers exist; monetization does not.
- **An admin console over `User`.** Staff is a config allowlist; the population is 1–3 people.
- **Mobile chunked upload.** RN cannot slice an opaque `file://`; the legacy endpoint stays.
- **A UserBooks/Editions shared abstraction** — assessed as false parallelism during the R1–R6 sweep.
- **Python anywhere.** Distillation is TorchSharp + a synthetic teacher.
- **Audiobooks.** A recurring per-book narration cost against a product whose thesis is reading; TTS already reads any selection aloud.
- **A bot that merges its own dependency updates.** A merge deploys production; an automatic update is safe exactly as far as its constraints are machine-checkable (`expo install --check` in CI, a fingerprint report on every PR), and the rest are why nothing merges itself.
- **Majors, applied automatically.** `deps-refresh.yml` raises patch and minor in the catalog and reports majors without touching them.
- **Two progress-path "fixes":** `LocatorKind` on the catalog path would refuse the mark-as-read sentinel it was meant to protect (catalog books have no second coordinate space). `MaxChapterNumber` has a reader again (`ChapterFrontier`, chapter review's spoiler gate), so its missing remap on re-ingest is a real defect, written up in [`assistant-handoff.md`](05-features/assistant-handoff.md#defects-found-along-the-way).
