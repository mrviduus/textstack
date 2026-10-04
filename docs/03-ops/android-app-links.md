# Android App Links — making https links open the app

A link to `https://textstack.app/en/books/the-aeneid` should open TextStack on a phone that has it
installed. Until 2026-08-27 it opened Chrome, and so did the password-reset email.

## What was wrong

`apps/mobile/app.json` declares `autoVerify: true` for `https://textstack.app/en/books*` and
`/reset-password*`. On install, Android fetches `https://textstack.app/.well-known/assetlinks.json`
and checks that the site vouches for the app. It got the SPA's `index.html` with HTTP 200 — nginx's
catch-all `try_files $uri /index.html` answers every unknown path that way — so verification failed:

```
adb shell pm get-app-links app.textstack.mobile
  textstack.app: 1024          # 1024 = verification failed
```

The custom scheme (`textstack://book/the-aeneid`) always worked; it needs no verification. Only
https links were affected — which is every link anyone would ever share.

## Where the file lives, and why there

`apps/web/public/.well-known/assetlinks.json`.

- vite copies `public/` into `dist/` verbatim, and nginx serves from `apps/web/dist`, so the file
  appears at the site root with no nginx change. The `/.well-known/` blocks nginx does have are exact
  matches for MCP/OAuth metadata; `assetlinks.json` matches none of them and
  falls through to `location /`, whose `try_files $uri /index.html` serves a real file when there is
  one.
- **Not** hand-placed on the server: `deploy.yml` builds with `emptyOutDir`, so anything dropped
  into `dist/` by hand dies at the next deploy.

## The one manual step: the fingerprint

The SHA-256 is not in this repo and cannot be — the AAB is signed by **Play App Signing**, so the
key lives with Google and EAS, not with the source.

```bash
cd apps/mobile
npx eas-cli credentials -p android      # Android → production → shows the fingerprints
```

Or Play Console → your app → **Test and release → Setup → App integrity → App signing**.

Copy the **App signing key certificate** SHA-256 (32 colon-separated hex bytes) into
`sha256_cert_fingerprints`.

Easiest route: the same page has a **Digital Asset Links JSON** section at the bottom where Google
generates the snippet with the app signing fingerprint already filled in — take it from there rather
than transcribing hex by hand. The upload key's fingerprints are listed separately, under
**Upload key certificate**, further up the page.

**List both keys.** Play re-signs uploads with the app signing key, but a build installed straight
from an `.aab`/`.apk` you built yourself carries the **upload** key. Listing both means the same file
verifies for Play installs and for local ones:

```json
"sha256_cert_fingerprints": [
  "AA:BB:…:FF",   // app signing key (Play installs — the one that matters for users)
  "11:22:…:99"    // upload key (locally installed builds)
]
```

Both fingerprints are filled in (the placeholder is gone). `apps/web/src/lib/assetlinks.test.ts`
pins the file's shape and the fingerprint format.

## Verifying after deploy

```bash
# 1. The site serves JSON, not a web page.
curl -sI https://textstack.app/.well-known/assetlinks.json | grep -i content-type
#    expect: application/json           (before the fix: text/html)

# 2. Ask Android to re-check. Needs the app installed.
adb shell pm verify-app-links --re-verify app.textstack.mobile
adb shell pm get-app-links app.textstack.mobile
#    expect: textstack.app: verified    (before the fix: 1024)

# 3. The link itself.
adb shell am start -a android.intent.action.VIEW -d "https://textstack.app/en/books/the-aeneid"
#    expect: TextStack opens on the book, with no browser chooser
```

Verification runs at install time, so an already-installed build needs the `--re-verify` above (or a
reinstall) after the file goes live. Nothing in the app changes; no OTA, no new build.

## Not done: iOS

`app.json` declares no `associatedDomains` and `TextStack.entitlements` is empty, so iOS Universal
Links were never configured at all — the server half is not the only piece missing there. Android is
the launch platform; this is recorded in `docs/STATUS.md` so it does not read as working.
