# infra/systemd

User-level systemd unit files for the long-running pollers in
[`../scripts/`](../scripts/README.md).

Why **user-level** (`systemctl --user`) and not system-wide?
- No root required — deploy user owns everything.
- Survives deploys: `git pull` doesn't touch `~/.config/systemd/user/`.
- Requires `loginctl enable-linger <user>` so units keep running after logout
  (the `make <name>-setup` targets handle this automatically).

## Units

| File | Service | ExecStart |
|------|---------|-----------|
| `seo-publish-poller.service` | SEO Auto-Publish | `infra/scripts/seo-publish-poll.sh` |
| `seo-backfill-poller.service` | SEO Backfill | `infra/scripts/seo-backfill-poll.sh` |
| `quality-poller.service` | Book Quality validation | `infra/scripts/quality-poll.sh` |

All three share the same shape:
- `Type=simple`
- `Restart=on-failure`, `RestartSec=10`
- `StartLimitBurst=5` over `StartLimitIntervalSec=300` — after 5 crashes in
  5 min systemd stops retrying (check logs to unblock).
- Hardcoded `WorkingDirectory=/home/vasyl/projects/onlinelib/textstack` —
  **edit if the deploy path changes**.

## Install

Done via Makefile targets — they copy the unit into
`~/.config/systemd/user/`, reload the daemon, enable + start.

```bash
make seo-publish-setup
make seo-backfill-setup
# quality-poller: no make target yet
systemctl --user enable quality-poller
systemctl --user start quality-poller
```

First time on a fresh host:
```bash
loginctl enable-linger $(whoami)  # units survive logout
```

## Manual install (if Makefile target is missing)

```bash
mkdir -p ~/.config/systemd/user
cp infra/systemd/<name>.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now <name>
```

## Uninstall

```bash
systemctl --user stop <name>
systemctl --user disable <name>
rm ~/.config/systemd/user/<name>.service
systemctl --user daemon-reload
```

## Status quick-check

```bash
systemctl --user list-units --type=service | grep poller
```

All three should show `active running`. If one is `failed` — see
[`../scripts/README.md`](../scripts/README.md#what-to-monitor) and
[`internal/ops/incident-runbook.md`](../../internal/ops/incident-runbook.md).
