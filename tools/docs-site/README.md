# The docs site

This folder is tooling only. The pages are the plain Markdown files in [`../../docs`](../../docs/).

- `src/content.config.ts` loads `../../docs` as pages: the first `# Heading` is the title, relative
  links become site links, links to files outside `docs/` become GitHub links.
- `src/theme.css` is the look. `src/mermaid.js` draws diagrams.
- `astro.config.mjs` holds the side menu.

Run it:

```bash
cd tools/docs-site
pnpm install --ignore-workspace
pnpm dev                              # http://localhost:4321
DOCS_BASE=/textstack pnpm build       # what CI checks: links still work under a sub-path
```

Live at https://docs.textstack.app (GitHub Pages, `.github/workflows/docs-site.yml`). The DNS record
is a `CNAME docs → mrviduus.github.io`, DNS only, in Cloudflare. The old address
`mrviduus.github.io/textstack` redirects here.

`--ignore-workspace` matters: this folder has its own lockfile and is not part of the apps' workspace.
