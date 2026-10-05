# Incidents

Postmortems for things that broke in production. One file per incident, newest first.

These are here because they are the most valuable writing in the repository — not the features. A
feature entry says what the system does; an incident says what it did *instead*, and why nobody
noticed. That is the part worth reading a year later, and the part worth writing articles from.

**Blameless.** Every one of these was caused by a reasonable decision made with the information
available at the time. The fix that matters is the one that closes the *class*, not the instance.

| Date | Incident | Shape |
|---|---|---|
| 2026-09-02 | [A deploy waited on a prompt, and 1990 pages went missing](2026-09-02-corepack-prompt-stranded-the-ssg.md) | A move, not a copy |
| 2026-09-01 | [SSG rebuilds failed silently after the workspace move](2026-09-01-ssg-worker-lost-its-output-path.md) | Absolute path outlived its layout |
| 2026-08-31 | [A deploy wiped the SSG build that was running](2026-08-31-deploy-wiped-a-running-ssg-rebuild.md) | Reported what it did, not what survived |
| 2026-08-31 | [425 author pages 404'd to Google while working for people](2026-08-31-authors-404-to-crawlers-only.md) | Split serving hides the failure |
| 2026-08-11 | [SSG dead for five weeks — a forbidden HTTP header](2026-08-11-ssg-dead-five-weeks.md) | A mitigation that could never work |
| 2026-08-07 | [The scrubber built to stop SQL leaks leaked SQL — twice](2026-08-07-sentry-scrubber-leaked-sql.md) | Second egress path |
| 2026-08-07 | [Readers lost their place in books (23505 upsert race)](2026-08-07-reading-position-lost-23505.md) | Racing yourself |
| 2026-07-18 | [A shifted double-delete destroyed a real chapter](2026-07-18-double-delete-destroyed-chapter.md) | Stale index after mutation |
| 2026-07-14 | [Nothing crashed and the CPU sat at 390% for an hour](2026-07-14-pdf-parse-fell-to-ollama.md) | Silent routing fallback |
| 2026-07-14 | [A hung RAG parse wedged the whole indexing worker](2026-07-14-rag-parse-wedged-worker.md) | Shared fate in a sweep loop |
| 2026-07-10 | [The nightly backup leaked 156 GB and broke itself](2026-07-10-backup-leaked-156gb.md) | Measuring the wrong mount |
| 2026-07-09 | [Spurious "Unauthorized" mid-session](2026-07-09-refresh-token-stampede.md) | Rotation + concurrency |

## Recurring shapes

Read the list above and the same failure keeps returning in different clothes:

1. **Silence is the symptom.** SSG, the PDF route, the RAG parse and the backup all reported success
   while doing the wrong thing. Nothing threw. The evidence was an *absence* — of pages, of chunks, of
   free disk — which no alert was watching for.
2. **The mitigation was there and did not work.** The `Host` header, the SQL scrubber, the `df -h`
   check: each existed, each was believed, none was verified against the real path.
3. **A second path bypasses the first fix.** Breadcrumbs then events; one delete then a renumber.
   Close the class or expect the sequel.

## Writing one

Copy [`_TEMPLATE.md`](_TEMPLATE.md). Name it `YYYY-MM-DD-short-slug.md` using the date it was
*discovered*. Add a row to the table above and link it from the `CHANGELOG.md` line.

A postmortem earns its file when the answer to "why didn't we see it?" is more interesting than the
diff. If the answer is just "we hadn't written that code yet", it is a changelog line, not an incident.
