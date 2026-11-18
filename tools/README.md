# Development tools

Run commands from the repository root unless stated otherwise.

| Folder | Purpose | Command |
|---|---|---|
| `docs-site/` | Build the website from `docs/`; separate pnpm lockfile | `pnpm -C tools/docs-site dev` |
| `checks/` | Node, extension, links, advisories, Expo alignment; changelog generation | `node tools/checks/check-extension.mjs` |
| `dependencies/` | Dependency bumps and version drift reports | `node tools/dependencies/bump-catalog.mjs --dry-run` |
| `import/` | Prepare external content for the library | `python3 -I tools/import/arxiv-to-epub.py <arxiv_id> <out_dir>` |

Repository tool tests: `pnpm test:scripts`.
Deployment, Docker, backups, mobile OTA and registry retention helpers live in `infra/scripts/`.
App-specific scripts stay with their app.
