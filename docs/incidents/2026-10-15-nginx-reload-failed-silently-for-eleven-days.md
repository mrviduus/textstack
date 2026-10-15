# Every nginx change for eleven days was synced, "reloaded", and never went live

**Date:** 2026-10-15
**Status:** Mitigated (deploy now detects it and restarts; the first restart ships with the fix)

## Impact

From 2026-10-04 to 2026-10-15, production nginx ran the config as of 2026-10-04 15:51 (EDT). Each deploy
copied the new `textstack.conf`, passed `nginx -t`, printed "nginx reloaded" and went green. None of
these went live:

- **#693** (2026-10-04) — per-client rate-limit keys (`$limit_key`, CF-Connecting-IP). Public traffic
  arrives from cloudflared on loopback, so every `limit_req` zone still keyed on `127.0.0.1`: one
  shared bucket for all visitors, as before #693.
- **#738** (2026-10-06) — access log without query strings. `access.log` kept logging
  `/api/tts?text=<the passage read aloud>` and `/api/search?q=<query>` next to client IPs for nine days.
- **#852** (2026-10-14) — Sentry ingest in the CSP. Moot: the CSP never reached HTML pages (#857).
- **#860** (2026-10-15) — security headers on every HTML page, and `.mjs` served as JavaScript, which
  the web PDF reader's pdf.js worker needs.

## Root cause

#693 changed the key of existing `limit_req_zone`s. nginx keeps a zone's shared memory across a reload
and refuses a different key for it:

```
[emerg] limit_req "api_limit" uses the "$limit_key" key while previously it used the "$binary_remote_addr" key
```

On `[emerg]` during a reload, the master keeps the old workers and the old config. `systemctl reload
nginx` only sends the signal, so it exits 0. `nginx -t` checks the file, not whether the running
master can switch to it — and it passed. The deploy step treated "the reload command succeeded" as
"the config is live".

The post-deploy check said `x-seo-render` "proves nginx config is loaded". It proved that *a* config
was loaded: the old one sent the same header.

## Fix

The deploy step (`.github/workflows/deploy.yml`, Sync nginx config) now checks, on every deploy and not
only when the file changed, that every nginx worker is younger than the config file. If not, it
reloads; if the workers are still old, it restarts nginx (a restart is the only way to change a zone
key) and fails the deploy if even that does not take. *Verify SEO setup* now also requires a CSP with
`frame-ancestors` on `/en/` — a header only the current config sends.

This closes the class for nginx (any reload that does not take, for any reason), not just this zone.
It would not catch a header that is present in the file but wrong — that is what the CSP check is for.

## Lesson

A reload is a request, not a result. `systemctl reload`, `nginx -s reload`, `kill -HUP` all return as
soon as the signal is delivered; whether the server accepted the new config is only in its log and in
its worker processes. Verify the outcome (worker age, or a header only the new config sends), never
the exit code of the command that asked for it.

## Detection

By accident, 11 days in. Verifying #860 on prod: the new headers were missing, though the deploy log
said "nginx config changed — syncing … nginx reloaded". `nginx -T` on the server showed the new config;
`ps` showed workers started 2026-10-04; `error.log` held the `[emerg]` above, repeated at every deploy.
No alarm watched for it. Now the deploy fails if it happens.

---

## Owner follow-up

`access.log` and its rotated copies from 2026-10-06 to 2026-10-15 still contain query strings (TTS text,
search queries) next to IPs — what #738 meant to stop. Decide whether to purge them.
