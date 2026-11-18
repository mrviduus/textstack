# Nothing crashed and the CPU sat at 390% for an hour

**Date:** 2026-07-14
**Status:** Resolved

## Impact

A 106-page user PDF pegged the CPU-only Ollama container at ~390% for the whole parse (~42 s/page), produced zero chunks, and wedged the RAG indexing worker.

## Root cause

The Worker's `Ai:Routes` had no `pdf.parse` entry, so the parse fell through to `Ai:DefaultProvider: ollama`. Nothing threw, nothing logged an error, and no OpenAI traffic appeared — the failure mode was silence.

## Fix

Add `pdf.parse: openai-pdf` to the Worker config; later, emit `ai.provider.reason` on every route and alarm on a silent fallback for expensive tasks. PR #445.

## Lesson

A routing default is a silent failure waiting for a missing key. Nothing threw, nothing logged an
error, no OpenAI traffic appeared — the symptom was a CPU graph. Emit the routing *reason* on every
call so a fallback is visible, not inferred.

## Detection

A CPU graph. Nothing threw, nothing logged an error, and no OpenAI traffic appeared — the only
symptom was a container pinned at ~390% and a book that never finished indexing. The follow-up is
the reason `ai.provider.reason` is now emitted on every route: a silent fallback should be visible
as data, not inferred from a resource graph.

---

## Full write-up

*Preserved verbatim from the CHANGELOG entry of 2026-07-14. This is the long-form record — the source
material for articles and the detail a future reader needs.*

Regression from the durable-indexing change (which moved chunking off the API request into the Worker): the Worker's `Ai:Routes` had **no `pdf.parse` entry**, so the user-PDF vision→Markdown parse fell through to the Worker's `DefaultProvider: ollama` instead of `gpt-4.1`. On prod this pegged the CPU-only Ollama container at ~390% (≈4 cores) for the whole parse — ~42 s per page × a 106-page book — producing zero chunks visibly, no OpenAI traffic, and (because the parse is awaited inline in the sweep loop) wedging the RAG indexing worker. The API's `Ai:Routes` had `pdf.parse: openai-pdf` all along, which is why S3 worked before chunking moved processes. Fix: add `pdf.parse: "openai-pdf"` (+ the `Ai:Pdf` block) to `backend/src/Worker/appsettings.json`, mirroring the API. Config-only; Worker builds clean.
