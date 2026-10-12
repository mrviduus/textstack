# Mobile app

Moved verbatim from `CLAUDE.md` (2026-10-12) to keep the always-loaded context small. Read when the task touches this area.

### Mobile App Architecture

**Framework**: Expo 57, React Native 0.86.3, Expo Router (file-based routing). Upgraded 55 → 57 in one
step on 2026-09-28: SDK 56 and 57 bundle the *same* third-party native modules, so stopping at 56
would have bought a second upgrade for no reduction in risk. TypeScript is deliberately held at the
workspace catalog's 5.9 and listed in `expo.install.exclude` — the SDK asks for 6.0, which is a major
across web, admin and packages too and belongs in its own change.

**Pages** (`apps/mobile/app/`): tabs (library, search, upload, vocabulary, profile; `index` redirects), auth, book detail, reader, highlights + review, stats, vocabulary + review, user book upload/read.

**Contexts** (`apps/mobile/src/context/`): AuthContext, DownloadContext, LanguageContext, NativeLanguageContext, ThemeContext, ToastContext.

**Hooks** (`apps/mobile/src/hooks/`), e.g. useCardAnswer, useHaptics, useReaderChapter, useReaderPersistence, useReaderSettings, useReadingSession, useTts, useVocabularyReview.

**API**: Single `apps/mobile/src/lib/api.ts` module (consolidated, not split like web).

**Offline** (`src/lib/offlineDb.ts`, SQLite): covers BOTH catalogue editions and the reader's own uploads (uploads since 2026-09-14). Chapters **and, since 2026-09-27, a PDF upload's original file** (`src/lib/originalFileCache.ts`, under `Paths.document/originals/`, 2 GB budget with LRU eviction) — so a PDF opens offline in the same Original layout it has online instead of being substituted with its extracted text. When the original is missing it still falls back to reflow, and the server progress write is suppressed there to stop a chapter-space position overwriting a `page:<N>` one. `offlineDb.web.ts` is a no-op twin and **every export must exist in both** or the web bundle (which mobile e2e runs against) fails to resolve. Sign-out wipes cached uploads, never catalogue downloads. Details: `docs/05-features/offline-reading.md#mobile`.

**The reading path waits for neither a token nor a network, and that is a rule rather than a
property.** Both chapter loaders (`src/hooks/useReaderChapter.ts`, `src/components/reader/useUserBookReaderSource.ts`)
read SQLite **first** and only then ask the server, whose answer refreshes the stored row in place
(`refreshCachedChapter`, an `UPDATE` that leaves `cached_at` alone — the insert would reorder the
offline table of contents) and never re-renders the chapter under someone reading it. Network-first
was not wrong on a plane, where `fetch` rejects at once; it was wrong on every network that is
present but useless — a captive portal, a tunnel — where the reader waited out the socket timeout in
front of a book already on the phone. `chapterLoadOrder.test.ts` pins the ordering, because nothing
in CI can feel it.

**What an account is still for**, now that reading needs none: cross-device sync, the upload quota,
and **wiping one account's private files when it signs out** — without that last one a reader's PDF
stays on the phone for whoever signs in next. Nothing on the reading path may grow a fourth reason.
An automatic sweep also removes downloads whose book the account no longer has
(`chooseOrphanedDownloads`), which is only safe because the listing it compares against either
succeeded or threw.

**E2E**: Playwright specs in `apps/mobile/e2e/tests/` — navigation, books, search, vocabulary, highlights, reader smoke. Not run by CI (needs a live backend).

**Build**: EAS Build (cloud) for dev/prod. OTA updates via `expo-updates`.

### Releasing to Play Internal Testing

```bash
cd apps/mobile
eas build -p android --profile production --auto-submit-with-profile internal
```

(`--auto-submit` alone FAILS — the profile must be named. `eas.json` has `submit.internal`, `closed` and `production`; `production` opens a 10% staged rollout, which EAS cannot widen afterwards — 25/50/100 is done by hand in Play Console. For JS-only changes prefer an OTA: `npx eas-cli update --branch production --platform android --environment production -m "<msg>"` — `--environment` is REQUIRED whenever the run is non-interactive, and the command fails without it. Verify the runtime first, from `apps/mobile` and nowhere else: `npx expo-updates fingerprint:generate --platform android` silently computes a different hash from the repo root and reports it as valid. CI path, and the one to prefer: the `mobile-release.yml` workflow_dispatch — the repo secret `EXPO_TOKEN` has been set since 2026-09-01. It builds from a clean checkout, which is the only way to avoid the fingerprint poisoning above rather than work around it.)

That single command builds the AAB and pushes it to Internal Testing. Service account key is stored in EAS-managed credentials (uploaded via `eas credentials -p android` or the web dashboard), so `eas submit` works from any machine or CI without a local key file. Local mirror at `apps/mobile/google-service-account.json` (gitignored) is a convenience backup, not required. Service account email: `eas-submit-textstack@orbital-heaven-496518-t5.iam.gserviceaccount.com`. Permission granted: "Release apps to testing tracks" for the TextStack app.
