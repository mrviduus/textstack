# Translation failed on every call because OpenAI retired its model, and nothing logged it

**Date:** 2026-10-24
**Status:** Mitigated (fix in #918; production also needs `OPENAI_MODEL` changed in the server `.env`)

## Impact

Every `POST /api/translate` on production returned 503 — web, mobile and the reader's word bubble.
Explain, the tutor and reading were unaffected. When it started is not known: there was no log
line to date it by (see Detection). Confirmed live on 2026-10-24 with two requests, both
`503 · HTTP 404 (invalid_request_error: model_not_found) The model gpt-4.1-nano has been deprecated`.

## Root cause

Translation ran on `gpt-4.1-nano`, set as the default `OpenAI:Model` in every place that names a
default (appsettings, compose, `.env.example`, the client fallback). OpenAI retired the model, and
the call began failing with `model_not_found`. Explain kept working only because it has its own
route on `gpt-4.1-mini`.

The 503 itself was correct. What made it invisible: the endpoint's `catch (Exception ex)` returned
`Results.Problem` and logged nothing. Sentry takes events at `Error` and above, so it received none.
`/health/ready` checks the DB, schema, storage, Ollama and SSG — not the model — and stayed `ready`.

## Fix

#918:
- Default `OpenAI:Model` → `gpt-4.1-mini` (appsettings Api + Worker, compose, `OpenAiLlmClient`
  fallback, translate cache id, `ModelRegistrySeeder`, `.env.example`, About/privacy text).
- The translate catch logs `Error` ("Translate LLM call failed") → a Sentry event; the response no
  longer echoes the provider's error text to clients.
- Migration `TranslateRegistryOnGpt41Mini` updates the existing `models` row, which the seeder
  never touches once the table has rows.

That closes the *instance*. The *class* — a dependency that fails on every call while health says
ready — is closed only as far as Sentry now sees it. No alert fires on a provider deprecation notice,
and there is no synthetic translate check.

## Lesson

A catch that turns an exception into a status code must log it, or the error exists only in the
response body of a user who has already left. The same request on a sibling endpoint (Explain)
logged `Error`; the two were written apart and drifted. And a model id is a dependency with an end
date: pin it where it can be changed without a deploy, and expect to change it.

## Detection

The owner noticed translation was not working while using the app. Not Sentry, not health, not
CI. Time to detection is unknown, because the failure left no record. The alarm that would have
caught it on the first call — an `Error` event from the translate catch — exists from #918.
