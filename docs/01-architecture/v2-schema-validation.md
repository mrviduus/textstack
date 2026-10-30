# V2 draft SQL — disposable PostgreSQL validation

**2026-10-29 · Result: 32 checks passed after one draft-schema correction.**
This is constraint/lifecycle validation, not an accepted migration or an application readiness claim.

## Isolation and method

- PostgreSQL 16.15, matching the application's PostgreSQL major version, from the existing local
  `postgres:16` image. No pgvector extension was needed by these nine tables.
- A newly named container, no network, no published ports, database data on tmpfs. No existing volume,
  credentials, database or production backup used. The container was removed after the run.
- Minimal `public.users(id uuid)` fixture, then the complete nine-table draft. All users, books and
  text were generated fixtures. The current full `users` schema, triggers and legacy data were not tested.
- Each check used a transaction rolled back afterward. Expected failures checked the PostgreSQL
  SQLSTATE. Deferred constraints were forced immediate before rollback, including account deletion.
- Initial harness startup raced PostgreSQL's temporary initialization server; that attempt did not
  reach the schema. The harness was corrected to wait for final initialization before executing SQL.

## Checks

| Area | Checks | Result |
|---|---:|---|
| Schema creation and per-book checkpoint default/isolation | 3 | Pass |
| File hashes, owner isolation and one-current-version rule | 4 | Pass |
| Reading-state file ownership, fractions and paired frontier | 3 | Pass |
| Unanchored legacy quotes, required file for anchors, owner isolation | 3 | Pass |
| Vocabulary uniqueness, distinct language/forms, example/review ownership, retry-key uniqueness and unchanged card state after example insertion | 8 | Pass |
| Checkpoint append/uniqueness/nonempty content, share ownership, sharing without uploaded file bytes | 5 | Pass |
| Hidden-book removal, share unlink/delete, unchanged progress, replacement rollback and account cleanup | 6 | Pass |
| **Total** | **32** | **Pass** |

Operation-key uniqueness is not an implementation of retry-safe APIs. The database rejects duplicate
keys; handlers still have to compare canonical payloads and return the original response or a conflict.
The example test inserts a separate row directly; it does not validate a future word-save endpoint.

## Defect found and corrected

Deleting a fixture account initially failed because nondeferrable provenance foreign keys checked book
references before the cascade through word cards had removed their examples. The initial run had
31 passing checks and one failure.

Six `ON DELETE NO ACTION` foreign keys in the draft now use `DEFERRABLE INITIALLY DEFERRED`.
They remain enforced, but account deletion can complete its cascades before end-of-transaction checks.
The final run forced constraints immediate after the deletion and verified zero remaining records in
all nine tables for that owner; the other owner's library entry remained.

Ordinary book removal still sets `removed_at`; it is not a hard-delete cascade. Referenced-share
deletion still needs explicit unlinking. Deferred checks do not make invalid references acceptable
at commit. Future code must handle commit-time constraint errors as well as statement-time errors.

## Application contracts deliberately not enforced by the current DDL

Direct SQL probes confirmed that the draft permits:

- A non-lowercase `word_key`: the future API needs one canonical normalization contract.
- A checkpoint linked to a share from the same owner/book but a different file version: write logic
  must compare optional file/chapter provenance with the share.
- An empty JSON locator object: application code must validate the envelope and actual CFI/Range.

These are documented implementation responsibilities, not passing application checks. The DDL alone
does not establish authorization, valid locators, automatic lowercase conversion or semantic chapter identity.

## Limits and next step

No API/MCP handler, actual file upload, filesystem transaction, browser, phone, legacy schema integration,
sync conflict or concurrent-request behavior was tested. Share deletion retry receipts, tombstones and
retention remain open. Full legacy insight/auth/optional-table integration is outside this nine-table test.

Local generated-fixture harness and raw reports are at `/tmp/textstack-v2-schema-validation/` in this
session; they are temporary, not a checked-in regression suite. Preserve a reproducible integration
suite with the first implementation slice. Do not interpret this report as CI coverage.

Next: review the [schema](v2-library-draft.sql) with the owner, then write the Android local EPUB
import/open/restart/resume implementation PDD. Cloud sync and production schema rollout remain separate.
