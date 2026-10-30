# A migrator for a database nobody reads yet kept the API from starting

**Date:** 2026-10-30
**Status:** Resolved — 44 minutes. `textstack_v2` still cannot be created on the server, which is a separate, pre-existing defect (#1056).

## Impact

`https://textstack.app/api/*` returned 502 from **14:01 to 14:45 UTC — 44 minutes** — between the
deploy of `fa136ece` (#1050), which recreated `api` and `worker` and then refused to start them, and
the deploy of #1057, which started them. Measured by polling `/api/health/ready` from outside: 502
at 14:45:00, 200 at 14:45:30. Static pages kept serving — nginx has
the SSG output on disk, so `/en` answered 200 throughout — so what broke was everything that needs
the API: sign-in, uploads, the reader for uploaded books, vocabulary, TTS, translation, the MCP
server and the admin panel.

The deploy of #1052, queued behind it, failed at the same step.

## Root cause

M1.1 (#1050) added `migrator-v2` to `docker-compose.yml` and gave `api` and `worker`:

```yaml
depends_on:
  migrator-v2:
    condition: service_completed_successfully
```

`docker compose up -d` honours that condition before it starts a dependent, so `migrator-v2` exiting
non-zero is indistinguishable, to the deploy, from "the database is not ready": it starts neither
container and exits 1. The site went down for a database **nothing connects to** — M1.2 is the slice
that writes the first repository against `textstack_v2`, and it has not landed.

Why `migrator-v2` exited 1 is a second, unrelated defect, found in its container logs:

```
ERROR:  template database "template1" has a collation version mismatch
DETAIL:  The template database was created using collation version 2.41, but the
         operating system provides version 2.36.
```

`CREATE DATABASE` copies `template1`, and PostgreSQL refuses to copy a template whose recorded
collation version does not match the one the running OS provides. On the server:

| database | `datcollversion` | |
|---|---|---|
| `textstack_prod` | 2.36 | matches the OS — the live database is fine |
| `template1` | 2.41 | mismatch — nothing can be created from it |
| `postgres` | 2.41 | mismatch |

So the cluster has been unable to create *any* new database since whenever its image's glibc went
backwards (2.41 → 2.36), and nothing noticed, because nothing had created a database since initdb.
`run.sh` was the first caller in the cluster's life. The live database is not at risk: its own
collation version matches, which is the thing that would threaten its text indexes. Tracked as
#1056; the one-line repair is `ALTER DATABASE template1 REFRESH COLLATION VERSION` (and the same for
`postgres`), on a cluster where neither database holds application data.

The sharp edge here is that this was a *pre-existing, invisible* server condition. No test could
have caught it: CI and local runs create `textstack_v2` against a freshly-initdb'd container whose
template matches by construction. Which is the point of the next section.

The gate was the defect regardless of that. It was reviewed three times — `/check`, an
adversarial QA pass, `/code-review` at `xhigh` — and all three read the dependency as correct
because ADR-021 says only the migrator migrates and the API waits for it. It says that about the
database the API reads. Copying it to a database the API does not read turned a V2 problem into an
outage.

## Fix

#1057: `migrator-v2` moves behind the compose profile `v2` and nothing depends on it. `docker compose
up` no longer runs it; `make migrate-v2` does, and `docker compose run` enables the profile itself.
The CI round trip is unaffected — it runs the migrations under `docker run`, not compose.

This closes the **class** for now, in the only way that is true today: no service gates on V2 while
no service reads V2. It does not close the class for later. When M2.2 puts real data in
`textstack_v2`, "is V2 migrated?" becomes a real question again, and the answer has to be a
readiness gate on the V2 endpoints — `/health/ready` already does exactly this for the legacy
database (behind schema → 503) — and never a container that must exit 0 before the site may start.

## Lesson

**A dependency is a decision about what may take the site down.** `depends_on` reads like
bookkeeping — this starts after that — and it is not: every `service_completed_successfully` is a new
way for the site to stay dark. The question to ask of each one is not "is this the right order?" but
"if this exits 1 at 03:00, should users notice?" For infrastructure that no request path touches, the
answer is no, and the gate belongs in a readiness probe, where a failure degrades one feature instead
of all of them.

Corollary, for a strangler migration specifically: the new system's plumbing must be able to fail
alone. Two databases exist precisely so that V2 can be broken while V1 serves. A hard dependency
from V1's containers to V2's migrator quietly undid that, which is the one property the whole
two-database decision (ADR-030) was bought to get.

## Detection

**By the owner, reading a red CI cross, about seven minutes in** — "one ci is down completely." Not
by an alarm; the alarm never ran. `health-check.yml` polls `/api/health/ready` on
`cron: '*/5 * * * *'`, and its last run before the outage was **08:56 UTC**, five hours earlier:
GitHub drops most scheduled runs at that frequency, so a five-minute cron in the file is a
three-to-six-hour cron in practice. The check works; its schedule is fiction (#1054).

Second gap: the deploy job reported `service "migrator-v2" didn't complete successfully: exit 1` and
nothing else. It never asked the container why — `docker compose logs migrator-v2` was one line away
from being in the failure output, and its absence is why the cause above needed an SSH session, and
an interactive VPN re-auth, to find at all (#1055).

---

## Full write-up

The misleading part was the shape of the failure. Nine of eleven CI checks on the open PRs were
green, the tenth (`advisories`) was a known-red registry re-scope being fixed in its own PR, and the
deploy that failed was two merges back in the list. Everything looked like a slow CI afternoon. The
site's own front page answered 200, because nginx serves SSG output from disk and does not need the
API to do it — so the first check anyone makes by hand ("is the site up?") said yes while sign-in,
uploads and the reader were all down. `/api/health/ready` was the only URL that told the truth.

What was ruled out, in order: a bad image (the digests pulled were this commit's, and `migrator`
itself exited 0); the baseline SQL (it never ran — the container failed before `migrate.sh`, since
`run.sh` does the `CREATE DATABASE` first and `set -eu` stops there); and a conflict with the legacy
migrator (the advisory lock `hashtext('schema_migrations')` is per-database, which M1.1 verified).

The fix was not the first instinct. Rolling back to `2e79f700` would also have restored the site, and
the break-glass command for it is in CLAUDE.md. Removing the gate was chosen instead because the
rollback would have un-shipped a correct schema baseline to fix a wrong dependency, and because the
dependency had to go either way — a rollback would have put the same trap back into the next deploy
of M1.1.
