# Uptime monitoring

Production is watched from outside by a **Sentry uptime monitor** (#1054, owner decision
2026-11-23). Sentry already holds the errors, so no new account and no new data processor:
the monitor only fetches a public URL.

## The monitor

| Field | Value |
|-------|-------|
| URL | `https://textstack.app/api/health/ready` |
| Method | `GET` |
| Interval | 5 minutes |
| Fails when | not `2xx` (readiness answers `503` when the database, schema, storage or library is down), or a timeout |
| Alerts | email to the owner |

`/health/ready` checks more than `/health`: the database, the schema version, collation,
storage and library write probes. A green answer means uploads and sync work, not only
that nginx is up. It goes through Cloudflare and nginx, so it also catches the tunnel or
the whole server being down.

## Setup (Sentry, once)

1. Sentry → **Alerts** → **Create Alert** → **Uptime Monitor**.
2. URL and method from the table; interval 5 minutes; environment `production`.
3. Name it `textstack.app ready`; owner = you; notify by email.
4. Save, then check the monitor shows a first green check within a few minutes. If
   Cloudflare blocks Sentry's prober (a 403 in the check log), allow it in Cloudflare
   → Security → WAF for the path `/api/health/ready`.

## Alert-response runbook

| Alert | First checks |
|-------|-------------|
| Monitor down, site loads | `curl -s https://textstack.app/api/health/ready` names the failing component. `docker compose logs api --tail=100` on the server. |
| Monitor down, site down too | Cloudflare tunnel status, then nginx and `docker compose ps` on the server. |
| A deploy failed | `deploy.yml` prints the failing containers' last 100 log lines (#1055). |
| TTS broken (health-check step "TTS synthesizes through Edge", or Sentry "TTS upstream failed") | The reason is in the Sentry issue or `docker compose logs api --tail=200 \| grep -i tts`. `403 when 101 was expected` = Microsoft changed the Edge token protocol (#827): diff upstream [rany2/edge-tts](https://github.com/rany2/edge-tts) `src/edge_tts/drm.py` + `constants.py` against `backend/src/Tts/TextStack.Tts/EdgeTtsDrm.cs`. Reproduce: `curl -G --data-urlencode "text=test $(date +%s)" -d lang=en https://textstack.app/api/tts -o /dev/null -w '%{http_code}\n'` (unique text, so the cache can't hide an Edge outage). |

## GitHub Actions health check

`.github/workflows/health-check.yml` asks what a URL probe cannot: the schema matches the
build, collation matches the OS, the sync API is ready, and TTS really synthesizes through
Edge. It is scheduled every 5 minutes but GitHub runs it every 3–6 hours, so it is a slow
second opinion, not the alarm. The alarm is the Sentry monitor.
