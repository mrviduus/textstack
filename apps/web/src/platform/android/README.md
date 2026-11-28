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
| `syncClient.ts` (+ upload tests in `syncClient.test.ts`) | `sync.ts` (+ the upload tests of `sync.test.ts`) |
| `deviceDownload.ts` | `reader/deviceDownload.ts` |
| `deviceLibrary.ts` (+ test) | `reader/deviceLibrary.ts` |
| `deadline.ts`, `singleFlight.ts` (+ tests) | the same names |
| `cachedUserBookDetail.ts` (+ test) | `cachedUserBookDetail.ts` |
| `api.ts` | `api.ts`, without `deleteAccount` (the web one is used) |
| `authEvents.ts` | `authEvents.ts` |

Changes in the copies:
- Import paths. The Expo modules come from `native.ts` under the same names.
- `deviceLibrary.ts`: the database opens through `sqliteDb.ts`, and the file calls go to `@capacitor/filesystem`.
  They are async here, so `wipeLibrary` and `removeLocalBook` wait for them.
- `localLibrary.ts`: `deviceHighlights` also gives each highlight's time (`at`), for the Highlights list.
- `librarySync.ts`: the `Platform.OS === 'web'` guards are gone (this code runs only on Android), and two lines
  changed for the web tsconfig (an unused parameter, a switch fallthrough). `downloadBook` waits for `io.intact`.
- `hostStorage.ts`: `HostFiles.exists`, `size` and `remove` may return a Promise, and every call waits for them.
  So `intactBook` is async.
- `syncClient.ts`: `ByteSource.read` and `UploadIo.open` may return a Promise. `deviceUploadIo` reads the file
  through the WebView (`deviceFileBlob` in `native.ts`: `fetch` of `Capacitor.convertFileSrc(uri)`, a `Blob`), not
  through an expo-file-system `FileHandle`. A fetch never creates a missing file, so the read-only open (#1610) is gone.
- `deviceDownload.ts`: the files go to `@capacitor/filesystem` (`Directory.Data`, `v2/<name>`). Every file call is
  async. `move` deletes the target before the rename. The download is `Filesystem.downloadFile` (deprecated: see its
  `ponytail:` comment). The host's files wait for `sweepStaging` and `makeFileDirs`; a failure is retried by the next
  call. The `Platform.OS === 'web'` guards are gone, and `deleteBook` has only the device path (no `userBooksApi`).
- `api.ts`: the tokens go through `writeTokens` / `clearTokens`, which keep a copy of the access token for calls
  that cannot wait. `APP_HEADERS` is empty until the shell gives the app version.
- Tests: a `@vitest-environment node` line where they need it, and plugin fakes in place of the Expo mocks.
  `syncClient.test.ts` has only the upload tests; its `deviceUploadIo` test checks the WebView read, not the open mode.

## New here
- `deviceDownload.test.ts`: `downloadIo.fetch` over a memory file system (the Expo app has no test of this file).
- `native.ts`: `AsyncStorage` (over localStorage), `SecureStore` (over `@aparajita/capacitor-secure-storage`), `uuid`
  and `NetInfo` (over `@capacitor/network`), with the Expo modules' names and shapes. The keys are not the Expo app's storage: #1643 carries them over on an existing install.
  `deviceFileBlob`: a device file as a `Blob`, read through the WebView (`Capacitor.convertFileSrc`).
- `account.ts`: the seam's `account` member (the web `AuthContext` calls it). Bearer session as in the Expo app; a
  new session claims the device library and adopts a guest's before the UI sets the user; sign-out pushes, then
  ends the session and wipes the library.
- `library.ts`: the seam's `library` member. Online it is the web's own calls (`api/userBooks`, bearer mode); offline
  or with no session, the books on this device (as the Expo Library screen). Delete is device-first. `syncNow()` is
  one library sync pass for the stored session.
- `vocabulary.ts`: the seam's `vocabulary` and `highlights` members. Saving a word needs the network, as in the Expo
  app (owner 2026-11-28). The reader's marks read the device rows, so they show offline. Highlights: the server's list
  online, this device's offline or with no session.
- `google.ts`: the seam's `google` member over `@capgo/capacitor-social-login` (the native sign-in). The button is
  a plain one.
- `sqliteDb.ts`: the `Db` surface of `localLibrary.ts` over `@capacitor-community/sqlite`. Same database name
  as the Expo app (`textstack-v2`).
- `readerSync.ts` (+ test): `createDeviceReaderSync`, the reader's `createSync`. It keeps the web `ReaderSync` contract
  (what `ReaderHost.tsx` calls) and saves as the Expo reader does, through `readerStorage()`. No member uses the network.
  - `restore` gives the stored place only; `loadHighlights` gives the stored highlights and quotations (`onHighlights`).
    The Expo reader restores the whole entry; the web host draws the highlights after the restore.
  - No session epoch guard, as in the Expo reader: a guest mint or a sign-in while reading does not stop the saves.
    The device library is the guard. After a wipe (sign-out, another account) it has no book with these bytes, so
    every write fails and the status is `unsaved`.
  - One queue of device writes. A save writes the page's latest `store` first, then the notes still to write. A failed
    store is `unsaved` and is written again by the next save. A failed removal stays `unsaved` for the rest of the open.
  - A note is kept in memory until the device takes it. A note on a highlight with no row yet (on pagehide the host
    writes the note before the last store) is written after the next store that lands; `unsaved` until then.
  - A note the device never read (`notes().unknown`, or before the first read) is not written over: `setNote` refuses
    it and the status is `unsaved` (Expo shows the editor loading; the web host has no such state).
  - `note` and `deleted` read the book's notes (`notes()`), kept in memory. They are read again after each edit and
    each sync pass.
  - Each save asks for one sync pass 10 s later (the Expo `SYNC_AFTER_SAVE_MS`). The timer is not cleared on close, so
    the last saves of an open still go soon.
  - While open, the book is the mounted reader of every pass (`holdReaderHost` + `openBookHost`); `close` releases it.
    Until `restore` resolves it is not restored (Expo `place.reader()`), so ADR-019 adopts a pulled place and the
    restore opens there. After it, it reports a reader who moved, as web does: a pulled place is kept or offered
    (`onNewerPlace`), never applied. The Expo reader moves a reader who did not move yet.
  - A reopen of the same bytes reads after the last session still writing (keyed by the sha256: a pass can re-key the id).
  - `complete`: `finishBook` (set once). It rejects with `NO_PLACE_YET` while this file has no stored place, as web
    rejects while the server has none. The Expo reader finishes with no place and keeps the write queued.
  - Not ported: the pass's `upload` of retained bytes (file sync). This app opens only books that the server has.
- `../android.reader.ts`: `openBook` gives the sync target again: the local file id (`file_id`); with none, the server's
  only when the server's file is these bytes; else no target. `hasToc` comes from one server look-up beside the open
  (Expo `openedToc.ts`), set on the target when it lands; only with a session and online. `queueSession` keeps an
  ended session in localStorage at once (`v2reader:pendingSessions`, the shared `pendingSessions` shape plus the
  book's bytes): pagehide waits for nothing. Then it goes into the device library (Expo `addSession`, under its client
  session id) and leaves localStorage only once kept there. `flushSessions` moves what is left, then runs the
  reader's first pass (failures retried).
  `accountEpoch` is `sessionEpoch`.
