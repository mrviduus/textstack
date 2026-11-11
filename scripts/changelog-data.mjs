#!/usr/bin/env node
//
// Data for the public changelog page (/:lang/changelog, #1216), baked into the web build so the
// page never calls GitHub while someone reads it. Android can read the same file later.
//
//   node scripts/changelog-data.mjs > apps/web/public/changelog.json    images.yml, before vite
//   node scripts/changelog-data.mjs --check                             pr-labels.yml, PR_BODY env
//
// Releases are the dated ones deploy.yml creates (#1220). The oldest is the baseline: PRs merged
// before it live in the frozen CHANGELOG.md, not here. Each PR goes under the first release created
// after it merged; a PR merged since the newest release (the build runs before its deploy creates
// one) goes under a group with tag null and today's date.
//
// A PR labelled `public` carries a block for readers in its description:
//
//   ## Public
//   Title: Read AZW3 books
//   Web, Android · New
//   Your Kindle AZW3 files now open in the reader.
//
// A malformed block fails --check on the PR; at build time the PR just loses its reader entry,
// with a warning, rather than failing the deploy.

export const KINDS = ['New', 'Fix', 'Improved', 'Changed']
export const WHERE = ['Web', 'Android']
const CALVER = /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/

/** The `## Public` block → { title, where, kind, text }. Throws a message naming what is wrong. */
export function parsePublic(body) {
  const m = /^##[ \t]*Public[ \t]*\r?\n([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/m.exec(body ?? '')
  if (!m) throw new Error('no "## Public" section in the description')
  const lines = m[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const title = /^Title:\s*(.+)$/.exec(lines[0] ?? '')?.[1]
  if (!title) throw new Error('first line must be "Title: <short title>"')
  const [whereRaw, kind, extra] = (lines[1] ?? '').split('·').map((s) => s.trim())
  const where = (whereRaw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (extra !== undefined || !where.length || !where.every((w) => WHERE.includes(w)) || !KINDS.includes(kind))
    throw new Error(`second line must be "<${WHERE.join(', ')}> · <${KINDS.join(' | ')}>"`)
  const text = lines.slice(2).join(' ')
  if (!text) throw new Error('add one or two plain sentences after the second line')
  return { title, where, kind, text }
}

/**
 * releases: GitHub releases ({ tag_name, created_at, html_url }); prs: search items for merged PRs.
 * → [{ tag, date, url, prs: [{ number, title, url, labels, public? }] }], newest first.
 */
export function build(releases, prs, now, warn = () => {}) {
  const rel = releases
    .filter((r) => CALVER.test(r.tag_name))
    .map((r) => ({ tag: r.tag_name, at: r.created_at, url: r.html_url }))
    .sort((a, b) => a.at.localeCompare(b.at))
  if (!rel.length) return []
  const groups = new Map(rel.slice(1).map((r) => [r.tag, { tag: r.tag, date: r.at.slice(0, 10), url: r.url, prs: [] }]))
  const pending = { tag: null, date: now.toISOString().slice(0, 10), url: null, prs: [] }
  for (const pr of prs) {
    const merged = pr.pull_request?.merged_at
    const labels = pr.labels.map((l) => l.name)
    if (!merged || merged < rel[0].at || labels.includes('dependencies')) continue
    const entry = { number: pr.number, title: pr.title, url: pr.html_url, labels }
    if (labels.includes('public')) {
      try {
        entry.public = parsePublic(pr.body)
      } catch (e) {
        warn(`#${pr.number}: ${e.message}`)
      }
    }
    const home = rel.slice(1).find((r) => r.at >= merged)
    ;(home ? groups.get(home.tag) : pending).prs.push(entry)
  }
  for (const g of [...groups.values(), pending]) g.prs.sort((a, b) => b.number - a.number)
  return [pending, ...[...groups.values()].reverse()].filter((g) => g.prs.length)
}

async function main() {
  if (process.argv.includes('--check')) {
    try {
      parsePublic(process.env.PR_BODY)
      console.log('Public block OK')
    } catch (e) {
      console.log(`::error::Labelled public: ${e.message}. Format: scripts/changelog-data.mjs header.`)
      process.exit(1)
    }
    return
  }
  const repo = process.env.GITHUB_REPOSITORY || 'mrviduus/textstack'
  const headers = { Accept: 'application/vnd.github+json' }
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`
  const get = async (path) => {
    const r = await fetch(`https://api.github.com${path}`, { headers })
    if (!r.ok) throw new Error(`GET ${path}: ${r.status}`)
    return r.json()
  }
  const releases = await get(`/repos/${repo}/releases?per_page=100`)
  const calver = releases.filter((r) => CALVER.test(r.tag_name)).map((r) => r.created_at).sort()
  const prs = []
  // ponytail: search caps at 1000 results (10 pages); move to per-release compare calls past that.
  for (let page = 1; calver.length && page <= 10; page++) {
    const q = encodeURIComponent(`repo:${repo} is:pr is:merged merged:>=${calver[0]}`)
    const { items } = await get(`/search/issues?q=${q}&per_page=100&page=${page}`)
    prs.push(...items)
    if (items.length < 100) break
  }
  const out = build(releases, prs, new Date(), (m) => console.error(`::warning::changelog: ${m}`))
  process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), releases: out }) + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
