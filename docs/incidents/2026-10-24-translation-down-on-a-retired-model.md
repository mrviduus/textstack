# Translation failed on every call because OpenAI retired its model, and health said ready

**Date:** 2026-10-24
**Status:** Resolved (#918, deployed 2026-10-24; `POST /api/translate` → 200 after the deploy)

## Impact

Every `POST /api/translate` on production returned 503 — web, mobile and the reader's word bubble.
Explain, the tutor and reading were unaffected. Confirmed live on 2026-10-24 with two requests, both
`503 · HTTP 404 (invalid_request_error: model_not_found) The model gpt-4.1-nano has been deprecated`.
Start time: not yet measured. Every failed call is an error row in `llm_traces` (feature
`translate`), so the first one dates it — check the admin AI Quality page.

## Root cause

Translation ran on `gpt-4.1-nano`, the default `OpenAI:Model` in every place that names a default
(appsettings, compose, `.env.example`, the client fallback). Production's `.env` does not set
`OPENAI_MODEL`, so the compose default was what ran. OpenAI retired the model, and the call
began failing with `model_not_found`. Explain kept working only because it has its own route on
`gpt-4.1-mini`.

The failure was reported, not silent: the call goes through the gateway's `TracingDecorator`, which
persists an error trace and raises `LlmFailureAlarm` — one Sentry event per (provider, task, reason)
per hour. What stayed green was `/health/ready`: it checks the DB, schema, storage, Ollama and SSG,
not whether a paid model still exists.

The first draft of this postmortem said the endpoint "logged nothing, so Sentry received none" and
added a `LogError` in the endpoint. Code review found the decorator path; the `LogError` would have
sent one unthrottled event per word tap on top of the throttled one. It was removed before merge.

## Fix

#918:
- Default `OpenAI:Model` → `gpt-4.1-mini` (appsettings Api + Worker, compose, `OpenAiLlmClient`
  fallback, translate cache id, `ModelRegistrySeeder`, `.env.example`, About/privacy text).
- Migration `TranslateRegistryOnGpt41Mini` updates the existing `models` row, which the seeder never
  touches once the table has rows.
- The translate catch no longer echoes the provider's error text to clients, and lets a budget
  hard-stop through to `ExceptionMiddleware` (429 instead of 503).

That closes the *instance*. The *class* — a model id with an end date that nobody is watching — is
open: no check fails on a retired model (#921; one model-id constant: #920). Because the compose default is what production runs,
the fix needed a deploy, not a server edit.

## Lesson

A model id is a dependency with an end date. When a provider retires it, the failure is total and
immediate, and the only signal is the alarm you already have — so the alarm has to reach someone.
And verify the reporting path before writing "nothing logged it": the decorator was one layer below
the endpoint.

## Detection

The owner noticed translation was not working while using the app — not by an alert. Whether the
throttled Sentry event (`ai.task=translate`, `ai.failure=exception`) arrived, and why it went unread,
is not yet checked. That is the open question this incident leaves (#919).
