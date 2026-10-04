# Uptime Monitoring

External probes for production services. Free-tier UptimeRobot covers the
playbook: 3 monitors, 5-min interval, email alerts. BetterStack is a drop-in
alternative (3-min interval, 10 monitors on free tier).

## Monitors

| Name | URL | Type | Expected | Interval |
|------|-----|------|----------|----------|
| Public site | `https://textstack.app/` | HTTP(S) | `200` | 5 min |
| API + DB | `https://textstack.app/api/health` | Keyword | body contains `healthy` | 5 min |
| Admin | `https://textstack.dev/` | HTTP(S) | `200` | 5 min |

`/api/health` round-trips Postgres (`SELECT 1`), so it doubles as a DB probe —
if DB is down, API returns 503 and UptimeRobot pages.

## Setup (UptimeRobot)

1. Sign up at <https://uptimerobot.com> (free tier).
2. Add the 3 monitors from the table above (**+ New Monitor** → HTTP(s) or
   Keyword).
3. **Alert Contacts** → add email (`${ADMIN_ALERT_EMAIL}`). Optional: Telegram
   bot or Slack webhook.
4. Attach all contacts to each monitor.
5. (Optional) **Public Status Page** → creates a public URL
   (`stats.uptimerobot.com/...`) listing the 3 monitors. Useful for buyers
   doing due diligence.

## Alert-response runbook

| Alert | First checks |
|-------|-------------|
| Public site down | `curl -I https://textstack.app/` → nginx/tunnel issue. Check Cloudflare Tunnel status, nginx logs on server. |
| `/api/health` failing | `ssh asus` → `docker compose ps` → find unhealthy container. `docker compose logs api worker db --tail=100`. |
| Admin down (only) | Admin container — `docker compose logs admin`. Public site likely still fine. |

## GitHub Actions health-check

`.github/workflows/health-check.yml` runs every 5 min. Beyond `/health` on both hosts and both
frontends, it asks things UptimeRobot cannot: a Googlebot-UA request must get prerendered HTML
(`X-SEO-Render: ssg`, >5 KB, has `<title>`), SSG must not be failing or stale (>72h), and book
listing, search and author pages must work. Not redundant — the SSG checks exist because
crawler-only breakage went unnoticed twice. There is also `GET /health/ready` (per-component:
db, storage critical; ollama soft).
