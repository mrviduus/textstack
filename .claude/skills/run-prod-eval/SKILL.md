---
name: run-prod-eval
description: Run an AI eval gate on production and read the result. Use to score a feature's DoD on prod (tool-call accuracy, judged suites) — the real scored runs that need an OpenAI key + corpus and an admin session, not CI.
---

# Run a prod eval

The deterministic half of each eval runs in CI (fake LLM). The **scored** half runs on prod against the
live corpus + key, admin-triggered, and persists an `eval_run` row (visible on `/ai-quality` → Evals).

## Endpoints (admin-only, POST)

- Tool-call accuracy (Phase 5): `/api/admin/ai-quality/evals/toolcalls/run` — sync, ~30 nano calls.
- Generic judged suite: `/api/admin/ai-quality/evals/run` (body `{features, judge}`), async — poll `/evals/status`.

`judge=openai` uses the stronger `Eval:JudgeModel` (gpt-4.1, independent of the nano generator);
`ollama` is free. Endpoints are admin-auth (cookie) and return 503 if the LLM/key isn't configured.

## How to run (browser, admin session required)

1. **Deploy must be done** — check `gh run list --workflow=deploy.yml --limit 1` is `completed success`.
   Wait out the ~25-min deploy window (the admin session also expires ~30 min — re-login if needed).
2. Confirm the endpoint exists (not 404): `curl -s -o /dev/null -w '%{http_code}'` POST unauth → expect 401.
3. Get a catalog `editionId` if needed: `curl -s 'https://textstack.app/api/books?lang=en&limit=1'`.
   
4. In a tab logged into **textstack.dev** (admin), fire it via `fetch` (cookie auth) and stash the result on
   `window` (the run can take 1-3 min): `fetch(url,{method:'POST',credentials:'include'}).then(r=>r.text())…`.
   Poll `window.__result`. Read `eval_runs` directly if the tab drops: `/api/admin/ai-quality/evals?feature=<f>&limit=5`.
5. **Report honestly**: the DoD numbers (e.g. judge ≥4/5, recall@8 ≥0.85, spoiler-leak = 0, avg steps ≤4,
   cost <$0.05), per-case breakdown of failures, and any contamination/caveats. The eval's job is to
   surface gaps — don't paper over a low score.

## Iterating
If a gate fails on a model-quality axis, the lesson from AI-033: **deterministic beats prompt-engineering**
where nano is weak (e.g. the Explain tool pre-router). Re-run after each deploy; track the trend
(0.33 → 0.50 → 0.73 → …).
