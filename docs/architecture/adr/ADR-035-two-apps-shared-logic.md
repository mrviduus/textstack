# ADR-035 — Two apps, one logic: shared hooks now, one Expo app only if measured

**Status:** Accepted · **Date:** 2026-11-27 · **Builds on:** [ADR-029](ADR-029-foliate-for-v2-epub.md), [ADR-032](ADR-032-one-engine-foliate-fork.md), [ADR-033](ADR-033-client-is-the-only-parser.md) · **Issue:** #1329

## Context

TextStack has two UI apps for one product: `apps/web` (React + Vite, plain CSS) and `apps/mobile`
(Expo 57, expo-router, React Native). Most features are written twice. The question in #1329: replace
`apps/web` with the Expo app running in the browser (`react-native-web`), or remove the duplication
another way.

### Where the lines are

Non-test source at `988a409e` (`wc -l`; tests, mocks and `.d.ts` excluded):

| | `apps/web` | `apps/mobile` |
|---|---|---|
| Total | 30.2k (18.4k TS/TSX + 11.8k CSS) | 23.0k |
| Logic written on both sides | 4.9k | 3.8k |
| Views written on both sides | 17.1k (7.3k TSX + 9.8k CSS) | 10.6k |
| Platform-only logic (storage, auth transport, downloads, OTA) | 2.0k | 4.8k |
| Reader host (must stay per platform) | 1.5k | 2.6k |
| Views on one side only | 4.0k | 0.6k |

`packages/shared` (7.2k) already holds the API client, sync calls, types, i18n and reader locators;
`packages/reader` (the reader page) is already one for both. The duplication is in views and CSS,
then in hooks and contexts.

How much of a logic pair really overlaps, read file by file (estimates): `useBookReviews` 95%,
`useVocabularyReview` 80%, `useLibrarySort` 80%, `useAssistantLauncher` 65%, `useReadingSession` /
`pendingSessions` 60%, `NativeLanguageContext` 55%, reader word/vocabulary logic 40%, auth 25%, reader
data sync 15% (web is online-only, Android is a local-first SQLite outbox: two architectures), TTS 15%.

The copies have drifted:
- Web's `useReaderSettings` saves the whole settings object under `reader.settings.v1`, so every default
  is stored as if the reader chose it, and a later change of a default never reaches them. Android
  fixed this with `reader.settings.v2`, which stores only what the reader changed.
- Android's `submitReview` sends no `operationId` or `reviewMode`; the shared client fills a fresh id
  and `'review'`, so the answer is recorded, but a retry is a new operation and the chosen mode is lost.
- `getReviewQueue`'s second argument is `true` on web and the practice flag on Android.

### The spike (2026-11-27)

Both apps built from the same commit; the Expo app exported with `npx expo export --platform web`,
served statically, opened at 1440×900 in Chromium.

| | Today's web app | Expo web export |
|---|---|---|
| JS + CSS to show the library, first open | 0.73 MB raw, **0.20 MB gzip** (`index`, `react-vendor`, CSS, `LibraryPage` chunk) | one bundle, 10.7 MB raw, **4.2 MB gzip** |
| Same, after keeping the reader page out of the bundle | — | 5.0 MB raw, **1.24 MB gzip** (6× web) |
| Code splitting | per route | none (`app.json` sets no async routes) |

- The Android reader page (`readerPage.generated.ts`, a 5.7 MB string) is inside the Expo web bundle,
  because `pageWebView.ts` imports it statically.
- The library signed out shows "Couldn't read the books on this device": `deviceLocalLibrary()` throws
  on web (`deviceLibrary.web.ts`).
- The layout is the phone layout stretched to 1440 px: a floating bottom tab bar, no header, no sidebar,
  no wide grid. Buttons render as `div`s; Tab order works on the tab bar and the page's own buttons.
- Not measured: signed-in screens (bearer login across origins needs CORS setup) and a reader, which
  Expo web does not have.

What the Expo app lacks on the web, from reading the code:

| Missing | Size |
|---|---|
| Reader: `ReaderScreen.tsx` returns "This reader runs on Android only" off Android; the web host (iframe, nonce CSP frame, server-backed session) would be ported from `ReaderHost.tsx` | L |
| Word popup, selection toolbar, translate/explain popups on web | L |
| Desktop layout: header or sidebar, wide grids, max-width containers | L |
| Storage: a server-backed library in place of SQLite and device files; upload from a `File` | M |
| Auth: tokens sit in `localStorage` (web keeps them in HttpOnly cookies); no Google sign-in on web | M |
| Keyboard: Cmd/Ctrl+K palette, Cmd/Ctrl+U upload, Cmd/Ctrl+F search, Escape, focus traps, hover | M |
| Routes: `/:lang/…` prefix; `/device`, `/connect-extension`, `/en/oauth/consent`, `/en/reset-password` are hard-coded by the backend and the browser extension | M |
| nginx and CI: `/library` and `/about` 301 rules, `/_expo/static` caching, CSP of the export, the reader frame files, `deploy.yml`/`images.yml` build `apps/web` | M |

Release coupling: `apps/mobile` changes ship to Android as an OTA on every merge (`mobile-ota.yml`),
and a change to `app.json` or a native dependency moves the runtime fingerprint, which starts a Play
store build. Every web change would travel that way.

## Options

