# apps/android

The Android app: a Capacitor shell around the android build of `apps/web` (ADR-035). It has no UI code of its
own. The same `applicationId` as the Expo app (`app.textstack.mobile`), so a Play update installs over it.

```bash
pnpm build:web                # apps/web: tsc, VITE_TARGET=android build into apps/web/dist-android, dist check
pnpm exec cap sync android    # copy the build and link the plugins into android/
cd android && ./gradlew :app:assembleDebug
pnpm check:permissions        # after ./gradlew :app:processReleaseMainManifest
```

- Build-time values of the bundle: `apps/web/android.env` (public, no secrets).
- Plugin versions: the pnpm catalog. `apps/web` imports the JS half, this package lists the same packages so
  `cap sync` links the native half.
- The reader frame: `ReaderFrameClient.java` serves `/reader/frame.html` from the APK with a fresh nonce per load and
  the headers of `packages/reader/src/frame.mjs` (nginx does this on the web). `pnpm check:reader-frame` holds the
  two equal.
- `versionCode` in `android/app/build.gradle` starts at 100, above the Expo app's last Play code (44).
- Social login is Google only (`capacitor.config.json`): the other providers add the Facebook SDK and ad-ID
  permissions.
