# A hung RAG parse wedged the whole indexing worker

**Date:** 2026-07-14
**Status:** Resolved

## Impact

One slow parse blocked every other book's indexing behind it.

## Root cause

The parse was awaited inline in the sweep loop with no timeout.

## Fix

Detach the chunk parse from the sweep loop and give it a hard timeout. PR #436.

## Lesson

Anything awaited inline in a sweep loop is a shared fate. One slow item becomes everyone's outage;
detach it and give it a hard timeout.

## Detection

Noticed as a queue that stopped moving — every other book's indexing was stuck behind one item.

---

## Full write-up

*Preserved verbatim from the CHANGELOG entry of 2026-07-14. This is the long-form record — the source
material for articles and the detail a future reader needs.*

Follow-up to the durable-indexing work: the sweep loop `await`ed each book's chunk (vision parse) **inline**, so one slow or hung parse blocked the whole loop — no drain, and critically no stale-reclaim — until it returned. The mis-routed 74-minute Ollama parse wedged the worker exactly this way. Now the sweep **detaches** the parse to a background `Task.Run` gated by a `SemaphoreSlim(1)`: it dispatches at most one parse at a time (bounds paid vision spend) and the loop keeps running stale-reclaim + drain checks every 30 s, so a stuck parse can't wedge it. A **hard parse timeout** (`Ai:Pdf:ParseTimeoutMinutes`, default 12, clamped below the 15-min stale window) terminates a live-but-slow parse to `Failed`/"indexing timed out, retry" before the stale sweep would — and the render phase now honors the token too, not just the vision calls. Restart-safe (the atomic `rag_indexing_started_at` claim runs before the parse, so a killed detached task is recovered by the stale sweep). **Hardened by adversarial QA** — the review caught (and this fixes) a **HIGH** semaphore leak: a DB exception between `Wait(0)` and dispatch would have leaked the slot permanently → the very silent-worker-wedge the change set out to kill; now a `try/finally` releases the slot on every non-dispatched path. `dotnet build` + **1120 unit** tests green. Live parse verified on prod earlier (OSCE: 375 chunks → Ready in ~4 min on gpt-4.1); the detach/timeout paths are unit-tested where pure and reasoned through for concurrency (no local OpenAI key / arm64 SIGILL).
