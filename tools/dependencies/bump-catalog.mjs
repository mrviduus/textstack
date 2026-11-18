#!/usr/bin/env node
//
// CLI around tools/dependencies/catalogBump.mjs: ask pnpm what is outdated, raise the
// catalog by patch and minor, report the majors it refused.
//
// Run: node tools/dependencies/bump-catalog.mjs [--dry-run]

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bumpCatalog, report } from './catalogBump.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKSPACE = join(ROOT, 'pnpm-workspace.yaml')
const DRY = process.argv.includes('--dry-run')

// `pnpm outdated` exits 1 whenever anything is outdated, which is the normal
// case here and not a failure. The output still arrives on stdout.
function readOutdated() {
  const args = ['outdated', '-r', '--format', 'json']
  const opts = { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  let out
  try {
    out = execFileSync('pnpm', args, { ...opts, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    out = e.stdout?.toString() ?? ''
    // Distinguish "nothing to report" from "pnpm could not run". Silence from a
    // broken command would otherwise read as a clean catalog.
    if (!out.trim()) {
      console.error('pnpm outdated produced no output — treating as a failure rather than as "nothing outdated"')
      process.exit(1)
    }
  }
  return JSON.parse(out || '{}')
}

const result = bumpCatalog(readFileSync(WORKSPACE, 'utf8'), readOutdated())
if (result.applied.length && !DRY) writeFileSync(WORKSPACE, result.text)

const text = report(result)
console.log(text)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.applied.length > 0 && !DRY}\n`)
  // One line for the PR title, so it says what moved without anyone opening it.
  const title = result.applied.length === 1
    ? `chore(deps): ${result.applied[0].replace(/ \((patch|minor)\)$/, '')}`
    : `chore(deps): raise ${result.applied.length} catalog versions`
  appendFileSync(process.env.GITHUB_OUTPUT, `title=${title}\n`)
}
