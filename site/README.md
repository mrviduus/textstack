# The docs site

This folder is tooling only. The pages are the plain Markdown files in [`../docs`](../docs/).

- `src/content.config.ts` loads `../docs` as pages: the first `# Heading` is the title, relative
  links become site links, links to files outside `docs/` become GitHub links.
- `src/theme.css` is the look. `src/mermaid.js` draws diagrams.
- `astro.config.mjs` holds the side menu.

Run it:

```bash
cd site
pnpm install --ignore-workspace
pnpm dev                              # http://localhost:4321
DOCS_BASE=/textstack pnpm build       # what CI builds
```

`--ignore-workspace` matters: this folder has its own lockfile and is not part of the apps' workspace.
