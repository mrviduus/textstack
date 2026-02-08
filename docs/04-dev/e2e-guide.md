# E2E Testing Guide (Playwright)

End-to-end tests verify real user flows in a browser. We use [Playwright](https://playwright.dev/) — it launches Chromium, navigates pages, clicks buttons, and asserts results.

---

## Prerequisites

1. **Docker services running** — `make up` (API, DB, Worker)
2. **Books in the database** — at least one EN book with chapters (global setup auto-discovers them)
3. **Node deps installed** — `pnpm install` in repo root

> Web dev server starts automatically via Playwright config (`reuseExistingServer: true` locally).

---

## Quick Start

```bash
# Install Playwright browsers (first time only)
pnpm exec playwright install chromium

# Run all E2E tests headless
pnpm -C apps/web test:e2e

# Run in UI mode (interactive, recommended for QA)
pnpm -C apps/web test:e2e:ui
```

---

## UI Mode (Recommended for QA)

Launch:
```bash
pnpm -C apps/web test:e2e:ui
```

### What you see

- **Left sidebar** — test files and individual tests
- **Right panel** — browser rendering + action log
- **Bottom** — console output, errors, trace

### How to use

| Action | How |
|--------|-----|
| Run all tests | Click "Run all" button (top) |
| Run single test | Click the play icon next to a test name |
| Filter by file | Click a file in the sidebar to show only its tests |
| Filter by project | Use the project dropdown (chromium / mobile / admin) |
| Watch mode | Toggle the eye icon — tests auto-rerun on file change |
| Re-run failed | Click the red test → "Retry" |

### Reading failures

When a test fails:
1. **Error message** — shown inline, describes what assertion failed
2. **Screenshot** — captured on failure, visible in the attachments tab
3. **Trace** — click "Trace" to open Playwright Trace Viewer (timeline of every action, network request, DOM snapshot)

---

## Headless Mode

```bash
# All tests
pnpm -C apps/web test:e2e

# Single file
pnpm -C apps/web test:e2e -- e2e/tests/smoke.spec.ts

# Single test by name
pnpm -C apps/web test:e2e -- -g "loads homepage"

# Specific project only
pnpm -C apps/web test:e2e -- --project=chromium
pnpm -C apps/web test:e2e -- --project=mobile
pnpm -C apps/web test:e2e -- --project=admin
```

---

## Viewing Reports

After a headless run, Playwright generates an HTML report:

```bash
pnpm exec playwright show-report apps/web/e2e/playwright-report
```

The report shows pass/fail per test, duration, and links to traces and screenshots for failures.

### Trace Viewer

Traces are captured on first retry. Open a trace:
```bash
pnpm exec playwright show-trace apps/web/e2e/test-results/<test-folder>/trace.zip
```

Shows: timeline of actions, DOM snapshots before/after each step, network requests, console logs.

---

## Test Structure

```
apps/web/e2e/
├── playwright.config.ts          # Config, projects, webServer
├── global-setup.ts               # Auth + test data discovery
├── global-teardown.ts            # Cleanup
├── fixtures/
│   ├── auth.fixture.ts           # Auth fixture (logged-in context)
│   └── test-data.ts              # Test data helpers
├── helpers/
│   ├── api.ts                    # API login helpers
│   ├── storage.ts                # Storage state helpers
│   └── reader.ts                 # Reader page helpers
└── tests/
    ├── smoke.spec.ts             # Homepage, book page, basic navigation
    ├── auth.spec.ts              # Login, user session
    ├── search.spec.ts            # Search query → results
    ├── bookmarks.spec.ts         # Create/delete bookmarks
    ├── reader-progress.spec.ts   # Reading progress save/restore
    ├── reader-mobile.spec.ts     # Mobile reader (iPhone viewport)
    ├── library-multilang.spec.ts # EN/UK library switching
    └── admin/
        └── ssg-rebuild.spec.ts   # Admin SSG rebuild flow
```

### Projects

| Project | Viewport | Runs tests matching |
|---------|----------|---------------------|
| `chromium` | Desktop Chrome | All except `*mobile*` |
| `mobile` | iPhone 13 (Chromium) | Only `*mobile*` |
| `admin` | Desktop Chrome | Only `*admin*` |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ERR_CONNECTION_REFUSED` | Services not running. Run `make up` and wait for API to be healthy. |
| `.test-data.json not found` or empty | Global setup failed. Check API is reachable at `localhost:8080` and has books. |
| Auth failures | Ensure `ENABLE_TEST_AUTH=true` in `.env` or API is in dev mode. |
| Stale test data | Delete `apps/web/e2e/.test-data.json` and `apps/web/e2e/.auth/`, then re-run. |
| Browser not installed | `pnpm exec playwright install chromium` |
| Admin tests skipped | Admin login failed — check admin credentials or `ADMIN_URL`. |
| Tests timeout | Increase timeout in config or check if web server started (look at terminal output). |

---

## Links

- [Playwright Docs](https://playwright.dev/docs/intro)
- [UI Mode](https://playwright.dev/docs/test-ui-mode)
- [Trace Viewer](https://playwright.dev/docs/trace-viewer)
- [Test Runner CLI](https://playwright.dev/docs/test-cli)
