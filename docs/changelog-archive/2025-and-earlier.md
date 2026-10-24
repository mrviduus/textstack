# Changelog archive — pre-2026 releases

The original hand-written release sections, preserved verbatim.

## [v0.1.0] — 2026-05-06

### Headline

First tagged release of TextStack under **GNU Affero General Public License v3.0**. Earlier development was BUSL-1.1; v0.1.0 onwards is AGPL-3.0 (PR #201). See `release-notes-v0.1.0.md` for the user-facing announcement.

### Library + Mobile parity wave (2026-05-05)

Web library got the duplication / discoverability fixes that surfaced once a real user (mrviduus, 26 uploads) started actually living in it. Mobile then absorbed every web change so iOS/Android shipped in the same shape — no more drift between platforms.

#### Web
- **Shelf "View all →" → dedicated page** ([#203](https://github.com/mrviduus/textstack/pull/203), [#204](https://github.com/mrviduus/textstack/pull/204)) — Continue reading / Recently added / Finished this month each render at `/library/shelf/:id` with the full grid instead of vanishing into a query-string filter.
- **Saved + Uploads merged on /library** ([#204](https://github.com/mrviduus/textstack/pull/204)) — single search, single status-tabs (combined counts), single sort, single grid. Combined merge-sort interleaves both lists; processing/failed uploads pin to top.
- **Add to collection on book detail pages** ([#204](https://github.com/mrviduus/textstack/pull/204)) — new `<AddToCollectionButton>` with `menu` and `button` variants. Wired into kebab, classic detail (when in library), and user-upload detail (when ready).
- **`BookDetailHero` extracted** ([#203](https://github.com/mrviduus/textstack/pull/203)) — cover/title/author/description/meta/actions slots shared by classic and user-upload detail pages. Eliminates the previous duplicate hero markup.
- **Saved cards finally show author** ([#204](https://github.com/mrviduus/textstack/pull/204)) — backend `LibraryItemDto` projects joined author names; combined sort/search use the field; cards render it under the title.
- **Collection sidebar filter applies to both saved + uploads** ([#204](https://github.com/mrviduus/textstack/pull/204)) — parallel fetch of both book-id sets so a single collection click filters everything in unified mode.
- **`status='all'` is the new default** ([#205](https://github.com/mrviduus/textstack/pull/205)) — fresh `/library` no longer applies a hidden Reading filter that silently hid Not-started + Finished books. Sidebar count and grid count finally match.
- **UX polish round 1** ([#218](https://github.com/mrviduus/textstack/pull/218)) — clicking a collection smooth-scrolls to the grid (was an invisible-above-fold change), active chip uses inverted bg/fg + bold + small shadow for Apple-grade visibility in light mode, and Add-to-collection on detail pages becomes a 36×36 circular `+` icon next to share/copy instead of a third giant pill.
- **UX polish round 2** ([#219](https://github.com/mrviduus/textstack/pull/219)) — sidebar is the canonical "+ New collection" entry (chip-row duplicate removed); empty-state chip-row hides entirely; status tabs become `position: sticky` so the active filter stays visible while scrolling a long grid.
- **UX polish round 3** ([#220](https://github.com/mrviduus/textstack/pull/220)) — sticky offset is now `top:80` to match `.site-header` height (no overlap during the collapse animation); destructive `Delete Book` moved out of the primary action row into a quiet "danger zone" text-link below the chapters list (Apple HIG: distance + understatement for destructive actions).
- **UX polish round 4** — Add-to-collection popover gains an inline "+ New collection" form (Apple Notes pattern; no extra dialog); icon buttons get an instant custom CSS hover tooltip instead of the 1-2s delayed native `title=""`; "Delete this book" in the danger zone is now a circular trash icon button matching the `+` icon pattern across the page.
- **UX polish round 5** — drop duplicate `title=""` on icon buttons that already use `aria-label` + custom CSS tooltip (was rendering two tooltips on hover — native after 1s on top of the custom one). Empty-state hint now flows through `aria-label` so the same single tooltip surfaces "Create a collection in the sidebar first" via the custom path.
- **UX polish round 6** — tooltip wraps on narrow viewports. `white-space: nowrap` was clipping the longer empty-state hint at the right edge on phones; now `white-space: normal` + `max-width: min(220px, 100vw - 24px)` keeps it readable across breakpoints. Same fix applied to the delete-icon tooltip.
- **UX polish round 7** — popover state resets on close. Click-outside / Esc / successful pick all flip `expanded:false`, but the `creatingNew` + `newName` state from the inline "+ New collection" form persisted across closes — re-opening landed straight into the input with stale text. Added a small effect that clears both whenever `expanded` becomes false.
- **UX polish round 8** — empty-state pop-over creates inline. Previously `collections.length === 0` made the icon button disabled with a tooltip telling the user to walk over to the sidebar. With the inline create form already living in the popover, that detour was needless: clicking "+ " in empty state now skips the (empty) list and lands directly in the create input.
- **UX polish round 9** — drop dead-code empty-state hint and harden the open-toggle. The grey hint added in round 8 was conditioned `isEmpty && !creatingNew` but the click handler set `creatingNew=true` synchronously on every empty click, so the hint never rendered. Removed the JSX + CSS for it. The click handler now only flips into create-mode when *opening* the popover (was running on close too — harmless but messy).
- **UX polish round 10** — mobile sheet resets on external visibility change. `AddToCollectionSheet` only ran reset() inside its own `handleClose` — when a parent flipped `visible:false` for any other reason (route change, focus loss, programmatic dismiss), `creating` and `newName` persisted into the next open. Same single-effect-on-visible pattern as the web popover (#224).
- **UX polish round 11** — web sidebar drawer mirrors the same reset. `LibrarySidebar` stays mounted and toggles via CSS, so the inline "+ New collection" form state survived re-opens on mobile-shaped viewports. Added a `drawerOpen` prop + effect that clears `creatingCollection` + `newCollectionName` whenever the drawer hides. Desktop sidebar is always visible, so the prop is undefined there and the effect no-ops.
- **Removed 4 unused SEO landing pages** ([#217](https://github.com/mrviduus/textstack/pull/217)) — `/learn-english-{brazil,spain}`, `/read-books-in-english`, `/books-with-translation` plus their components/CSS/routes/sitemap entries/nginx blocks. Not linked, not in sitemap, no traffic signal, three-week stale, and Brazil/Spain shipped with mixed-language UX. ~650 LOC, 23KB JS+CSS gzipped removed.

#### Mobile (iOS + Android)
Same arc, same scope — every web change ported. Shipped over OTA via EAS Updates so existing app installs picked everything up on next launch without a Store rebuild.

- **`DEFAULT_STATUS = 'all'`** ([#206](https://github.com/mrviduus/textstack/pull/206)) — mirror of #205. iOS/Android library now opens with the full collection, not the Reading-only subset.
- **Author on saved cards + sort** ([#207](https://github.com/mrviduus/textstack/pull/207)) — shared `UserLibraryItem` type gains `author`, sortLibraryItems handles author with the same null-rules as uploads, both grid and list views render the author line under the title.
- **Collections support** ([#208](https://github.com/mrviduus/textstack/pull/208)) — shared `collectionsApi` (list/create/update/delete + add/remove/getBookIds). New `useCollections` hook (60s cache + subs). New `<AddToCollectionSheet>` bottom-sheet picker. `useBookActions` accepts `onAddToCollection`; both action sheets prepend it. Detail pages get an "Add to collection" button.
- **Shelf "View all" screens** ([#209](https://github.com/mrviduus/textstack/pull/209)) — `/library/shelf/[shelfId]` route renders a full grid of any shelf; carousel headers gained the link.
- **Sidebar collections section + filter** ([#210](https://github.com/mrviduus/textstack/pull/210)) — drawer renders the user's collections under the source tabs; tapping one filters both saved and uploads in parallel.
- **Auto-refetch on cache invalidation** ([#211](https://github.com/mrviduus/textstack/pull/211), [#212](https://github.com/mrviduus/textstack/pull/212)) — adding a book to the active collection now re-fetches the membership immediately. Implemented via a versioned subscription that landed first as a hand-rolled hook then rewrote on `useSyncExternalStore` for tear-free concurrent reads.
- **EAS Updates wired up** ([#213](https://github.com/mrviduus/textstack/pull/213), [#214](https://github.com/mrviduus/textstack/pull/214)) — `runtimeVersion: { policy: "appVersion" }` + `updates.url` pointing at the existing EAS project. `eas update --platform all` now ships JS-only changes to existing apps without a binary rebuild.
- **Web shim for offlineDb** ([#215](https://github.com/mrviduus/textstack/pull/215)) — `apps/mobile/src/lib/offlineDb.web.ts` no-op stubs unblock `eas update --platform all`. expo-sqlite was pulling its `.wasm` import into the web bundle and crashing the export.
- **dist-web/ added to .gitignore** ([#216](https://github.com/mrviduus/textstack/pull/216)) — prevents test-export artefacts from being committed.



Complete rebuild of the user-owned books experience. From "upload buried 4 clicks deep" to a Kindle-class library with tags, collections, full-text search, AI assistance, and command palette. 20 slices shipped behind feature flags then enabled all-on after stable rollout.

#### Upload UX
- **Persistent upload button in header** ([`28a377c`](https://github.com/mrviduus/textstack/commit/28a377c)) — `+ Upload book` button now lives in the main header on every page; Cmd+U opens the modal from anywhere. Cuts upload from 4 clicks to 1.
- **Drag-and-drop anywhere on web** ([`1592991`](https://github.com/mrviduus/textstack/commit/1592991)) — drop an EPUB / PDF / FB2 onto any page and the upload modal opens with the file pre-loaded. Matches the Notion / Linear / Slack pattern modern users expect.
- **Library empty state is now an active drop zone** ([`d7ec6bb`](https://github.com/mrviduus/textstack/commit/d7ec6bb)) — first-run users see a large drop-zone CTA instead of a passive "no books yet" message. The empty state now teaches the upload action by demonstrating it.

#### Library
- **Continue Reading shelf at the top of Library** ([`34d818e`](https://github.com/mrviduus/textstack/commit/34d818e)) — last-opened books appear as a horizontal shelf so resuming is one tap, not a scan of the grid. The #1 reason users open Library now has a one-tap path.
- **Cover grid with progress and status badges** ([`34d818e`](https://github.com/mrviduus/textstack/commit/34d818e)) — bigger covers, percent-read printed on the cover, and Reading / Finished / Processing / Failed badges that read at a glance. Brings the grid up to Kindle quality.
- **Five-option sort menu** ([`35747c2`](https://github.com/mrviduus/textstack/commit/35747c2)) — Recently opened (default), Recently added, Title, Author, Progress. Replaces the limited 3-option control and matches Kindle / Calibre conventions.
- **Filter chips for reading state** ([`35747c2`](https://github.com/mrviduus/textstack/commit/35747c2)) — All / Reading / Finished / Not started / Failed chips above the grid. Users with 20+ books can now scope to "what am I reading right now" without scrolling.
- **In-library search by title and author** ([`35747c2`](https://github.com/mrviduus/textstack/commit/35747c2)) — search bar filters the grid live as you type. At 50+ books, recall beats browsing.
- **Unified per-book action menu** ([`35747c2`](https://github.com/mrviduus/textstack/commit/35747c2)) — single `BookActionMenu` replaces the two drift-prone menus (saved vs uploaded). Adds Mark finished / unfinished and creates the surface for slices 11+.

#### Power features (tags, collections, search, stats)
- **Editable book metadata** ([`1e74a6a`](https://github.com/mrviduus/textstack/commit/1e74a6a)) — modal to fix title, author, language, genre, and description on uploaded books. Respects user agency when LLM enrichment guesses wrong.
- **Free-form tags on uploaded books** ([`a35ec67`](https://github.com/mrviduus/textstack/commit/a35ec67)) — attach multiple tags (`fantasy`, `for-work`, `2026-reading-list`), filter by tag, and use `tag:` syntax in search. Power-user organization Kindle's collections cannot do.
- **Collections — named shelves** ([`cb255ec`](https://github.com/mrviduus/textstack/commit/cb255ec)) — create shelves like "Summer reading" or "Russian classics" and put books in many at once. Complements tags: tags are facets, collections are intentional groupings.
- **Bulk select + bulk actions** ([`d7b6c6b`](https://github.com/mrviduus/textstack/commit/d7b6c6b)) — multi-select books and apply Mark finished, Add to collection, Add tag, or Delete in one go. Necessary for hygiene at 30+ books.
- **Per-book personal stats page** ([`3f2419e`](https://github.com/mrviduus/textstack/commit/3f2419e)) — book detail now shows hours read, words encountered, vocab saved from this book, highlights count, sessions, and current pace. The data Kindle does not give you.
- **Full-text content search across uploads** ([`e2830ca`](https://github.com/mrviduus/textstack/commit/e2830ca)) — opt-in toggle extends Library search into chapter content via PostgreSQL FTS. "I remember a passage about X" now has an answer.

#### AI + polish
- **AI auto-tag suggestions via Ollama** ([`c3c6d3f`](https://github.com/mrviduus/textstack/commit/c3c6d3f)) — after ingestion, Ollama proposes 3–5 tags from title, author, and the first chapter; one click to accept. Removes the friction of manual tagging from slice 12.
- **Cmd+K command palette** ([`b0f1c74`](https://github.com/mrviduus/textstack/commit/b0f1c74)) — search-driven palette to jump anywhere or run any action in one keystroke. Standard pattern in Linear / Raycast / GitHub — devs and students will recognize it.
- **Reading time estimate per book** ([`9701567`](https://github.com/mrviduus/textstack/commit/9701567)) — "~3h 20m left" on cards and detail pages, computed from the user's actual pace, not a generic 200 wpm. Tiny touch, big perceived smarts.
- **Library stats dashboard strip** ([`391ff64`](https://github.com/mrviduus/textstack/commit/391ff64)) — compact monthly snapshot at the top of Library: pages this month, current streak, goal progress. Surfaces the value of staying in TextStack without forcing users into the Stats page.

#### Cleanup
- **Slice 99 — drop feature flags** ([`08d9de8`](https://github.com/mrviduus/textstack/commit/08d9de8)) — removed 19 flag references and `features.ts`. Features now always-on. Roadmap closed.

### SEO Backfill Automation (2026-04-14)
- **ADR-010** — `docs/ADR-010-seo-backfill-automation.md` describes architecture.
- **Editable prompt templates** — admin panel CRUD (per entity_type × field_type × language), version-frozen on edit.
- **DB-backed queue** — `seo_backfill_jobs` with atomic `FOR UPDATE SKIP LOCKED` claim.
- **Separate systemd poller** — `seo-backfill-poller` (does not mix with `seo-publish-poller`). Setup via `make seo-backfill-setup`.
- **Claude CLI generation** — JSON schema validation with 3 retries on invalid output.
- **Before/After snapshots** — full revert support even after success.
- **Coverage dashboard** — Author/Edition/Genre gap tracking per FieldType.
- **Review gate** — default ON, progressive trust via `trust_level` (manual → review → auto). Strictest wins for multi-field jobs.
- **`seo_source` column** — `manual` | `auto` | `hybrid` on Author/Edition/Genre/BlogPost; auto-skip entities marked `manual`.
- **Prompt injection guard** — `SeoPromptSanitizer` strips role markers (`assistant:`, `system:`) and template delimiters.
- **Admin UI** — `/seo-backfill` with Coverage, Templates, Jobs, Settings tabs.
- **Deploy** — `deploy.yml` restarts `seo-backfill-poller` post-deploy; Makefile `make deploy` mirrors.
- **Deprecates** `docs/seo-content-task.md` manual tracker — migrate to `/seo-backfill`.

### Practice & Review UX Improvements (2026-04-08)
- **Flashcards default mode** — classic flashcards now first and default (was Blitz)
- **Retry wrong words** — optional "Retry wrong words (N)" button on session summary to re-practice mistakes
- **Practice always available** — button never disabled, backend `includeAll` serves non-due words when queue empty
- **Real-time streak badge** — progress ring updates live during review via custom event + optimistic UI
- **Streak goal = 10 words** — progress ring fills to 10, turns green when goal met, amber while in-progress
- **No negative messaging** — removed "keep practicing" tier, lowest is now "Great work!" even at 0%
- **Twemoji flags** — replaced Unicode emoji flags with Twemoji CDN SVGs (fixes Windows rendering)
- **Dark mode badge fix** — explicit colors instead of CSS vars that blended with dark background
- **Popup flicker fix** — outside-click handler uses container ref to avoid toggle race condition
- **No-cards redirect** — review page redirects to practice instead of showing dead-end empty state
- **Vocabulary table on practice page** — shows all words sorted by due date (was "reviewed today" only)
- **Refactor** — removed redundant `NativeLang.flag` field, deduplicated banner/label logic

### Vocabulary Review Overhaul (2026-04-06)
- **Blitz + Classic modes** — segmented control on Practice page, Blitz (MC cards) and Classic (3D flip flashcards with self-assessment)
- **Classic Flashcards** — CSS 3D flip animation, self-assessment buttons (Forgot/Almost/Knew), maps to SRS isCorrect
- **New Word intro card** — shown for stage=0 words before quiz: word, sentence, translation, AI explanation
- **AI explanation** — Ollama generates 2-3 sentence explanation in native language when word saved, shown on NewWordCard
- **Sound effects** — Web Audio API synthesized sounds (correct/wrong/flip/complete), toggle in review header
- **Session summary redesign** — reward banner (4 tiers), stats row, action buttons
- **Practice page redesign** — removed emoji icons, Apple-like card sections, mode selector
- **Dark mode fix** — replaced undefined CSS vars (`--color-surface`, `--color-hover`) with proper theme vars
- **Removed typing mode** — ContextCard deleted, context cloze now uses MC (backend returns `multiple_choice`)
- **Ollama model upgrade** — switched from `gemma3:4b` to `qwen3:8b` for better multilingual quality
- **Mobile: vocab review overhaul** — ported all web review changes to React Native
  - Blitz (MC) + Classic (FlashCard with 3D flip) modes
  - Haptic feedback (expo-haptics): correct/wrong/flip/complete
  - NewWordCard for stage=0 words, ReviewFeedback (mini/full), SessionSummary with reward tiers
  - Mode selector (Blitz/Classic toggle) on vocabulary index
  - Word list context snippets with bold word in sentence
  - MC fix: `correctOptionIndex` instead of string comparison
  - Removed dead code: ContextCard, fuzzyMatch, levenshtein, inline feedback/summary

### Auto Publish — Automated Book Publishing Pipeline (2026-04-02)
- **Auto-publish admin page** — configurable pipeline: Draft → SEO generation → publish, fully managed from admin panel
- **SEO generation via Claude CLI** — `seo-generate.sh` calls `claude-sonnet-4-6` to generate description, relevance, themes, FAQs for editions and authors
- **Polling daemon** — `seo-publish-poll.sh` (systemd) polls DB every 60s, processes queued jobs
- **Settings** — books/day (1–10), hour UTC, require review gate, language filter, enable/disable toggle
- **Priority queue** — admin can queue specific editions with priority, processed first regardless of schedule
- **Candidates view** — shows Draft editions ready to publish with SEO readiness indicators (D/R/T/F)
- **Internal publish endpoint** — `POST /internal/editions/{id}/publish` (Docker network only), triggers SSG automatically
- **SSG periodic rebuild settings** — moved from `appsettings.json` to admin panel (enable/disable, interval hours)
- **Integration tests** — 10 auth tests for all admin autopublish endpoints

### Admin Improvements (2026-04-01)
- **Publish/unpublish buttons** on author detail page
- **SEO readiness filter + badge** for editions & authors lists
- **Dashboard** — live stats, recent jobs, blog metrics
- **Default og:image fallback** for pages without cover

### User Features (2026-03-28)
- **Email/password auth** — register, login, forgot password flow
- **User profile** — avatar upload + name edit
- **Vocabulary fix** — typed recall mode no longer requires exact word typing
- **Selection toolbar fix** — word selection works correctly in reader

### Mobile App (2026-03-25)
- **Full PWA parity** — shared API refactor, offline reading, progress sync
- **Top bar fix** — render after WebView so icons visible
- **User book reader fix** — missing slug param in appendChapter

### CodeGen — AI Code Generation (2026-03-22)
- **CodeGen admin page** — describe a task, Claude Code implements it in iterative loop (Ralph pattern), creates PR
- **PDD auto-generation** — each job creates a Product Design Doc in `docs/05-features/codegen-{id}.md` on first iteration
- **Host-based execution** — uses Claude Code CLI with Max subscription (OAuth), runs on host via `codegen-poll.sh`
- **Rerun support** — restart terminal jobs with clean state
- **Hardening** — input validation, timeouts, double-click guard, branch checkout verification
- **Mobile-responsive admin** — hamburger menu, off-canvas sidebar, responsive tables/forms for all admin pages

### Vocabulary
- **Vocab review card** removed from homepage
- **Dark mode fix** — vocab review button invisible in dark mode
- **Button overflow fix** — vocab review card button on narrow screens

### SSG / SEO — Critical Fix (2026-03-12)
- **Fix: SSG saved error pages as permanent static files** — if API failed during prerender (timeout, 499), broken HTML with `noindex` was saved and served to Google. Now skips saving pages with `noindex` meta tag
- **Fix: detail pages treated all errors as 404** — created `errorUtils.ts` with `isNotFoundError()`. Only real HTTP 404 gets `noindex`; transient errors (499, timeout) no longer add `noindex`
- **Fix: Google JS hydration overwrites SSG** — strip `<script type="module">` and `<link rel="modulepreload">` from SSG output so Googlebot can't re-execute React
- **Fix: SSG worker blocked by AllowedHosts** — added Docker hostname `api` to `AllowedHosts` in `appsettings.json`
- **Fix: nginx served SSG to all users** — `if ($is_bot)` inside regex location broken ("if is evil"). Replaced with `map $is_bot $ssg_file` + `try_files` — bots get SSG, real users get SPA
- **Fix: Google Live Test got SPA instead of SSG** — `Google-InspectionTool/1.0` UA didn't match bot detection. Added to `map $http_user_agent $is_bot`
- **Fix: nginx sites-enabled was stale copy** — `sites-enabled/textstack` was a file, not symlink. Deploy now creates symlink via `ln -sf`
- **Retry logic** — failed routes retried up to 2x during SSG rebuild
- **Deploy SEO smoke test** — new CI step verifies `X-SEO-Render: spa` for real users, bot detection active, nginx bot map configured
- **Backup cleanup** — keep only 5 newest backups (deploy + scheduled), freed 37GB disk
- **Admin blog INTERNAL_ERROR** — all admin blog endpoints used `GetSiteId()` which throws on admin routes (SiteContextMiddleware skipped). Changed to `[FromQuery] Guid siteId` (PR #37)

### Blog
- **Full-stack blog** — admin CRUD, public pages, comments (2-level threaded), likes, share buttons
- **Admin panel** — create/edit/publish/unpublish, cover upload, stats, search, status/language filters
- **Web** — `/:lang/blog` list, `/:lang/blog/:slug` detail, Article JSON-LD, internal link interception
- **SSG** — prerender blog list + detail, `/sitemaps/blog.xml`, nginx location blocks
- **i18n** — en + uk translations, legacy URL redirects for `/blog`

### Vocabulary
- **Definition on review cards** — show dictionary definition below book sentence on all card types (MC, typed recall, context, feedback)

### TTS (Text-to-Speech)
- **Edge TTS integration** — direct WebSocket to `speech.platform.bing.com`, no deps, no API key
- **`TextStack.Tts`** — separate class library: `EdgeTtsClient` (WebSocket protocol), `EdgeTtsService` (disk cache + SemaphoreSlim)
- **API**: `GET /api/tts?text=&lang=&speed=` → MP3, `GET /api/tts/voices?lang=` → voice list
- **Two-layer cache** — server disk (SHA256 key, 30d TTL, 1GB limit) + client IndexedDB (30d TTL)
- **Vocabulary** — speak buttons on word list + all SRS cards (MC, typed recall, context, feedback)
- **Reader** — speak in SelectionToolbar, DictionaryPopup (word), TranslationPopup (source + translated)
- **Settings** — TTS speed in ReaderSettingsDrawer (0.75x – 2.0x)
- **Voices** — `en-US-AriaNeural` (en), `uk-UA-PolinaNeural` (uk), 200+ available
- **Tests** — 19 unit (EdgeTtsServiceTests), 11 integration (TtsEndpointTests), 6 E2E (tts.spec.ts)

### SEO Content — Full Coverage
- **654 authors** with full SEO (bio, relevance, themes, FAQs) — 100% of indexable authors
- **1,567 editions** with full SEO (description, relevance, themes, FAQs) — 100% of published editions
- **52 Ukrainian authors** — all with Ukrainian-language bios, themes, FAQs
- **~412 one-book English authors** — A–X alphabetical bulk generation
- **Priority authors**: Trollope (22), Wallace (19), Leblanc (12), Orczy (12), Norton (10)
- **73 two-book authors** + all 3+ book authors completed in earlier batches
- FAQ schema markup for rich snippets in search results

### Features
- **Authors pagination** — paginated author listing page
- **Header search fix** — query preserved on navigation
- **Reading progress** — cross-language library links, session reliability
- **i18n book detail** — all hardcoded English strings translated
- **EPUB fix** — handle self-closing `<script/>` in XHTML

### Content: OpenBook2 Ukrainian Library Import
- **220 EPUB books** imported from [OpenBook2](https://sites.google.com/view/openbook2) (public domain Ukrainian classics)
- **~50 Ukrainian authors** created — Franko, Shevchenko, Lesya Ukrainka, Kotsiubynsky, Shakespeare, Dickens, etc. (stored as Франко, Шевченко, Леся Українка, Коцюбинський, Шекспір, Діккенс)
- **Categories**: Ukrainian literature, world literature, public digitization (stored as українська література, світова література, суспільне оцифрування)
- **Scraper**: Node.js script crawled Google Sites pages, extracted Google Drive EPUB links, downloaded 311 MB
- **Upload**: batch upload via admin API with auto author/genre creation
- **Source**: OpenBook2 — an online library of Ukrainian and world classics

### Rebrand: OnlineLib → TextStack
- **Solution & projects renamed** - `onlinelib.sln` → `textstack.sln`, `OnlineLib.*` → `TextStack.*`
- **C# namespaces updated** - 70+ files migrated to `TextStack.*` namespaces
- **Telemetry renamed** - service names `textstack-api/worker`, activity sources `TextStack.*`
- **GitHub repo renamed** - `github.com/mrviduus/textstack`
- **Deployment paths updated** - workflows, Makefile, nginx config

### Single Domain Consolidation (ADR-007)
- **textstack.app** - single public domain for all books
- **textstack.dev** - admin panel only (auth-gated, noindex)
- **Migration** - merge programming books to general site
- **Admin Tools page** - reprocess, reimport, sync operations
- **Removed multisite code** - HostSiteResolver, SiteService, AdminSitesEndpoints
- **Admin port** - changed from 5174 → 81 (easier to remember)
- **SSG Worker** - Docker service polls DB for rebuild jobs, prerenders pages automatically
- **See**: `docs/01-architecture/adr/007-single-domain-consolidation-deploy.md`

### Removed
- **DjVu format support** — unused, removed extractor, tests, Docker deps
- **Tempo** - distributed tracing service removed to save ~350MB RAM
- **Multisite infrastructure** — HostSiteResolver, SiteService, SitesPage (ADR-007)
  - Traces still collected via OTEL but not stored
  - To restore Tempo in future, see `docs/tempo-restore.md`

### Offline Reading (PWA)
- **IndexedDB storage** - chapters cached locally for offline reading
- **Download manager** - global context tracks active downloads, progress, errors
- **Resume support** - paused/interrupted downloads continue from last chapter
- **Storage quota check** - warns when <50MB available, handles QuotaExceededError
- **Kindle-style library UI** - 3-dots menu with download/resume/remove options
- **Offline badge** - visual indicator (download icon, spinner, pause icon)
- **Cache-first reader** - serves from IndexedDB when available

### User Authentication
- **Google OAuth** - cookie-based auth with JWT refresh
- **User library** - save/unsave books, persisted server-side
- **Reading progress sync** - resume position synced to server
- **Continue Reading** - library shows last read chapter with progress bar

### Library
- **My Library page** - grid view of saved books
- **Progress indicators** - visual progress bar per book
- **Read/unread status** - mark books as read
- **Quick actions** - context menu for common operations

### Search Improvements
- **Enter to search** - pressing Enter navigates directly to search page
- **Overlay close fix** - View All Results properly closes overlay
- **Direct navigation** - search input triggers page navigation

### Admin
- **Stats cards** - authors/genres pages show count summaries
- **Genres filter alignment** - consistent with authors page layout
- **Published filter** - sitemap/admin respects publication status

### SEO - Chapter Splitting
- **Chapter splitter** - long chapters auto-split at word boundaries (HTML block-aware)
- **Site-level config** - `MaxWordsPerPart` per site (general: 1000, programming: 2000)
- **Split-on-publish** - chapters split before publishing, reload after split
- **Reprocessing API** - `POST /admin/reprocess/split-existing` for batch reprocess
- **GeneratedRegex** - compiled regex patterns for performance

### Reader
- **Theme cleanup** - reader theme properly reset on unmount (fixes body class leak)
- **Mobile progress** - footer shows overall book % instead of chapter %
- **Help button** - hidden on mobile (keyboard shortcuts not applicable)
- **Scroll tracking** - mobile progress bar reflects scroll position
- **Double-tap fullscreen** - double-tap on content toggles fullscreen (mobile)

### SEO
- **Legacy URL redirects** - 301 redirect `/authors/*` → `/en/authors/*` (nginx + React Router)
- **Google Search Console fix** - non-prefixed URLs now properly redirect to language-prefixed versions

### i18n
- **Full Ukrainian i18n** — all pages translated (en/uk JSON files)
- **Dynamic language** in library list view links

### E2E Testing
- **Playwright e2e tests** — chromium, mobile, admin projects with CI pipeline
- **Flaky test fixes** — bookmark test waits for btn enabled before click

### Reader
- **Text selection** — highlights, translate (LibreTranslate), dictionary
- **iOS selection toolbar fix** — use `selectionchange` event, suppress native context menu in PWA

### Infrastructure
- **Regex timeouts** in text processors
- **Retry on 5xx/429 errors** — error state in home sections
- **Separate storage URL config** — reader highlights height fix

### SEO
- **Trailing slashes** on all sitemap URLs (books, authors, pages)
- **IndexNow API key** for Bing indexing
- **URL redirects & canonicalization** — redirect logic in HTTP block for Cloudflare SSL

### Ops
- **Sudoers** for passwordless nginx deploy
- **Backup directory** → `~/backups/textstack`
- **Docker context fix** — `.dockerignore` to exclude data folder, permission fixes

### Removed
- **Old IndexNow key file**
- **Redundant download button** from library list

### Documentation
- **database.md** - Updated to match actual schema: added UserRefreshToken, BookAsset, TextStackImport, SeoCrawlJob, SeoCrawlResult; fixed Chapter/User/IngestionJob/ReadingProgress/Bookmark/Note schemas; removed non-existent search_documents table

---

## [0.1.0] - 2025-01-09 - MVP 1

### Reader
- **Full-featured Kindle-like reader**
  - Centered text column, responsive layout
  - Settings drawer: font size, line height, width, theme (light/sepia/dark), font family, text alignment
  - TOC drawer, chapter prev/next navigation
  - Progress % indicator, localStorage persistence
- **Fullscreen mode** - auto-hide top/bottom bars, `F` shortcut
- **Keyboard shortcuts** - arrow keys, `?` for help modal, help button in top bar
- **Mobile support** - swipe navigation, centered nav arrows
- **Visual effects** - aged book edge / burnt paper effect

### UI/UX
- **Header** - collapsing animation on scroll, language switcher (UA/EN)
- **Search** - integrated in header, fuzzy/typo-tolerant, view all results link fix
- **Home hero** - responsive layout, improved alignment
- **Book grid** - responsive layout improvements
- **About page** - creator section with image

### Backend
- **SEO module** - `GET /seo/sitemap.xml`, `SeoService`, `SeoHead` component
- **Full-text search** - PostgreSQL FTS, pg_trgm fuzzy search, GIN indexes
- **Example books seeder** - migration seeds sample data
- **Public API** - `/books`, `/books/{slug}`, `/books/{slug}/chapters/{chapterSlug}`, `/authors`, `/genres`, `/search`
- **Admin API** - file upload, ingestion jobs CRUD
- **EPUB parser** - VersOne.Epub + HtmlAgilityPack, chapter extraction
- **Ingestion worker** - background polling, EPUB → chapters, search_vector indexing
- **Data model** - Work/Edition hierarchy, Admin auth system, UserLibrary
- **Admin app** - separate React app on port 81

### Changed
- Rebrand to **TextStack**, default language to English
- Book/Translation → Work/Edition data model
- Swashbuckle → Scalar.AspNetCore for OpenAPI
- Docker compose defaults (`.env` optional)

### Technical
- Fresh migration: `Initial_WorkEdition_Admin`
- Removed: Book, BookTranslation, ChapterTranslation entities
