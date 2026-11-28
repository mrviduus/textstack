# platform/android

The Android side of the platform seam (ADR-035, #1642): the local-first library that the Expo app runs today,
in web code over Capacitor plugins. Only `../android.ts` and `../android.reader.ts` import this folder.

## Copies
These files are copies of the Expo app's code (owner decision, 2026-11-27). The Expo app stays the
production app until #1644, and #1645 deletes the originals. Until then, a fix in one copy goes to the other.

| File here | Original in `apps/mobile/src/lib/` |
|---|---|
| `localLibrary.ts` | `reader/localLibrary.ts` |
| `hostStorage.ts` (+ test) | `reader/hostStorage.ts` |
| `sessionWrites.ts` (+ test) | `sessionWrites.ts` |
| `sqliteShim.ts` | `reader/sqliteShim.ts` (+ `memoryConnection`, the plugin's connection for tests) |
| `librarySync.ts` (+ test) | `reader/sync.ts` (+ `sync.test.ts`) |
| `finishBook.sync.test.ts`, `sessions.sync.test.ts`, `discuss.sync.test.ts` | the same names in `reader/` |
| `syncClient.ts` | `sync.ts`, without `deviceUploadIo` (it comes with the upload) |
| `deviceLibrary.ts` (+ test) | `reader/deviceLibrary.ts` |
| `deadline.ts`, `singleFlight.ts` (+ tests) | the same names |
| `api.ts` | `api.ts`, without `deleteAccount` (the web one is used) |
| `authEvents.ts` | `authEvents.ts` |

Changes in the copies:
- Import paths. The Expo modules come from `native.ts` under the same names.
- `deviceLibrary.ts`: the database opens through `sqliteDb.ts`, and the file calls go to `@capacitor/filesystem`.
  They are async here, so `wipeLibrary` and `removeLocalBook` wait for them.
- `librarySync.ts`: the `Platform.OS === 'web'` guards are gone (this code runs only on Android), and two lines
  changed for the web tsconfig (an unused parameter, a switch fallthrough).
- `api.ts`: the tokens go through `writeTokens` / `clearTokens`, which keep a copy of the access token for calls
  that cannot wait. `APP_HEADERS` is empty until the shell gives the app version.
- Tests: a `@vitest-environment node` line where they need it, and plugin fakes in place of the Expo mocks.

## New here
- `native.ts`: `AsyncStorage` (over localStorage), `SecureStore` (over `@aparajita/capacitor-secure-storage`), `uuid`
  and `NetInfo` (over `@capacitor/network`), with the Expo modules' names and shapes. The keys are not the Expo app's storage: #1643 carries them over on an existing install.
- `account.ts`: the seam's `account` member (the web `AuthContext` calls it). Bearer session as in the Expo app; a
  new session claims the device library and adopts a guest's before the UI sets the user; sign-out pushes, then
  ends the session and wipes the library.
- `sqliteDb.ts`: the `Db` surface of `localLibrary.ts` over `@capacitor-community/sqlite`. Same database name
  as the Expo app (`textstack-v2`).
