# Readers lost their place in books (23505 upsert race)

**Date:** 2026-08-07
**Status:** Resolved

## Impact

`PUT /me/progress` returned 500 ten times in four hours from real readers, dropping the saved reading position.

## Root cause

Read-then-insert with no concurrency control. One reader produces overlapping writes (30s heartbeat, sendBeacon on unload, offline flush, second device); both see no row, both INSERT, the loser violates the unique index.

## Fix

Catch SQLSTATE 23505 and merge into the winner's row, re-applying the stale-write guard against the winner's timestamp. PR #447.

## Lesson

One user is enough to race yourself. Heartbeat + `sendBeacon` on unload + offline flush + a second
device all write the same row; "concurrency" needed no second user at all.

## Detection

Sentry, within hours of the integration going live: ten 500s in four hours on `PUT /me/progress`,
grouped into one issue. This is the incident that paid for the integration — the endpoint had been
failing for real readers with no user-visible error and no server-side signal anyone was reading.

---

## Full write-up

*Preserved verbatim from the CHANGELOG entry of 2026-08-07. This is the long-form record — the source
material for articles and the detail a future reader needs.*

Found by Sentry on its first day in production, which is the point of having installed it. `PUT /me/progress/{editionId}` was throwing `Npgsql.PostgresException: 23505: duplicate key value violates unique constraint "ix_reading_progresses_user_id_site_id_edition_id"` — ten times in four hours, from real readers, returning a 500 and **dropping the reader's position in the book**. Nothing crashed, no test failed, and the only prior symptom would have been a user saying "it forgot where I was".

Root cause is a textbook read-then-insert with no concurrency control: `UpsertProgress` queries `ReadingProgresses` for the row, and inserts when it finds none. One reader legitimately produces overlapping writes — the 30s session heartbeat, a `sendBeacon` on unload, an offline-queue flush after reconnect, or simply a second device — so two requests both see no row, both `INSERT`, and the loser violates the unique index. The window is milliseconds wide, which is why it only appears at real traffic and never in a test.

Fix: catch the unique violation and merge into the winner's row instead of failing. On `DbUpdateException` with SQLSTATE **23505** (matched via `PostgresErrorCodes.UniqueViolation`, not a message string, so it survives locale and constraint renames) the doomed insert is detached, the winner is re-read, and the client's write is applied to it — the exact update path we would have taken had we lost the race by one more millisecond. Critically, **the stale-write guard is re-applied against the WINNER's timestamp**, so recovering from the race still cannot move a reader backwards; and the monotonic `MaxChapterNumber` high-water mark (which feeds the RAG spoiler gate) is raised through the same shared `ApplyProgressUpdate` helper used by the normal path, so the two can never drift. A unique violation with no winning row (e.g. deleted in between) is rethrown rather than silently swallowed — that is not the race we know how to recover from.

Chosen over a native `INSERT … ON CONFLICT DO UPDATE` deliberately: the endpoint's semantics include an early return that echoes the *existing* row back when the client's timestamp is stale, which does not express cleanly in an upsert statement, and rewriting a hot path into raw SQL to fix a millisecond race is more risk than the race. The retry keeps every existing behaviour and touches one method.

**1289 unit tests green** (9 new, locking the high-water-mark monotonicity, the NULL-vs-ordinal-0 seeding rule, and that the recovery triggers on 23505 and nothing else — a foreign-key violation must still surface). Build + `dotnet format --verify-no-changes` clean. No migration.
