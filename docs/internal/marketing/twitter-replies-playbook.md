# TextStack — Twitter "drop your link" reply playbook

Use for replies in build-in-public / "what are you shipping this weekend" / "share your project" threads on X.

---

## Core positioning (one-liner you can always fall back on)

> A reader for developers who want to finish English technical books in their native language. Tap any term → context-aware translation that knows the book's domain.

The DDIA story is the strongest hook you have. Use it whenever you can.

---

## Reply variants

Pick by tone of the host thread. Each is under the X 280-char limit unless noted.

### Variant A — DDIA story (strongest, lead with this)

> Quit *Designing Data-Intensive Applications* three times.
>
> Built TextStack on the fourth — a reader that translates tech terms in-context. Tap "attention" in an ML book → you get the neural-net meaning, not the everyday one.
>
> https://textstack.app

**When to use:** Any thread where the host welcomes a short backstory. Default choice.

---

### Variant B — Kindle Word Wise replacement (devtools/indie crowd)

> A modern Kindle Word Wise, built for tech books instead of conversational language.
>
> Tap unfamiliar terms → LLM translation aware of the book's domain. Capped weekly SRS, so no review spiral.
>
> 18+ languages. Sample chapters open without signup → https://textstack.app

**When to use:** Threads run by devtools / indie founders (Levels, Marc Lou, Tony Dinh). They appreciate the comparison framing.

---

### Variant C — ESL devs angle (international audience)

> Building TextStack: a reader for devs who read English tech books as a second language.
>
> Tap any term → context-aware translation. "Eventual consistency" gets the distributed-systems meaning, not the dictionary one.
>
> https://textstack.app

**When to use:** Threads with a non-US-centric audience, or hosts who themselves are non-native English speakers. Big lever — there are way more ESL devs than English-native ones reading dense English books.

---

### Variant D — AI engineering learners (specific niche)

> TextStack — built it to actually finish AI/ML books without losing the thread when terms pile up.
>
> Tap "attention", "embedding", "B-tree" → translation aware of the domain you're reading. Offline PWA + mobile.
>
> https://textstack.app

**When to use:** Threads in the AI-eng community (swyx-adjacent, ML Twitter, "learning ML" posts).

---

### Variant E — minimum viable reply (when thread is huge / saturated)

> Building TextStack: read English tech books in your native language. Tap a term → context-aware translation. The thing I wished existed when I quit DDIA.
>
> https://textstack.app

**When to use:** Threads with 200+ replies where you need to be punchy or get scrolled past.

---

## What to attach (do this every time)

- **A screenshot or 5-second GIF of the tap-to-translate flow.** Visual replies in these threads get an order of magnitude more attention than text-only.
- **The repo's hero image works in a pinch:** `docs/assets/hero.png` from your README.
- Ideal: a short loop showing real DDIA-style text, finger taps "eventual consistency", popup with translation appears.

If you don't have a GIF yet, **make one before posting.** This is the single highest-leverage thing on the list.

---

## Rules (do not skip)

1. **Don't ask for stars in the first reply.** Closes more doors than it opens. The CTA in your README ("⭐ Star the repo if you've ever abandoned a technical book mid-way") is fine on the repo page — keep it off cold replies.
2. **Lead with the problem, not the tech stack.** Nobody on X cares that it's .NET 10 + Postgres in a "what are you building" thread. The DDIA story is the story.
3. **One reply per day, max.** More than that and X starts demoting your replies and the algorithm marks you as a spammer.
4. **Engage with 2-3 other replies in the same thread.** Adds signal that you're a real person, not a link-dropper. Reply to someone with a thoughtful comment about THEIR project.
5. **Don't reply to threads older than ~6 hours.** They're already dead.
6. **Track what works.** Keep a row per reply: thread URL, variant used, GIF y/n, impressions after 24h, stars added that day. After 5–10 attempts you'll know which angle wins.

---

## Where to post — accounts whose threads actually get read

Verify each is still active before relying on it (people change platforms).

### Tier 1 — high-signal "build in public" hosts

- **@levelsio (Pieter Levels)** — runs recurring "what are you working on" threads. Largest indie-maker audience on X. The DDIA hook lands hard here.
- **@marc_louvion (Marc Lou)** — ShipFast author, indie/SaaS audience. Variant B (Kindle Word Wise) fits his crowd best.
- **@tdinh_me (Tony Dinh)** — Black Magic / BlackBox indie maker. Friday "ship of the week" type threads.
- **@yongfook (Jon Yongfook)** — Bannerbear, OG build-in-public. Posts often, audience reads.
- **@arvidkahl (Arvid Kahl)** — bootstrapped founders audience. Good for the "I built the thing I needed" angle.

### Tier 2 — adjacent audiences worth a try

- **@swyx (Shawn Wang)** — AI engineering community. Variant D (AI-eng learners) is purpose-built for this audience.
- **@dannypostmaa (Danny Postma)** — AI tools indie hackers. Variant D works here too.
- **@patwalls (Pat Walls)** — Starter Story. Bigger general-business audience.

### Tier 3 — opportunistic

- **@sickdotdev** — the post in your screenshot (May 9, 2026, 5,912 views, 225 replies as of capture). Worth a reply but the thread is saturated; use Variant A or E and attach a GIF, otherwise you'll get scrolled past.

### Don't bother (for this audience)

- Generic "drop your SaaS" threads from no-name accounts with <5k followers. Audience is just other founders dropping their links — zero signal converts.

---

## Beyond X — higher-leverage shots worth queuing

X "drop your link" threads are a numbers game with low conversion. These convert way better per hour invested:

- **Show HN** — your DDIA story is exactly the kind of "I built the thing I wished existed" post HN loves. The dev.to article you've already got is half the writeup. One Show HN post can outperform 30 Twitter replies.
- **r/programming, r/learnprogramming** — same DDIA framing, but check subreddit self-promo rules first.
- **dev.to follow-ups** — you've got the original DDIA piece; a "6 months in: what I learned shipping TextStack" post would do well.
- **Hacker News /newest** — separate from Show HN, post the textstack.app link with the DDIA framing as the title.
- **Lobsters** — smaller but high-quality dev audience.

---

## Today's recommended action

1. Make a 5-second tap-to-translate GIF (or screenshot if a GIF is too much friction right now).
2. Pick **one** Tier-1 thread that's <6h old and posted today.
3. Reply with **Variant A**, GIF attached.
4. Reply thoughtfully to 2 other people's projects in the same thread.
5. Note the post URL and check it again in 24h.

That's it. Don't fan out across 5 threads in one day.
