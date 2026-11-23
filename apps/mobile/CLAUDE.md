# Mobile app

Loaded when working under `apps/mobile/`. Updated for M6 (2026-11-17): the catalog screens, the legacy reader and its SQLite chapter loaders are gone.

### Key files

| Area | Path |
|------|------|
| Reader page (both hosts) | `packages/reader/src/` (`build.mjs`, `page.mjs`, `readerPage.generated.ts`); `packages/reader/README.md` |
| Reader host, Android | `apps/mobile/src/components/reader/ReaderScreen.tsx`, `apps/mobile/app/my-books/read/` |
| Local library + sync | `apps/mobile/src/lib/reader/localLibrary.ts`, `sync.ts` |
| Guest session | `apps/mobile/src/lib/guestSession.ts`, `src/components/SessionGate.tsx` |
| App, API, contexts, e2e | `apps/mobile/app/`, `apps/mobile/src/lib/api.ts`, `apps/mobile/src/context/`, `apps/mobile/e2e/` |

### Mobile App Architecture

**Framework**: Expo 57, React Native 0.86.3, Expo Router (file-based routing). TypeScript is deliberately held at the
workspace catalog's 5.9 and listed in `expo.install.exclude` (the SDK asks for 6.0, a major across the workspace).

**Pages** (`apps/mobile/app/`): tabs (`index`, library, upload, vocabulary, profile), `(auth)/login`, `onboarding/language`, book detail `my-books/[id]`, the reader `my-books/read/[bookId]/[chapterSlug].tsx` (renders `ReaderScreen`; the slug is ignored), `my-books/upload`, `highlights/`, `vocabulary/review`, static pages (about, privacy, terms, contact, connect, reset-password), dev route `dev/epub.tsx` (`__DEV__` only).

**Contexts** (`apps/mobile/src/context/`): AuthContext, DownloadContext, LanguageContext, NativeLanguageContext, ThemeContext, ToastContext.

**Hooks** (`apps/mobile/src/hooks/`), e.g. useReaderBars, useReaderSettings, useTts, useVocabularyReview, useBookOffline, useHaptics, useFlushOnLeave.

**API**: `apps/mobile/src/lib/api.ts`, over `@textstack/shared`'s client (`/me/v2` calls in `packages/shared/src/api/` (`sync.ts`, `books.ts`, `upload.ts`, `vocabulary.ts`)).

**The reader** is the V2 page in a WebView (`apps/mobile/src/components/reader/ReaderScreen.tsx`, page and protocol in `packages/reader/src/`, `packages/reader/README.md` is the reference). It opens the book's file retained on the device (`hostStorage.ts`, `<documents>/v2/`) and keeps positions, highlights, sessions and saved words in the local SQLite library `textstack-v2` (`localLibrary.ts`); `sync.ts` pushes an outbox and pulls change feeds beside it. **The reading path waits for neither a token nor a network**, and nothing on it may need an account. Sign-out wipes the V2 library after one push and a warning with what the server lacks (README "Sign-out and identities").

**Offline downloads**: `DownloadContext` still stores an upload as the old SQLite chapter rows (`src/lib/offlineDb.ts`), which the V2 reader does not read — open in [#1406](https://github.com/mrviduus/textstack/issues/1406). A PDF's original file cache is `src/lib/originalFileCache.ts`. `offlineDb.web.ts` and `reader/deviceLibrary.web.ts` are web twins and **every export must exist in both** or the web bundle (which mobile e2e runs against) fails to resolve.

**What an account is still for**, now that reading needs none: cross-device sync, the upload quota, and wiping one account's private files when it signs out. Nothing on the reading path may grow a fourth reason.

**E2E**: Playwright specs in `apps/mobile/e2e/tests/` (navigation, highlights, vocabulary, v2-sync). Not run by CI (needs a live backend).

**Build**: EAS Build (cloud) for dev/prod. OTA updates via `expo-updates`.

**Patched native dependency** (#1228): `react-native-webview` 13.16.1 carries a pnpm patch
(`patches/react-native-webview@13.16.1.patch`, `patchedDependencies` in `pnpm-workspace.yaml`, applied by every
`pnpm install`, EAS included): the V2 reader's book interceptor (`TextStackBookServer.java`, https instead of
`file://`) and a narrowed message bridge (main frame only; on the old-engine fallback, only the V2 page's user-agent answer). It is native code: a change to it needs a new
dev client (`npx expo run:android` from `apps/mobile`, or `npm run build:dev:android`) and ships only in a store
build. The Expo fingerprint hashes `node_modules/react-native-webview` itself (measured with `npx expo-updates
fingerprint:generate --platform android` from `apps/mobile`: the hash moves with the patch applied or not), so an OTA
never reaches a build without it. Bumping the package:
`pnpm patch react-native-webview@<new>`, re-apply the hunks, `pnpm patch-commit <dir>`, delete the old `.patch`,
rerun `bookOrigin.test.ts` (it pins the Java serving rule to `bookOrigin.mjs`); an install fails loudly if a patch
no longer applies.

### Releasing to Play Internal Testing

```bash
cd apps/mobile
eas build -p android --profile production --auto-submit-with-profile internal
```

(`--auto-submit` alone FAILS — the profile must be named. `eas.json` has `submit.internal`, `closed` and `production`; `production` releases to 100% (first publish, no users; for updates set `releaseStatus: inProgress` + `rollout: 0.1` — EAS cannot widen a rollout afterwards, that is done by hand in Play Console). For JS-only changes prefer an OTA: `npx eas-cli update --branch production --platform android --environment production -m "<msg>"` — `--environment` is REQUIRED whenever the run is non-interactive, and the command fails without it. Verify the runtime first, from `apps/mobile` and nowhere else: `npx expo-updates fingerprint:generate --platform android` silently computes a different hash from the repo root and reports it as valid. CI path, and the one to prefer: the `mobile-release.yml` workflow_dispatch — the repo secret `EXPO_TOKEN` has been set since 2026-09-01. It builds from a clean checkout, which is the only way to avoid the fingerprint poisoning above rather than work around it.)

That single command builds the AAB and pushes it to Internal Testing. Service account key is stored in EAS-managed credentials (uploaded via `eas credentials -p android` or the web dashboard), so `eas submit` works from any machine or CI without a local key file. Local mirror at `apps/mobile/google-service-account.json` (gitignored) is a convenience backup, not required. Service account email: `eas-submit-textstack@orbital-heaven-496518-t5.iam.gserviceaccount.com`. Permission granted: "Release apps to testing tracks" for the TextStack app.

**Build gate** (`GET /app/config`): `MOBILE_MIN_SUPPORTED_BUILD` blocks old builds with a full-screen "Please update"; `MOBILE_LATEST_BUILD` shows a dismissible "new version" bar below it. An OTA only reaches a build with the same runtime, so once a build is fully rolled out on Play, a one-line PR bumps the `MOBILE_LATEST_BUILD` default in `docker-compose.yml` to its versionCode; the deploy ships it (#914).
