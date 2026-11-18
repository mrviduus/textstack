# Status

**Last updated: 2026-11-18.** Where the project is *now*: what is live, half-finished, known-broken or deliberately not done. What the product does: [`docs/README.md`](README.md). What changed and when: [the changelog page](https://textstack.app/en/changelog) (merged PRs by week); before #1220, [`CHANGELOG.md`](../CHANGELOG.md) and [`changelog-archive/`](https://github.com/mrviduus/textstack/tree/f465e6b0afa9fa5df1cc1cc8ca816f1cd22f9e74/docs/internal/changelog-archive). Closed items are deleted from here, not struck through; git history keeps them.

> **Keeping it honest:** a PR that finishes a line here deletes or moves that line in the same PR. New open items go to [GitHub issues](https://github.com/mrviduus/textstack/issues) with a label; the items below move to an issue when someone touches them.

---

## Shipped and live

TextStack is a personal library: you upload your own books and read them. The public catalog, its SEO pages and the SSG are gone (M6, 2026-11-17).

| Area | State |
|---|---|
| **Reader** (web + Android) | One reader: our foliate-js fork in a sandboxed page ([ADR-029](architecture/adr/ADR-029-foliate-for-v2-epub.md), [ADR-032](architecture/adr/ADR-032-one-engine-foliate-fork.md)), built by `apps/mobile/src/lib/v2reader/build.mjs`. EPUB, MOBI, AZW3, FB2, CBZ and PDF; highlights, notes, bookmarks, search in the book, TTS, saved-word marks, Discuss this chapter. On Android the book opens from the device, offline. iOS has no reader (M6 D4). `packages/reader-engine` is deleted ([ADR-025](architecture/adr/ADR-025-reader-engine-package.md) Superseded). |
| **Data** | One Postgres database, `textstack_v2` ([ADR-030](architecture/adr/ADR-030-two-databases-one-cutover.md) Done, schema [ADR-031](architecture/adr/ADR-031-v2-schema.md)); Dapper only, no EF Core ([ADR-028](architecture/adr/ADR-028-dapper-and-repositories.md)); one SQL ledger in `database/` run by the `migrator` service ([ADR-026](architecture/adr/ADR-026-sql-first-migrations.md), [ADR-021](architecture/adr/ADR-021-migrations-owned-by-the-migrator.md)). Book bytes on their own volume (`data/library`). The legacy database was dropped 2026-11-17 after a verified archive restore ([archive](internal/ops/backup.md#the-legacy-archive-pre-v2)). |
| **Sync** | `/me/v2/*`: revision + `operation_id` per write, change feeds, file sync in parts ([`v2-sync-protocol.md`](internal/v2/v2-sync-protocol.md)). |
| **Security & ops** | All P0/P1 items of the [architecture review 2026-10](https://github.com/mrviduus/textstack/blob/f465e6b0afa9fa5df1cc1cc8ca816f1cd22f9e74/docs/internal/architecture/review-2026-10/00-summary.md) fixed. `/me` and `/internal` fail closed by path ([ADR-024](architecture/adr/ADR-024-auth-fails-closed-by-path.md)); every ungated route is in `tests/TextStack.UnitTests/Routes/routes.public.txt`. Catalog URLs answer `410 Gone` from nginx (M6 D1). |
| **Backups** | Nightly `textstack_v2` dump + storage and library to Cloudflare R2 (restic), monthly restore drill. [`backup.md`](internal/ops/backup.md). The legacy archive (`pre-v2-cutover`) is kept outside restic and on the owner's Mac. |
| **AI platform** | Translate and Explain on OpenAI; local tasks on Ollama (soft in `/health/ready`). The conversation happens in the reader's own assistant. |
| **Assistant handoff (MCP)** | 18 tools (`backend/src/Contracts/Mcp/McpManifest.cs`) over stdio + streamable HTTP, all on `/me/v2`; OAuth sign-in ([ADR-017](architecture/adr/ADR-017-mcp-oauth-authorization-server.md)) or connect key. The catalog and retired tools went at M6 (D6, NuGet 2.0.0). [`mcp.md`](reference/mcp.md). |
| **Observability** | Sentry on API, Worker, MCP server, web and mobile; OpenTelemetry → Aspire locally only. [`delivery.md`](architecture/delivery.md#observability). |
| **Entitlements & guests** | `UserTier { Guest, Free, Supporter, Staff }`, config-driven quotas; guests get a real server session that registering promotes in place ([ADR-014](architecture/adr/ADR-014-guest-sessions.md)). |
| **Mobile** | Android is in **production on Google Play**. Expo SDK 57 / RN 0.86. OTA via `expo-updates` on merge; a moved runtime fingerprint builds and submits to Internal instead. Release runbook: [`play-store-release.md`](internal/ops/play-store-release.md). |
| **Admin** | `apps/admin` at textstack.dev is a shell: login and an empty home (M6 D2). Knobs are edited by SQL. |
| **Delivery** | Build once on GitHub, deploy by digest ([ADR-020](architecture/adr/ADR-020-build-once-deploy-by-digest.md), [`delivery.md`](architecture/delivery.md)); secret-scanned images; fatal pre-deploy dump; pinned actions. One Node version in `.nvmrc`, one pnpm workspace with a version catalog, weekly dependency refresh PR. |

## V2 — done

The V2 program ([#1013](https://github.com/mrviduus/textstack/issues/1013)) finished on 2026-11-17: M5, the switch, and M6, legacy retirement, the same day ([plan](internal/v2/m6-deletion-plan.md); the legacy archive: [backup.md](internal/ops/backup.md#the-legacy-archive-pre-v2)). The plan and its audits are kept as history ([`v2-plan.md`](internal/v2/v2-plan.md), [`architecture/v2.md`](architecture/v2.md)). Post-M6 text cleanup (wave 20, #1420–#1422): comments, docs, skills and agents describe the V2-only system.

## In flight

**Focus (owner): no new side work.** Anything new goes into Known-broken below and is not started, unless it is a production outage or a security problem.

- **One parser = the client ([ADR-033](architecture/adr/ADR-033-client-is-the-only-parser.md), [plan](internal/v2/one-parser-plan.md)):** book details on upload ([#1426](https://github.com/mrviduus/textstack/issues/1426)), then TOC sync, then server extraction deleted.
- **M6 leftovers:** dead web CSS and params, the mobile offline download format, unused shared exports, two MCP gaps — [#1406](https://github.com/mrviduus/textstack/issues/1406).
- **Bring back on V2:** goals, achievements, per-book stats, vocabulary settings/pending/lookups/concepts, highlight review — [#1366](https://github.com/mrviduus/textstack/issues/1366).
- **Book page:** show saved conversations (MCP checkpoints) — [#1405](https://github.com/mrviduus/textstack/issues/1405).
- **Reader follow-ups:** wave 18 review leftovers [#1364](https://github.com/mrviduus/textstack/issues/1364); opened mark, contents param, hidden-bar clicks [#1385](https://github.com/mrviduus/textstack/issues/1385).
- **.NET base images:** [#1403](https://github.com/mrviduus/textstack/issues/1403).
- **Delivery, owner steps (ADR-020):** repo settings (require actions pinned to a full SHA, allowed actions = GitHub + verified + listed, turn off "Actions can approve PRs", delete the unused `CLAUDE_CODE_OAUTH_TOKEN` secret, enable non-provider secret patterns). Making the `mobile` CI job a required check.
- **Two-audience onboarding** ("I work in tech" / "I'm learning English"), planned, not started. [Plan](https://github.com/mrviduus/textstack/blob/f465e6b0afa9fa5df1cc1cc8ca816f1cd22f9e74/docs/internal/marketing/onboarding-consilium-2026-10-08.md).
- **Article:** Sentry write-up, draft on vasyl.blog; needs edits, image, publish, then a DEV cross-post.

## Known-broken / open follow-ups

Each is a real defect, known and not yet fixed.

**Server and ops**
- **No guest reaper since B3** (#1412 deleted `GuestCleanupWorker` with EF; `RetentionCleanupWorker` sweeps sessions, tokens, grants and LLM traces, not guest users). Abandoned guest rows and their uploads stay. Needs an issue.
- **Upload covers are readable by URL without auth** (`/storage`, ADR-024 step 2) — #956.
- **`/internal` trusts a forwarded address from the home LAN** (ADR-024): `ForwardedHeaders` trusts `X-Forwarded-For` from 192.168/16. nginx refuses it from outside.
- **Six user routes live outside `/me`** and rely on their handler's check: `GET /auth/me`, `POST /auth/device/approve|deny`, `POST /oauth/authorize/approve|deny`, `GET /oauth/token-status`. No plan to move them.
- **The transitional tables' comment says "Dropped at M6.4"**; they are kept (ADR-031 Amended 2026-11-17, D8). Changing the comment is a migration.
- **Mobile OTA targets one runtime only** (#762, issue #914): it publishes to the runtime of the newest *finished* production build. If production runs an older build than Closed testing, production stops receiving OTAs. [Runbook](internal/ops/play-store-release.md#known-limits-of-the-automatic-ota).
- **GitHub scheduled backups run hours late** (`backup.yml` cron 03:00 UTC started 10:12 on 2026-10-05). Consider triggering from the server's cron, GitHub schedule as a fallback.
- **Server hygiene:** three `.env.bak*` files with live secrets; the server's `node_modules` does not match the lockfile.
- **Review 2026-10 P2 still open:** #16 background services inside the API, #18 auth opt-in per endpoint, #19 admin API on the public host / no audit log, #26 (GDPR delete leaves LLM trace text, caches, backups).
- **Dependency advisories with no fix to apply** are listed in `KNOWN` in `scripts/check-advisories.mjs`.
- **`@sentry/react-native` is ahead of the Expo SDK pin**; recorded in `expo.install.exclude` as deliberate, but nobody remembers whether it was.
- **Play Console** (#915, #916): the Data Safety form may still hold the pre-2026-08-20 answers; the correct answers are in [`play-store-release.md`](internal/ops/play-store-release.md). The feature graphic and one screenshot still show "Ask this book".
- **Permissions:** 20 OEM launcher/badge permissions via `expo-notifications` (WATCH list in `apps/mobile/scripts/check-android-permissions.mjs`).

**Product**
- **Web has no service worker,** so nothing is real offline in a fresh tab.
- **A new user is shown nothing that explains the app** (`onboarding/language` only asks the native language; guests are not asked).
- **iOS Universal Links were never configured**, and iOS has no reader (D4).
- **Login answers 500, not 401,** when a stored password hash is malformed (BCrypt throws); only reachable with bad data.
- **`ReviewCardDto.reviewMode` is a dead field** (`packages/shared/src/types/api.ts`).
- **`t()` has no plural rules;** `plural()` in `packages/shared` handles English one-vs-many in code.

## Under discussion (no decision)

Nothing at the moment.

## Deliberately not doing

Recorded so they stop being re-proposed:

- **Z-Library integration.**
- **Billing / Stripe / tier upgrade from the UI.** Tiers exist; monetization does not.
- **An admin console over users.** Staff is a config allowlist; the population is 1–3 people. The admin app stays a shell (D2).
- **Python anywhere.**
- **Audiobooks.** A recurring per-book narration cost against a product whose thesis is reading; TTS already reads any selection aloud.
- **A bot that merges its own dependency updates.** A merge deploys production; the rest of the constraints are why nothing merges itself.
- **Majors, applied automatically.** `deps-refresh.yml` raises patch and minor in the catalog and reports majors without touching them.
- **A public catalog.** Retired at M6 ([ADR-027](architecture/adr/ADR-027-retire-public-catalog.md), #992).
