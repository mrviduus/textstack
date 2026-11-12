// The TextStack docs site (#1275). Content is the plain Markdown in ../docs; this folder is tooling only.
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  // GitHub Pages serves a project under /<repo>/; a custom domain serves it at /.
  site: process.env.DOCS_SITE ?? 'https://mrviduus.github.io',
  base: process.env.DOCS_BASE ?? '/',
  integrations: [
    {
      name: 'diagrams',
      hooks: {
        'astro:config:setup': ({ injectScript }) =>
          injectScript('page', `import ${JSON.stringify(new URL('./src/mermaid.js', import.meta.url).pathname)}`),
      },
    },
    starlight({
      title: 'TextStack docs',
      customCss: ['./src/theme.css'],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/mrviduus/textstack' }],
      editLink: { baseUrl: 'https://github.com/mrviduus/textstack/edit/main/site/' },
      sidebar: [
        { label: 'Stories', items: ['stories', 'glossary'] },
        { label: 'Start', items: ['start/run-locally', 'start/first-pr'] },
        {
          label: 'How it works',
          items: [
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
