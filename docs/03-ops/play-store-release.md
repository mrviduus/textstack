# Play Store release runbook

How a build reaches Android users, and the answers you will be asked for again and
cannot look up anywhere else. Play offers no export of the Data Safety form, so the
copy below **is** the record — update it in the same commit that changes the answer.

Live status lives in [`docs/STATUS.md`](../STATUS.md). This file is the mechanics.

---

## Tracks and profiles

| Play track | eas.json profile | Command |
|---|---|---|
| Internal testing | `internal` | `npm run submit:internal` |
| Closed testing (Alpha) | `closed` | `npm run submit:closed` |
| Production | `production` | `npm run submit:production` |

The profile name **is** the track (`eas.json` → `submit.<profile>.android.track`). If
Play was set up with a custom closed-track name, `submit.closed.android.track` must
match that name rather than the default `alpha`.

Credentials live server-side on EAS, which is why no profile sets
`serviceAccountKeyPath` and why CI can submit without a key file. Adding that path
would break the GitHub Actions route. `apps/mobile/google-service-account.json` is a
local convenience copy, gitignored, not required.

## Staged rollout

`submit.production` opens at **10%** (`releaseStatus: "inProgress"`, `rollout: 0.1`).

- `rollout` is a **fraction between 0 and 1**, not a percentage. `10` is the silent
  mistake here.
- **EAS cannot advance an existing rollout.** 10 → 25 → 50 → 100 is done by hand in
  Play Console → Production → Releases → Manage rollout. Re-submitting with a bigger
  number creates a *second release* rather than widening the first.
- Wait ~48h between steps and watch Android vitals (ANR rate, crash rate) plus Sentry.

## The runtime-version rule

`app.json` uses `runtimeVersion.policy: "fingerprint"`. The runtime is a hash of the
native inputs — config plugins, native dependencies, `app.json` — so:

> **Any change that touches a native dependency or a config plugin changes the runtime
> and therefore cannot ship as an OTA. It needs a build.**

This is the point of the policy, not a limitation of it. The previous `appVersion`
policy resolved to the literal string `1.0.0` forever, so an OTA could land on a
binary missing the native module it needed — which is what the defensive
`try { require() } catch {}` guards in `useTts.ts`, `vocabReminder.ts` and
`profile.tsx` were written against.

Before publishing an OTA, confirm the runtime still matches the shipped build:

```bash
cd apps/mobile
npx expo-updates runtimeversion:resolve --platform android
# The field is `runtime`, not `runtimeVersion` — the latter returns null, which
# reads as "no runtime" and means the opposite of what it looks like.
eas build:list --platform android --status finished --limit 50 --json \
  | jq -r '[.[] | select(.buildProfile == "production")][0].runtime'
```

If they differ, you need a build, not an update.

`npm run check:runtime-version` was named here as the thing that would do this
comparison. It was never written. What does it now is
[`.github/workflows/mobile-ota.yml`](../../.github/workflows/mobile-ota.yml): on every
push to `main` touching `apps/mobile/**` or `packages/**` it resolves the runtime,
compares it with the newest finished Android production build, and publishes the OTA
only on a match. A mismatch **fails the run** and says a build is needed — deliberately,
because `eas update` succeeds either way, and a silent skip is indistinguishable from a
delivered update.

Run it by hand from Actions → Mobile OTA (auto) with `dry_run` on to see the comparison
without publishing. It needs the `EXPO_TOKEN` secret, like every other EAS workflow here.

## Permissions

The allowlist and the reasoning live in `apps/mobile/scripts/check-android-permissions.mjs`.
Run it after any dependency change:

```bash
cd apps/mobile
npx expo prebuild --platform android --clean
(cd android && ./gradlew :app:processReleaseMainManifest)
npm run check:permissions
```

It reads the **merged** manifest when one exists. The source manifest lists ~10
permissions; the merge produces ~37, and only the merged set resembles what Play shows
a user. Before promoting to production, also check the real artifact
(`bundletool dump manifest --bundle=app.aab`) and Play Console → App bundle explorer →
Permissions, which is the only authoritative view.

Blocked on purpose, via `app.json` → `android.blockedPermissions`:

| Permission | Why it appeared | Why it is blocked |
|---|---|---|
| `RECORD_AUDIO` | `expo-audio` / `expo-image-picker` defaults | The app never records. TTS plays back; the picker is avatar-only. |
| `SYSTEM_ALERT_WINDOW` | `expo-dev-launcher` **config plugin** — writes into the shared main manifest even in release builds | No overlay feature exists. |
| `CAMERA` | `expo-image-picker` default | Avatars come from the photo library only. |

Still requested, still unresolved — see the WATCH list in that script:

- `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK` from `expo-audio`. The app
  plays TTS in the foreground only, so they look unused — and `MEDIA_PLAYBACK` drags the
  app into Play's foreground-service declaration flow (a form plus a demo video). Not
  blocked blind: if `expo-audio` starts a service internally, blocking them turns TTS
  into a `SecurityException`. **Decide on a device**: block both, build, then play a
  word, a sentence and a full paragraph.
- 20 OEM launcher/badge permissions from ShortcutBadger via `expo-notifications`. The app
  never sets a badge. On a reading app's listing, "read your settings" and "install
  shortcuts" read badly.

## Data Safety answers

Submitted answers, verbatim. **Fill this form and the privacy policy in the same
sitting** — a Data Safety declaration that contradicts the policy is a suspension
category, not a warning category.

