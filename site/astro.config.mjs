// The TextStack docs site (#1275). Content is the plain Markdown in ../docs; this folder is tooling only.
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  // GitHub Pages serves a project under /<repo>/; a custom domain serves it at /.
  site: process.env.DOCS_SITE || 'https://mrviduus.github.io',
  base: process.env.DOCS_BASE || '/',
  integrations: [
    {
      name: 'page-scripts',
      hooks: {
        'astro:config:setup': ({ injectScript }) =>
          injectScript(
            'page',
            ['mermaid', 'lesson'].map((f) => `import ${JSON.stringify(new URL(`./src/${f}.js`, import.meta.url).pathname)}`).join(';'),
          ),
      },
    },
    starlight({
      title: 'TextStack docs',
      customCss: ['./src/theme.css'],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/mrviduus/textstack' }],
      editLink: { baseUrl: 'https://github.com/mrviduus/textstack/edit/main/site/' },
      sidebar: [
        { label: 'Stories', items: ['stories', 'glossary'] },
        {
          label: 'Start',
          items: [
            {
              label: 'Run it locally',
              items: ['start/run-locally', 'start/run-1-get-the-code', 'start/run-2-start-it', 'start/run-3-open-a-book'],
            },
            {
              label: 'Ship a first pull request',
              items: ['start/first-pr', 'start/pr-1-pick-the-work', 'start/pr-2-change-and-check', 'start/pr-3-open-the-pull-request'],
            },
          ],
        },
        {
          label: 'How it works',
          items: [
            'architecture/story',
            'architecture',
            'architecture/flows',
            'architecture/frontend',
            'architecture/delivery',
            'architecture/v2',
            { label: 'Decisions', collapsed: true, items: [{ autogenerate: { directory: 'architecture/adr' } }] },
          ],
        },
        {
          label: 'Reference',
          items: [
            'reference/environment-variables',
            'reference/mcp',
            'guides/e2e-tests',
            'architecture/data-model',
            'architecture/data-access',
          ],
        },
        { label: 'Self-host', items: ['self-host'] },
      ],
    }),
  ],
})
