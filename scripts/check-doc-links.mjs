#!/usr/bin/env node
// Every relative link in the docs points at a file that exists (#1237).
// Checks every tracked .md file, so links into docs/ from outside it count too. Run by ci.yml (job `docs-links`)
// and by hand: node scripts/check-doc-links.mjs
// Not checked: http(s) links, #anchors, text inside code fences and code spans.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

// apps/mobile, packages: wave 13 owns them until it merges; their old paths are fixed in #1239.
const SKIP = /^(apps\/mobile|packages)\//
const files = execFileSync('git', ['ls-files', '--', '*.md'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !SKIP.test(f) && existsSync(f))

const LINK = /\]\(\s*<?([^)\s>]+)|<(?:img|a)\s[^>]*?(?:src|href)="([^"]+)"/g
const broken = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')
    .replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, (block) => block.replace(/[^\n]/g, ' ')) // keep line numbers
    .replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length))
  for (const match of text.matchAll(LINK)) {
    const raw = match[1] ?? match[2]
    if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(raw)) continue
    const path = decodeURIComponent(raw.split('#')[0].split('?')[0])
    if (!path || existsSync(normalize(join(dirname(file), path)))) continue
    const line = text.slice(0, match.index).split('\n').length
    broken.push(`${file}:${line}  ${raw}`)
  }
}

if (broken.length) {
  console.error(`Broken relative links (${broken.length}):\n${broken.join('\n')}`)
  process.exit(1)
}
console.log(`docs links ok: ${files.length} files`)
