# infra/scripts

Long-running shell pollers that run on the prod server. Each one watches
Postgres (or an API endpoint) for queued jobs, dispatches work through the
Claude CLI, and reports back.

All scripts run as the unprivileged deploy user under **systemd --user**.
Units live next door in [`../systemd/`](../systemd/README.md).

## Scripts

| Script | Purpose | Run as |
|--------|---------|--------|
| `seo-publish-poll.sh` | Polls `auto_publish_jobs`. Generates SEO fields (description, relevance, themes, FAQs) via Claude CLI, then publishes drafts. | systemd unit `seo-publish-poller` |
| `seo-backfill-poll.sh` | Polls `seo_backfill_jobs` via API (not DB directly — API owns state machine). Dispatches `seo-backfill-generate.sh` per job. | systemd unit `seo-backfill-poller` |
| `seo-backfill-generate.sh` | One-shot per-job runner: fetches rendered prompts from API, invokes Claude CLI per field with retries, POSTs output back. | Invoked by `seo-backfill-poll.sh` |
| `seo-generate.sh` | Manual SEO generation for a single edition or author. Admin-invoked, not polled. | `./infra/scripts/seo-generate.sh edition <uuid>` |
| `rebuild-ssg.sh` | Queues a Full SSG rebuild (`POST /internal/ssg/rebuild-all`) and follows the job until it ends. Not a poller. | `make rebuild-ssg` |
| `quality-poll.sh` | Polls `book_quality_jobs`. Validates book text (spelling, formatting) then applies fixes via internal API. | systemd unit `quality-poller` |

## Dependencies

All scripts require:
- **`claude` CLI** on PATH — paid Max subscription. The deploy user must have
  `claude` logged in (`~/.claude` config must exist and be readable).
- **`curl`**, **`jq`** — standard tooling.
- **`docker`** with `textstack_db_prod` running (for scripts that shell into
  `psql` directly — mostly `seo-publish-poll.sh`, `seo-generate.sh`,
  `quality-poll.sh`).
- **`textstack_api_prod`** reachable at `http://localhost:8080` (for scripts
  that go through API: `seo-backfill-*`).

Internal API endpoints (`/internal/**`) are only reachable from within the
Docker network — scripts run on the host, so they hit `localhost:8080`.

## Logs

```bash
journalctl --user -u seo-publish-poller -f
journalctl --user -u seo-backfill-poller -f
journalctl --user -u quality-poller -f
```

Or via Makefile where available:
```bash
make seo-backfill-logs
```

## Install / restart / stop

Each poller has a bundle of Makefile targets. Pattern:

| Action | Command |
|--------|---------|
| Install + start | `make <name>-setup` |
| Status | `make <name>-status` |
| Follow logs | `make <name>-logs` |
| Restart | `make <name>-restart` |
| Stop | `make <name>-stop` |

Installed units (all currently):
- `seo-publish-poller` — `make seo-publish-setup` / `-status`
- `seo-backfill-poller` — `make seo-backfill-setup` / `-status` / `-logs` /
  `-restart` / `-stop`
- `quality-poller` — no Makefile shortcut yet; `systemctl --user enable
  quality-poller && systemctl --user start quality-poller`

First-time host setup requires `loginctl enable-linger $(whoami)` so that
user-level systemd survives logout (the `-setup` targets call this).

## What to monitor

| Signal | What it means |
|--------|--------------|
| `systemctl --user is-active <unit>` != `active` | Poller crashed, restart pending or exhausted (`Restart=on-failure`, 5 attempts over 300s). |
| `journalctl` shows repeated `claude: command not found` | `claude` CLI missing for deploy user, or subscription lapsed. |
| Jobs stuck in `Running` in DB > 30 min | CLI hung. Restart the relevant poller. |
| `seo_backfill_jobs` all `Failed` | Check Resend admin alert emails (`ADMIN_ALERT_EMAIL`). Usually prompt validation error — see API logs. |

## When to **not** install a poller

The pollers burn Claude API tokens on a schedule. Only install what you use:
- `seo-publish-poller` — needed if you rely on **admin → Auto Publish**.
- `seo-backfill-poller` — needed if you rely on **admin → SEO Backfill**.
- `quality-poller` — optional book-text QA; can stay off in a fresh deploy.

The API itself works without any poller running — jobs just queue up without
being processed.

## See also

- [`../systemd/README.md`](../systemd/README.md) — unit files
- [`docs/03-ops/incident-runbook.md`](../../docs/03-ops/incident-runbook.md) — first-response steps
- [CLAUDE.md](../../CLAUDE.md#auto-publish) — Auto Publish feature overview
