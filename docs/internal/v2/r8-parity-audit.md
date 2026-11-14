# R8 parity audit — legacy readers vs the V2 reader page

**Date:** 2026-11-11 · **Issue:** [#1040](https://github.com/mrviduus/textstack/issues/1040) (R8) · **Status:** read-only audit, input for wave planning. Nothing here is decided until the owner answers §6.

R8 deletes the legacy readers (web `ReaderPage`, mobile `ReaderShell`, `packages/reader-engine`) and the transitional
`book_chapters` / `ingestion_jobs` path. ADR-029 names it the reader's point of no return. This audit lists what the
legacy readers do that the V2 page ([`apps/mobile/src/lib/v2reader/`](../../../apps/mobile/src/lib/v2reader/README.md))
does not, sorts each gap, and sizes the waves to R8.

Sources: a code inventory of each of the three readers at `main` 01d9940d (file:line evidence for every row was
collected; the most useful pointers are kept below). "Web" / "Mobile" = the legacy readers; "V2" = the page plus its
two dev hosts (Android `__DEV__` route, web `/dev/reader-v2`).

## 1. Where V2 stands

- **Hosting:** dev-only on both hosts. Android reads bytes by `file://` (dev-only per ADR-029 D4; native https
  serving was the owner's direction 2026-10-30, not built). No iOS. **No production route exists on either host.**
- **Formats:** EPUB, MOBI6, KF8/AZW3 (synthetic evidence), FB2/FBZ, CBZ, PDF (dev hosts; desktop gate half only).
  Legacy reads only server-extracted HTML (EPUB/PDF) plus the ADR-012 PDF viewer.
- **Sync:** Android host has the R6 SQLite library + outbox (reading state + `epub-cfi` annotations). **The web host has
  no sync at all** (localStorage).
- **UI on the page:** text, prev/next, font ±, flow toggle, a dev highlight button (web host only), a dev gloss label.
- **Protocol** (README "Protocol"): host → page `openUrl, restore, highlightSelection, goTo, section/next/prev, font,
  flow, showTranslation`; page → host `ready, opened, open-failed, restored, store, relocate, word, tap, highlighted,
  openLink, telemetry, log`. No message exists for selection, settings, TOC request, search, TTS, sessions or footnotes.

## 2. Parity matrix

Legend — **Need**: `R8` must exist before R8 · `owner` needs a decision (§6) · `drop` not carried (reason given) ·
`fix` a legacy defect, do not port it.

### 2.1 Opening, hosting, errors

| Behaviour | Web | Mobile | V2 | Need |
|---|---|---|---|---|
| Production route for an upload | `/:lang/library/my/:id/read` | `/my-books/read/:id/:slug` | none | R8 |
| Android bytes without `file://` | — | — | `file://` dev-only | R8 (native https serving, ADR-029 D4) |
| iOS | n/a | legacy works | absent | owner |
| SQLite/device-first open, offline | IndexedDB catalog only | yes (reading path needs no token, CLAUDE.md rule) | Android: local file; web: no | R8 (both hosts) |
| Loading state, error states (404, offline, unopenable, retry) | yes (`ReaderScreens.tsx`, `useChapterEngineFailure`) | yes (`Reader.tsx:20-58`) | one error line; no `ready`/`opened` deadline (#1080, #1081) | R8 |
| Corrupt PDF → "Read as text" fallback | yes | yes | n/a (no server text on V2) | drop (V2 has no extracted text by design) |
| Deep link `?highlight=<id>` jumps to a highlight | yes | param passed, **never read** (`app/highlights/index.tsx:147`) | `goTo(cfi)` exists | R8 |
| Deep link `?find=` (content search) | yes | — | — | drop (`V2_FEATURES.contentSearch` false) |
| Renderer crash → rebuild, re-restore | — | yes | yes (reload, refuse after 2nd) | — |
| WebView floor | n/a | any | Chrome 117 | owner (update screen, ADR-029 D6) |

### 2.2 Layout, navigation, chrome

| Behaviour | Web | Mobile | V2 | Need |
|---|---|---|---|---|
| Flow | scroll only | scroll only | paginated + scrolled, live | — (V2 ahead) |
| TOC UI | drawer (Contents/Bookmarks/Highlights) | sheet | data only (`opened.toc`, `relocate.toc`), **no UI** | R8 |
| Chapter prev/next + "n / N" | footer + end-of-chapter bar | footer + in-page block | host buttons ‹ ›, "section i/n" | R8 |
| End-of-chapter block (next title, Discuss, finished book) | yes | yes | absent | R8 (see 2.8) |
| Immersive bars (auto-hide, tap toggles, scroll hides) | yes | yes + first-run coachmark | absent | R8 |
| Tap zones / keyboard page turn | Esc/Ctrl+F only | none | foliate swipe only | owner (paginated mode makes tap zones expected) |
| Android back: close selection → exit prompt | — | yes | absent | R8 |
| Keep screen awake | — | yes | absent | R8 |
| Safe areas, status bar with bars | — | yes | partial (host) | R8 |
| Image lightbox (zoom, pan) | yes | yes | absent | R8 |
| External links | new tab | system browser | `openLink` http(s), allowlisted | — |
| Internal links / footnote in same file | scroll | scroll | foliate navigates (cross-file too) | — (V2 ahead) |
| Footnote popup | no | no | no (foliate `footnotes.js` not built) | owner (nice-to-have) |
| Skip link, `noindex` title | web | — | — | R8 (web) |

### 2.3 Position and progress

| Behaviour | Web | Mobile | V2 | Need |
|---|---|---|---|---|
| Save debounced, flush on hide/background/unmount | yes | yes | 400 ms debounce, saves on relocate | verify flush on background (Android host) — R8 |
| Restore ladder (anchor → offset → %) | engine | engine | CFI + quote check; `pdf-page`; `textstack-*` by fraction | — |
| Cross-device newer-position rule (ADR-019: adopt / move / toast) | silent move, no toast | move or toast | Android: adopt/move/offer banner; **web host: none** | R8 (web host sync) |
| Book % display | top bar + footer | footer | `relocate.fraction` shown raw | R8 |
| Time left (chapter / book) from personal WPM | book, `/me/reading/pace` | chapter | absent | R8 |
| PDF page counter, go-to-page, scrubber | web toolbar | mobile chrome | absent | R8 (with R7) |
| Fixed-layout EPUB saves a position | n/a | n/a | **never** (#1196) | R8 |
| CBZ position synced | n/a | n/a | local only (#1188) | owner |
| "Finish book" | local overlay only (bug, §5) | finished-book block | `completeV2Book` exists, no UI | R8 |

### 2.4 Selection, word tap, translation, explain

| Behaviour | Web | Mobile | V2 | Need |
|---|---|---|---|---|
| Word tap → popup (translation or definition by native language) | `WordPopup` | `SelectionActionBar` inline gloss | popup on both hosts (#1269); an edge word in paginated flow turns the page | R8 |
| Native-language picker inside the popup | yes | yes | legacy's: web in the popup, Android through the gloss line's sheet (#1269) | R8 |
| Multi-word selection toolbar (highlight, translate, explain, listen, copy) | yes | yes | toolbar on both hosts (#1269): highlight, translate, explain, copy; listen with TTS (#1272) | R8 |
| Translation popup / sheet | yes | yes | yes, fetched by the host (#1269) | R8 |
| Explain (streamed) | yes | yes | web streamed; Android one answer, as its legacy sheet (#1269) | R8 |
| `tooLong` (>500 chars) notice | yes | yes | yes (#1269) | R8 |
| Page has no network (CSP) — every lookup through the host | — | — | by design | constraint |

### 2.5 Vocabulary

| Behaviour | Web | Mobile | V2 | Need |
|---|---|---|---|---|
| Save word on tap (sentence, book, translation) + outcomes (`pending`, `lookup`, `deleted` restore) | yes | yes | yes (#1270): web on a tap, Android the bar's Save; `deleted` offers Restore on both | R8 |
| Inline saved-word marks by SRS stage | yes | yes | absent (only a gloss for one tapped word) | R8 |
| Inline translation above saved words (setting) | yes | yes | `showTranslation` per word only | R8 |
| Backfill missing translations once per open | yes | yes | absent | R8 |
| Guest: 3rd word mints a session (web), nudges at 3/10 | yes | nudges | as legacy (#1270) | R8 |
| Mark as known | hook unwired | yes, hidden on V2 | absent | drop (`V2_FEATURES.markAsKnown` false) |
| Vocabulary feed in the V2 local sync (Android) | — | — | absent (feeds: library, reading, annotations) | R8 |

### 2.6 Highlights, notes, bookmarks

| Behaviour | Web | Mobile | V2 | Need |
|---|---|---|---|---|
| Create highlight, 4 colours | yes | yes (last colour) | yellow only; web dev host only | R8 |
| Note, recolour, delete | note/delete (reflow); recolour PDF only | yes | absent | R8 |
| Highlights list, tap to jump | TOC tab | sheet | absent | R8 |
| Offline queue / replay | IndexedDB three-way merge | **none** (error toast) | outbox (Android) | — (V2 ahead on Android); web host R8 |
| `textstack-anchor-v1` annotations | drawn | drawn | dropped (#1195) | owner |
| PDF highlights (rects) | yes | yes | absent | R8 (with R7) |
| Bookmarks | yes; hidden on V2 | yes; hidden on V2 uploads | absent | owner (#1117 said "not until R5/R6"; both are done) |
| Reviewed-highlight marks (chapter review) | yes | — | absent | owner |

### 2.7 TTS, settings

| Behaviour | Web | Mobile | V2 | Need |
|---|---|---|---|---|
| Speak word / selection, speed 0.75–2× | yes (word-by-word overlay on web) | yes | absent (TTS stubbed in the build) | R8 (host-side audio, page highlights the range) |
| Continuous read-aloud, background audio | no | no | no | drop |
| Font size | 14–28 | 14–28 | 12–32 via `font(±)`, no UI | R8 |
| Font family (serif, sans, OpenDyslexic) | yes | yes | absent | R8 (OpenDyslexic is an accessibility feature) |
| Line height | 4 steps | 4 steps | hard-coded 1.7 | R8 |
| Alignment | yes | yes | absent | R8 |
| Theme light / sepia / dark | yes | yes | fixed background | R8 |
| Margins | fixed | fixed | fixed 24 px | — (parity already) |
| Settings persisted per device | localStorage | AsyncStorage | flow only | R8 |

### 2.8 Sessions, stats, assistant, telemetry, accessibility

| Behaviour | Web | Mobile | V2 | Need |
|---|---|---|---|---|
| Reading sessions (heartbeat, idle, queue; V2 `PUT /me/v2/sessions`) | yes | yes | absent | R8 |
| Stats widget (session min, daily goal, streak) | yes | yes | absent | owner (keep or drop) |
| "Discuss chapter" handoff at chapter end / exit prompt | yes | yes | absent | R8 — needs a rule for "chapter" on foliate sections (no `chapterSlug`) |
| Exit prompt "review N words" | — | yes | absent | owner |
| GA4 `book_opened`, `vocab_saved`, session end; Sentry on open failures | web | Sentry init only | `telemetry` → console | R8 (a sink) |
| Accessibility: drawers as dialogs, aria labels, skip link, reduced motion | web | partial (top bar unlabeled) | **nothing** | R8 (at least legacy level) |
| i18n via `t()` | partial | partial | none (dev UI) | R8 (no regression) |

### 2.9 Catalog-only behaviour

Catalog reading, catalog downloads to IndexedDB/SQLite, auto-add to library at 1 %, the "bring your own book"
ask, catalog bookmarks and progress: **drop**. The public catalog retires at M6 (#992 decision, ADR-027 input);
the V2 page never reads catalog editions. Until M6 the legacy reader keeps serving the catalog, so R8 must not
delete it before M6.1 either — see §4.

## 3. Legacy defects found — fix, do not port

| Defect | Where |
|---|---|
| Web TOC shows `chapterNumber + 1` (breaks the "ordering key, not ordinal" rule; uploads show 2..N+1) | `apps/web/src/components/reader/ReaderTocDrawer.tsx:151` |
| Mobile "Auto-save words on tap" toggle is persisted and never read | `apps/mobile/src/components/ReaderSettingsDrawer.tsx:191`, `useReaderSettings.ts:17` |
| Mobile TTS maps any language without a region to `en-US` (a `uk` book speaks with an English voice) | `apps/mobile/src/hooks/useTts.ts:48-54` |
| Mobile `?highlight=` is passed by the highlights screen and read by neither reader route | `apps/mobile/app/highlights/index.tsx:147` |
| Web "Finish book" never marks the book complete on the server | `apps/web/src/pages/ReaderPage.tsx:414-421` |
| Web `ttsVoiceEn` setting stored, never read | `apps/web/src/hooks/useReaderSettings.ts:14` |

The V2 work should not reproduce these; whether to fix them in the legacy readers before R8 is the owner's call (§6).

## 4. What R8 deletes (and what blocks the deletion)

- **Backend:** `/me/v2/books/{id}/files/{fileId}/chapters[/{key}]` and `ChapterReadService`; `IBookChapterRepository`,
  `IIngestionJobRepository`, `TransitionalLocators`, `BookChapter*`, `FileIngestionJob`; the V2 extraction worker
  (`V2IngestionService`, `V2IngestionWorker`) and its enqueue in `LibraryContentService`; `textstack-*` acceptance in
  `SyncValidation`, `ReadingSyncService`, `AnnotationSyncService` and the `book_chapters` EXISTS guards in
  `ReadingStateRepository`; the feed's extraction summary; the ETL steps that write chapters/jobs; schema in
  `database/v2` (a drop migration, M6.4).
- **Shared / clients:** the transitional reader in `packages/shared/src/api/v2.ts` and `v2Books.ts`,
  `packages/shared/src/reader/v2Locators.ts`, the fraction fallback; web `ReaderPage` and every reader-engine consumer;
  mobile `components/reader/*`, `readerEnginePage.ts`, `readerEnginePdfPage.ts`; the ADR-012 viewer once the PDF gate
  passes (#1128).
- **Port first (ADR-032 D6):** the V2 page imports `rangeToLocator`, `textNodes`, `blockOf`, `sentenceAround` from
  `packages/reader-engine`; they move into the wrapper before the package goes.
- **Blocked by:** M5 cutover; the old-client window (60 days, last 14 silent) before `textstack-*` is refused
  (`v2-sync-protocol.md` "Transitional locators"); R4 device gates (#1036); R7 + the PDF gate (#1039, #1128); and,
  for the catalog half of the legacy readers, M6.1.

## 5. Proposed R8 DoD (the plan row's DoD column is empty)

1. Every row marked `R8` in §2 works on the production route of both hosts (web, Android), behind `Features:V2Api`.
2. The owner's §6 decisions are recorded, and the rows they keep are in.
3. Device evidence: the R4 matrix rows and one physical-device pass of the reader on Android; the PDF gate's device half.
4. No client sends `textstack-*` (telemetry shows the old-client window closed).
5. The deletions in §4 merged with the M6.4 drop migration; `dotnet test`, web and mobile suites green; a restore
   drill on the post-drop schema.

## 6. Owner decisions this audit needs

1. Bookmarks on V2 — #1117 deferred them "until R5/R6", both done: in or out?
2. In-book search — web has chapter search, mobile none, foliate's search is stubbed: in or out?
3. Paginated as the default (ADR-032 says yes) → tap zones / volume keys expected?
4. iOS for the V2 reader: in R8 scope or later?
5. Stats widget, exit prompt, reviewed-highlight marks: keep?
6. `textstack-anchor-v1` annotations (#1195) and the CBZ position rule (#1188).
7. Fix the §3 legacy defects in the legacy readers now, or let R8 delete them?

### Recommended answers (2026-11-11)

Given to the owner the same day; the owner answered "ok, do it" to the list. They are the working
defaults for wave 13. A wave that builds on one of them names it in its brief, so the owner can still
say no before code depends on it.

1. Bookmarks: in. Cheap on V2, and readers expect them.
2. In-book search: in, late (wave D). foliate has it; it is only stubbed out of our build.
3. Tap zones: in, since paginated is the default. No volume keys.
4. iOS: after R8.
5. Stats widget and exit prompt: dropped. Reviewed-highlight marks: kept.
6. #1195: list `textstack-anchor-v1` annotations as quotations. #1188: sync the CBZ position by entry name.
7. Legacy defects: the web TOC number and the mobile TTS voice fixed now (#1213); R8 deletes the rest.

## 7. Sizing

| Wave | Work | Depends on |
|---|---|---|
| A | **Done, wave 13 (2026-11-11), dark behind the flag.** Production hosting: Android native https serving (no `file://`), web prod route behind the flag, web host on the shared V2 sync client, error/loading states, `ready`/`opened` deadlines (#1080, #1081) | owner: WebView ≥117 screen |
| B | **Started, wave 14 (2026-11-12):** the frame is built — bars, tap zones, keys, Android back / keep-awake / save on close (#1263, #1264), the web newer-place offer (#1232). Open: TOC #1261, settings #1260, progress #1262, lightbox #1265, finish book #1266, a11y + i18n #1267. Reader chrome: TOC, settings (size, family, line height, align, theme), progress + time left, immersive bars, back/exit, keep-awake, lightbox, finish book, a11y + i18n baseline | A |
| C | **Started, wave 14:** the selection event (#1268). Open: popup #1269, vocabulary save #1270, marks and glosses #1271, TTS #1272. Word layer: selection event in the protocol, word popup/translate/explain via the host, vocabulary save + outcomes, saved-word marks, inline glosses, backfill, guest nudges, TTS for word/selection | A |
| D | Annotations: colours, notes, delete, list, `?highlight=` jump, fixed-layout EPUB position (#1196), sessions to `/me/v2/sessions`, chapter-discuss handoff on sections | B, C |
| E | PDF: R7 host + server round trip (#1039), device half of the gate (#1128), PDF page chrome + highlights, fork fixes (#1203), ADR-012 viewer deleted | A; owner's corpus; fork yes |
| F | R8 deletion: port reader-engine helpers, delete legacy readers + transitional backend + M6.4 drop | M5, old-client window, A–E |

**Estimate: 6 engineering waves (A–F)**, inside the earlier 5–7 guess, now with named contents; B and C can run in
parallel after A. The calendar is bound by M5 and the 60-day old-client window, not by the waves.
Owner answers in §6 can remove work (search, bookmarks, iOS, stats) but cannot remove wave A.
