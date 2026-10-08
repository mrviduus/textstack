# Onboarding, content & homepage — consilium 2026-10-08

Seats: product, marketing/content, product designer (mobile first). Status: **proposed, awaiting owner answers** (bottom).

## Owner decisions (2026-10-08, after the consilium) — these override the seats where they differ

1. **Two audiences at first-run, not one.** Owner overruled "no role question":
   - 💻 **I work in tech**: devs, data engineers, DevOps, QA, anyone in IT. Internal name: tech professionals.
   - 📖 **I'm learning English**: the current path, kept as is.
   - **Students: skipped for now.** No starter content for them.
2. **The choice switches content, not features.** Same reader for both. What changes:
   - the starter text (tech → a paper section; English → Alice, as today);
   - the card copy;
   - the **Popular / featured shelf**: tech → top papers and tech books; English → public-domain classics (today's shelf).
3. **Papers imported to prod (2026-10-08).** 10 CC BY 4.0 arXiv papers, built from arXiv HTML with `infra/scripts/arxiv-to-epub.py`. Each carries an "About this edition" attribution page. Genre `machine-learning`; author = lead author or team.

   | Paper | Author on the edition |
   |---|---|
   | Chain-of-Thought Prompting (Google) | Jason Wei |
   | Gemini | Gemini Team, Google |
   | Gemini 1.5 | Gemini Team, Google |
   | Gemma 3 Technical Report | Gemma Team, Google DeepMind |
   | LLaMA | Hugo Touvron |
   | Constitutional AI | Yuntao Bai |
   | Direct Preference Optimization | Rafael Rafailov |
   | Tree of Thoughts | Shunyu Yao |
   | Self-Consistency | Xuezhi Wang |
   | Mixtral of Experts | Albert Q. Jiang |

   - Admin upload **publishes immediately**, so all 10 are live. SEO fields were queued in SEO Backfill; some jobs stop at NeedsReview.
   - Not hostable (arXiv default licence): Attention, GPT-3, InstructGPT, DeepSeek-R1/V3, Llama 2/3, LoRA, RAG, Scaling Laws, Chinchilla, Toolformer.
   - Sparks of AGI is CC BY, but its arXiv HTML is broken (3 of ~10 sections), so it was skipped.
   - Known gaps: a few formulas render as raw TeX (DPO, ToT); figures built from LaTeX tables lose their body and keep only the caption (e.g. CoT Fig. 3).
4. **Tech starter candidate:** Chain-of-Thought, §1–2 (~1,000 words, dense in terms, the origin of "reasoning" models).

## Problem

Every first-run surface sells the language-learning app README says we are not:

- Mobile Discover `StartReadingCard`: "Learn a language by reading real books" (`packages/shared/src/i18n/en.json:55`) → opens **Alice in Wonderland** (`apps/mobile/src/lib/demoBook.ts`, same on web).
- Reader coachmark teaches Translate + Save. **Explain — the core interaction — is never shown.**
- Web `/en`: the hero ("Finish the book you keep quitting") is close, but the CTA opens Alice. After it come a classics StatsBar, emoji feature grid, a comparison vs LingQ/Kindle/Speechify (language-learning rivals), a "Classic literature" shelf, and an FAQ saying "programming books are being added".
- The gh-pages landing (#750, `origin/gh-pages:index.html`) already tells the right story, but it lives on github.io, where it builds no authority for textstack.app.

Root cause = **content + copy**, not the missing segmentation.

## Decisions (proposed, all 3 seats agree unless noted)

1. **No role question** ("programmer / student / learning a language?").
   - The answer changes nothing: every branch ends in the same reader.
   - The language-learner option reopens the audience we cut on 2026-10-04.
   - There are no analytics to act on the answer.
   - The question that matters already exists: native language (onboarding/language), which drives translate vs explain.
   - If the owner still wants it: one optional chip row on the existing language screen ("I mostly read: Tech books / Papers / Novels") that only picks the starter chapter. No new screen.
2. **One starter for everyone: a real tech text, opened on a short section, no account.**
   - Swap `DEMO_BOOK` (Alice) for it, mobile and web.
3. **Wow moment = Explain on a term you half-know**, e.g. "quorum", "log matching", "replication lag".
   - You get a domain-aware explanation in your native language without leaving the page.
   - No account, no setup, no new cost.
4. **Coachmarks:** reuse `ReaderTapCoachmark`, 3 steps max. No tour engine, no carousel.
   1. "Hold a term you half-know". 2–3 starter terms get a dotted underline, in this chapter only.
   2. The sheet opens with the explanation (this is the wow).
   3. At chapter end, reuse the `ownBookAsk` slot: "Upload your own book" / "Discuss this chapter with your Claude".
   - MCP is **not** in the first run (it needs an account and a connector setup). It is the second wow, later.
5. **Homepage = port the gh-pages landing into textstack.app `HomePage`** and delete the current sections. Don't merge the two.
   - Keep: the headline "Read the hard programming books. Finish them.", the autoplay live demo (dotted terms + Explain/Translate/Discuss), the real-reader GIF, the three ways, the MCP transcript, the founder story, and the typography (Source Serif + JetBrains Mono, highlighter marks).
   - Order: hero + live demo → GIF → three ways → MCP → "your books on every screen" → founder → CTA.
   - Cut: StatsBar, the emoji FeaturesSection, ComparisonSection, the language-learning FAQ items. The Classic-literature shelf becomes one "Browse the free library →" link (it keeps the SSG/SEO pages).
   - CTA: "Read <starter> now — no account" → opens the starter section with one term pre-highlighted.
   - Mobile fixes for the landing at 390px:
     - Hide the 3D book pile below 900px, so the demo sits right under the CTAs.
     - Make the 340vh pinned `journey` desktop-only, or cut it to about 150vh.
   - Book pile: show only books we host (Rust Book, SICP, Raft), or label the rest "your upload". DDIA, CLRS and Database Internals imply we host them.
   - After the port, gh-pages `index.html` → meta refresh + `rel=canonical` to textstack.app (Pages can't 301). `/architecture/` stays.
   - Must stay SSG-prerendered.
6. **Mobile `StartReadingCard` copy** → e.g. "Read the hard programming books. Hold a term you half-know." Meta: "<section>, ~5 min".
   - The landing passage and the app starter are the **same text**: write it once.
7. **Famous papers are a conversion asset, not an SEO engine.**
   - At DR ~3, "raft paper explained" and "attention is all you need explained" are unwinnable.
   - Long tail is possible: per-term pages ("raft election timeout explained") in EN + ES/DE/FR/PT/IT/UK.
   - Acquisition comes from distribution (below).

## Content: what we may host (verified by the marketing seat)

| Text | Licence | Verdict |
|---|---|---|
| **Raft — Ongaro PhD dissertation** "Consensus: Bridging Theory and Practice" (Stanford 2014) | CC BY 4.0. The Raft paper content is reproduced with permission | **Host.** Ch. 3 = the Raft paper in essence |
| Raft paper, USENIX ATC '14 | Noncommercial reproduction only | No, use the dissertation |
| **The Rust Programming Language** | MIT / Apache-2.0 | **Host** |
| **AOSA / 500 Lines** | CC BY 3.0 (code MIT) | **Host** (e.g. the nginx and Git chapters) |
| Effective Go / Go spec | CC BY 4.0? (unchecked) | Check, then host |
| Attention Is All You Need | arXiv non-exclusive; Google grants tables/figures only | **Link only** |
| InstructGPT, GPT-3 | arXiv non-exclusive | Link only |
| "Introducing ChatGPT" (OpenAI blog) | OpenAI copyright | Link only, short quotes |
| MapReduce, Bigtable, GFS, Dynamo | USENIX noncommercial / ACM | Link only |
| Bitcoin whitepaper | MIT claim, contested | Skip (noisy, off-brand) |

**AI angle (legal):** our own annotated *reading guide* to "Attention Is All You Need" (our text, linking to arXiv), or a CC-BY-4.0 LLM paper picked by filtering arXiv licence metadata.

**Disagreement: starter text**

| Seat | Starter |
|---|---|
| Marketing, product | Raft dissertation ch. 3: real, famous, legal, and it gives the HN story a hook |
| Designer | Our own ~600-word replication/consensus passage: reflows, no PDF quirks, already exists on the landing ("Example passage written for this page") |

Resolution proposal: start with **our own passage** (fast and safe), then add the **Raft dissertation** as the first catalog "paper" once its extraction quality is checked (formulas, figures, references). Owner decides (Q1).

## Distribution (marketing)

- **Show HN:** "Read the Raft dissertation with every term explained in place". Demo link, no signup, weekday US morning.
- **Reddit:** r/distributedsystems, r/rust (the Rust Book with inline explanations). Lead with a GIF.
- **dev.to series:** "Reading the Raft paper with my own Claude via MCP". MCP is the novel angle.
- **Papers We Love** meetups; ES/DE/UK dev communities: "Raft in your language".
- **MCP directories:** list the connector with Raft as the default demo.

## Success metric

- Primary: share of new guests who open the starter and Explain/save ≥1 term from it (`VocabularyWord.bookTitle` + guest `CreatedAt`). Target ≥30%.
- Secondary: guest → account (`User.PromotedAt`), first upload within 7 days.
- Caveat: at ~0 traffic the numbers stay unreadable for weeks. The real gate is a qualitative pass with the 12 Play testers.

## Slices (in order)

- **S0 — content, no code, now:**
  - Pick the starter (Q1).
  - If Raft: import the dissertation via admin upload, check extraction, choose a ~5–10 min section, add an attribution block (CC BY 4.0).
- **S1 — web homepage = landing port:**
  - Delete the old sections, keep SSG and the library link.
  - Point the CTA at the starter.
  - Canonical gh-pages → textstack.app.
- **S2 — mobile (JS-only, ships as OTA on merge):**
  - `DEMO_BOOK`, `StartReadingCard` copy, 3-step coachmark.
  - Update `apps/mobile/src/lib/__fixtures__/shared-catalog.golden.json`.
  - **Merge after Play production approval (~2026-10-16)**: a mobile merge auto-OTAs, and first-run copy shouldn't change while the app is under review.
- **S3 — store listing copy:** drop the "learn a language" framing.
- **Later:** MCP prompt at chapter end for signed-in users; per-term long-tail pages; the AI reading guide.

**Not building:** role picker with branches, carousel/tour engine, per-persona home, analytics to justify segmentation, hosting arXiv-default/USENIX/ACM papers, a separate mobile landing.

## Questions for the owner

1. Tech starter: CoT §1–2 (live now), our own passage, or the Raft dissertation?
2. ~~Role question~~: decided, 2 audiences (tech / English). Where: a chip row on the language screen, or its own screen?
2a. Featured shelf per audience: is it the existing `make featured` list split in two, or a genre filter?
2b. Can a user switch audience later (profile setting)?
3. Homepage literally = landing, classics → one link?
4. Book pile: only hosted titles, or keep DDIA/CLRS labelled "your upload"?
5. Retire gh-pages landing → canonical to textstack.app?
6. AI angle: our own "Attention" reading guide enough, or a CC-BY LLM paper?
7. Mobile S2 after Play approval (~10-16): ok?
8. Store listing: drop language-learner copy too?
9. Long-tail per-term pages (ES/DE/UK…): hand-written or generated?
