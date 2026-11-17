# infra/scripts

Shell and Python helpers for the prod server and a laptop. No pollers: the SEO, quality and SSG
pollers, their systemd units and `claude-isolated.sh` went with the public catalog (M6).

## Scripts

| Script | Purpose | Run as |
|--------|---------|--------|
| `pg-dump-checked.sh` | `pg_dump` that fails on an incomplete dump (trailer check, `.tmp` until complete). | `backup.yml`, `deploy.yml` pre-deploy backup, `make backup` |
| `backup-verify.sh` | Restores a V2 dump into a throwaway Postgres container and runs sanity queries. | `make backup-verify` |
| `backup-files-tar.sh` | The files archive of `backup.yml` (self-check: `backup-files-tar.test.sh`). | `backup.yml` |
| `arxiv-to-epub.py` | Builds an EPUB (with a CC BY attribution page) from a paper's arXiv HTML. Refuses anything not CC BY 4.0. Needs `pandoc`. | `python3 -I infra/scripts/arxiv-to-epub.py <arxiv_id> <out_dir>` (on a laptop) |
| `metrics.sql` | Ad-hoc usage metrics (users, …). | `psql -f` |
