# Changelog

Notable changes to TextStack. Newest first.

**How this file works** — three homes, on purpose. This one stays scannable:

| | |
|---|---|
| **`CHANGELOG.md`** (this file) | One line per change, grouped by deploy date. The index. |
| [**`docs/incidents/`**](docs/incidents/README.md) | Postmortems. What broke, why it was invisible, what it taught. |
| [**`docs/changelog-archive/`**](docs/changelog-archive/) | The full write-up behind every line here, preserved verbatim. |
| [**`docs/STATUS.md`**](docs/STATUS.md) | Where the project actually is right now. |

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are
[CalVer](https://calver.org/) — the deploy date, because TextStack ships to one production
environment on merge and there is no other version anyone can name.

Writing an entry: **one line**, ending with a link. If it needs a paragraph, the paragraph belongs in
the archive; if it broke production, it belongs in `docs/incidents/`. See
[`.claude/commands/changelog.md`](.claude/commands/changelog.md).

---

## [Unreleased]

- **MCP** — Claude/ChatGPT can manage your vocabulary: `add_vocabulary_words` (up to 20, translation or definition required, one result per word), `update_vocabulary_word`, `delete_vocabulary_word`; `list_my_vocabulary` returns ids; saves fall back to the profile's native language, assistant saves are tagged `source = mcp`, word writes share the per-user `highlight-write` limit, wipe-all refuses OAuth tokens (18 → 21 tools) — backend, web · [details](docs/changelog-archive/2026-H2.md#2026-10-03-mcp-vocabulary-write)
- **Reader** — free dictionary (api.dictionaryapi.dev) removed: no phonetic/definition in the web word popup, no auto English definition on vocab save, no live lookup in review feedback; same-language (definition mode) word taps show the contextual Explain instead — backend, web, mobile · [details](docs/changelog-archive/2026-H2.md#2026-10-03-drop-free-dictionary)
- **Reader** — one chapter at a time, like web: no more appending the next chapter as you scroll; an end-of-chapter block offers Next (prefetched to the device), Discuss (saves progress first), the previous chapter, and on the last chapter "You finished" + Review words + Library; a chapter turn keeps one reading session and the saved-word count — mobile
- **Uploads** — sharing an uploaded book shares the book, not a dead end: mobile drops the text-only Share and renames "Save a copy" (the original file) to Share; web swaps the private-page link (a login wall for whoever got it) for downloading the file — web, mobile
- **Guests** — one obvious way from guest to account: a "You're reading as a guest" card on top of the mobile profile and Create account / Sign in in the web menu (no more signing out to register); Google first and "keep everything you've saved" on the login screen; nudges at the 3rd and 10th saved word; "Delete guest data" really deletes server-side; no more random animal names; a failed token refresh no longer wipes the guest mid-signup; `User.PromotedAt` + `guest_promoted`/`guest_merged` logs to measure conversion — backend, web, mobile
- **Reader** — the Claude/ChatGPT picker under "Discuss this chapter" was invisible (dark text on the dark-mode menu); it now takes its text colour from the same theme as its background — web
- **Discover** — Discover/home show a curated Popular shelf (1984, Animal Farm, Kafka…) instead of newest; `/books` defaults to Popular (`sort=recent` keeps newest-first); the order is `Edition.FeaturedRank` (migration seeds it), set in admin or via `make featured` (`PUT /internal/featured`, whole-shelf replace + Full SSG rebuild) — backend, admin, web, mobile
- **Stats** — short web reading sessions were rejected (400): the heartbeat's first +30s could exceed the session's own span; duration is now capped at the wall clock, queued ones are repaired, and a 400 no longer retries forever — web
- **Perf** — fewer requests from the new fields: home Continue card reads `/me/library/shelves` (`continueReading[0]` + its `chapterSlug`) instead of `/me/library` + `/me/progress` + `/me/books` (3→1), and the upload/clip reader takes the clip's source link from the book detail it already loads instead of fetching the Read later list (−1 per open); `useContinueReading` deleted — web
- **Perf** — fewer requests: the Header no longer pulls full `/me/reading/stats` on every page (it shows only vocab fields), and library cards share one `/me/reading/pace` request instead of one per card on a cold cache; no behaviour change — web
- **Perf** — fewer DB round trips on hot paths: progress PUT 4→2 (projected chapter, no html/tsvector), chapter GET 3→2 (both neighbours in one query), shelves 9→3 (pace aggregated in SQL, shelves cut in memory); one server pace rule for estimates (`ReadingPace`: own wpm at ≥3 sessions, else 200; minutes round to nearest) — shelves, book-stats minutes left, `/me/reading/pace`; displayed wpm stays measured; additive `chapterSlug` on every shelf item, `sourceUrl` on user-book detail — backend
- **Perf** — mobile fewer requests, no behaviour change: Library/Stats/Vocabulary stop loading twice per open (focus refresh re-fired when `loading` flipped), my-books detail fetches progress once on open and runs one poll for processing + enrichment, insights fetched once per book screen (lifted into `useBookReviews`) — mobile
- **Refactor** — web runs `@textstack/shared`'s api client in cookie mode (`initApi({ credentials: 'include' })`, 401 → refresh → retry kept): one `authFetch` for both apps; web copies of collections, library shelves, insights, MCP keys, OAuth grants and the tutor client deleted (tutor now shared with mobile); progress, library, profile and account calls in web `auth.ts` now refresh on 401 too (they used to just fail) — web, mobile, shared
- **Refactor** — duplicated pure logic moved to `packages/shared`: language catalogue, achievements, library search (mobile gains `tag:`), `parseSeoThemes` (admin via deep-path alias), web library filter/count/sort now the shared `entries` functions, identical web API types re-exported; one reading-time rule everywhere — personal pace from `/me/reading/pace`, else 200 wpm (was 150 mobile, 250 web reader) — web, mobile, admin
- **Refactor** — mobile reader internals: one chrome type/latch/effect for reflow + PDF, one `ExitCard` for the three exit prompts, book progress set in one place, one infinite-scroll hook for both sources (`fetchNext` per source, still device-first), one `DownloadButton` on both book screens; no behaviour change — mobile
- **MCP** — each tool's description lives once (Contracts' manifest) instead of being hand-copied into the runtime catalog and compared character for character by a test — backend
- **Library** — an upload's book page read its position from this browser's localStorage only, so a book 44% read elsewhere said "Start Reading" and the Assistant menu offered the whole book instead of the current chapter; it now asks the server first — web
- **Refactor** — backend dead-code sweep (~1.8k lines): RAG/PDF-vision leftovers (providers, routes, rate limits, config, DTOs, multimodal path, datasets), five agent tools nothing offered, internal chapter `/split` endpoints, unused NuGet packages; no behaviour change — backend, infra
- **Refactor** — web dead code out: ~1.8k lines of orphaned CSS (Ask/RAG panel, scroll reader, home sections, shelves, language picker), 13 unreferenced components, 10 unused `offlineDb` functions (expired dictionary/TTS/explain caches now evicted once per app start), 92 dead web + 5 shared i18n keys (new web unused-key guard), test-only library sort/filter helpers, admin `@dnd-kit/*`; privacy/terms stop naming Book Chat and the librarian — web, admin
- **Refactor** — search: dropped write-only `search_documents` table (migration), its indexer, `reindex-search` CLI/make target and the never-deployed Meilisearch provider; one fewer heavy edition+chapters query per ingestion/publish — backend, infra
- **Refactor** — backend copy-paste helpers merged to one home each: StripHtml/CountWords (HtmlCleaner), SanitizeText (TextProcessingUtils), GenerateSecureToken, ExtractJson, TruncateToWords, ParseTzOffset, advisory-lock helpers, TryQueueQualityJobAsync, Explain+Translate genre lookup and SHA256 file cache (FileJsonCache); no behaviour change — backend
- **Refactor** — mobile dead code: no-op analytics module, dead hooks/caches/offlineDb exports, RAG citation leftovers, overlay-v2 + text-position kill switches and the legacy `<mark>` highlight painter deleted; `noUnusedLocals` on — mobile
- **SEO** — 14 author pages 404'd to crawlers again: the August backfill left 102 accidental `indexable = false` authors with no book yet, and auto-publish gave them books; a migration flips the whole pool — backend · [incident](docs/incidents/2026-08-31-authors-404-to-crawlers-only.md#addendum--2026-10-01-it-came-back-as-predicted)
- **Fix** — audit bugs: mobile rare-word save shows its notice again (+ "Add anyway"), first catalog chapter no longer numbered 0, search drops "Ch. N"; web upload reader stops a 404 auto-add, deleting a review clears ✓ Reviewed, Processing/Failed PDFs open from list view, one `timeAgo`, guests no longer 403 on grants; Explain stops offering the deleted `search_book`; CI now runs Extraction and AI-eval tests and UnitTests is in the solution — backend, web, mobile, infra
- **Library** — one Discuss instead of Discuss book + Review chapter: talk the chapter over freely, the assistant warns before later chapters and offers the review when you're done, and the result comes home; Discuss also at the end of a chapter in the reader (web) and on leaving a finished chapter (mobile); review method v3 builds on the conversation — backend, web, mobile · [details](docs/changelog-archive/2026-H2.md#2026-10-01-one-discuss)
- **Library** — one "✦ Assistant ▾" button beside Continue Reading on every book page: Discuss this book / Review current chapter (or open its review), through the same connected-chat logic as the chapter-row Review; the "Open in Claude / ChatGPT" links and connector hint are gone — web, mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-30-one-assistant-button)
- **MCP** — Discuss / Review open the chat with one human sentence and a short id line; the how-to-work rules moved into the MCP server's instructions; upload titles lose trailing shadow-library domains like "(z-library.sk, 1lib.sk)" — backend, web, mobile, worker · [details](docs/changelog-archive/2026-H2.md#2026-09-30-human-handoff-briefs)
- **Library** — chapter review in the reader and Practice: a dot on every highlight a review used (HTML + PDF), tapping it shows the block, the rule and Open review; quotes on the summary open the text at that highlight; a Chapter questions card on Practice with its own Forgot/Almost/Knew session; no Review button on front/back matter or chapters under 800 words — web (+ mobile for the last) · [details](docs/changelog-archive/2026-H2.md#2026-09-30-chapter-review-reader)
- **MCP** — the review method stopped sending readers to a chapter-review page and a Practice section that don't exist yet (method v2) — backend
- **Library** — chapter review, UI: every chapter row on a book page gets Review (opens your connected Claude/ChatGPT with the brief, or a connect dialog if none) or ✓ Reviewed → its summary page — problem, why, rule, your highlights, check-yourself questions, threads, Next — web + mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-30-chapter-review-ui)
- **MCP** — ChatGPT couldn't connect: its client document declares private_key_jwt and also supports "none", and we refused it on the declared field alone — backend
- **Web** — nginx's trailing-slash redirect dropped every query string, so the OAuth consent page lost its request id and always said "expired" — infra, backend
- **Deploy** — the MCP health check expected an anonymous 200, which OAuth made a 401 by design; it now checks for the 401 + challenge and JSON discovery documents — infra
- **Library** — clicking a book opens its page (cover, description, chapters) instead of dropping you into the text; a Continue button on the card still goes straight back to where you were — web
- **MCP** — connect Claude or ChatGPT by signing in: an OAuth server for the MCP endpoint, which now asks every client to log in; a consent page, and a "Connected apps" list with Disconnect on the connect page (web + app); keys and the personal URL still work, under "For developers" — backend, web, mobile, infra · [details](docs/changelog-archive/2026-H2.md#2026-09-29-mcp-oauth-connect-in-one-click)
- **CI** — an Expo patch release upstream no longer turns every pull request red; minor/major SDK drift still fails — infra
- **Uploads** — a PDF whose outline groups chapters under parts is split into its chapters, not its parts (DDIA: 3 parts of 150–240 pages → 12 chapters) — worker · [details](docs/changelog-archive/2026-H2.md#2026-09-29-uploads-pdf-chapters-under-parts)
- **MCP** — chapter review: the reader's own assistant reviews a chapter by the TextStack method (`get_chapter_review` / `save_chapter_review`), the result lands in the chapter's insight as structure and its questions get their own SRS queue — backend · [details](docs/changelog-archive/2026-H2.md#2026-09-29-mcp-chapter-review)
- **MCP** — ChatGPT can reach your library: a connect key now also comes as a personal URL, because ChatGPT's connectors can't send a header — backend, web, mobile, infra · [details](docs/changelog-archive/2026-H2.md#2026-09-29-mcp-chatgpt-connects-with-a-personal-url)
- **SEO** — Bing accepts IndexNow again: it only takes the key it first verified, so prod is back on the February key — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-28-seo-indexnow-bing-refuses-separately)
- **SEO** — IndexNow reaches Bing through Yandex while Bing refuses direct submissions, and the worker logs why a submission failed — web · [details](docs/changelog-archive/2026-H2.md#2026-09-28-seo-indexnow-bing-refuses-separately)
- **SEO** — IndexNow had been refused (403) on every rebuild since late April: prod's key and the key file on the site were two different keys — web · [details](docs/changelog-archive/2026-H2.md#2026-09-28-seo-indexnow-refused-on-every-rebuild)
- **Docs** — CONTRIBUTING links an optional Neovim setup that matches the repo's formatting rules — docs
- **Offline** — "+" no longer asks a fresh install to sign in, and a book you just uploaded arrives without leaving the app — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-28-offline-the-door-and-the-book-that-was-not-ready)
- **CI** — the advisory check stopped going through a package manager, and learned to say "could not check" instead of failing silently — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-28-advisories-a-check-that-can-say-it-failed)
- **Mobile** — Expo 55 → 57 and React Native 0.83 → 0.86, in one step rather than two — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-28-mobile-expo-55-to-57)
- **Guests** — opening a chapter no longer creates an account, which is how crawlers made 7,147 of the 7,263 guest rows on production — web · [details](docs/changelog-archive/2026-H2.md#2026-09-28-guests-a-render-is-not-a-commitment)
- **Offline** — a downloaded book opens from the phone instead of waiting out a network that never answers, keeps scrolling past chapter one offline, and a book deleted elsewhere stops taking up space here — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-28-offline-a-downloaded-book-stops-waiting-for-the-network)
- **Uploads** — "Download EPUB" gave back a text-only re-encoding; it now hands over the file you uploaded, from the device when the book is already there — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-28-uploads-the-button-gives-back-your-file)
- **Offline** — the library shelf says what is on your phone, what is arriving, and what still needs a connection — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-28-offline-the-shelf-says-where-each-book-is)
- **Offline** — your own books arrive on the device without being asked twice — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-28-offline-the-library-fetches-itself)
- **CI** — a deploy stops re-running the whole suite the pull request just passed — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-28-ci-a-deploy-that-re-proved-the-pull-request)
- **Auth** — every launch restored your session and then minted a new guest over it, stranding the library on the server — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-28-auth-a-session-restored-and-immediately-replaced)
- **Uploads** — a fresh install was told to create an account to upload, for want of a session nothing had asked for — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-28-uploads-a-sign-up-wall-that-only-existed-because-nothing-had-asked)
- **Offline** — the app now has a budget for what it keeps on your phone, and a deleted book stops leaving its file behind — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-28-offline-a-budget-for-the-phone-and-two-bugs-only-a-device-could-show)
- **Offline** — a downloaded PDF opens offline as the book, not as text with the figures stripped out — mobile, backend, shared · [details](docs/changelog-archive/2026-H2.md#2026-09-27-offline-the-book-you-downloaded-is-the-book-you-get)
- **Mobile** — offline reading had been on `main` and on nobody's phone for twelve days; a refused update now starts the build it was asking for — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-27-mobile-a-refusal-that-was-correct-for-twelve-days-now-ships-the-build-itself)
- **Deps** — two package families that Dependabot had split a version at a time, put back on one version — backend · [details](docs/changelog-archive/2026-H2.md#2026-09-27-deps-two-package-families-that-dependabot-split-one-at-a-time)
- **Deps** — one dependency proposal twice a year instead of six unread pull requests, and a vulnerability that no longer waits for the calendar — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-27-deps-one-proposal-twice-a-year-and-a-vulnerability-that-does-not-wait-for-it)
- **Infra** — a patch-level dependency drift had blocked every deploy — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-27-infra-a-patch-level-dependency-drift-had-blocked-every-deploy)
- **Ops** — a backup verifier that failed on its own race, not on the backup — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-27-ops-a-backup-verifier-that-failed-on-its-own-race-not-on-the-backup)
- **Offline** — your own uploads download for offline reading, and "Download EPUB" stops answering "not authorised" — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-14-offline-your-own-books-download-and-a-download-button-that-was-never-authorised)
- **QA** — three regressions found in code shipped the day before, and a guard taught to read prose — backend, mobile, shared · [details](docs/changelog-archive/2026-H2.md#2026-09-12-qa-three-regressions-in-code-shipped-the-day-before)
- **Guests** — a sign-in that left your reading behind no longer tells you it was kept — web, mobile, shared · [details](docs/changelog-archive/2026-H2.md#2026-09-11-guests-the-reader-is-told-when-their-work-did-not-come-across)
- **Sentry** — a laptop's stale API key had been filing production-looking incidents for a month — backend, mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-11-sentry-a-developer-machine-is-not-an-incident)
- **Genres** — opening any genre on the phone showed nothing, because the endpoint never sent the authors both clients read — backend, mobile, shared · [details](docs/changelog-archive/2026-H2.md#2026-09-11-genres-a-field-two-clients-used-and-the-server-never-sent)
- **Tutor** — the exercise it plans is now the card you actually get, not a badge over one flashcard — backend, web, mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-11-tutor-the-planned-exercise-becomes-the-card)
- **Tutor** — the planner was being told to call a tool deleted months ago, on every run — backend · [details](docs/changelog-archive/2026-H2.md#2026-09-11-tutor-an-instruction-that-could-not-be-obeyed)
- **Guests** — the middleware that keeps an active reader from being deleted had never run once — backend · [details](docs/changelog-archive/2026-H2.md#2026-09-11-guests-a-middleware-that-never-ran)
- **Insights** — each conclusion says when you settled it, and the four-category enum was dropped before it was built — web, mobile, shared · [details](docs/changelog-archive/2026-H2.md#2026-09-10-insights-a-conclusion-can-be-removed)
- **Insights** — a conclusion filed against the wrong chapter can be removed; it used to be permanent — backend, web, mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-10-insights-a-conclusion-can-be-removed)
- **Progress** — one "mark as finished" across web and mobile, and the first write for a book stops being the exception — backend, web, mobile, shared · [details](docs/changelog-archive/2026-H2.md#2026-09-10-progress-the-same-action-writes-the-same-thing)
- **MCP** — the assistant can see where you are, and can record a chapter you finished somewhere else — backend · [details](docs/changelog-archive/2026-H2.md#2026-09-10-mcp-the-assistant-can-see-where-you-are)
- **Mobile** — the assistant handoff and the conclusions it writes back reach the phone, and a percent that was silently a fraction — mobile, web, shared · [details](docs/changelog-archive/2026-H2.md#2026-09-08-mcp-the-book-opens-to-your-assistant-and-the-conclusions-come-back)
- **MCP** — TextStack.Mcp 1.1.0 on NuGet: the tool ships the uploaded-library and write-back tools — backend · [details](docs/changelog-archive/2026-H2.md#2026-09-08-mcp-the-book-opens-to-your-assistant-and-the-conclusions-come-back)
- **Library** — searching your own library answered 500 on every call and always had, behind an empty-looking result — backend · [details](docs/changelog-archive/2026-H2.md#2026-09-08-mcp-the-book-opens-to-your-assistant-and-the-conclusions-come-back)
- **MCP** — your uploaded books open to your assistant, and its conclusions come back into the book — backend, web · [details](docs/changelog-archive/2026-H2.md#2026-09-08-mcp-the-book-opens-to-your-assistant-and-the-conclusions-come-back)
- **Docs** — ADR-015 records the position model, and QA-001 finally crosses a chapter boundary — docs · [details](docs/changelog-archive/2026-H2.md#2026-09-07-docs-adr-015-and-the-scenario-that-was-never-in-qa-001)
- **Library** — the shelf called Continue Reading can finally continue something — backend, shared · [details](docs/changelog-archive/2026-H2.md#2026-09-07-library-the-shelf-that-could-not-continue)
- **Reader** — web joins the position model; a slug with a colon and a tab-close write both stop losing data — web · [details](docs/changelog-archive/2026-H2.md#2026-09-07-reader-web-joins-the-position-model)
- **Reader** — the reading position is a place in the text, not a pixel — mobile, backend, shared · [details](docs/changelog-archive/2026-H2.md#2026-09-07-reader-the-position-is-a-place-in-the-text)
- **Reader** — a font size change stops destroying your place, and three defects found on the way — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-07-reader-a-font-size-change-stops-destroying-your-place)
- **Vocabulary** — Blitz runs Blitz, after a mode set in one mount effect lost to the default read in the next — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-06-vocabulary-blitz-runs-blitz-and-four-smaller-things-a-qa)
- **Mobile** — one word tap buys one translation instead of two, and the screen behind the reader stops refetching — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-06-mobile-one-word-tap-buys-one-translation-not-two-and-the)
- **QA** — the guest loop walked on a device with a traffic log, and the step that guards the data loss could not reach it — docs · [details](docs/changelog-archive/2026-H2.md#2026-09-06-qa-the-guest-loop-walked-on-a-device-with-a-traffic-log)
- **Dictionary** — a word tap survives the dictionary API being down, and fails in 3s instead of 10 when it cannot — backend · [details](docs/changelog-archive/2026-H2.md#2026-09-06-dictionary-an-upstream-outage-stops-being-an-outage)
- **Guest** — a reader finishes the loop — read, save a word, review it — with no account, and registering keeps every bit of it — mobile, backend · [details](docs/changelog-archive/2026-H2.md#2026-09-06-guest-the-whole-loop-without-an-account)
- **Mobile** — a reader with no account gets an invitation, not a red error, and a Save button that is actually there — mobile, web · [details](docs/changelog-archive/2026-H2.md#2026-09-05-mobile-an-invitation-not-a-red-error)
- **Extension** — the checks its README describes now run, and can now fail — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-02-extension-a-gate-that-could-not-fail)
- **Mobile** — crashes from testers now reach somewhere a person can read them — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-03-mobile-crash-reporting-stops-being-dormant)
- **Security** — Dependabot alerts are on, and a stale lockfile that had been hiding eleven advisories is gone — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-03-security-alerts-on-and-a-lockfile-that-was-hiding-things)
- **Reader** — tapping an image opens it again, after a null `document.body` killed the listener on every load — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-02-reader-tapping-an-image-opens-it-again)
- **Profile** — languages are named, not flagged — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-02-profile-languages-are-named-not-flagged)
- **Updates** — a fix lands on the next screen instead of the second cold start, but never mid-chapter — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-02-updates-a-fix-lands-without-two-restarts)
- **Profile** — the build number sits on the About row and survives an update, because it comes from the installed package — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-02-profile-the-build-number-survives-an-update)
- **Profile** — the app says which build it is, and whether the JS came from the store or arrived after — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-02-profile-which-build-is-this)
- **SSG** — a deploy that waited on a prompt stopped taking 1990 prerendered pages with it — infra · [incident](docs/incidents/2026-09-02-corepack-prompt-stranded-the-ssg.md)
- **SSG** — something finally watches whether pages are being regenerated at all — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-02-ssg-something-watches)
- **SSG** — a worker that fails every job stops calling itself healthy — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-02-ssg-worker-honest-health)
- **SSG** — rebuilds stopped failing on a path the workspace move invalidated, while the site looked fine — infra · [incident](docs/incidents/2026-09-01-ssg-worker-lost-its-output-path.md)
- **CI** — dependencies refresh themselves weekly, and the lane that matters is the one that changes no versions at all — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-01-ci-dependencies-refresh-themselves)
- **Security** — 125 dependency findings down to 3, none of them shipping, and something now watches — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-01-security-125-findings-down-to-3)
- **Infra** — one pnpm workspace with a version catalog, the JS answer to Directory.Packages.props — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-01-infra-one-workspace-one-catalog)
- **Infra** — one Node version, declared once, and production stops running an end-of-life runtime — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-01-infra-one-node-version)
- **CI** — an OTA goes out on merge, and refuses to when the runtime says it would reach nobody — infra · [details](docs/changelog-archive/2026-H2.md#2026-09-01-ci-an-ota-goes-out-on-merge)
- **Beta** — the site and the README carry a standing Android beta badge, not a Play badge that leads to a 404 — web · [details](docs/changelog-archive/2026-H2.md#2026-09-01-beta-a-standing-android-badge)
- **Selection** — extending a long-press into a sentence reaches the app, so Listen stops reading one word — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-01-selection-extending-a-long-press-reaches-the-app)
- **Reader** — speech starts when asked, and the Listen button reads the passage you picked — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-01-reader-speech-starts-when-asked)
- **Selection** — a passage longer than 300 characters stops disappearing instead of opening a toolbar — mobile · [details](docs/changelog-archive/2026-H2.md#2026-09-01-selection-a-long-passage-stops-disappearing)
- **Search** — a common word stops timing out, because ranking happens after deduplication instead of over every chapter — backend · [details](docs/changelog-archive/2026-H2.md#2026-08-31-search-a-common-word-stops-timing-out)
- **Android** — the launcher icon stops being a solid block for anyone using themed icons — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-31-android-the-launcher-icon-stops-being-a-solid-block)
- **SSG** — a rebuild that lost its files stops promoting the remains over a working site, and the deploy stops calling that success — infra · [incident](docs/incidents/2026-08-31-deploy-wiped-a-running-ssg-rebuild.md)
- **SEO** — 425 author pages stopped returning 404 to Google while working for people, and a check now asks a crawler's question — infra · [incident](docs/incidents/2026-08-31-authors-404-to-crawlers-only.md)
- **Beta** — the Android invite works on the live site, where chapter URLs end in a slash — web · [details](docs/changelog-archive/2026-H2.md#2026-08-31-beta-the-android-invite-works-on-the-live-site)
- **Beta** — the site invites Android readers into the closed test, but only ones who have opened a book — web · [details](docs/changelog-archive/2026-H2.md#2026-08-31-beta-the-site-invites-android-readers)
- **Resume** — the locator decides on every screen that offers to continue, not just one — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-29-resume-the-locator-decides-on-every-screen)
- **Progress** — a row stops being able to contradict itself — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-29-progress-a-row-stops-being-able-to-contradict-itself)
- **Reader** — a restore now says when it has landed, and nothing is saved before it does — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-29-reader-a-restore-now-says-when-it-has-landed)
- **Reader** — the mobile reader stopped writing a position before it had restored one — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-28-reader-stopped-writing-a-position-before-restoring-one)
- **Settings** — a stored default stopped masquerading as a decision, and auto-speak moved to where it is looked for — backend + mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-28-settings-a-stored-default-stopped-masquerading)
- **Reader** — continuing a book stopped erasing where you had got to — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-28-reader-continuing-a-book-stopped-erasing-where-you-got-to)
- **AI tools** — three ways an agent could state something the data did not say — backend · [details](docs/changelog-archive/2026-H2.md#2026-08-28-ai-tools-three-ways-an-agent-could-state-something)
- **Mobile** — the language question is now decided while rendering, not by an effect that could be missed — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-28-mobile-the-language-question-is-decided-while-rendering)
- **Mobile** — a book screen re-reads where you got to, instead of showing where you were before you read — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-28-mobile-a-book-screen-re-reads-where-you-got-to)
- **Reader + highlights + tutor** — four small places where the screen said more than the data did — backend + web + mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-28-four-small-places-where-the-screen-said-more)
- **Mobile** — the library filter row stopped depending on fitting a phone — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-28-mobile-the-library-filter-row-stopped-depending-on-fitting)
- **Vocabulary** — a card says its word out loud instead of waiting to be asked — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-28-vocabulary-a-card-says-its-word-out-loud)
- **Vocabulary** — a Smart session answer is recorded when it is given, not when the session ends — backend + web + mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-28-vocabulary-an-answer-is-recorded-when-it-is-given)
- **Vocabulary** — Smart session answers now count toward spaced repetition — backend · [details](docs/changelog-archive/2026-H2.md#2026-08-27-vocabulary-smart-session-answers-now-count)
- **Mobile** — counts agree with their nouns, the streak card stops filling four tabs, and a one-option control is gone — web + mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-27-mobile-counts-agree-with-their-nouns)
- **Highlights** — a saved passage is shown inside the sentence it came from, and "review" stopped claiming to be one — backend + web + mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-27-highlights-a-saved-passage-is-shown-inside-the-sentence)
- **Ask + Librarian** — a citation names its chapter, and the AI screens speak to the reader instead of about them — backend + web + mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-27-ask-librarian-a-citation-names-its-chapter)
- **Deep links** — the site can now vouch for the Android app, so book links stop bouncing to the browser — web + docs · [details](docs/changelog-archive/2026-H2.md#2026-08-27-deep-links-the-site-can-now-vouch-for-the-android-app)
- **Progress** — a percentage now travels with the unit it is measured in — backend + web + mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-27-progress-a-percentage-now-travels-with-the-unit-it-is-mea)
- **Reader** — the WebView stopped reloading itself out from under the reader — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-27-reader-the-webview-stopped-reloading-itself-out-from-unde)
- **Mobile** — the app asks which language you know, instead of translating English into English — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-27-mobile-the-app-asks-which-language-you-know-instead-of-tr)
- **Mobile** — offline stopped looking like an empty account — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-27-mobile-offline-stopped-looking-like-an-empty-account)
- **Mobile** — controls stopped outranking the content they shape — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-27-mobile-controls-stopped-outranking-the-content-they-shape)
- **User books** — an uploaded EPUB opens on the book, not on its own index — extraction + mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-27-user-books-an-uploaded-epub-opens-on-the-book-not-on-its)
- **Mobile** — the newest build stopped calling itself outdated — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-27-mobile-the-newest-build-stopped-calling-itself-outdated)
- **Mobile** — Library was 13 blocks of chrome before the first book; now 3 — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-26-mobile-library-was-13-blocks-of-chrome-before-the-first-b)
- **Reader** — six ways a reader lost their place, plus the "time left" that was never built — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-25-reader-six-ways-a-reader-lost-their-place-plus-the-estim)
- **Mobile** — Library is a reader-first front door; two dead routes fixed — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-25-mobile-library-is-a-reader-first-front-door-resume-then-e)
- **AI** — 24 LLM traces a day were silently dropped: Postgres cannot store a NUL — backend · [details](docs/changelog-archive/2026-H2.md#2026-08-21-ai-24-llm-traces-a-day-were-silently-dropped-postgres-c)
- **Backend** — Npgsql was declared 9.0.3 and running 10.0.2 — backend · [details](docs/changelog-archive/2026-H2.md#2026-08-21-backend-npgsql-was-declared-903-and-running-1002)
- **Security** — two packages with high-severity advisories, one of them unused — backend · [details](docs/changelog-archive/2026-H2.md#2026-08-20-security-two-packages-with-high-severity-advisories-one)
- **CI** — 14 E2E tests removed, two of which could not fail — infra · [details](docs/changelog-archive/2026-H2.md#2026-08-20-ci-14-e2e-tests-removed-two-of-which-could-not-fail)
- **Web** — links rendered outside the language provider pointed at paths the router does not serve — web + infra · [details](docs/changelog-archive/2026-H2.md#2026-08-20-web-links-rendered-outside-the-language-provider-pointed)
- **Mobile** — crash reporting, wired but dormant until a DSN is supplied — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-20-mobile-crash-reporting-wired-but-dormant-until-a-dsn-is-s)
- **CI** — E2E stops gating production on everything except smoke, and the Chrome download stops flaking deploys — infra · [details](docs/changelog-archive/2026-H2.md#2026-08-20-ci-e2e-stops-gating-production-on-everything-except-smok)
- **Legal** — the privacy policy said data stayed in your browser and that nothing was shared; both were false — web + mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-20-legal-the-privacy-policy-said-data-stayed-in-your-browse)
- **Mobile** — a farewell banner for the frozen `1.0.0` runtime, before the fingerprint switch strands it — mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-20-mobile-a-farewell-banner-for-the-frozen-100-runtime-befor)
- **Reader** — the dyslexic font was a saved GitHub web page on both platforms, so the setting never worked — web + mobile · [details](docs/changelog-archive/2026-H2.md#2026-08-19-reader-the-dyslexic-font-was-a-saved-github-web-page-on-bot)
- **CI** — web unit tests and the whole mobile app were never checked by CI — infra · [details](docs/changelog-archive/2026-H2.md#2026-08-19-ci-web-unit-tests-and-the-whole-mobile-app-were-never-check)
- **Mobile** — Play production plumbing: a submit profile that exists, two permissions that shouldn't, and a guard — mobile + infra · [details](docs/changelog-archive/2026-H2.md#2026-08-19-mobile-play-production-plumbing-a-submit-profile-that-exi)
- **Docs** — CHANGELOG split into an index, an archive and postmortems — docs · [details](docs/changelog-archive/2026-H2.md#2026-08-11-docs-changelog-split-into-an-index-an-archive-and-post)


## [2026.08.11]

- **SEO** — static-site generation had been dead for five weeks; a forbidden HTTP header killed it — backend · [**postmortem**](docs/incidents/2026-08-11-ssg-dead-five-weeks.md) · [details](docs/changelog-archive/2026-H2.md#2026-08-11-seo-static-site-generation-had-been-dead-for-five-weeks-a-fo)

## [2026.08.09]

- **Users** — entitlement tiers replace two hardcoded storage constants — backend · [details](docs/changelog-archive/2026-H2.md#2026-08-09-users-entitlement-tiers-replace-two-hardcoded-storage-consta)

## [2026.08.08]

- **Worker** — provider readiness check + circuit breaker, and a Sentry environment tag that lied — backend + infra · [details](docs/changelog-archive/2026-H2.md#2026-08-08-worker-provider-readiness-check-circuit-breaker-and-a-sentry)

## [2026.08.07]

- **Observability** — Sentry leaked SQL a second way: EF Core error EVENTS, not just breadcrumbs — backend · [**postmortem**](docs/incidents/2026-08-07-sentry-scrubber-leaked-sql.md) · [details](docs/changelog-archive/2026-H2.md#2026-08-07-observability-sentry-leaked-sql-a-second-way-ef-core-error-e)
- **Reader** — reading position was silently lost on concurrent saves (23505 upsert race) — backend · [**postmortem**](docs/incidents/2026-08-07-reading-position-lost-23505.md) · [details](docs/changelog-archive/2026-H2.md#2026-08-07-reader-reading-position-was-silently-lost-on-concurrent-save)

## [2026.08.06]

- **Observability** — Sentry for API + Worker, with LLM agent and provider-routing spans — backend + infra · [details](docs/changelog-archive/2026-H2.md#2026-08-06-observability-sentry-for-api-worker-with-llm-agent-and-provi)

## [2026.07.18]

- **Quality pipeline** — a shifted double-delete could destroy a real chapter (Ivan Ilyich lost chapter I) — infra + backend · [**postmortem**](docs/incidents/2026-07-18-double-delete-destroyed-chapter.md) · [details](docs/changelog-archive/2026-H2.md#2026-07-18-quality-pipeline-a-shifted-double-delete-could-destroy-a-rea)

## [2026.07.17]

- **Mobile** — persistent Book Chat parity (history, markdown, quote-and-ask, spoiler toggle) — mobile + shared · [details](docs/changelog-archive/2026-H2.md#2026-07-17-mobile-persistent-book-chat-parity-history-markdown-quote-an)

## [2026.07.15]

- **Book Chat** — precomputed per-chapter summaries: "summarize chapter N" now draws on a whole-chapter digest — backend · [details](docs/changelog-archive/2026-H2.md#2026-07-15-book-chat-precomputed-per-chapter-summaries-summarize-chapte)
- **RAG** — deterministic tie-breaker on retrieval ORDER BY (repo now matches the article) — backend · [details](docs/changelog-archive/2026-H2.md#2026-07-15-rag-deterministic-tie-breaker-on-retrieval-order-by-repo-now)
- **Upload** — truncated PDFs are caught with a clear message instead of a scary "corrupted" failure — backend + web · [details](docs/changelog-archive/2026-H2.md#2026-07-15-upload-truncated-pdfs-are-caught-with-a-clear-message-instea)
- **Book Chat** — tutor-grade answers: prompt rewrite, gpt-4.1, markdown rendering, 10× token headroom — backend + web · [details](docs/changelog-archive/2026-H2.md#2026-07-15-book-chat-tutor-grade-answers-prompt-rewrite-gpt-4-1-markdow)
- **Book Chat** — "Ask this book" gets persistent history, quote-and-ask, and your highlights as context — backend + web · [details](docs/changelog-archive/2026-H2.md#2026-07-15-book-chat-ask-this-book-gets-persistent-history-quote-and-as)

## [2026.07.14]

- **Reliability** — a slow/hung RAG parse can no longer wedge the indexing worker — backend · [**postmortem**](docs/incidents/2026-07-14-rag-parse-wedged-worker.md) · [details](docs/changelog-archive/2026-H2.md#2026-07-14-reliability-a-slow-hung-rag-parse-can-no-longer-wedge-the-in)
- **Hotfix** — PDF vision-RAG parse routes to gpt-4.1 in the Worker (was Ollama) · [**postmortem**](docs/incidents/2026-07-14-pdf-parse-fell-to-ollama.md) · [details](docs/changelog-archive/2026-H2.md#2026-07-14-hotfix-pdf-vision-rag-parse-routes-to-gpt-4-1-in-the-worker)
- **Reliability** — "Ask this book" indexing no longer gets stuck + reading sessions survive a deleted book — backend + web · [details](docs/changelog-archive/2026-H2.md#2026-07-14-reliability-ask-this-book-indexing-no-longer-gets-stuck-read)
- **Reader** — highlights are now reachable (nav + in-reader drawer/sheet) & translation offers every language — web + mobile · [details](docs/changelog-archive/2026-H2.md#2026-07-14-reader-highlights-are-now-reachable-nav-in-reader-drawer-she)

## [2026.07.13]

- **Reader** — highlights work in the Original-layout PDF reader (web + mobile) · [details](docs/changelog-archive/2026-H2.md#2026-07-13-reader-highlights-work-in-the-original-layout-pdf-reader-web)
- **User books** — metadata enrichment is reliable + visible (description/genre/year) — backend + web + mobile · [details](docs/changelog-archive/2026-H2.md#2026-07-13-user-books-metadata-enrichment-is-reliable-visible-descripti)

## [2026.07.10]

- **Extraction** — drop PDF inline-image extraction for user books (gate, don't delete) — backend (ADR-012 S5a) · [details](docs/changelog-archive/2026-H2.md#2026-07-10-extraction-drop-pdf-inline-image-extraction-for-user-books-g)
- **Mobile** — PDFs render in "Original layout" (PDF.js in the reader WebView) — mobile + shared (ADR-012 S4) · [details](docs/changelog-archive/2026-H2.md#2026-07-10-mobile-pdfs-render-in-original-layout-pdf-js-in-the-reader-w)
- **Reader** — restore the standard chrome in PDF "Original" mode + page bookmarks — web + backend · [details](docs/changelog-archive/2026-H2.md#2026-07-10-reader-restore-the-standard-chrome-in-pdf-original-mode-page)
- **AI quality** — `pdfvision` eval gate scores the PDF vision-RAG feature end-to-end (ADR-012 S3) — backend · [details](docs/changelog-archive/2026-H2.md#2026-07-10-ai-quality-pdfvision-eval-gate-scores-the-pdf-vision-rag-fea)
- **Ask this book** — vision-RAG for PDFs with page citations that jump to the page (ADR-012 S3) — backend + web · [details](docs/changelog-archive/2026-H2.md#2026-07-10-ask-this-book-vision-rag-for-pdfs-with-page-citations-that-j)
- **Reader** — PDF reading progress is page-based (library % + resume) — web + backend (ADR-012 S2) · [details](docs/changelog-archive/2026-H2.md#2026-07-10-reader-pdf-reading-progress-is-page-based-library-resume-web)
- **Reader** — PDFs open instantly, Original-only (ADR-012 S1) — web + backend · [details](docs/changelog-archive/2026-H2.md#2026-07-10-reader-pdfs-open-instantly-original-only-adr-012-s1-web-back)
- **Ops** — root cause: the nightly backup was leaking 156 GB of orphaned pgdata volumes — infra · [**postmortem**](docs/incidents/2026-07-10-backup-leaked-156gb.md) · [details](docs/changelog-archive/2026-H2.md#2026-07-10-ops-root-cause-the-nightly-backup-was-leaking-156-gb-of-orph)
- **Ops** — backup verify self-diagnoses failures + reaps leaked containers — infra · [details](docs/changelog-archive/2026-H2.md#2026-07-10-ops-backup-verify-self-diagnoses-failures-reaps-leaked-conta)
- **Reader** — "Original layout": pixel-perfect PDF view for uploaded books — web + backend · [details](docs/changelog-archive/2026-H2.md#2026-07-10-reader-original-layout-pixel-perfect-pdf-view-for-uploaded-b)

## [2026.07.11]

- **Reader** — hide the misleading word-based % in the PDF Original top bar — web · [details](docs/changelog-archive/2026-H2.md#2026-07-11-reader-hide-the-misleading-word-based-in-the-pdf-original-to)

## [2026.07.09]

- **Auth** — longer sessions: refresh-token TTL 30 → 365 days — backend · [details](docs/changelog-archive/2026-H2.md#2026-07-09-auth-longer-sessions-refresh-token-ttl-30-365-days-backend)
- **Auth** — fix spurious "Unauthorized" mid-session (refresh-token stampede) — web · [**postmortem**](docs/incidents/2026-07-09-refresh-token-stampede.md) · [details](docs/changelog-archive/2026-H2.md#2026-07-09-auth-fix-spurious-unauthorized-mid-session-refresh-token-sta)
- **Library** — drop the shelf carousels, book grid to the top — web · [details](docs/changelog-archive/2026-H2.md#2026-07-09-library-drop-the-shelf-carousels-book-grid-to-the-top-web)
- **PDF reader fixes** — Word/Quartz exports parse cleanly (KMK OSCE model book) — extraction + web/mobile · [details](docs/changelog-archive/2026-H2.md#2026-07-09-pdf-reader-fixes-word-quartz-exports-parse-cleanly-kmk-osce)

---

## Earlier releases

104 entries from 2026-05 to 2026-06 — the AI platform build-out (Phases 1–12), the mobile app, RAG, agents, and the SRS work — are archived in full:

- **2026-06** — 89 entries · [archive](docs/changelog-archive/2026-H1.md)
- **2026-05** — 15 entries · [archive](docs/changelog-archive/2026-H1.md)

Pre-2026 releases: [`docs/changelog-archive/2025-and-earlier.md`](docs/changelog-archive/2025-and-earlier.md)
