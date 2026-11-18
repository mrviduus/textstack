# The scrubber built to stop SQL leaks leaked SQL — twice

**Date:** 2026-08-07
**Status:** Resolved

## Impact

Statement text and schema (no parameter values) left the process to a third party, through two independent channels.

## Root cause

EF Core interpolates SQL into the human-readable text, not the structured `data` bag — first via breadcrumbs, then via Error-level events picked up by the ILogger integration.

## Fix

Drop EF Core breadcrumbs and events outright rather than redacting them; the same failure is reported by ExceptionMiddleware with a stack trace and no SQL. PRs #446, #445.

## Lesson

A scrubber written against one egress path will be bypassed by the next one. Breadcrumbs and events
are separate channels into the same SDK; blocking one said nothing about the other. Allowlist what
leaves, don't denylist what you happened to think of.

## Detection

Both halves were caught by looking, not by an alarm. The breadcrumb leak surfaced during the first
live verification of the Sentry integration; the event leak surfaced on the first full production day,
reading real issues. A scrubber has no failing test to write against unknown egress paths — the only
detection is to read what actually arrived at the vendor.

---

## Full write-up

*Preserved verbatim from the CHANGELOG entry of 2026-08-07. This is the long-form record — the source
material for articles and the detail a future reader needs.*

Caught by the integration's own first day in production. Yesterday's PR (#445) found and fixed EF Core **breadcrumbs** carrying `Executed DbCommand … SELECT …` in their message; that fix was real but incomplete. EF Core also logs a *failed* command at **Error** level, and Sentry's `ILogger` integration turns any Error into an **event** — so the first live capture of the (separately real) `PUT /me/progress` failure arrived with `INSERT INTO reading_progresses (id, chapter_id, edition_id, locator, max_chapter_number, percent, site_id, updated_at, user_id) VALUES (@p0, …)` inline in the event message. Two distinct channels, one shared assumption: that nulling the structured `data` bag was where the SQL lived. It never was — EF interpolates the statement into the human-readable text on both paths.

Scope of the exposure, stated precisely: **no parameter values ever left the process** — `EnableSensitiveDataLogging` is off, so EF renders `@p0` / `'?'`, and Npgsql itself writes "Detail redacted as it may contain sensitive data" on the inner `PostgresException`. What did leave was statement shape and schema (table and column names). No book text, no reader identity. Still a promise this integration explicitly made and broke, and schema disclosure to a third party is not free.

Fix: `SentryScrubber.Scrub` now drops any event whose `Logger` starts with `Microsoft.EntityFrameworkCore`, plus a message probe for `Executed DbCommand` / `Failed executing DbCommand` so a re-categorised logger can't reopen the hole (`SentryScrubber.IsDatabaseCommandEvent`). **Dropping loses no signal**, which is what makes it the right call rather than a redaction exercise: the same failure is already reported by `ExceptionMiddleware` as a `DbUpdateException` carrying a full stack trace, the Npgsql SQLSTATE (`23505`) and the violated constraint name — everything needed to debug it, none of the SQL. A test locks that the middleware event survives while the EF command event dies.

The generalisable lesson, and the reason this is worth a CHANGELOG entry rather than a quiet patch: **a scrubber written against one egress path will be bypassed by the next one.** The original design rejected Sentry's OpenTelemetry exporter precisely because it bypasses `BeforeSend` — then shipped with two log-pipeline channels doing the same thing from the inside. Unit tests were green throughout both, because they asserted the scrubber's behaviour on the input shape we imagined rather than on what the SDK actually assembles. Only reading a real captured event found either one.

**1284 unit tests green** (3 new), build + `dotnet format --verify-no-changes` clean. No migration, no config, no behaviour change when `SENTRY_DSN` is unset.
