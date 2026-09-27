#!/usr/bin/env node
//
// CLI around scripts/nugetBump.mjs: ask the SDK what is outdated, raise
// Directory.Packages.props by patch and minor, report the majors it refused.
//
// Needs a restore first — `dotnet list package` reads the assets file, not the
// project. Run: dotnet restore && node scripts/bump-nuget.mjs [--dry-run]

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bumpPackages, latestVersions, report } from './nugetBump.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROPS = join(ROOT, 'Directory.Packages.props')
const DRY = process.argv.includes('--dry-run')

// The JSON arrives on stdout, but MSBuild is free to put a warning there first.
// Slice from the first brace rather than trusting the whole stream to be JSON.
function readOutdated() {
  const args = ['list', 'package', '--outdated', '--format', 'json']
  const out = execFileSync('dotnet', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const start = out.indexOf('{')
  // Silence from a broken command would otherwise read as a current manifest.
  if (start === -1) {
    console.error('dotnet list package produced no JSON — treating as a failure rather than as "nothing outdated"')
    process.exit(1)
  }
  return JSON.parse(out.slice(start))
}

const result = bumpPackages(readFileSync(PROPS, 'utf8'), latestVersions(readOutdated()))
if (result.applied.length && !DRY) writeFileSync(PROPS, result.text)

const text = report(result)
console.log(text)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.applied.length > 0 && !DRY}\n`)
  appendFileSync(process.env.GITHUB_OUTPUT, `count=${result.applied.length}\n`)
}
