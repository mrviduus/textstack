# Uptime monitoring

Production is watched from outside by a **Sentry uptime monitor** (#1054, owner decision
2026-11-23). Sentry already holds the errors, so no new account and no new data processor:
the monitor only fetches a public URL.

## The monitor

| Field | Value |
|-------|-------|
| URL | `https://textstack.app/api/health/ready` |
| Method | `GET` |
| Interval | 1 minute (timeout 10 s) |
| Fails when | 3 failed checks in a row: not `2xx`/redirect (readiness answers `503` when the database, schema, storage or library is down), or a timeout |
| Alerts | email, through the project's alert rules ("high priority issues") |

`/health/ready` checks more than `/health`: the database, the schema version, collation,
storage and library write probes. A green answer means uploads and sync work, not only
that nginx is up. It goes through Cloudflare and nginx, so it also catches the tunnel or
the whole server being down.

## Where it is

Sentry → Monitors → Uptime → **Uptime Monitoring for https://textstack.app** (created by Sentry
in Aug 2026 on the home page; pointed at `/api/health/ready` on 2026-11-23, environment
`Production`). The free plan allows one uptime monitor: change this one, don't add another.

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
