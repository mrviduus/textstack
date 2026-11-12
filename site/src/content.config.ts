// Loads ../docs as the site's pages, so the Markdown stays plain and readable on GitHub:
// no frontmatter, a normal `# Title`, relative links between files.
import { defineCollection } from 'astro:content'
import type { Loader } from 'astro/loaders'
import { docsSchema } from '@astrojs/starlight/schema'
import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const DOCS = path.join(REPO, 'docs')
const GITHUB = 'https://github.com/mrviduus/textstack'
// Not site pages: working notes on their way to /internal (#1275).
const HIDDEN = /^(internal\/|STATUS\.md$)/

/** docs-relative file → page id: README.md → index, stories/index.md → stories. */
const idOf = (rel: string) =>
  rel.replace(/\.md$/, '').replace(/(^|\/)(README|index)$/, '') || 'index'

/** Relative links work on GitHub as written; here they become site URLs, or GitHub URLs for files outside the site. */
function rewriteLinks(md: string, rel: string, base: string): string {
  const here = path.dirname(path.join(DOCS, rel))
  const fix = (target: string) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return target
    const [p, frag = ''] = target.split(/(?=#)/)
    const abs = path.resolve(here, p)
    if (!existsSync(abs)) return target
    const inDocs = path.relative(DOCS, abs)
    const isDir = statSync(abs).isDirectory()
    if (inDocs.startsWith('..') || HIDDEN.test(isDir ? `${inDocs}/` : inDocs))
      return `${GITHUB}/${isDir ? 'tree' : 'blob'}/main/${path.relative(REPO, abs)}${frag}`
    if (inDocs.startsWith('assets/')) return `${base}${inDocs}`
    if (isDir) return `${base}${inDocs}/${frag}`
    if (!abs.endsWith('.md')) return `${GITHUB}/blob/main/docs/${inDocs}${frag}`
    const id = idOf(inDocs)
    return `${base}${id === 'index' ? '' : `${id}/`}${frag}`
  }
  return md
    .replace(/(\]\(\s*<?)([^)\s>]+)/g, (_, pre, t) => pre + fix(t))
    .replace(/(<(?:img|a)\s[^>]*?(?:src|href)=")([^"]+)/g, (_, pre, t) => pre + fix(t))
}

const repoDocs: Loader = {
  name: 'repo-docs',
  async load({ store, parseData, renderMarkdown, generateDigest, config, watcher }) {
    const base = config.base.endsWith('/') ? config.base : `${config.base}/`
    const sync = async () => {
      store.clear()
      for (const rel of globSync('**/*.md', { cwd: DOCS })) {
        if (HIDDEN.test(rel)) continue
        const file = path.join(DOCS, rel)
        const raw = readFileSync(file, 'utf8')
        const h1 = /^# +(.+)$/m.exec(raw)
        const body = rewriteLinks(h1 ? raw.replace(h1[0], '') : raw, rel, base)
        const id = idOf(rel)
        const filePath = path.relative(fileURLToPath(config.root), file)
        const data = await parseData({ id, data: { title: h1?.[1] ?? id }, filePath })
        store.set({
          id, data, body, filePath,
          digest: generateDigest(raw),
          rendered: await renderMarkdown(body, { fileURL: pathToFileURL(file) }),
        })
      }
    }
    await sync()
    watcher?.add(DOCS)
    watcher?.on('change', (f) => f.startsWith(DOCS) && sync())
  },
}

export const collections = {
  docs: defineCollection({ loader: repoDocs, schema: docsSchema() }),
}
