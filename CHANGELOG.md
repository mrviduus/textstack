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

- **Progress** — one "mark as finished" across web and mobile, and the first write for a book stops being the exception — backend, web, mobile, shared · [details](docs/changelog-archive/2026-H2.md#2026-09-10-progress-the-same-action-writes-the-same-thing)
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