| | Lines removed (net) | Time | Risk |
|---|---|---|---|
| **A.** One Expo app for Android and web; `apps/web` deleted | ~17–21k (mostly CSS and views) | 8–12 weeks | High: reader, layout, auth, routes, hosting all rebuilt; web ships through the mobile release path; bundle 6× larger |
| **B.** Two apps; duplicated logic moves into `packages/shared` as headless hooks, apps keep views | ~1.3k code, ~0.5k tests | 1–2 weeks | Low |
| **C.** B now; A re-decided later with numbers | B now | B now | Low now |
| **Reader chrome inside the reader page** (TOC, settings, search, word popup drawn once by `packages/reader`, for both hosts) | ~4k (unverified) | spike first | Medium: Android touch feel inside a WebView |

## Decision

**C.** Two apps stay. The logic both apps run moves to `packages/shared` now; views stay per app. A is
not rejected forever, but it is not started: the spike shows a phone shell that would have to grow a
reader, a desktop layout and a web auth before it matches what `apps/web` already does, at 6× the
download.

Rules for the move:
- A shared hook takes what differs as plain arguments: storage (`get`/`set`, sync or async), opening a
  URL, minting an id, the current user. No new interface types around them.
- Merged: hooks and contexts with high overlap (list below). **Not merged:** reader data sync (two
  architectures, and Android's must work with no network and no account), TTS playback, `useBookActions`
  (a web hook vs an Android action sheet), the reader hosts.
- Where the copies drifted, the shared version takes the correct behaviour (Android's settings rule,
  web's `operationId`/`reviewMode`), and the PR says what changes for the reader.

Dead code goes first, on both sides and in the backend.

**Reopen A** only when both hold:
1. The Expo web build downloads at most 1.5× what today's web app downloads to show the library
   (gzip JS + CSS on first open; 0.20 MB today, so ≤ 0.30 MB).
2. The reader chrome lives in the reader page (phase P2 passed), so A's largest missing pieces exist once.

## Plan

Each phase is small PRs; nothing starts without the owner's "start".

**P0 — delete, no refactor (~−4k lines + dead CSS)** (#1624, #1625)
- Web: DTO types in `api/vocabulary.ts` and `api/userBooks.ts` that copy `@textstack/shared` types;
  `api/explain.ts` (shared `explainApi` does it); the hand-written fetch in `api/translation.ts`, and its
  `getLanguages`, which nothing calls (its backend route answers 404 in production).
- `packages/shared` modules no app imports: `achievements`, `vocabLevel`, `lib/pathPrefix`,
  `reader/progressLocators`.
- Dead CSS: selectors in `books.css` (3.4k), `vocabulary.css` (2.5k), `reader.css` (2.2k) that match
  no element after the M6 retirements. Size known after the scan.
- Backend, no callers: `AiProviderReadinessCheck`, `OllamaLlmClient`, `ProviderHealth`,
  `ProviderCircuit`, `RouteAlarm`, the compose `ollama` service and the `Ai:Routes` entries for retired
  features (check production overrides first); `LocatorSpace`; the review-question repository and the
  unused `IBookInsightRepository` review methods; `IEmbeddingService` and its client;
  `ImageProcessingHelper`; the legacy `ILlmService` adapter and factory; the admin-settings write path;
  `PUT /me/v2/books/{id}/checkpoint-saving`; `IUserRepository.SetRoleAsync`; `/translate/languages`
  and the second `/api/translate` mapping; the duplicate Base64Url and etag helpers.
- Backend agent and tool stack, own PR: `Ai.Agents`, `Ai.Tools`, `Application/Tools`,
  `EnrichmentAgent` and its prompt and result, the agent and crew types in `Ai.Core`,
  `AgentRunWriter`, the enrichment eval, and `Api`'s unused EvalSuite reference. Explain and translate
  call the LLM client directly (their tool list is always empty, `ExplainEndpoints.cs`), then the
  tool-call parsing left without a caller goes too. The explain and translate evals stay: they test
  live features. The MCP server's 18 tools are separate and untouched. The `agent_run` table is dropped
  by a migration only if nothing reads it.

**P1 — shared headless logic (~−1.3k code, ~−0.5k tests)** (#1626), one PR per pair, in this order:
`useReaderSettings` (fixes web's settings bug) → `useBookReviews` → `useVocabularyReview` (fixes the
review drifts) → `useLibrarySort` → `useAssistantLauncher` → `useReadingSession` / `pendingSessions` →
`NativeLanguageContext` core → reader word and vocabulary logic → guest mint and session gate.
Each PR leaves the Android runtime fingerprint unchanged (JS only), so it ships as an OTA.

**P2 — reader chrome spike** (#1627): the TOC only, drawn inside the reader page for both hosts. The owner
judges it on the Android device; web is checked for keyboard and focus. The owner then decides whether
settings, search and the popups follow.

**P3 — reopen A** if the two conditions above hold; otherwise this ADR stands.

## Consequences

- Views are still written twice. A new screen costs two views but one hook.
- Behaviour drift between web and Android stops for the logic that moves; a fix lands once.
- Line count falls by ~5k in P0–P1 (more if P2 passes), far less than A promises, at a fraction of the
  risk, and without routing web releases through the Android OTA path.
- The spike numbers are reproducible: `pnpm -C apps/web build`, and
  `npx expo export --platform web` in `apps/mobile`; compare gzip of the files the library route loads.
