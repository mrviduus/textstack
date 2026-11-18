# Mobile reader storage and sync

Mobile adapters for the [shared reader](../../../../../packages/reader/README.md).

- `hostStorage.ts`: retained book files and staging.
- `localLibrary.ts`: SQLite library, annotations, progress and outbox.
- `deviceLibrary.ts` / `deviceLibrary.web.ts`: platform adapters.
- `sync.ts`: push/pull sync with the API.
- `sqliteShim.ts`: SQLite test adapter.
- `hostErrors.ts`, `webViewVersion.ts`: device error and WebView checks.

Renderer, format readers and shared host protocol: `packages/reader/src/` from the repository root.
