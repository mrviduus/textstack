#!/usr/bin/env node
//
// Data for the public changelog page (/:lang/changelog, #1216), baked into the web build so the
// page never calls GitHub while someone reads it. Android can read the same file later.
//
//   node scripts/changelog-data.mjs > apps/web/public/changelog.json    images.yml, before vite
//   node scripts/changelog-data.mjs --check                             pr-labels.yml, PR_BODY env
//
// The PRs merged since the switch (release 2026.11.11, #1220); earlier changes are in the frozen
// CHANGELOG.md. The page groups them by week.
//
// A PR labelled `public` (added weekly by /changelog-week) carries a block for readers:
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
export const SINCE = '2026-11-11T18:50:19Z' // created_at of release 2026.11.11, the switch

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

/** Search items for merged PRs → [{ number, title, url, labels, mergedAt, public? }], newest first. */
export function build(prs, warn = () => {}) {
  const out = []
  for (const pr of prs) {
    const mergedAt = pr.pull_request?.merged_at
    const labels = pr.labels.map((l) => l.name)
    if (!mergedAt || mergedAt < SINCE || labels.includes('dependencies')) continue
    const entry = { number: pr.number, title: pr.title, url: pr.html_url, labels, mergedAt }
    if (labels.includes('public')) {
      try {
        entry.public = parsePublic(pr.body)
      } catch (e) {
        warn(`#${pr.number}: ${e.message}`)
      }
    }
    out.push(entry)
  }
  return out.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
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
  const prs = []
  // ponytail: search caps at 1000 results (10 pages); page by merged-date windows past that.
  for (let page = 1; page <= 10; page++) {
    const q = encodeURIComponent(`repo:${repo} is:pr is:merged merged:>=${SINCE}`)
    const r = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=100&page=${page}`, { headers })
    if (!r.ok) throw new Error(`GitHub search: ${r.status}`)
    const { items } = await r.json()
    prs.push(...items)
    if (items.length < 100) break
  }
  const out = build(prs, (m) => console.error(`::warning::changelog: ${m}`))
  process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), prs: out }) + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
