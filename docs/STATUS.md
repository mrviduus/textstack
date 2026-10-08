# Status

**Last updated: 2026-10-08.** Where the project actually is — not what it does (that's
[`docs/README.md`](README.md)) and not what changed (that's [`CHANGELOG.md`](../CHANGELOG.md)).

If you read one page before picking work back up, read this one. It exists because the changelog
answers "what happened" and nothing answered "what is half-finished right now".

> **Keeping it honest:** update this file whenever something moves between the three lists below.
> A `/pr` that finishes a line here should delete or move that line in the same PR.

---

## Shipped and live

| Area | State |
|---|---|
| **Reader** (web + mobile) | EPUB + PDF. PDFs are original-first ([ADR-012](01-architecture/adr/ADR-012-pdf-original-first-lazy-parse.md)), page-based progress, highlights, TTS, vocabulary SRS. One chapter at a time on both clients since 2026-10-03 (#683 dropped mobile infinite scroll for an end-of-chapter block: Next, Discuss, previous). The free dictionary (api.dictionaryapi.dev) is gone (2026-10-03, #685); on web, a same-language word tap shows the contextual Explain instead (`lib/wordBubbleFetch.ts`). **Reader bug hunt R1 + R2 done 2026-10-05** (#713–#719): last scroll saved, Next → Prev keeps the place, PDF no longer drifts a page per open, no ghost highlights, font change keeps the place, mobile restore never waits on the network; re-ingest keeps readers' data ([ADR-018](01-architecture/adr/ADR-018-reingest-updates-chapters-in-place.md)). [Write-up](changelog-archive/2026-H2.md#2026-10-05-reader-bug-hunt-r1-r2). **R3 + R4 done 2026-10-06** (#723–#731): the 47-finding list is closed except `/storage` capability URLs — guest merge keeps uploads, offline bookmark queue on web, WebView crash recovery and Back closes the toolbar on mobile, custom typography no longer reopens at the top, web PDF no longer saves page 1 before the resume jump, progress GETs time out at 3 s; position logic follows [ADR-019](01-architecture/adr/ADR-019-reader-position-rules.md) (shared rules, not one state machine); phone and web highlight anchors are pinned by cross-app fixtures; mobile `ReaderShell.tsx` split 1689 → 617 lines. Write-ups: [R3](changelog-archive/2026-H2.md#2026-10-06-reader-bug-hunt-r3), [R4 + ADR-019](changelog-archive/2026-H2.md#2026-10-06-reader-r4-and-adr-019), [anchors](changelog-archive/2026-H2.md#2026-10-06-cross-app-anchors), [split](changelog-archive/2026-H2.md#2026-10-06-reader-shell-split). Device checks are still owed — see In flight. |
| **Sync** | Progress last-write-wins compares the client clock only with itself, catalog and uploads (`client_updated_at`, #695/#710); offline highlights replay with a three-way merge (#694/#708/#709); reading sessions queued on both clients. [Write-up](changelog-archive/2026-H2.md#2026-10-05-sync-correctness). |
| **Security & ops** | All P0/P1 items of the [architecture review 2026-10](01-architecture/review-2026-10/00-summary.md) fixed 2026-10-04/05 (#690–#704): sandboxed stored files, `/internal` closed at nginx, hashed refresh tokens + token audiences, EPUB limits, real `/api/health` check, disk alarm, SSG rebuild nightly instead of per deploy. [Write-up](changelog-archive/2026-H2.md#2026-10-05-security-ops-hardening). Since 2026-10-07 `/me` and `/internal` fail closed by path like `/admin` ([ADR-024](01-architecture/adr/ADR-024-auth-fails-closed-by-path.md) PR 0+1); every ungated route is listed in `tests/TextStack.UnitTests/Routes/routes.public.txt`, which a new public route must update. [Write-up](changelog-archive/2026-H2.md#2026-10-07-auth-fails-closed-by-path). |
| **Backups** | Nightly off-site copy to Cloudflare R2 (restic, encrypted, deduplicated, 9 GB guard; #696/#700) and a monthly restore drill on a clean runner (#703; first run passed: DB 206 s, files 37 s). [`backup.md`](03-ops/backup.md). |
| **AI platform** | Translate (OpenAI `gpt-4.1-nano`), Explain and upload enrichment (`gpt-4.1-mini`; enrichment = `bookmeta.agent` → `openai-explain`, sends title, author and the first 600 characters of chapter one, plus Open Library lookups); vocabulary distractors, the old book-metadata fallback path and tag suggestions (Ollama 0.35.1 since 2026-10-05, local, $0; prompts name the reader's language, not its code — [#711/#712](changelog-archive/2026-H2.md#2026-10-05-local-llm-quality)); the SEO publishing crews; the Tutor study planner. Traces, model registry, shadow routing and drift detection still govern those. **The reader-facing chat surfaces were deleted 2026-09-10** — the conversation now happens in the reader's own assistant (next row). |
| **Assistant handoff (MCP)** | 21 tools (`backend/src/Contracts/Mcp/McpManifest.cs`) over stdio + streamable HTTP. The conversation happens in the reader's own Claude or ChatGPT; conclusions come back as `BookInsight`. Connect by OAuth sign-in (2026-09-30, [ADR-017](01-architecture/adr/ADR-017-mcp-oauth-authorization-server.md)), or a connect key / personal URL for ChatGPT. Chapter review ([ADR-016](01-architecture/adr/ADR-016-chapter-review-lives-in-book-insight.md), [`chapter-review.md`](05-features/chapter-review.md)) shipped end to end 2026-09-29 → 10-01: MCP tools, Review/summary pages, reader badges, Chapter questions on Practice, one Discuss button. Vocabulary write tools (add/update/delete) 2026-10-04. [`assistant-handoff.md`](05-features/assistant-handoff.md), [`mcp.md`](05-features/mcp.md). |
| **Observability** | Sentry on API, Worker, MCP server and ssg-worker (one project, `service` tag), API request + LLM/provider-routing spans; OpenTelemetry → Aspire locally only (no OTLP endpoint in prod, so no metrics there — [delivery.md](01-architecture/delivery.md#observability)). Mobile Sentry is **armed** since 2026-09-03 — project `textstack-mobile` in the `textstack` org, DSN supplied as an EAS environment variable (`EXPO_PUBLIC_SENTRY_DSN`, production + preview) rather than a repo file, so it reaches OTA bundles as well as store builds. |
| **Entitlements** | `UserTier { Guest, Free, Supporter, Staff }`, config-driven quotas — now including `AiEnabled` and `DailyEnrichmentCap`, enforced server-side by `RequireAiAccount()` (403 `account_required`). |
| **Guest sessions** | Web and mobile both mint an anonymous `User` row on demand; the read → save → review loop works with no account, and registering promotes that row in place. [ADR-014](01-architecture/adr/ADR-014-guest-sessions.md). Walked end to end on Android on 2026-09-06 with every request logged ([QA-005 report](qa/reports/2026-09-06-android-guest-loop.md)): promotion-in-place proven by the account's `createdAt` matching the guest mint, both AI walls firing zero requests, and the book still opening when the mint is rate-limited. Since 2026-10-03 (#681) a guest has an obvious path to an account (profile card, web menu), and conversion is countable: `User.PromotedAt` plus `guest_promoted` / `guest_merged` log lines. |
| **SEO / SSG** | Prerendered pages, sitemap, IndexNow. Four incidents since 2026-08-11 ([dead five weeks](incidents/2026-08-11-ssg-dead-five-weeks.md), [deploy wiped a running rebuild](incidents/2026-08-31-deploy-wiped-a-running-ssg-rebuild.md), [worker lost its output path](incidents/2026-09-01-ssg-worker-lost-its-output-path.md), [a prompt stranded the swap](incidents/2026-09-02-corepack-prompt-stranded-the-ssg.md)), each invisible from outside because humans get the SPA and it renders fine. Now watched three ways: the worker refuses to promote a rebuild that lost its files, `/health/ready` reports rebuild age and failure, and the health check asks a crawler's question every five minutes. Since 2026-10-07 ([write-up](changelog-archive/2026-H2.md#2026-10-07-ssg-worker-robustness)): a hung rebuild ends `Failed` after 5 min without a rendered route (`SSG_JOB_STALL_MS`; cap max(60 min, 2 s per route), `SSG_JOB_DEADLINE_MS`); a page whose API calls failed is never saved, and that route keeps its live page; a build with more than 10 % failures is refused; a DB restart no longer crashes the worker. |
| **Mobile** | Android on Play Internal + Closed testing (`versionCode 28`, 2026-09-27). Expo SDK 57 / RN 0.86 since 2026-09-28. OTA via `expo-updates` on merge; when the runtime fingerprint has moved an update cannot reach anyone, so the same workflow builds and submits to Internal instead. **Offline by default** (2026-09-27/28): the reader's own uploaded file is stored on the device (`originalFileCache.ts`, 2 GB LRU), the library downloads itself on Wi-Fi, the shelf shows each book's state, chapter loaders read the device before the network, and an account is for sync, quota and wiping private files at sign-out — not for reading. |
| **Delivery** | Build once on GitHub, deploy by digest ([ADR-020](01-architecture/adr/ADR-020-build-once-deploy-by-digest.md), [`delivery.md`](01-architecture/delivery.md)): images secret-scanned before the push, pulled `name@digest`; the web `dist` too since 2026-10-07 — built and canary-scanned on GitHub (`textstack-web` image), scanned again with the server's real values and swapped in file by file before anything is live, no npm on the server unless the pull fails; OTA bundle scanned; actions SHA-pinned, pulled images digest-pinned (Dependabot moves both); read-only workflow tokens; rollback must be on main; mobile/extension merges skip the server; pre-deploy dump after the SSG wait, before anything live changes; GHCR pruned weekly (`ghcr-retention.yml`; the first real delete with `GITHUB_TOKEN` is unproven until the first scheduled run). Next: slim Dockerfiles (in flight), then drop *Free disk space*. |
| **Build & deps** | One Node version in `.nvmrc` (24.20.0), enforced across CI, four Dockerfiles and the deploy runner. One pnpm workspace with a version catalog — the JS answer to `Directory.Packages.props`. Weekly dependency refresh by pull request. |
| **Catalog** | Discover/home show a curated **Popular** shelf (2026-10-03, #680): order is `Edition.FeaturedRank`, set in admin or by `make featured` (`PUT /internal/featured`, whole-shelf replace; crawlers see the new order after the nightly SSG rebuild). `/books` defaults to Popular; `sort=recent` keeps newest-first. |
| **Codebase** | Refactor + perf sweep 2026-10-01/02 (#661–#678): dead code out on backend, web and mobile; `search_documents` and the Meilisearch provider dropped (search is Postgres FTS over `chapters` only); web runs `@textstack/shared`'s api client in cookie mode, so one `authFetch` serves both apps; shared pure logic moved to `packages/shared`; fewer requests and DB round trips on hot paths; one reading-time rule (own pace at ≥3 sessions, else 200 wpm). No behaviour change intended. |

## In flight

> **Focus (owner, 2026-10-08): no new side work.** Order:
> 1. ~~Finish what is running: #770 and #771~~ — both merged 2026-10-08.
> 2. **Reader engine** — decided 2026-10-08: separate package `packages/reader-engine`, strangler
>    migration behind flags, no iframe, scroll only, reflow then PDF. Phase 0 #774 merged; Phase 1: [ADR-025](01-architecture/adr/ADR-025-reader-engine-package.md)
>    accepted, `packages/reader-engine` = API types + stored-shape mappers (test-first). Android spike
>    done: 8/8 pass ([results](01-architecture/adr/ADR-025-reader-engine-package.md#android-spike-results-phase-1b-2026-10-08)). Next: Phase 2 after launch. Production engine
>    code only after Play launch. Owner runs [QA-007](qa/scenarios/QA-007-reader-android-r1-r4.md).
> 3. Later, in 2–3 bundled PRs while reader work waits on something: the rest of
>    [review 2026-10](01-architecture/review-2026-10/00-summary.md) (#19 admin roles/audit, #20 book models,
>    #21 LLM jobs on the owner's Claude login, #24 web `api/` duplicate, #25 two SEO engines, #26 GDPR traces,
>    #31 ADR numbering, #32 housekeeping) and the ADR-022/023/024 remainder (`/storage` originals move,
>    delete the book quality queue, reconciler enrichment).
>
> Anything new goes into **Known-broken** below and is not started, unless it is a production outage or a
> security problem.

- **Reader — after R4.** ~~Reader bug hunt R3 — next~~: R3 and R4 shipped 2026-10-06 (#723–#731).
  Next: **split web `ReaderPage.tsx` (~900 lines) / `ReaderHighlights.tsx` (661) by job**, the way
  #731 split mobile `ReaderShell.tsx`; ~~then an e2e reader smoke~~ — blocking `@reader-smoke` has 7 tests (2026-10-08); PDF reopen
  waits for a CI PDF fixture (engine Phase 2). **Every R1–R4 mobile fix is unit-tested only — the owner's phone checklist
  (Android first) is still owed**, after the OTA that carries #723/#728/#730/#731.
- **Delivery — owner steps after ADR-020.** Repo settings: require actions pinned to a full SHA,
  allowed actions = GitHub + verified + listed, turn off "Actions can approve PRs", delete the unused
  `CLAUDE_CODE_OAUTH_TOKEN` secret, enable non-provider secret patterns. Then measure an `images` run
  after the slim Dockerfiles and delete *Free disk space* if the room is there.
- **Play Store → production application around 2026-10-16** — see the Play Store entry below.

- **Owner-only checks left from the assistant handoff** — that the mobile Claude and ChatGPT apps
  accept a custom connector at all, and one live end-to-end conversation on a phone. The code is
  shipped (see Shipped → Assistant handoff); the destructive migrations `DropBookChat` /
  `DropRagSpine` merged 2026-09-10, so the `migrator` service has applied them on deploy.

- **Chunked upload** — 1 of 8 steps done (tiers, PR #449). Files over ~100 MB still fail at
  Cloudflare's per-request body cap with a bare `Upload failed: 413`. Plan:
  `~/.claude/plans/claude-code-task-shimmering-brook.md`.
- **Play Store → production** — needs 12 testers × 14 days on the closed track. Owner's note,
  2026-10-02: 12 of 12 testers reached and the 14-day clock started, so the production application
  can go in around 2026-10-16 (not verifiable from the repo). Code-side gates are done: submit profile,
  permission hygiene + guard, honest privacy policy and Data Safety answers, delete-account
  instructions per platform, and a runbook at [`docs/03-ops/play-store-release.md`](03-ops/play-store-release.md).
  Builds have used a fingerprint runtime since build 22, so they no longer share `1.0.0`.

  **Build 27** (`versionCode 27`, 2026-09-11, commit `50a1a987`) went
  to both Internal and Closed testing that day. It was built from a laptop rather than through
  `mobile-release.yml`, which is why the workflow's run history shows only one successful release —
  worth knowing before reading that history as the record of what testers hold. Note what build 27
  predates: **offline reading (#612, 2026-09-14) is in none of these builds.** It added `expo-sharing`,
  which moved the fingerprint, so the OTA correctly refused on the night it merged and the feature sat
  undelivered for twelve days. Fixed two ways on 2026-09-27: build 28 was dispatched, and a refusal now
  starts a build instead of only reporting one is needed.

  **Build 24** (`versionCode 24`, 2026-09-02) carried the selection-speech fixes (#509). It exists because the pnpm workspace migration moved the runtime fingerprint — 122 of
  135 fingerprint sources now resolve through the workspace root — so the OTA that had been verified
  working an hour earlier could no longer reach the installed build. The six-step checklist in
  [`docs/qa/reports/2026-09-01-android-tts-selection.md`](qa/reports/2026-09-01-android-tts-selection.md)
  passes on the owner's own phone against this build (2026-09-02). **It has still not been run on the
  reporter's Galaxy S24**, which is not the same input stack.

  Build 22 was the first build whose runtime is a fingerprint rather than the shared `1.0.0`. A manual pass against build 21 found 24 defects —
  [`docs/qa/reports/2026-08-26-android-manual-pass.md`](qa/reports/2026-08-26-android-manual-pass.md).
  23 are fixed (#458-#468); the one that is not is **P2-5**, a notification permission dialog that
  no code path in the app can produce — the only `requestPermissionsAsync` is behind a toggle that
  was Off, and `targetSdkVersion: 36` rules out Android's automatic prompt. Reproduce it on an
  emulator with `adb logcat` before changing anything.

  Not yet verified on a device: the reader chrome work (#463, #467) touches the main reading path,
  and "the bars toggle and the page does not move" is a claim only a phone can settle.
- **Article** — Sentry write-up, draft on vasyl.blog; needs edits, image, publish, then a DEV cross-post.

## Known-broken / open follow-ups

- **First-run sells a language app; two-audience onboarding is planned, not started** (2026-10-08).
  The mobile card says "Learn a language by reading real books" and opens Alice. The owner decided on two
  first-run audiences ("I work in tech" / "I'm learning English"), each with its own starter text and
  Popular shelf. Content is ready: 10 CC BY arXiv AI papers are live. **Deferred until after Play
  production approval (~2026-10-16)**: testers already passed first-run, so they would not see it, and a
  mobile merge is an OTA. Plan and open questions: [`marketing/onboarding-consilium-2026-10-08.md`](marketing/onboarding-consilium-2026-10-08.md).
  Prod nit: those 10 editions have their abstract inside "About this edition".

- ~~**A deploy fails the upload being processed** (found 2026-10-07, ADR-022). The Worker restarts on
  every push; the cancelled extraction lands in the generic `catch` and the book is marked `Failed`,
  "corrupted or password-protected" (`UserIngestionService.cs:393-405`; catalog
  `Worker/Services/IngestionService.cs:305-338`). Fix: cancellation → `Queued` — ADR-022 PR 1.~~
  **Fixed 2026-10-07** (ADR-022 PR 1, #769): both ingestion catches and
  enrichment give the claim back on a graceful stop (`ShutdownRequeueTests`); the inline enrichment
  kick is gone. Not yet watched through a real deploy: check the next deploy's Worker log for
  "interrupted by shutdown; returned to queue" and that no upload ends `Failed` around it.
- **Interrupted ingestion can leave orphan image files** (found 2026-10-07, #769 review). Both
  ingestion paths write image files before the rows that reference them commit. A run stopped in
  between leaves files with no row, and the rerun writes them again under new ids. This is disk
  only: nothing references the old files. Fix: write images under a deterministic name (hash of
  edition + original path), or sweep `assets/` against `book_assets` / chapter HTML.
- ~~**SSG rebuild after an admin edit or publish may be silently skipped** (found 2026-10-07, ADR-023).
  Eight un-awaited enqueues use the request's scoped `DbContext` after the request (`AdminEndpoints.cs:438,513,579`,
  `AdminGenresEndpoints.cs:298`, `AdminAuthorsEndpoints.cs:346`, `AdminService.Editions.cs:268-270,322,343`)
  behind an empty `catch`. A job left `Queued` blocks every later identical enqueue through the duplicate
  check. Fix: await + log — ADR-023 PR 1.~~ **Resolved 2026-10-08 by deletion**
  ([write-up](changelog-archive/2026-H2.md#2026-10-08-ssg-one-consumer)). Prod had zero `Specific` jobs
  ever (112 Full in 30 days), so no edit ever queued a rebuild. Owner chose to remove the per-edit path
  rather than repair it: ssg-worker renders every route whatever the mode (~20 min, ~2000 IndexNow URLs
  per job). The nightly Full rebuild is the only automatic trigger; an edit reaches crawlers after it,
  or at once with the admin "New Rebuild" button / `make rebuild-ssg`.
- ~~**`Incremental` SSG mode is a full render** (2026-10-08). The admin form still offers it; the route
  provider and ssg-worker treat it exactly like Full. Remove it, or make it mean something.~~ **Removed
  2026-10-08** (#771): Full is the only mode. Prod had only Full rows (11,640, read-only check); the
  column's converter reads any legacy string as Full (`SsgRebuildModeMappingTests`).
- **Unverified: does ssg-worker's `Host` header reach the API?** (2026-10-08). In a local run, Node's
  `fetch` to `http://127.0.0.1:<port>` with `headers: { host: 'localhost' }` got a 400 from Kestrel,
  while `http://localhost:<port>` worked, so `fetch` may send the URL's host, not ours. Prod Full jobs
  complete (`API_URL=http://api:8080`), so it works there; whether by the header or because the API
  resolves `api` is not checked.
- **Cancelling a Running SSG job does not stop it** (found 2026-10-08). `CancelJobAsync` sets
  `Cancelled`, but ssg-worker never re-reads the row and its final `setJobStatus` overwrites it with
  `Completed`/`Failed`.
- **Vocabulary words promoted by the hourly reconciler are never enriched** (found 2026-10-07, ADR-023):
  `DailyCapService.ReconcileUserAsync` does not call `QueueEnrichment`. Fix: enrichment moves into an Application service; the reconciler awaits it word by word (owner, 2026-10-07).
- **Uploaded originals are readable by URL without auth** (`/storage`, ADR-024). Fix: originals move behind `/me/books/{id}/file`; covers and chapter images only after they get an authenticated route (owner, 2026-10-07).
- **`/internal` trusts a forwarded address from the home LAN** (ADR-024). The gate is now one check
  (`PathGates`), but `ForwardedHeaders` trusts `X-Forwarded-For` from 192.168/16, so a LAN client can
  claim a docker address. nginx refuses `/api/internal/` from outside, so it is LAN-only. Fix: a
  shared-secret header for the pollers, ssg-worker and `backup.yml` — ADR-024 step 3, after #19.
- **Six user routes live outside `/me`** and still rely on their handler's check (ADR-024): `GET /auth/me`,
  `POST /auth/device/approve|deny`, `POST /oauth/authorize/approve|deny`, `GET /oauth/token-status`.
  Listed in `routes.public.txt` and in the `PathGates` comment; no plan to move them.
- **Mobile OTA targets one runtime only** (2026-10-07, #762). `mobile-ota.yml` publishes to the
  runtime of the newest *finished* production build. Once the production track runs an older build
  than Closed testing, production stops receiving OTAs. **Fix before the second store release.**
  [Runbook](03-ops/play-store-release.md#known-limits-of-the-automatic-ota).
- ~~**Reader bug hunt — R3 open list** (2026-10-05).~~ **Closed 2026-10-06** by #723 (mobile), #724
  (data), #725 (web) — [write-up](changelog-archive/2026-H2.md#2026-10-06-reader-bug-hunt-r3). The
  hunt ran on `d92e83aa`; R1/R2 had fixed web C1–C3, H1–H4, M1, M4; mobile C1, C2, H1–H3, M1, M2, M9,
  L3; data C1, H1, M2, M3, M4, L3, L5.
  - ~~*Web:* M2 search counts, M3 removed pending vocab word synced at guest mint, L1 TTS keeps
    speaking, L2 "finished book" unreachable, L3 search index not reset, L4 offline bookmark delete
    comes back~~ — #725. ~~L5 non-GUID bookmark chapter id → 500~~ — #724 (`BadHttpRequestException`
    → 400 in `ExceptionMiddleware`).
  - ~~*Mobile:* M3 Back closes the book, M4 3 s blank per chapter offline, M5 upload TTS/translate in
    app language, M6 no WebView crash recovery, M7 PDF page input under keyboard, M8 inflated session
    words, L1 font rebuild by %, L2 partial heartbeat dropped, L4 silent PDF 401, L5 clock trust~~ —
    #723.
  - ~~*Data:* M1 guest merge drops a slug-conflicting upload, L1 unclamped local stamp, L2 non-atomic
    highlight version check, L4 unvalidated writes → 500, L6 streaks in UTC~~ — #724. **Still open:**
    `/storage` serves uploads publicly by GUID path (a capability URL).
  - ~~*Deferred from R2:* offline bookmark queue; `editionId:slug` pending highlight ids; upload
    bookmarks offline; `VocabOverlayLayer` re-map~~ — #725 (the last one already worked; regression
    test added).
  - ~~*Re-ingest (ADR-018 limits):* chapter delete / merge don't rewrite slug locators;
    `MaxChapterNumber` not remapped~~ — #724, ADR-018 updated.
  - *Size:* ~~mobile `ReaderShell.tsx` 1593 lines~~ — split to 617 by #731. Web `ReaderPage.tsx` and
    `ReaderHighlights.tsx` are next (In flight). `readerHtml.ts` (1576, JS in a string, untyped) and
    `readerBridge.ts` (625) belong to the reader-engine work.
  - *Coverage:* still open — see the list below.

- **Reader — open after R3/R4** (2026-10-06):
  - **QA-007 findings 2026-10-08** ([report](qa/reports/2026-10-08-reader-android.md)), not started:
    ~~PDF reopens one page back~~ (fixed #778, web had it too); guest Library empty online after a
    download without "Save to Library"; ~~Books genre chips stretch tall and search "1984" → "No books
    found"~~ (fixed #779: the Books screen's default genre was `'popular'`, a sort, so the list was
    always empty — not a search bug); Library "Continue" opens book detail, not the reader; native selection handles stay after
    highlighting; ~~a wrong pt-BR translation ("pocketed → enterrado")~~ (#780: mobile never sent the
    sentence with a word tap; nano vs mini eval built, run pending); ~~PDF detail "~33 pages" for 15~~
    (#780: real page count, stored at ingestion; PDFs uploaded before it still show the estimate until retried);
    dev build toasts "injectJs failed: markVocabWords is …" in both PDF and text readers (RN injects
    vocab into a document that has no such function yet, or none at all for PDF) — check whether vocab
    marks can miss on first paint.
  - **PDF current page (review of #778), minor:** the mobile viewer measures against `innerHeight`,
    which includes any strip RN chrome overlays; and the saved page (`readingPage`) and the zoom/re-fit
    anchor (`pageAtViewportTop`) are two different notions on purpose — anything new needing "the
    current page" should use `readingPage`. Engine Phase 5 (PDF as the `fixed` layout) owns both.
  - **Login answers 500, not 401, when a stored password hash is malformed** (BCrypt throws in
    `AuthService` login). Only reachable with bad data; found 2026-10-08 after a hand-edited hash.
  - **Mobile legacy `<mark>` vocab path, for engine Phase 2/6** (old WebViews without CSS Highlights
    only; no test phone has one): a highlight over a word with an inline translation also paints the
    floating label; `vhlLegacyMark` rewrites text nodes, which moves live highlight ranges' boundaries;
    nothing redraws highlights after marking. A per-consumer wrapper (#776, closed unmerged) was inert
    on chapter load and could crash on a collapsed range. Root fix: one text-only measurement inside the
    overlay (Phase 2); the legacy path is deleted in Phase 6. The "fuzzy match paints `exact.length`"
    item was not a bug: the resolver's fuzzy window is `exact.length` wide by design.
  - **Mobile reader hooks have no tests of their own.** Fixes are tested through pure modules
    extracted from them and source-text wiring guards (`readerR3Wiring.test.ts`,
    `readerR4Wiring.test.ts`). A small hooks harness would let a test drive the real hook.
  - **Web has no service worker**, so "Download" is not real offline in a fresh tab.
  - **ADR-019 owner questions** ([end of the ADR](01-architecture/adr/ADR-019-reader-position-rules.md#open-questions-owner)):
    after a TOC jump, a newer same-chapter position from another device moves the reader silently on
    mobile — keep that or ask? And should web get the "read further on another device" toast?
  - **Web R4 `ponytail:` ceiling** (`apps/web/src/hooks/useReaderScrollSync.ts`, #729): after an open the server has not
    answered, a layout shift above the reading line larger than 48 px (a late image) reads as the
    reader moving, and the stale local place is saved. Upgrade path: the late server answer ends the
    held open.
  - **Vocab inline-translation text in anchors differs.** Web's anchor creator skips
    `.vocab-inline-translation` and `[data-vocab-overlay]` text (`EXCLUDE_SELECTOR` in
    `apps/web/src/lib/textAnchor.ts`); the phone's `getRangeAnchor` (`readerBridge.ts`) does not.
    Since #730 the phone cuts context from the chapter element and its overlay sits outside it, so this
    only matters for the body fallback (PDF viewer). No fixture covers it.
  - **`mcp.json` anchor fixture is copied by hand** from `SynthesizeAnchor`
    (`McpToolCatalog.cs`); a change to the C# will not regenerate it, so the fixture can drift.
  - **An MCP highlight of a repeated quote lands on the first occurrence.** `SynthesizeAnchor` writes
    no prefix/suffix, so the resolver cannot tell the copies apart. Pinned as a known limit in the
    cross-app fixtures.

- **GitHub scheduled backups run hours late.** `backup.yml` is cron `0 3 * * *` (3 AM UTC); on
  2026-10-05 the scheduled run started at **10:12 UTC**. GitHub queues `schedule` events under load and
  gives no start-time promise, so the nightly backup (and the full SSG rebuild after it) can drift into
  the day. Consider triggering it from the server's own cron (`gh workflow run backup.yml`), keeping
  the GitHub schedule as a fallback.

- **Architecture review 2026-10 — open P2 items** ([summary](01-architecture/review-2026-10/00-summary.md)):
  #15 one claim rule for the 11 polled queues (only the catalog retry cap is fixed, #706/#707); #16
  background services inside the API, vocab enrichment fire-and-forget; ~~#17 migrations run twice~~ —
  done 2026-10-07 ([ADR-021](01-architecture/adr/ADR-021-migrations-owned-by-the-migrator.md): only the
  migrator migrates; a schema behind the build → `/health/ready` 503; rollback is
  `docker compose run --rm -e MIGRATE_TARGET=<name> migrator`); #18 auth is opt-in per
  endpoint (group-level filter); #19 admin roles unchecked, no audit log, admin API reachable on the
  public host; #20 one `BookRef` rule for new code (the collection-orphan part is fixed, #706); ~~#22 no
  metrics in prod, no Sentry on ssg-worker / mcp-server~~ — done 2026-10-07 (OTLP off unless
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set; Sentry on both, same DSN, `service` tag; a hosted metrics
  backend is the owner's call — [delivery.md](01-architecture/delivery.md#observability)); ~~#23 the server cannot tell which mobile app
  version calls~~ — done 2026-10-06 (`X-App-Version`/`X-App-Build` in log scope, trace, Sentry tag;
  `GET /app/config` serves `Mobile:MinSupportedBuild` (Android versionCode, env
  `MOBILE_MIN_SUPPORTED_BUILD`), app shows a blocking update screen below it); #24 web's own `api/` beside the shared client; #25 two SEO engines;
  #26 GDPR delete leaves LLM trace text, caches, backups. Also open from #707:
  `claude-isolated.sh` under `env -i` is untested (needs a try on the server).

- **Parts of offline-by-default are not verified on a device.** The 2026-09-28 device pass (Pixel 7
  Pro emulator, production, airplane mode) covered download, restart, offline open and Save a copy.
  Not covered: the automatic Wi-Fi sweep fetching a library it does not already hold, the 2 GB budget
  and its eviction order, and the full-disk stop.

- ~~**Five web modules and one stylesheet have no importers.**~~ Deleted 2026-09-10 —
  `lib/fuzzyMatch.ts`, `lib/wordAtPoint.ts`, `hooks/useOfflineDownload.ts`, `hooks/useSwipe.ts`,
  `hooks/useVocabLevel.ts`, `styles/native-language-picker.css`. The hook inventory in `CLAUDE.md`
  listed three of them as live and no longer does.

- **Two progress-path defects are deliberately not being fixed**, and the reasons are worth reading
  before someone "fixes" them: `LocatorKind` on the catalog path would refuse the mark-as-read
  sentinel it was meant to protect (catalog books have no second coordinate space at all), and
  ~~`MaxChapterNumber` now has no reader — its only one was the deleted RAG spoiler gate~~ — stale:
  `ChapterFrontier` (chapter review's spoiler gate, `Application/ChapterReview/ChapterFrontier.cs`)
  reads it again, which is why its missing remap on re-ingest is now a real defect (below). Both are
  written up in [`assistant-handoff.md`](05-features/assistant-handoff.md#defects-found-along-the-way).

- **`BookInsight.Source` is a constant, and the Edition FK cascades.** `Source` is hardcoded `"mcp"`
  at save and never updated on replace, so it cannot yet be used to scope anything (a future
  assistant-side delete would scope on exactly it). And `OnDelete(Cascade)` on the Edition FK means
  deleting one catalog edition hard-deletes every reader's insights about it — low risk today, but
  destruction of user content from an admin action.

Each of these is a real defect that is *known and not yet fixed*. They live here rather than in
someone's memory.

- ~~**Eleven mobile surfaces have never been tested.**~~ Closed 2026-08-27: the third pass
  ([report](qa/reports/2026-08-27-android-untested-surfaces.md)) walked all eleven. Five clean
  (bookmarks, the vocabulary review session, account deletion, resume after >30 min backgrounded,
  the custom `textstack://` scheme), two broken, four working with defects — nine findings, all
  fixed in #480-#486. Three of the nine were diagnosed differently on re-verification than in the
  report, and the corrections changed the work: `ch.0` was a genuine 0-based ordinal rather than a
  null leaking through; highlight context was already stored in the anchor and only dropped by two
  DTO projections, so it came back retroactively with no migration; and the third-person AI prose
  was a prompt defect, not a screen defect.
- **Mobile Lane A e2e is still the spec, not a suite.** `docs/qa/MOBILE-TEST-PLAN.md` describes it;
  17 tests in 6 specs exist (`apps/mobile/e2e/tests/`), and CI does not run them because they need a live
  backend. Every fix from the QA sweep shipped with pure unit tests instead.
- **Highlight "revisit" has no recall model.** `Highlight` carries only `LastReviewedAt`, and the queue
  is a 24-hour cooldown — no interval, no schedule, no review log, and no field on the request a grade
  could arrive in. The screen is a page-turner and now says so rather than calling itself review.
  Making it real means new columns and an SRS path of its own; deliberately not done for launch.
- **PDF highlights have no context and never will.** Reflow highlights store ~30 characters either side
  in their anchor, so they gained context retroactively. A PDF-rect anchor carries only `exact`; those
  render as the passage alone. Capturing surrounding text at PDF-highlight time is the open follow-up.
- **A word tap can still dispatch two messages one character apart.** The reader bridge sends the tap
  and Android's own `selectionchange`; the exact-match dedupe only collapses identical strings, and
  the single-flight added in #561 keys on the text, so a pair differing by one character is still two
  translations. Suspected cause: `WORD_RE` carries a straight apostrophe while extraction writes curly
  ones — but the obvious guard re-breaks drag-to-extend, fixed directly above it. Measure both
  dispatched strings before changing anything.
- **`ReviewCardDto.reviewMode` is a dead field.** No client reads it, and one of its two declared
  values (`'context'`) cannot reach the wire — `ReviewCardBuilder` rewrites every context card to
  `multiple_choice`. Same shape as `selfAssessment` below. Documented on the field in
  `packages/shared/src/types/api.ts`; removing it touches two DTO copies plus the server contract and
  needs its own slice.
- **Four QA accounts and their guest rows sit on production** — `qa-guest-{a,b,c,d}-20260906@textstack.app`,
  created during the QA-005 pass, plus several abandoned guest rows that `GuestCleanupWorker` will not
  prune because they hold vocabulary. The findings they were created for are closed (#561, #562), so
  they can go.
- **`selfAssessment` is captured and discarded.** The three-button card ("Forgot / Almost / Knew") sends
  the choice, `SubmitReviewRequest` accepts it, and no server code reads it — so "Almost" differs from
  "Knew" only in the boolean derived from it. Either make the middle button mean something, or drop it.
- **`t()` has no plural rules, so plurals cannot be translated.** Web `t()` interpolates `{{var}}`, the
  shared `t()` takes no parameters, and neither picks a form by count. `plural()` in `packages/shared`
  handles English one-vs-many in code; count strings in `en.json` stay hard-plural.
- **iOS Universal Links were never configured.** No `associatedDomains` in `app.json`, empty
  entitlements — the iOS half of this work does not exist yet, on either side.
- ~~**Agent tools still describe themselves more strongly than their payloads support.**~~ Moot
  2026-10-01 — every tool named below is deleted (`find_earlier_definition`, `get_example_sentence`,
  `search_library_semantic` with RAG on 2026-09-10; `LibraryToolShared`, `get_user_vocabulary` in the
  backend dead-code sweep, no agent offered them). An audit of all
  eleven found the same shape as the "you keep missing this word" incident in several more places, and
  three were fixed (history claims, invisible row truncation, chapter numbering). Left, in order of
  how badly each could mislead a reader: `find_earlier_definition` asserts a term was "first introduced"
  in the earliest of eight semantic candidates and, when the spoiler gate hides the real one, states
  the book does not discuss it at all; `get_example_sentence` returns the top RAG chunk without
  checking the word appears in it, under a description promising "a real example sentence";
  `search_library_semantic` degrades silently to keyword search with no field saying so, while its
  description promises meaning-based matching; `LibraryToolShared` surfaces the derived `approxPages`
  where a real page count would go and drops the always-null `pages`, so "312 pages" is shown for a
  book whose length is not stored; `get_user_vocabulary` does not filter retired words and describes
  all of them as "terms the user is already learning". The pattern is consistent: the description
  string is one notch stronger than the projection, and no prompt fix reaches a claim made in a tool
  description.
- **`RetrievedCard` carries no review history**, so the tutor's grounded re-projection cannot re-assert
  what the tools now send — the prompt rule is the only thing enforcing it.
- **SSG stall detection ignores first-pass failures.** A rebuild is stopped when no route has
  rendered (or been skipped as noindex) for 5 min (`SSG_JOB_STALL_MS`); in the retry pass every
  attempt counts. Failures do not count in the first pass, because a hung API still "completes" each
  route as a 30 s navigation timeout. The cost: a good build whose first pass hits ~5 min of
  consecutive failures (~160 routes in a row) is stopped. A job that keeps moving can run past the
  deploy's 40-min SSG wait, up to max(60 min, 2 s per route); the deploy then goes ahead as before, and
  the survival floor refuses a build it wiped.
- **SSG treats any failed API call as a failed page.** That includes secondary calls the app hides
  when they fail (an author's "other authors"). Such a page keeps its previous version rather than
  shipping without those links. The cost: one endpoint that is broken on every page fails every
  rebuild until it is fixed. That is loud (`Failed` jobs, Sentry), not silent.
- **Soft-404s to crawlers.** The catch-all nginx `location /` returns 200 for non-SSG paths; the bot-404
  guard exists only in `@spa`.
- **Dead nginx block.** `location /ssg/` aliases a directory that does not exist; the real pages come
  from `apps/web/dist/ssg`, and the block's comment claims it is required.
- **`X-SEO-Render` lies.** It is set from `map $is_bot`, so it reports "you look like a bot", not "SSG
  was served". It cost real debugging time during the SSG incident.
- **`.env.bak*` on the server** — three untracked backups holding live secrets.
- **The server's `node_modules` does not match the lockfile.** Its web build shipped react 19.2.6 and
  DOMPurify 3.4.3 (live bundle, 2026-10-07) against a lockfile of 19.2.3 / 3.4.16. Normal deploys no
  longer build there (the bundle comes from GitHub), but the fallback still would: delete the
  server's `node_modules` (root and `apps/*/node_modules`) once, by hand.
- **One permission group still requested and unjustified**: 20 OEM launcher/badge permissions
  from ShortcutBadger via `expo-notifications` (the app never sets a badge). It is on the WATCH list
  in `apps/mobile/scripts/check-android-permissions.mjs`. ~~`FOREGROUND_SERVICE` +
  `FOREGROUND_SERVICE_MEDIA_PLAYBACK` from `expo-audio`~~: removed 2026-10-07 in 1.1.0
  (`enableBackgroundPlayback: false`), because Play blocked releases on the overdue
  foreground-service declaration. Owner: once 1.1.0 is on Closed testing, confirm in
  Play Console → App content that the declaration is gone.
- **A new user is shown nothing that explains the app, and until 2026-09-05 three of the four tabs
  they could reach were dead ends.** `onboarding/language` is the only onboarding route, it asks one
  question — the native language — and its own code says guests are never asked, because they have
  nowhere to save it.

  **Correction to the earlier version of this entry:** it said a signed-out person lands on Library
  and meets a sign-in wall. They do not. `apps/mobile/app/(tabs)/index.tsx:35` has redirected guests
  to **Discover** since PR #453 — *"a guest has no library to land in — for them the catalog IS the
  app"*. There is no wall on entry. The problem was never the first screen; it was that Discover
  explains nothing, and that everything past it was broken for a reader with no account.

  **Correction two:** it said Google counts the 14 days by activity rather than by opt-in. The
  opposite is true. Google's page requires *"a minimum of 12 testers who have been opted in
  continuously for at least 14 days"*, and *"testers who opt in, test for fewer than 14 days, and
  then opt out do not count"*. A tester who installs, bounces and never opens the app again still
  counts, as long as they stay opted in. The dead ends therefore never threatened the clock — they
  threatened the **application form**, which asks whether testers used all the features and what
  changed as a result.

  **Partly closed 2026-09-05** (`fix(guest): remove the dead ends…`): Save is now rendered for a
  reader with no account and answers honestly instead of being absent; Vocabulary and Stats offer a
  sign-in invitation instead of a red "Couldn't load your library" with a Retry that re-401s forever.
  Reading, translation and dictionary always worked signed out.

  **Closed 2026-09-06** (`feat(guest): a reader can finish the whole loop without an account`): mobile
  mints a guest session on demand — opening a book, through `ReaderSessionGate` — so read → tap a
  word → save → Vocabulary → review works with no sign-up. Registering promotes that same server row
  in place; signing in merges it. Posture recorded in
  [ADR-014](01-architecture/adr/ADR-014-guest-sessions.md). Both data-loss bugs named above are
  fixed: `mobilePost` now sends `Authorization` (and refreshes an expiring token first, because an
  expired bearer made `/auth/register` answer 200 and silently skip the merge), and a guest's Sign
  Out is behind a destructive confirm that names what disappears. Four more found on the way and
  fixed: `MergeGuestAsync` bulk-updated `ReadingSessions` across a partial unique index, which 500'd
  sign-in *permanently* for anyone it hit; the whole paid-inference surface accepted a guest token;
  `PromoteLookup` bypassed the tier's enrichment cap; and `IntegrationSkip` counted 500 as
  "environment unavailable", so a merge that threw reported as skipped rather than failed.

  **Still open.** Two things, and neither is small.

  *Nothing explains the app on Discover.* `onboarding/language` remains the only onboarding route and
  it asks one question. A guest can now finish the loop — nothing on the first screen tells them the
  loop exists. The reader coachmark is still the only teaching moment in the app.

  ~~*We cannot measure whether any of this helped.*~~ Partly answered 2026-10-03 (#681): the no-op
  mobile `analytics.ts` was deleted (#664), and guest → account conversion is now counted server-side
  — `User.PromotedAt` plus `guest_promoted` / `guest_merged` log lines in `AuthService`. There is still
  no client-side event pipeline.

  ~~`GuestActivityMiddleware` is dead code.~~ Fixed 2026-09-11 (#604): it now reads identity from the
  token (`ValidateAccessTokenIdentity`), so `LastActiveAt` tracks real activity.

  **Reversed 2026-09-06: a guest may upload.** `canUpload` was account-only by product choice; the
  product's thesis is user books first, and the two contradicted. It is now a session predicate
  (`hasSession`) and the server was already permitting it — `Entitlements:Tiers:Guest` grants one
  book at 50 MB. ADR-014 §3a. ~~An install that has never opened a book meets
  the sign-in wall on upload~~ — fixed 2026-09-28 (#628): `SessionGate` now wraps the upload route too.
  Still open: **an abandoned guest upload is
  permanent disk** — `GuestCleanupWorker` preserves any guest holding an upload, so a guest who
  uploads 50 MB and then reinstalls leaves a file nothing can reach and nothing will collect.
  Bounded per row, unbounded in rows. Deliberately not solved: picking a guest-retention number
  needs the real occupancy figure first.

- ~~**The selection fix passes on a phone, but not yet on the phone that reported it.**~~ Closed
  2026-09-03: the reporter ran all six steps of
  [`2026-09-01-android-tts-selection.md`](qa/reports/2026-09-01-android-tts-selection.md) on the
  Galaxy S24 that produced the original bug. That was the last thing this report was waiting on.
- **Four dependency advisories have no fix to apply.** `decode-uri-component` and `uuid` sit inside
  Expo's own tree, where forcing a version to quiet an audit is how a working mobile build stops
  working; `braces` (via Metro, 2026-10-03) and `node-forge` (via `@expo/cli`, 2026-10-02) have no
  fixed release published at all. None ships in the app. Each is written down with its reason in
  `KNOWN` in `scripts/check-advisories.mjs`, which fails CI on any advisory *not* on that list — and
  also fails if one of them stops being reported, because then the excuse has expired.
- **The advisory check no longer goes through a package manager** (2026-09-28). It reads
  `pnpm-lock.yaml` and asks the npm registry directly, and it has a third outcome — **COULD NOT
  CHECK** — that is neither a pass nor a finding. Before that it shelled out to `pnpm audit`, which on
  the Expo SDK 57 tree produced no report and never exited: CI killed the job at its ceiling with an
  empty log, and a red cross meaning "we did not check" is indistinguishable from one meaning "we
  found something".
- **`@sentry/react-native` is ahead of the Expo SDK pin** — 8.24 against `~7.11`. Recorded in
  `expo.install.exclude` as deliberate, but nobody now remembers whether it was.
- **Play's Data Safety form still holds the pre-2026-08-20 answers**, which now contradict the
  rewritten privacy policy. The correct answers are recorded verbatim in
  [`docs/03-ops/play-store-release.md`](03-ops/play-store-release.md); submitting them is a manual
  Play Console step. A form that disagrees with the policy is the worst of the three possible states.
- **`llm_traces` grows without bound.** Not an oversight — the policy now says so plainly, and account
  deletion anonymises rather than removes (`ON DELETE SET NULL`). But the table stores prompts and the
  book excerpts sent as context, with no cleanup job, and this project has already lost a night to
  [disk exhaustion](incidents/2026-07-10-backup-leaked-156gb.md). Worth a size check before it is worth
  a retention job.

## Under discussion (no decision)

Brainstorming only — nothing here is decided, planned or started. Recorded so the ideas are not lost
and nobody mistakes them for a direction.


Full write-up: [reader-engine-brainstorm.md](01-architecture/reader-engine-brainstorm.md). Evidence from
four open-source engines: [reader-engine-evaluation.md](01-architecture/reader-engine-evaluation.md)
(#722). One part is now decided: restore/save/sync logic is **shared rules in
`packages/shared/src/reader/`, not one state machine**
([ADR-019](01-architecture/adr/ADR-019-reader-position-rules.md)) — and those rules are needed
whatever engine is chosen.
- **A shared reader engine** — `@textstack/reader-engine`, TypeScript, one engine for web and mobile
  behind a standards-based `Locator` / `Publication` contract (Readium-style), instead of two readers
  that share pure helpers. Prompted by R1/R2, where the same bug had to be fixed once per client (PDF page drift: #714 web,
  #716 mobile; the bars bug in #701).
- **Where the parser runs** — server (today), on the device, or hybrid local-first (parse on the
  device for instant reading, server for sync and search).

## Deliberately not doing

Recorded so they stop being re-proposed:

- **Z-Library integration** — declined. The legal public-domain alternative (Gutendex import) is planned
  instead: `~/.claude/plans/textstack-public-domain-discovery.md`.
- **Billing / Stripe / tier upgrade from the UI.** Tiers exist; monetization does not.
- **An admin console over `User`.** Staff is a config allowlist; the population is 1–3 people.
- **Mobile chunked upload.** RN cannot slice an opaque `file://`; the legacy endpoint stays.
- **A UserBooks/Editions shared abstraction** — assessed as false parallelism during the R1–R6 sweep.
- **Python anywhere.** Distillation is TorchSharp + a synthetic teacher.
- **Audiobooks.** Narration for a catalogue this size is a recurring per-book cost against a product
  whose thesis is reading, not listening. TTS already reads any selection aloud, which is the part
  that serves a learner.
- **A bot that merges its own dependency updates.** Updates arrive as pull requests and a person
  merges them. Here a merge deploys production, and the day this was decided produced six proposals
  that were wrong on their merits — a version number is visible to a bot, an Expo SDK matrix and a
  runtime fingerprint are not. The rule that came out of it: *an automatic update is safe exactly as
  far as its constraints are machine-checkable.* Two of those constraints now are —
  `expo install --check` in CI, and a fingerprint report on every PR — and the rest are why nothing
  merges itself.
- **Majors, applied automatically.** `deps-refresh.yml` raises patch and minor in the catalog and
  reports majors without touching them.
