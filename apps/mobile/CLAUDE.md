# Mobile app

Claude loads this guide when it works under `apps/mobile/`. The guide was updated for M6 (2026-11-17). The catalog screens, the legacy reading screen and its SQLite chapter loaders are gone.

### Key files

| Area | Path |
|------|------|
| Reading screen page (both hosts) | `packages/reader/src/` (`build.mjs`, `page.mjs`, `readerPage.generated.ts`); `packages/reader/README.md` |
| Reading screen host, Android | `apps/mobile/src/components/reader/ReaderScreen.tsx`, `apps/mobile/app/my-books/read/` |
| Local library + sync | `apps/mobile/src/lib/reader/localLibrary.ts`, `sync.ts` |
| Guest session | `apps/mobile/src/lib/guestSession.ts`, `src/components/SessionGate.tsx` |
| App, API, contexts, e2e | `apps/mobile/app/`, `apps/mobile/src/lib/api.ts`, `apps/mobile/src/context/`, `apps/mobile/e2e/` |

### Mobile App Architecture

**Framework**: Expo 57, React Native 0.86.3, Expo Router (file-based routing). TypeScript stays at the workspace catalog's 5.9 on purpose and is listed in `expo.install.exclude`. The SDK asks for 6.0, a major version change across the workspace.

**Pages** (`apps/mobile/app/`): tabs (`index`, library, upload, vocabulary, profile), `(auth)/login`, `onboarding/language`, book detail `my-books/[id]`, `my-books/upload`, `highlights/`, `vocabulary/review`. Static pages: about, privacy, terms, contact, connect, reset-password. The reading screen is `my-books/read/[bookId]/[chapterSlug].tsx`: it renders `ReaderScreen` and ignores the slug. The dev route is `dev/epub.tsx` (`__DEV__` only).

**Contexts** (`apps/mobile/src/context/`): AuthContext, DownloadContext, LanguageContext, NativeLanguageContext, ThemeContext, ToastContext.

**Hooks** (`apps/mobile/src/hooks/`), for example useReaderBars, useReaderSettings, useTts, useVocabularyReview, useBookOffline, useHaptics, useFlushOnLeave.

**API**: `apps/mobile/src/lib/api.ts`, over `@textstack/shared`'s client. The `/me/v2` calls are in `packages/shared/src/api/` (`sync.ts`, `books.ts`, `upload.ts`, `vocabulary.ts`).

**The reading screen** is the V2 page in a WebView (`apps/mobile/src/components/reader/ReaderScreen.tsx`). The page and its protocol are in `packages/reader/src/`, and `packages/reader/README.md` is the reference.
- The screen opens the book file retained on the device (`hostStorage.ts`, `<documents>/v2/`).
- It keeps reading positions, highlights, sessions and words in the local SQLite library `textstack-v2` (`localLibrary.ts`).
- Beside it, `sync.ts` pushes an outbox and pulls change feeds.
- **The reading path waits for neither a token nor a network.** The reading path must not need an account.
- Sign-out wipes the V2 library after one push and a warning. The warning shows what the server lacks (README "Sign-out and identities").

**Offline downloads**:
- Download = the book file retained on the device. It is the same fetch that the reading screen does on open (`src/lib/reader/deviceDownload.ts`).
- "On this device" means that this file exists (`DownloadContext`).
- The old SQLite chapter cache is gone (#1522). On start, `src/lib/offlineDb.ts` only deletes its database.
- The cache of PDF book files is gone too (#1527). The same start drops an older build's `<documents>/originals/` and its AsyncStorage keys. Share sends the retained book file.
- `offlineDb.web.ts` and `reader/deviceLibrary.web.ts` are web twins. **Every export must exist in both**, or the web bundle fails to resolve. Mobile e2e runs against the web bundle.

**What an account is still for**, now that reading needs none: cross-device sync, the upload quota, and wiping one account's private files when it signs out. The reading path must not add a fourth reason.

**E2E**: Playwright specs in `apps/mobile/e2e/tests/` (navigation, highlights, vocabulary, v2-sync). CI does not run them, because they need a live backend.

**Build**: EAS Build (cloud) makes the dev and prod builds. OTA updates go through `expo-updates`.

**Patched native dependency** (#1228): `react-native-webview` 13.16.1 carries a pnpm patch,
`patches/react-native-webview@13.16.1.patch` (`patchedDependencies` in `pnpm-workspace.yaml`). Every `pnpm install`
applies it, EAS included. The patch holds:
- the V2 reading screen's book interceptor (`TextStackBookServer.java`, https instead of `file://`);
- a narrowed message bridge: main frame only. On the old-engine fallback, the bridge passes only the V2 page's user-agent answer.

The patch is native code. A change to it needs a new dev client (`npx expo run:android` from `apps/mobile`, or
`npm run build:dev:android`), and it ships only in a store build. The Expo fingerprint hashes
`node_modules/react-native-webview` itself, so an OTA never reaches a build without the patch. We measured this with
`npx expo-updates fingerprint:generate --platform android` from `apps/mobile`: the hash changes with the patch applied or not.

To bump the package:
1. Run `pnpm patch react-native-webview@<new>` and apply the hunks again.
2. Run `pnpm patch-commit <dir>` and delete the old `.patch`.
3. Run `bookOrigin.test.ts` again. It pins the Java serving rule to `bookOrigin.mjs`.

If a patch no longer applies, the install fails with an error.

### Releasing to Play Internal Testing

```bash
cd apps/mobile
eas build -p android --profile production --auto-submit-with-profile internal
```

- `--auto-submit` alone FAILS: you must name the profile.
- `eas.json` has `submit.internal`, `closed` and `production`. `production` releases to 100% (first publish, no users). For updates, set `releaseStatus: inProgress` + `rollout: 0.1`. EAS cannot widen a rollout afterwards: widen it by hand in Play Console.
- For JS-only changes, prefer an OTA: `npx eas-cli update --branch production --platform android --environment production -m "<msg>"`. `--environment` is REQUIRED when the run is non-interactive. Without it, the command fails.
- Verify the runtime first, from `apps/mobile` and nowhere else. From the repo root, `npx expo-updates fingerprint:generate --platform android` silently computes a different hash and reports it as valid.
- The CI path is the one to prefer: the `mobile-release.yml` workflow_dispatch. The repo secret `EXPO_TOKEN` has been set since 2026-09-01. The workflow builds from a clean checkout. Only a clean checkout avoids the fingerprint poisoning of the previous item, instead of a workaround.

That single command builds the AAB and pushes it to Internal Testing. EAS stores the service account key in EAS-managed credentials (uploaded with `eas credentials -p android` or the web dashboard). So `eas submit` works from any machine or CI without a local key file. The local mirror at `apps/mobile/google-service-account.json` (gitignored) is a backup for convenience; it is not required. Service account email: `eas-submit-textstack@orbital-heaven-496518-t5.iam.gserviceaccount.com`. Permission granted: "Release apps to testing tracks" for the TextStack app.

**Build gate** (`GET /app/config`):
- `MOBILE_MIN_SUPPORTED_BUILD` blocks old builds with a full-screen "Please update".
- `MOBILE_LATEST_BUILD` shows a "new version" bar below it, and the reader can dismiss the bar.

An OTA only reaches a build with the same runtime. So, when a build is fully rolled out on Play, a one-line PR bumps the `MOBILE_LATEST_BUILD` default in `docker-compose.yml` to its versionCode. The deploy ships it (#914).
