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
| `sqliteShim.ts` | `reader/sqliteShim.ts` |

Changes in the copies: import paths, and a `@vitest-environment node` line in the tests.

## New here
- `sqliteDb.ts`: the `Db` surface of `localLibrary.ts` over `@capacitor-community/sqlite`. Same database name
  as the Expo app (`textstack-v2`).
