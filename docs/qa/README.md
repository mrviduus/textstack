# QA Test Scenarios

Manual test scenarios for verifying reader functionality.

## Structure

```
docs/qa/
├── README.md           # This file
├── MOBILE-TEST-PLAN.md # The mobile e2e lane, as specified
├── scenarios/          # Individual test scenarios — the steps
│   └── *.md
└── reports/            # What a given run actually found, dated
    └── YYYY-MM-DD-*.md
```

## Running Tests

When asked to run a QA scenario:
1. Follow steps exactly as written
2. Verify each expected result
3. Document any deviations in "Actual Results"

## Instrumenting a defect for the next run

**Diagnostics meant for a device reproduction must not be behind `__DEV__`.**

A tester runs the Play build plus an OTA. `__DEV__` is false there — only the
`development` EAS profile sets `developmentClient`. A `console.log` added to
"make the next run report a fact" prints nothing in the only configuration the
next run will use.

This is written down because it happened: the language-onboarding defect was
reproduced three times, each time with logging in place that could not fire, so
three reproductions produced no evidence and two fixes were built on guesses.

Use `breadcrumb()` (`apps/mobile/src/lib/breadcrumb.ts`) instead — a Sentry
breadcrumb rides along with whatever the session reports, costs nothing when no
DSN is set, and is readable without a cable. Record the *inputs to the decision*
and the answer, not the flow: a breadcrumb per step is a trail nobody reads.

`__DEV__` stays right for warnings aimed at whoever is running the dev client.

## Observing a defect: a toast is a window, not a state

**Screenshot within a second of the action, or record the screen.** A late screenshot cannot
distinguish "no feedback" from "feedback you missed", and the two get written up identically.

From the QA-005 run: a defect was filed saying that Save with no session did nothing at all — no
request, no toast, no state change — and withdrawn on re-run. The toast lives 3.6 s; the screenshots
were taken 4–7 seconds after the tap. An empty screen was read as silence, and the app had in fact
said plainly that the word was not kept.

The rule generalises past toasts to every transient: haptics, a spinner, a flash of feedback, an
optimistic row that settles. If the evidence is a still frame, the still frame has to be inside the
window. `adb shell screenrecord` costs nothing and answers "when", which a screenshot cannot.

Corollary, from the same run: **a negative claim needs a positive instrument.** "Nothing was sent"
is only worth writing down if a traffic log was watching. Otherwise say the step could not be
verified.

## Scenario Format

Each scenario includes:
- **Preconditions**: Setup required before testing
- **Steps**: Actions to perform
- **Expected Results**: What should happen
- **Actual Issues**: Known bugs (updated after testing)

## Scenarios

| ID | Name | Area |
|----|------|------|
| QA-001 | [Reading Progress & Auto-Save](scenarios/QA-001-reading-progress.md) | Reader, Library |
| QA-002 | [Library Multilang Navigation](scenarios/QA-002-library-multilang-navigation.md) | Library, i18n |
| QA-003 | [SSG Rebuild Admin](scenarios/QA-003-ssg-rebuild.md) | Admin, SSG |
| QA-004 | [Bookmarks & Autosave](scenarios/QA-004-bookmarks-autosave.md) | Reader, Bookmarks |
| QA-005 | [Guest Loop](scenarios/QA-005-guest-loop.md) | Auth, Reader, Vocabulary, Profile — Android only |
| QA-006 | [Assistant handoff & the September fixes](scenarios/QA-006-assistant-handoff-and-september-fixes.md) | MCP key, Insights, Tutor, Genres, Guest merge — Android only, **not yet run** |

Runs live in [`reports/`](reports/); the most recent is
[2026-09-06 — QA-005 on the Android emulator](reports/2026-09-06-android-guest-loop.md).
