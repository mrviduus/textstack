# 425 author pages returned 404 to Google while working perfectly for people

**Date:** 2026-08-31
**Status:** Resolved — recurred 2026-10-01, see Addendum

## Impact

425 of 716 authors — every one of them with at least one published, indexable book — had
`authors.indexable = false`. SSG prerenders only authors that pass that flag, and nginx routes
crawlers to SSG output rather than the SPA. So `/en/authors/<slug>/` returned **404 to Googlebot and
200 to a browser**, for the same URL, at the same moment:

```
/en/authors/george-grey/    human=200   Googlebot=404
/en/authors/lew-wallace/    human=200   Googlebot=404
/en/books/dracula/          human=200   Googlebot=200
```

Sampled 40 authors drawn from the database rather than from any public listing: 12 were in the
public index and all 12 answered 200 to a crawler; 28 were not and all 28 answered 404. No
exceptions in either direction.

Duration is not precisely bounded. The `false` rows were created between 2026-01-01 and 2026-03-16;
a partial backfill on 2026-05-19 brought 189 authors back but left 527 behind. The Ahrefs crawl of
2026-08-25 recorded 356 of them as 404, 348 of those newly seen. Search Console at the time of this
write-up: 644 pages indexed, 2,846 not indexed, **7 total search clicks in three months**.

## Root cause

Migration `20251225233053_AddAuthorsGenresSeoFields` added `authors.indexable` without
`defaultValue: true`. Every row that already existed got `false`. The entity default in
`Domain.Entities.Author` is `true`, so authors created through the application are fine — which is
why the pool refilled with correct rows after May and the problem looked closed.

The flag is read by the SSG route builder in `SsgEndpoints.cs`:

```csharp
var authors = await db.Authors
    .Where(a => a.Indexable)
    .Where(a => a.EditionAuthors.Any(ea =>
        ea.Edition.Status == EditionStatus.Published && ea.Edition.Indexable))
```

Nothing here is wrong. `Indexable` means "an admin chose to hide this author", and honouring it is
correct. The defect is that 425 rows were carrying a value nobody chose — a migration artefact
wearing the costume of a deliberate decision.

What turned a data blemish into an SEO outage is the split-serving in nginx: bots get SSG, humans get
the SPA fallback. A page missing from SSG is a hard 404 for a crawler and a perfectly good page for a
person. The two audiences cannot see each other's failures.

## Fix

Data, not code. A backfill of the 425 rows that have a published indexable edition, taken under a
full `pg_dump` with the affected ids saved separately so a rollback is 425 rows rather than a restore:

```sql
UPDATE authors a SET indexable = true
WHERE NOT a.indexable
  AND EXISTS (SELECT 1 FROM edition_authors ea JOIN editions e ON e.id = ea.edition_id
              WHERE ea.author_id = a.id AND e.status = 1 AND e.indexable);
```

`indexable = true` went from 189 to 614; authors with a published book and `false` went to zero; 102
remain false and should, having no published book. The SSG route list grew from 185 authors to 610,
and a full rebuild was queued.

This closes the **instance**. It does not close the class, and the May backfill proves it: the same
statement was run on 2026-05-19, fixed part of the pool, left the rest, and nobody knew for three
months. The class is closed — as far as it can be — by the detection below.

## Lesson

**When crawlers and people are served different responses for the same URL, every human check is
blind by construction.** Opening the page, clicking the link, asking a colleague to look — all of it
confirms the half that works. The site had been visibly fine to everyone who visited it while half
its author pages were 404 to the only visitor that mattered for growth.

The corollary is about the flag itself. A column that means "someone decided to hide this" must never
be able to acquire that meaning by accident. A migration that adds such a column without a default
does not create a missing value; it creates 527 false decisions that are indistinguishable from real
ones. If the code comment left after May had been a `defaultValue: true` instead, there would have
been nothing to find today.

## Detection

Found by accident, three months in, and that is the important sentence.

The owner sent an Ahrefs site-audit link for an unrelated reason — we were discussing Play Store
testers. The audit had been sitting there since 2026-08-25 with `404 page: 356` on its front screen.
Nothing alerted; the number was visible to anyone who opened the tab and nobody had.

No alarm existed that could have caught it. `health-check.yml` ran every five minutes and checked the
API, both frontends, book listing and search — all with a default user agent, so all served the SPA,
so all green throughout. The check that would have caught this on day one is the one that asks a
crawler's question, and it now exists: a step samples books from the public API, follows each book's
author to `/en/authors/<slug>/` with a Googlebot user agent, and fails on anything but 200. Sampling
from the books API is deliberate — every public listing of authors is generated by the same filtered
query the bug lives in, so a missing author is invisible there. A book's author is the one public
place a missing author still appears.

Verified the probe fails before it passes: run against production mid-rebuild it reported four of
seven sampled authors uncrawlable and exited non-zero.

---

## Full write-up

The first hypothesis was wrong and worth recording. The 404s were all author pages, so the obvious
guess was slug encoding: the first row in the audit was `hjalmar-söderberg`, non-ASCII, exactly the
shape of a slug-generation mismatch. It was a coincidence of alphabetical sorting. Percent-encoding
the slug and refetching returned the same 404 as the plain ASCII ones.

The second wrong turn was mine and cost more time. A sweep of all 185 authors from the public API
reported zero failures while a direct check of `george-grey` returned 404 seconds later. The sweep
was not wrong about the authors it tested — `george-grey` was never in the list it was testing, which
was the finding, not the error. But the sweep also had a real bug: `curl` inside `while read` consumes
stdin, so the loop count could not be trusted either. Two defects with the same symptom, one of them
the answer.

The thing that resolved it was refusing to sample from the API listing and going to the database
instead. 716 authors in `authors`, 185 in the public list — a gap that no public endpoint could have
revealed, because every public endpoint is downstream of the filter.

## Addendum — 2026-10-01: it came back, as predicted

The health-check smoke (the detection added above) failed on 2026-10-01: André Gide, Mary De Morgan
and Grimmelshausen answered 404 to a crawler. A full SSG rebuild did not help. 14 authors were
hidden with a published book, every one created 2026-03-16 and published by auto-publish between
2026-09-11 and 09-14.

The August backfill flipped only the artefact rows that **already** had a published book; the
"102 remain false and should" were artefacts too — they just had no book yet. Auto-publish then gave
them books, and nothing re-evaluates an author's flag when one of their books is published.

Fix: migration `BackfillAuthorIndexableArtefacts` sets `indexable = true` on every `false` row
created before 2026-03-17 — the whole artefact pool, not the 14 that surfaced. After it, `false`
can only mean an admin hid the author. Lesson: a backfill that fixes the rows that *currently*
misbehave leaves the latent ones armed; fix the class of rows that carry the accidental value.