| Data type | Collected | Shared | Linked to identity | Purpose |
|---|---|---|---|---|
| Name, Email address | Yes | No | Yes | App functionality, Account management |
| Photos (avatar) | Yes (optional) | No | Yes | App functionality |
| Files & docs (uploaded books) | Yes | **Yes → OpenAI** | Yes | App functionality |
| App activity → other UGC (prompts, highlights, vocabulary) | Yes | **Yes → OpenAI** | Yes | App functionality |
| App activity → app interactions (reading sessions) | Yes | No | Yes | App functionality, Analytics |
| App info & performance → Crash logs, Diagnostics | *Not yet — no crash SDK on mobile* | — | — | — |

Also: encryption in transit **Yes**; users can request deletion **Yes**, at
`https://textstack.app/en/delete-account`; "data processed ephemerally" **No** —
`llm_traces` stores prompts and book excerpts, so that box must stay unticked.

Sending book text to OpenAI **is "sharing"** under Play's definition. Files & docs →
Shared: Yes is the row people most often get wrong.

Two rows change the moment `@sentry/react-native` ships (Crash logs, Diagnostics, and
Device or other IDs → Shared: Yes → Sentry, since the DSN points at hosted
`ingest.us.sentry.io` rather than a self-hosted instance). Adding an analytics
transport to `apps/mobile/src/lib/analytics.ts` would add more — which is why it is
deliberately still a no-op.

## Privacy policy

Text lives in **one** file, `packages/shared/src/i18n/en.json` → `privacy.*`, `terms.*`,
because Play requires the in-app policy and the policy at the listed URL to say the same
thing. Web's `apps/web/src/locales/en.json` is an overlay and may not shadow those
namespaces — `apps/web/src/locales/__tests__/legalShadow.test.ts` fails if it does.
`packages/shared/src/i18n/legalContent.test.ts` checks the third-party processors are
still named and the retention answer is still stated.

Section **order** lives in `packages/shared/src/legal/sections.ts`; both the web page
and the mobile screen map over it. Adding a section is one entry plus the strings.

Bump `privacy.updated` / `terms.updated` whenever the text changes materially, and
update the Data Safety table above in the same commit.

## Crash reporting

`@sentry/react-native` is wired but **dormant**. Two switches turn it on, and they
belong in the same change.

**1. Reporting.** Set `EXPO_PUBLIC_SENTRY_DSN` for the build. With it unset,
`initSentry()` returns immediately, the SDK never initialises, and nothing is sent —
the same contract the backend uses for `SENTRY_DSN`.

Note the mechanic: Expo **inlines** `EXPO_PUBLIC_*` at bundle time. The DSN is baked
into the JS bundle when the build or `eas update` runs, not read when the app starts.
Setting it later needs a new build or a new update, not an environment change.

Put it in the `production` (and `preview`) build profile's `env` block in `eas.json`,
or as an EAS environment variable. A DSN in a client app is public by design — it is
an ingest endpoint, not a credential — so it does not need to be a secret.

Use a **separate Sentry project** from the backend (`textstack-mobile`), so mobile
noise does not drown the API's issue stream, while both stay in the same organisation
for cross-service tracing.

**2. Symbolication.** `app.json` sets the Sentry plugin's `disableAutoUpload: true`.
That is deliberate: source-map upload runs `sentry-cli` during the release build and
**fails the whole build** when `SENTRY_AUTH_TOKEN` is absent — verified locally, the
Gradle release task exits 1. No build should break on a missing secret.

Without uploads, every production stack trace is minified Hermes bytecode offsets and
the integration is decorative. So when you turn reporting on:

```bash
cd apps/mobile
eas secret:create --scope project --name SENTRY_AUTH_TOKEN --value <token>
```

then flip `disableAutoUpload` to `false` in the plugin options. For OTA updates the
maps need a separate upload after `eas update` — the bundle changes without a build,
so an OTA'd crash is unsymbolicated unless that step runs.

**What is already handled.** `dist` is set from `Updates.updateId`, so "crashing on
build 21" and "crashing on Tuesday's OTA" are distinguishable — without it a JS-only
fix looks like it changed nothing. `sendDefaultPii: false`, no `Sentry.setUser`, and
no Session Replay, which keeps crash data in the *not linked to identity* bucket on
the Data Safety form. `src/lib/sentryScrub.ts` redacts `text`, `q`, `word`,
`sentence`, `prompt` and `question` from every breadcrumb and request URL, because
`/api/tts`, `/api/translate` and `/api/explain` all carry the passage being read in
the query string, and shipping book text to a processor is a disclosure we have not
made.

**Data Safety consequence.** Turning this on adds two rows to the table above:
*App info & performance → Crash logs* and *Diagnostics*, plus *Device or other IDs*
for Sentry's installation id. All three are **Shared: Yes → Sentry**, since the DSN
points at hosted `ingest.us.sentry.io` rather than a self-hosted instance. Keep them
**not linked to identity** — that is what the configuration above buys.

## Release checklist

1. `npm run typecheck && npm test` in `apps/mobile` (CI runs both).
2. Permission check — the four levels above.
3. If native deps or plugins changed: build, do **not** OTA.
4. Bump `privacy.updated` if the policy text moved; update Data Safety the same day.
5. Submit to the track: `npm run submit:closed` (or `:production`).
6. Read the **pre-launch report** — a free crawl on ~10 real devices, and the cheapest
   check that exists on the PDF.js Original viewer, which shipped without device
   verification (see `docs/changelog-archive/2026-H2.md`, ADR-012 S4).
7. Production only: hold at 10%, watch vitals for 48h, then widen by hand.
8. If Sentry is enabled: confirm a test event arrives **with a readable stack trace**.
   Source maps are the part that silently does not work.
