# ADR-035 — One UI codebase: the web app in an Android shell

**Status:** Accepted (option D, after spike #1629) · **Date:** 2026-11-27 · **Builds on:** [ADR-029](ADR-029-foliate-for-v2-epub.md), [ADR-032](ADR-032-one-engine-foliate-fork.md), [ADR-033](ADR-033-client-is-the-only-parser.md) · **Issue:** #1329

## Context

TextStack has two UI apps for one product: `apps/web` (React + Vite, plain CSS) and `apps/mobile`
(Expo 57, expo-router, React Native). Most features are written twice. The question in #1329: replace
`apps/web` with the Expo app running in the browser (`react-native-web`), or remove the duplication
another way.

### Where the lines are

Non-test source, first measured at `988a409e`, before the dead-code cut (#1624, #1625):

| | `apps/web` | `apps/mobile` |
|---|---|---|
| Total | 30.2k (18.4k TS/TSX + 11.8k CSS) | 23.0k |
| Logic written on both sides | 4.9k | 3.8k |
| Views written on both sides | 17.1k (7.3k TSX + 9.8k CSS) | 10.6k |
| Platform-only logic (storage, auth transport, downloads, OTA) | 2.0k | 4.8k |
| Reader host (must stay per platform) | 1.5k | 2.6k |
| Views on one side only | 4.0k | 0.6k |

After the cut (`04f5e034`): `apps/web/src` 27.5k, `apps/mobile` 23.1k, `packages/shared/src` 6.9k.

`packages/shared` already holds the API client, sync calls, types, i18n and reader locators;
`packages/reader` (the reader page) is already one for both. The duplication is in views and CSS,
then in hooks and contexts, and the copies have drifted (web's `useReaderSettings` stores every default
as if chosen; Android's `submitReview` loses `operationId` and `reviewMode` on a retry).

### The Expo-web measurement (2026-11-27)

Both apps built from the same commit; the Expo app exported with `npx expo export --platform web`,
served statically, opened at 1440×900 in Chromium.

| | Today's web app | Expo web export |
|---|---|---|
| JS + CSS to show the library, first open | 0.73 MB raw, **0.20 MB gzip** | one bundle, 10.7 MB raw, **4.2 MB gzip** |
| Same, after keeping the reader page out of the bundle | — | 5.0 MB raw, **1.24 MB gzip** (6× web) |
| Code splitting | per route | none |

The Expo web app also showed the phone layout stretched to 1440 px, no reader (`ReaderScreen.tsx` is
Android only), tokens in `localStorage` instead of HttpOnly cookies, and no Google sign-in on web.

## Options

| | Lines removed (net) | Time | Risk |
|---|---|---|---|
| **A.** One Expo app for Android and web; `apps/web` deleted | ~17–21k | 8–12 weeks | High: reader, layout, auth, routes, hosting rebuilt; web ships through the mobile release path; 6× download |
| **B/C.** Two apps; duplicated logic moves into `packages/shared` as headless hooks | ~5k with the dead-code cut | 1–2 weeks | Low, but views stay written twice |
| **D.** One web app; Android becomes a Capacitor shell around the `apps/web` build; `apps/mobile` deleted | ~18–20k (−23k mobile, +3–5k offline layer, shell, glue) | 6–10 weeks | Medium: existing installs, release path |

## Decision

**D.** `apps/web` is the only UI. Android is a thin Capacitor shell around its build; `apps/mobile` is
deleted once the shell is in production. A is rejected (download, layout, release coupling); C is not
needed once one app is left.

### Architecture

```
apps/web                one UI (React + Vite, as today)
 ├─ src/…               screens, hooks, ReaderHost: shared by both targets
 └─ src/platform/       the only seam between web and Android
     ├─ index.ts        the Platform interface
     ├─ web.ts          server library, cookies, Google Identity Services
     └─ android.ts      SQLite library, device files, bearer tokens, native Google, notifications
        picked at build time: VITE_TARGET=web|android (the other side is tree-shaken out)

apps/android            thin Capacitor shell, almost no code of its own
 ├─ capacitor.config.ts webDir = the android build of apps/web
 └─ android/            same applicationId and Play upload key: installs over today's app

backend                 unchanged except one CORS origin (https://localhost)
```

1. **Shell: Capacitor** (8.x). The stack stays TypeScript. Plugins: `@capacitor-community/sqlite`,
   `@capacitor/filesystem`, `@capacitor/app`, a native Google sign-in plugin, secure storage, local
   notifications, share.
2. **One `Platform` seam.** Everything that differs goes through it, and screens never ask which
   platform they run on: library and progress (server or local SQLite), book bytes (server URL or a local
   file), auth (HttpOnly cookies or bearer tokens in secure storage), sign-in, notifications, share, file
   picking.
3. **Offline.** `localLibrary.ts`, `hostStorage.ts` and the `reader/sync.ts` outbox move from
   `apps/mobile` nearly as they are, over the SQLite plugin, with the same schema and database name.
   The app's assets ship inside the APK. Reading needs no token and no network.
4. **Book bytes.** The retained file (`files/v2/books/<sha256>.epub`) is read by `fetch` from
   `Capacitor.convertFileSrc(uri)` and handed to the page as `openBytes`, as on the web. The patched
   WebView and its book interceptor are not needed.
5. **Existing installs.** On first launch the shell copies today's expo-sqlite file
   (`files/SQLite/textstack-v2`, journal mode `delete`) to the plugin's place
   (`databases/textstack-v2SQLite.db`, `addSQLiteSuffix`) and keeps the books folder where it is. Nothing
   is deleted until the new store has it. Tokens in expo-secure-store cannot be read by a new plugin:
   readers sign in once more; their local data stays.
6. **Reader frame.** One `ReaderHost.tsx`. Web: nginx fills the frame's nonce, as today. Android: the
   frame ships in the APK and the shell fills `%READER_FRAME_NONCE%` per load in
   `BridgeWebViewClient.shouldInterceptRequest`, with nginx's headers.
7. **Updates.** Web ships on merge, as today. Android: an AAB built in GitHub Actions, signed with the
   Play upload key, uploaded to the internal track, promoted by hand. `mobile-ota.yml` has no
   replacement at first; a live-update path comes later only if the store delay hurts.
8. **Android back button** → `history.back()` (Capacitor's default) plus a reader listener. **Layout:**
   the web app is already phone-shaped; the shell build drops the cookie banner and site footer and
   bundles its fonts.

### The spike (#1629, 2026-11-27)

A throwaway Capacitor 8.6 shell around an `apps/web` build (branch `spike/1629-capacitor`, never
merged), installed with `adb install -r` over a debug build of today's app that held a book, a
highlight with a note, a saved word, a position and an outbox row. Emulator, Android API 37.

| # | Check | Result |
|---|---|---|
| 1 | A book on the device opens offline with no account | Pass: airplane mode, guest; the book opens and pages turn |
| 2 | The shell opens today's database and books folder | Pass: copied database read back (books 1, annotations 1, reading state 1, vocabulary 1, outbox 1); the book file found and served |
| 3 | The reader frame runs from the APK under a nonce the host mints | Pass: ~40 lines of Java fill the nonce; the page's scripts run (an unfilled nonce fails closed) |
| 4 | Native Google sign-in returns a token the backend accepts | Partly: the native chooser opens with today's web client id; the token exchange is checked in D2 on the internal track (owner, 2026-11-27). Production CORS refuses `https://localhost` today: one origin to add |
| 5 | An AAB builds from the command line | Pass: `./gradlew :app:bundleRelease`, 30 s, 13.7 MB |

Debug APK 19.8 MB. Full report: #1629.

### Phases

Each phase is small PRs; nothing starts without the owner's "start".

| Phase | What | Issue |
|---|---|---|
| D0 | The `Platform` seam in `apps/web`, no behaviour change | #1641 |
| D1 | The offline library ported into `android.ts`, with its tests | #1642 |
| D2 | The shell, existing installs, Play internal track | #1643 |
| D3 | Parity by checklist, then production on the owner's yes | #1644 |
| D4 | `apps/mobile` deleted | #1645 |

Real users have data on their phones: D2 and D3 delete nothing on a device until the new store holds it,
go to the internal track before production, and need the owner's explicit yes for the production rollout.

## Consequences

- A feature is written once, for both web and Android. Behaviour drift between the two stops.
- ~18–20k lines go when `apps/mobile` is deleted; the Expo, EAS and React Native toolchains go with it.
- Android loses instant OTA until a live-update path exists: every Android change is a store build.
- Some native feel in lists and gestures may be lost; the reader is already a WebView on both.
- The backend stays as it is: its mobile mode (bearer tokens, `X-Client: mobile`) already exists.
